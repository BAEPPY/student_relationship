import { newId } from './tokens.js';
import { createHash } from 'node:crypto';

export const SEATING_HISTORY_LIMIT = 10;
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function legacyRoundId(room, fallbackRound = null) {
  if (room.seating?.roundId) return room.seating.roundId;
  return room.currentRoundId || room.rounds?.at(-1)?.id || fallbackRound?.id || null;
}

function historyEntry(round, seating, { label = '', source = 'manual', sourceHistoryId = null } = {}) {
  return { id: seating.versionId, roundId: round.id, savedAt: seating.updatedAt,
    label: String(label || '').trim().slice(0, 80), source, sourceHistoryId, seating: clone(seating) };
}

/** Lazy one-time migration. A legacy seat plan belongs to one round only. */
export function ensureSeatingHistory(room) {
  const rounds = Array.isArray(room.rounds) ? room.rounds : [];
  if (!rounds.length) return room;
  if (own(room, 'seating')) {
    const target = rounds.find((round) => round.id === legacyRoundId(room));
    if (room.seating && target && !target.seating) target.seating = clone(room.seating);
    delete room.seating; // never migrate the same plan into a later newly-created round
  }
  for (const round of rounds) {
    if (round.seating) {
      round.seating.roundId = round.id;
      round.seating.updatedAt ||= round.startedAt || room.createdAt || null;
      // PG can migrate separate read copies before a write persists: their CAS version must agree.
      round.seating.versionId ||= `legacy-${createHash('sha256').update(JSON.stringify(stable(round.seating))).digest('hex').slice(0, 24)}`;
    }
    if (!Array.isArray(round.seatingHistory)) round.seatingHistory = [];
    if (round.seating && !round.seatingHistory.length) {
      round.seatingHistory.push(historyEntry(round, round.seating, { label: '이전 저장안', source: 'legacy' }));
    }
    round.seatingHistory = round.seatingHistory.slice(0, SEATING_HISTORY_LIMIT);
  }
  return room;
}

/** Read-only projection, also works with unmigrated single-round report fixtures. */
export function seatingView(room, round) {
  const seating = own(round, 'seating') ? round.seating :
    legacyRoundId(room, round) === round.id ? room.seating : null;
  return { seating: clone(seating || null), seatingHistory: clone(round.seatingHistory || []) };
}

/** The caller validates layout/roster and checks expectedVersionId before saving. */
export function saveRoundSeating(room, round, parsed, { now = new Date().toISOString(), label = '', source = 'manual',
  sourceHistoryId = null, inputRevision = null, id = newId() } = {}) {
  ensureSeatingHistory(room);
  if (sourceHistoryId && !round.seatingHistory.some((entry) => entry.id === sourceHistoryId)) {
    throw new Error('복원할 자리표가 이 회차의 최근 이력에 없어요. 새로 확인해 주세요.');
  }
  const seating = { ...clone(parsed), roundId: round.id, updatedAt: now, versionId: id, inputRevision };
  round.seating = seating;
  const entry = historyEntry(round, seating, { label, source, sourceHistoryId });
  round.seatingHistory = [entry, ...(round.seatingHistory || [])].slice(0, SEATING_HISTORY_LIMIT);
  return clone(seating);
}

/** Visit every independent saved copy for student/role removal and retention maintenance. */
export function walkSeatings(room, visitor) {
  ensureSeatingHistory(room);
  for (const round of room.rounds || []) {
    if (round.seating) visitor(round.seating, round, null);
    for (const entry of round.seatingHistory || []) if (entry.seating) visitor(entry.seating, round, entry);
  }
}

export function removeStudentSeating(room, studentId) {
  walkSeatings(room, (seating) => {
    const removed = new Set();
    for (const [seatId, sid] of Object.entries(seating.seats || {})) {
      if (sid === studentId) { delete seating.seats[seatId]; removed.add(seatId); }
    }
    if (Array.isArray(seating.pinned)) seating.pinned = seating.pinned.filter((seatId) => !removed.has(seatId));
  });
}
