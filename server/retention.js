// 데이터 보관 정책: 회차(조사) 응답은 마감 뒤 14개월이 지나면 자동 삭제됩니다.
import { makeRound, monthName } from './rounds.js';

export const RETENTION_MONTHS = Number.parseInt(process.env.RETENTION_MONTHS, 10) || 14;
export const WARN_DAYS = 60;
const LOG_LIMIT = 12;

export function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/** 회차의 마지막 활동 시각: 시작·마감, 응답 제출, 성향 설문·지원서 저장, 역할 배정·AI 분석 가운데 가장 늦은 시각 */
export function roundLastActivity(round) {
  let latest = round.startedAt || null;
  const bump = (t) => { if (typeof t === 'string' && t && (!latest || t > latest)) latest = t; };
  bump(round.closedAt);
  for (const sub of Object.values(round.submissions || {})) bump(sub?.submittedAt);
  for (const p of Object.values(round.profiles || {})) bump(p?.updatedAt);
  for (const a of Object.values(round.applications || {})) bump(a?.updatedAt);
  bump(round.roleAssignment?.createdAt);
  bump(round.roleAssignment?.updatedAt);
  bump(round.roleAssignment?.publishedAt);
  bump(round.aiAnalysis?.createdAt);
  return latest;
}

export function roundExpiresAt(round, months = RETENTION_MONTHS) {
  const last = roundLastActivity(round);
  return last ? addMonths(last, months).toISOString() : null;
}

export function roomLastActivity(room) {
  let latest = room.createdAt || null;
  const bump = (t) => { if (t && (!latest || t > latest)) latest = t; };
  for (const r of room.rounds || []) bump(roundLastActivity(r));
  bump(room.seating?.updatedAt);
  bump(room.teacherNotes?.updatedAt);
  for (const h of room.roleHistory || []) bump(h?.updatedAt);
  return latest;
}

/**
 * 만료된 회차를 지웁니다. 교실 전체가 오래 쓰이지 않았으면 교실 삭제를 요청합니다.
 * @returns {{ changed: boolean, deleteRoom: boolean, removed: object[] }}
 */
export function purgeExpired(room, now = new Date(), months = RETENTION_MONTHS) {
  const cutoff = addMonths(now, -months).toISOString();
  const nowIso = new Date(now).toISOString();
  const removed = [];
  const keep = [];
  for (const r of room.rounds || []) {
    const last = roundLastActivity(r);
    if (last && last < cutoff) removed.push(r); else keep.push(r);
  }
  // 1인 1역 달별 기록도 같은 기간이 지나면 지웁니다. (저장 시각이 없는 옛 기록은 그대로 둠)
  const history = room.roleHistory || [];
  const keptHistory = history.filter((h) => !(h?.updatedAt && h.updatedAt < cutoff));
  const historyChanged = keptHistory.length !== history.length;
  if (historyChanged) room.roleHistory = keptHistory;
  if (!removed.length) return { changed: historyChanged, deleteRoom: false, removed };

  const lastActivity = roomLastActivity(room);
  if (keep.length === 0 && lastActivity && lastActivity < cutoff) {
    return { changed: true, deleteRoom: true, removed };
  }

  room.rounds = keep;
  if (room.rounds.length === 0) {
    const fresh = makeRound(monthName(nowIso), nowIso);
    room.rounds.push(fresh);
  }
  if (!room.rounds.some((r) => r.id === room.currentRoundId)) room.currentRoundId = room.rounds[room.rounds.length - 1].id;
  room.retentionLog = [
    ...(room.retentionLog || []),
    ...removed.map((r) => ({ name: r.name, startedAt: r.startedAt, closedAt: r.closedAt, deletedAt: nowIso, submitted: Object.keys(r.submissions || {}).length })),
  ].slice(-LOG_LIMIT);
  return { changed: true, deleteRoom: false, removed };
}

/** 선생님 화면에 보여 줄 보관 상태 */
export function retentionView(room, now = new Date(), months = RETENTION_MONTHS) {
  const warnBefore = new Date(now.getTime() + WARN_DAYS * 86400000).toISOString();
  const rounds = (room.rounds || []).map((r) => ({ id: r.id, name: r.name, expiresAt: roundExpiresAt(r, months) }));
  return {
    months,
    warnDays: WARN_DAYS,
    expiring: rounds.filter((r) => r.expiresAt && r.expiresAt <= warnBefore).sort((a, b) => a.expiresAt.localeCompare(b.expiresAt)),
    roomExpiresAt: roomLastActivity(room) ? addMonths(roomLastActivity(room), months).toISOString() : null,
    log: room.retentionLog || [],
  };
}

/** 모든 교실에 보관 정책을 적용합니다 (예약 작업/서버 시작 시). */
export async function purgeAll(store, now = new Date()) {
  const result = { rooms: 0, deletedRooms: 0, deletedRounds: 0 };
  const rooms = await store.listRooms();
  for (const snapshot of rooms) {
    result.rooms++;
    const probe = purgeExpired(structuredClone(snapshot), now);
    if (!probe.changed) continue;
    if (probe.deleteRoom) {
      await store.deleteRoom(snapshot.id);
      result.deletedRooms++;
      result.deletedRounds += probe.removed.length;
      continue;
    }
    let removedCount = 0;
    await store.updateRoom(snapshot.id, (fresh) => { removedCount = purgeExpired(fresh, now).removed.length; });
    result.deletedRounds += removedCount;
  }
  return result;
}
