// JSON 가져오기: 선생님 페이지에서 내려받은 전체 JSON 안의 복원용 원본(backup)으로 교실을 새로 만듭니다.
// - 선생님 열쇠와 학생 링크(토큰)는 파일에 없으므로 새로 발급해요 → 복원한 교실은 QR 을 다시 나눠 줘야 해요.
// - 파일은 누구나 고쳐서 올릴 수 있으니, 그대로 믿지 않고 아는 모양만 골라 다시 조립합니다.
//   (학생·회차 id 는 정해진 글자만 허용하고, 명단에 없는 학생이 낀 항목은 버려요)
import { newId, newToken } from './tokens.js';
import { isValidTag } from './reasons.js';
import { normalizeRoles } from './roles.js';

export const BACKUP_VERSION = 1;
export const IMPORT_LIMITS = { students: 80, rounds: 36, roomName: 60, roundName: 40, studentName: 30, reason: 300, nodes: 400000, depth: 24, text: 20000, list: 5000 };

class ImportError extends Error {
  constructor(message) { super(message); this.status = 400; }
}
const fail = (message) => new ImportError(message);
const BROKEN = '파일 내용이 올바르지 않아요. 선생님 페이지에서 내려받은 전체 JSON 파일인지 확인해 주세요.';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
/** 객체의 키로 써도 안전한 id 인지 (정해진 글자만 · Object 가 원래 갖고 있는 이름은 안 됨) */
const safeId = (id) => typeof id === 'string' && ID_RE.test(id) && !(id in Object.prototype) && id !== 'prototype';
const cleanName = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const isoOrNull = (v) => {
  if (typeof v !== 'string' || !v || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/**
 * 내보내기 파일에 넣는 복원용 원본. 선생님 열쇠 · 학생 링크(토큰) · 작성 중 임시 저장 · 자동 삭제 기록은 뺍니다.
 */
export function backupOf(room) {
  const { adminToken, id, retentionLog, ...rest } = structuredClone(room);
  return {
    version: BACKUP_VERSION,
    room: {
      ...rest,
      students: (rest.students || []).map(({ token, ...s }) => s),
      rounds: (rest.rounds || []).map(({ studentDrafts, ...r }) => r),
    },
  };
}

/** 파일 전체를 한 번 훑어 위험한 키 · 지나친 깊이 · 지나친 크기를 걸러요. */
function assertSafeJson(root) {
  let nodes = 0;
  const walk = (value, depth) => {
    if (++nodes > IMPORT_LIMITS.nodes) throw fail('파일이 너무 커서 가져올 수 없어요.');
    if (depth > IMPORT_LIMITS.depth) throw fail(BROKEN);
    if (typeof value === 'string') { if (value.length > IMPORT_LIMITS.text) throw fail(BROKEN); return; }
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      if (value.length > IMPORT_LIMITS.list) throw fail(BROKEN);
      for (const item of value) walk(item, depth + 1);
      return;
    }
    for (const key of Object.keys(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw fail(BROKEN);
      walk(value[key], depth + 1);
    }
  };
  walk(root, 0);
}

/** { 학생 id: 값 } 모양에서 명단에 있는 학생 것만, 값이 객체인 것만 남깁니다. */
function byStudent(input, roster, map = (v) => v) {
  const out = {};
  if (!isObject(input)) return out;
  for (const [sid, value] of Object.entries(input)) {
    if (!roster.has(sid)) continue;
    const mapped = map(value, sid);
    if (mapped !== undefined && mapped !== null) out[sid] = mapped;
  }
  return out;
}

function restoreRelations(input, roster) {
  return byStudent(input, roster, (targets, from) => {
    if (!isObject(targets)) return null;
    const out = {};
    for (const [to, r] of Object.entries(targets)) {
      if (!roster.has(to) || to === from || !isObject(r)) continue;
      if (r.type !== 'good' && r.type !== 'bad') continue;
      const tags = Array.isArray(r.tags) ? [...new Set(r.tags.map(String))].filter((t) => isValidTag(r.type, t)) : [];
      out[to] = { type: r.type, tags, reason: String(r.reason ?? '').trim().slice(0, IMPORT_LIMITS.reason), updatedAt: isoOrNull(r.updatedAt) };
    }
    return out;   // 아무도 고르지 않고 제출한 학생의 빈 칸({})도 원본 그대로 둬요
  });
}

function restoreCloserFriends(input, roster) {
  return byStudent(input, roster, (entry, sid) => {
    if (!isObject(entry)) return null;
    const ids = Array.isArray(entry.ids) ? [...new Set(entry.ids.map(String))].filter((id) => roster.has(id) && id !== sid) : [];
    const text = String(entry.text ?? '').trim().slice(0, IMPORT_LIMITS.reason);
    const review = String(entry.review ?? '').trim().slice(0, IMPORT_LIMITS.reason);
    const score = Number.isInteger(entry.score) && entry.score >= 1 && entry.score <= 5 ? entry.score : null;
    if (!ids.length && !text && !review && !score) return null;
    // 예전에 저장된 항목에는 한 달 소감 · 점수 칸이 없어요. 없던 칸은 만들지 않아야 AI 분석의 '입력이 바뀌었는지' 판단이 그대로예요
    const out = { ids, text };
    if ('review' in entry) out.review = review;
    if ('score' in entry) out.score = score;
    out.updatedAt = isoOrNull(entry.updatedAt);
    return out;
  });
}

function restoreRound(input, roster, usedIds) {
  if (!isObject(input)) throw fail(BROKEN);
  const name = cleanName(input.name).slice(0, IMPORT_LIMITS.roundName);
  if (!name) throw fail(BROKEN);
  const startedAt = isoOrNull(input.startedAt);
  if (!startedAt) throw fail(BROKEN);
  if (!safeId(input.id) || usedIds.has(input.id)) throw fail(BROKEN);
  usedIds.add(input.id);
  const round = {
    id: input.id, name, startedAt, closedAt: isoOrNull(input.closedAt),
    relations: restoreRelations(input.relations, roster),
    // 제출 기록: { submittedAt, firstSubmittedAt } (제출 시각을 읽을 수 없으면 제출하지 않은 것으로 봐요)
    submissions: byStudent(input.submissions, roster, (entry) => {
      const submittedAt = isoOrNull(isObject(entry) ? entry.submittedAt : null);
      if (!submittedAt) return null;
      const first = isoOrNull(entry.firstSubmittedAt);
      return first ? { submittedAt, firstSubmittedAt: first } : { submittedAt };
    }),
  };
  const closer = restoreCloserFriends(input.closerFriends, roster);
  if (Object.keys(closer).length) round.closerFriends = closer;
  // 성향 설문 · 역할 지원서: 학생별 객체만 (속 내용은 화면을 그려 보며 한 번 더 확인해요)
  for (const key of ['profiles', 'applications']) {
    const value = byStudent(input[key], roster, (v) => (isObject(v) ? v : null));
    if (Object.keys(value).length) round[key] = value;
  }
  // 역할 배정 · 자리표 · AI 분석 결과: 객체일 때만 그대로
  for (const key of ['roleAssignment', 'seating', 'aiAnalysis', 'aiSeating']) if (isObject(input[key])) round[key] = input[key];
  if (Array.isArray(input.seatingHistory)) round.seatingHistory = input.seatingHistory.filter(isObject);
  return round;
}

/**
 * 복원용 원본(backup)으로 새 교실을 만듭니다. 교실 id · 선생님 열쇠 · 학생 링크는 새로 발급해요.
 * @param {object} backup  export.json 의 backup ({ version, room })
 * @returns {object} 저장할 수 있는 교실
 */
export function restoreRoom(backup, { now = new Date(), name: nameOverride = '' } = {}) {
  if (!isObject(backup) || !isObject(backup.room)) throw fail('이 파일에는 복원용 자료가 없어요. 선생님 페이지에서 JSON 을 새로 내려받은 파일로 복원할 수 있어요.');
  if (backup.version !== BACKUP_VERSION) throw fail('이 파일은 지금 버전에서 복원할 수 없는 형식이에요.');
  assertSafeJson(backup);
  const src = backup.room;
  const nowIso = now.toISOString();

  const name = cleanName(nameOverride || src.name).slice(0, IMPORT_LIMITS.roomName);
  if (!name) throw fail(BROKEN);

  if (!Array.isArray(src.students) || src.students.length < 2) throw fail('파일에 학생이 2명 이상 있어야 복원할 수 있어요.');
  if (src.students.length > IMPORT_LIMITS.students) throw fail(`학생은 최대 ${IMPORT_LIMITS.students}명까지 가져올 수 있어요.`);
  const roster = new Set();
  const names = new Set();
  const students = src.students.map((s) => {
    if (!isObject(s) || !safeId(s.id) || roster.has(s.id)) throw fail(BROKEN);
    const studentName = cleanName(s.name);
    if (!studentName || studentName.length > IMPORT_LIMITS.studentName || names.has(studentName)) throw fail(BROKEN);
    roster.add(s.id);
    names.add(studentName);
    const student = { id: s.id, name: studentName, token: newToken(16), createdAt: isoOrNull(s.createdAt) || nowIso };
    if (isObject(s.body)) student.body = s.body;
    return student;
  });

  if (!Array.isArray(src.rounds) || !src.rounds.length) throw fail(BROKEN);
  if (src.rounds.length > IMPORT_LIMITS.rounds) throw fail(`회차는 최대 ${IMPORT_LIMITS.rounds}개까지 가져올 수 있어요.`);
  const roundIds = new Set();
  const rounds = src.rounds.map((r) => restoreRound(r, roster, roundIds));

  const clampMin = (v, fallback) => (Number.isInteger(v) && v >= 0 && v <= 10 ? v : fallback);
  const room = {
    id: newId(6),
    name,
    adminToken: newToken(24),
    createdAt: isoOrNull(src.createdAt) || nowIso,
    restoredAt: nowIso,
    minGood: clampMin(src.minGood, 3),
    minBad: clampMin(src.minBad, 1),
    students,
    rounds,
    currentRoundId: roundIds.has(src.currentRoundId) ? src.currentRoundId : rounds[rounds.length - 1].id,
  };
  if (Array.isArray(src.roles) && src.roles.length) room.roles = normalizeRoles(src.roles);
  if (Array.isArray(src.roleHistory)) room.roleHistory = src.roleHistory.filter(isObject);
  if (Array.isArray(src.groupActivities)) room.groupActivities = src.groupActivities.filter(isObject);
  if (Array.isArray(src.followups)) room.followups = src.followups.filter(isObject);
  if (isObject(src.teacherNotes)) {
    const seen = new Set();
    room.teacherNotes = {
      students: byStudent(src.teacherNotes.students, roster, (v) => {
        if (!isObject(v)) return null;
        const memo = String(v.memo ?? '').trim().slice(0, IMPORT_LIMITS.reason);
        const front = Boolean(v.front);
        return memo || front ? { memo, front } : null;
      }),
      rules: (Array.isArray(src.teacherNotes.rules) ? src.teacherNotes.rules : []).filter((r) => {
        if (!isObject(r) || !['apart', 'together'].includes(r.type) || !roster.has(r.a) || !roster.has(r.b) || r.a === r.b) return false;
        const key = [r.a, r.b].sort().join('|');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 100).map((r) => ({ type: r.type, a: r.a, b: r.b, note: String(r.note ?? '').trim().slice(0, 100) })),
      updatedAt: isoOrNull(src.teacherNotes.updatedAt) || nowIso,
    };
  }
  const reports = byStudent(src.studentReports, roster, (v) => (isObject(v) ? v : null));
  if (Object.keys(reports).length) room.studentReports = reports;
  return room;
}

/** 새 학년 교실에 함께 가져갈 1인 1역 역할 목록 (없으면 빈 배열). 역할 id 는 새로 붙여요. */
export function carriedRoles(input) {
  if (input === undefined || input === null) return [];
  return normalizeRoles(input).map((r) => ({ ...r, id: newId() }));
}
