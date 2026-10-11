import { newId } from './tokens.js';

export const FOLLOWUP_LIMITS = { text: 2000, entries: 1000 };
const fail = (status, message, code, entry) => Object.assign(new Error(message), { status, code, ...(entry ? { entry: followupEntryView(entry) } : {}) });

export function followupToday(now = new Date()) {
  return new Date(new Date(now).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function validDate(value, label, optional = false) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw fail(400, `${label}을 날짜로 입력해 주세요.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw fail(400, `${label}이 올바르지 않아요.`);
  return value;
}

function text(value, label, required = false) {
  if (typeof value !== 'string') throw fail(400, `${label}을 글로 입력해 주세요.`);
  const clean = value.trim();
  if (required && !clean) throw fail(400, `${label}을 적어 주세요.`);
  if (clean.length > FOLLOWUP_LIMITS.text) throw fail(400, `${label}은 ${FOLLOWUP_LIMITS.text}자 이하로 적어 주세요.`);
  return clean;
}

export function validateFollowup(room, input, now = new Date()) {
  const ids = new Set((room.students || []).map((s) => s.id));
  if (!Array.isArray(input.studentIds) || !input.studentIds.length || input.studentIds.length > ids.size
      || input.studentIds.some((id) => typeof id !== 'string' || !ids.has(id))
      || new Set(input.studentIds).size !== input.studentIds.length) throw fail(400, '기록에 해당하는 학생을 한 명 이상 골라 주세요. 삭제된 학생은 선택할 수 없어요.');
  const observedDate = validDate(input.observedDate, '관찰·상담 날짜');
  if (observedDate > followupToday(now)) throw fail(400, '관찰·상담 날짜는 오늘 이후로 정할 수 없어요.');
  const nextCheckDate = validDate(input.nextCheckDate, '다음 확인일', true);
  if (nextCheckDate && nextCheckDate < observedDate) throw fail(400, '다음 확인일은 관찰·상담 날짜와 같거나 뒤여야 해요.');
  if (!['open', 'completed'].includes(input.status)) throw fail(400, '확인 상태가 올바르지 않아요.');
  return {
    studentIds: [...input.studentIds], observedDate,
    observation: text(input.observation, '관찰·상담 내용', true), action: text(input.action ?? '', '한 일·도움'),
    nextCheckDate, status: input.status,
  };
}

// Whitelist the response: room/student tokens and arbitrary input keys never become record data.
export function followupEntryView(entry) {
  return Object.fromEntries(['id', 'version', 'studentIds', 'observedDate', 'observation', 'action', 'nextCheckDate', 'status', 'createdAt', 'updatedAt', 'completedAt'].map((key) => [key, structuredClone(entry[key])]));
}

export function followupView(room, now = new Date()) {
  return {
    room: { name: room.name }, today: followupToday(now),
    students: (room.students || []).map(({ id, name }) => ({ id, name })),
    entries: (room.followups || []).map(followupEntryView).sort((a, b) => b.observedDate.localeCompare(a.observedDate) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)),
  };
}

export function createFollowup(room, input, now = new Date()) {
  const fields = validateFollowup(room, { status: 'open', ...input }, now);
  const mutationId = input.clientMutationId;
  if (mutationId !== undefined && (typeof mutationId !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(mutationId))) throw fail(400, '저장 요청 정보가 올바르지 않아요.');
  const existing = mutationId && (room.followups || []).find((entry) => entry.clientMutationId === mutationId);
  if (existing) {
    // A lost response can be retried without inserting the same private record twice.
    if (Object.entries(fields).every(([key, value]) => JSON.stringify(value) === JSON.stringify(existing[key]))) return followupEntryView(existing);
    throw fail(409, '앞선 저장 요청이 이미 처리되었어요. 저장된 기록과 지금 작성한 내용을 비교해 주세요.', 'FOLLOWUP_CONFLICT', existing);
  }
  if ((room.followups || []).length >= FOLLOWUP_LIMITS.entries) throw fail(400, '상담·관찰 기록은 1000개까지 보관할 수 있어요. 필요 없는 기록을 정리해 주세요.');
  const timestamp = new Date(now).toISOString();
  const entry = { id: newId(12), version: 1, ...fields, createdAt: timestamp, updatedAt: timestamp, completedAt: fields.status === 'completed' ? timestamp : null };
  if (mutationId) entry.clientMutationId = mutationId;
  (room.followups ||= []).push(entry);
  return followupEntryView(entry);
}

function expectedEntry(room, id, expectedVersion) {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw fail(400, '저장된 버전 정보가 필요해요. 기록을 다시 열어 주세요.');
  const entry = (room.followups || []).find((e) => e.id === id);
  if (!entry) throw fail(404, '다른 곳에서 삭제했거나 보관 기간이 끝난 기록이에요. 작성한 내용은 화면에 남아 있어요.', 'FOLLOWUP_REMOVED');
  if (entry.version !== expectedVersion) throw fail(409, '다른 창에서 이 기록을 바꿨어요. 최신 기록을 확인해 주세요. 작성한 내용은 그대로 남아 있어요.', 'FOLLOWUP_CONFLICT', entry);
  return entry;
}

export function updateFollowup(room, id, input, now = new Date()) {
  const entry = expectedEntry(room, id, input.expectedVersion);
  const fields = validateFollowup(room, { ...entry, ...input }, now);
  const timestamp = new Date(now).toISOString();
  Object.assign(entry, fields, { version: entry.version + 1, updatedAt: timestamp,
    completedAt: fields.status === 'completed' ? entry.completedAt || timestamp : null });
  return followupEntryView(entry);
}

export function deleteFollowup(room, id, expectedVersion) {
  expectedEntry(room, id, expectedVersion);
  room.followups = room.followups.filter((e) => e.id !== id);
}

export function followupSummary(room, now = new Date()) {
  const today = followupToday(now);
  const result = { today, overdue: [], dueToday: [], upcoming: [], unscheduled: [], openCount: 0 };
  for (const entry of room.followups || []) {
    if (entry.status !== 'open') continue;
    const item = { id: entry.id, version: entry.version, studentIds: [...entry.studentIds], observedDate: entry.observedDate, nextCheckDate: entry.nextCheckDate, observation: entry.observation.slice(0, 120) };
    const bucket = !entry.nextCheckDate ? 'unscheduled' : entry.nextCheckDate < today ? 'overdue' : entry.nextCheckDate === today ? 'dueToday' : 'upcoming';
    result[bucket].push(item);
    result.openCount++;
  }
  for (const key of ['overdue', 'dueToday', 'upcoming', 'unscheduled']) result[key].sort((a, b) => (a.nextCheckDate || a.observedDate).localeCompare(b.nextCheckDate || b.observedDate) || a.id.localeCompare(b.id));
  return result;
}

/** Keep references in private free text aligned with roster renames, including other students' records. */
export function renameStudentFollowups(room, student, oldName, newName, now = new Date()) {
  if (!student?.id || typeof oldName !== 'string' || !oldName || typeof newName !== 'string' || !newName || oldName === newName) return 0;
  let changed = 0;
  for (const entry of room.followups || []) {
    const observation = entry.observation.split(oldName).join(newName);
    const action = entry.action.split(oldName).join(newName);
    if (observation === entry.observation && action === entry.action) continue;
    Object.assign(entry, { observation, action, version: entry.version + 1, updatedAt: new Date(now).toISOString() });
    changed++;
  }
  return changed;
}

/** Deletion is deliberately conservative: free text may identify a removed student too. */
export function removeStudentFollowups(room, student) {
  const before = room.followups || [];
  const name = String(student.name || '').trim();
  const keep = before.filter((entry) => !entry.studentIds.includes(student.id)
    && !(name && `${entry.observation}\n${entry.action}`.includes(name)));
  if (keep.length !== before.length) room.followups = keep;
  return before.length - keep.length;
}

/** Due dates do not extend retention; only an actual saved edit does. */
export function pruneFollowups(room, cutoff) {
  const limit = new Date(cutoff).getTime();
  if (!Number.isFinite(limit)) throw new TypeError('Invalid follow-up retention cutoff');
  const before = room.followups || [];
  const keep = before.filter((entry) => {
    const updated = new Date(entry.updatedAt || entry.createdAt).getTime();
    return Number.isFinite(updated) && updated >= limit;
  });
  if (keep.length !== before.length) room.followups = keep;
  return before.length - keep.length;
}
