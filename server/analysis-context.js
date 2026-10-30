import { createHash } from 'node:crypto';
import { listRelations } from './analysis.js';
import { previousRoleIds, roomRoles } from './roles.js';

// Fingerprints describe committed inputs, never private drafts, access tokens, or model-authored citations.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key])]));
  return value;
}
const fingerprint = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const sortedRecord = (record, known) => Object.fromEntries(Object.entries(record || {}).filter(([id]) => known.has(id)).sort(([a], [b]) => a.localeCompare(b)));

/** Capture before calling AI. The saved context contains references, not duplicate student writing. */
export function captureAnalysisContext(room, round, { kind = 'relationships', extra = null, now = new Date().toISOString(), history = undefined } = {}) {
  const known = new Set(room.students.map((student) => student.id));
  const students = room.students.map((student) => ({ id: student.id, name: student.name, ...(kind === 'seating' ? { body: student.body || {} } : {}) }));
  const relations = listRelations({ students, relations: round.relations || {} }).sort((a, b) => `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`));
  const profiles = sortedRecord(round.profiles, known);
  const applications = sortedRecord(round.applications, known);
  const closerFriends = sortedRecord(round.closerFriends, known);   // 이번 달 친해진 친구 (관계 분석 프롬프트에만 들어감)
  const submissions = sortedRecord(round.submissions, known);
  const teacherNotes = {
    students: sortedRecord(room.teacherNotes?.students, known),
    rules: (room.teacherNotes?.rules || []).filter((rule) => known.has(rule.a) && known.has(rule.b)),
  };
  const evidence = [];
  const timestamps = [];
  const at = (timestamp) => {
    if (typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp))) timestamps.push(new Date(timestamp).toISOString());
    return timestamp || null;
  };
  at(room.teacherNotes?.updatedAt); // 메모·규칙을 모두 지운 저장도 기록 시각에 반영합니다.
  for (const [id, submission] of Object.entries(submissions)) {
    evidence.push({ id: `submission:${id}`, kind: 'submission', studentIds: [id], updatedAt: at(submission.submittedAt) });
  }
  for (const relation of relations) evidence.push({ id: `relation:${relation.from}:${relation.to}`, kind: 'relation', studentIds: [relation.from, relation.to], from: relation.from, to: relation.to, updatedAt: at(relation.updatedAt) });
  for (const [id, profile] of Object.entries(profiles)) evidence.push({ id: `profile:${id}`, kind: 'profile', studentIds: [id], updatedAt: at(profile.updatedAt) });
  if (kind !== 'seating') for (const [id, application] of Object.entries(applications)) evidence.push({ id: `application:${id}`, kind: 'application', studentIds: [id], updatedAt: at(application.updatedAt) });
  if (kind !== 'seating') for (const [id, entry] of Object.entries(closerFriends)) evidence.push({ id: `closer-friends:${id}`, kind: 'closer-friends', studentIds: [id, ...(entry.ids || []).filter((other) => known.has(other))], updatedAt: at(entry.updatedAt) });
  for (const id of Object.keys(teacherNotes.students)) evidence.push({ id: `teacher-note:${id}`, kind: 'teacher-note', studentIds: [id], updatedAt: at(room.teacherNotes?.updatedAt) });
  for (const rule of teacherNotes.rules) evidence.push({ id: `teacher-rule:${rule.a}:${rule.b}`, kind: 'teacher-rule', studentIds: [rule.a, rule.b], updatedAt: at(room.teacherNotes?.updatedAt) });
  const missingStudentIds = students.filter((student) => !submissions[student.id]).map((student) => student.id);
  const total = students.length;
  const submitted = total - missingStudentIds.length;
  const snapshot = { version: 1, kind, roundId: round.id, students, relations, submissions, profiles, teacherNotes };
  if (kind === 'seating') {
    snapshot.roles = roomRoles(room).map(({ id, name }) => ({ id, name }));
    snapshot.roleAssignment = round.roleAssignment?.assignments || {};
    // Match aiAnalysisLines: only these fields from valid pairs among the first 15 enter the seating prompt.
    // Publication metadata, applications, prior role history and individual AI role advice do not.
    snapshot.aiAnalysis = {
      pairs: (Array.isArray(round.aiAnalysis?.pairs) ? round.aiAnalysis.pairs : []).slice(0, 15)
        .filter((pair) => known.has(pair.a) && known.has(pair.b))
        .map(({ a, b, riskLevel, conflictType, analysis }) => ({ a, b, riskLevel, conflictType, analysis })),
    };
    snapshot.inputConfig = extra;
  } else {
    snapshot.applications = applications;
    if (Object.keys(closerFriends).length) snapshot.closerFriends = closerFriends;
    // 지난 회차를 함께 읽은 분석은 그 회차들의 응답·돌아보기도 지문에 넣어, 지난 회차가 바뀌거나 지워지면 재분석 필요로 표시합니다
    if (Array.isArray(history)) {
      snapshot.history = history.map((r) => ({
        id: r.id, name: r.name,
        submittedIds: (r.submittedIds || []).filter((id) => known.has(id)).sort(),
        relations: (r.relations || []).filter((x) => known.has(x.from) && known.has(x.to)).map(({ from, to, type, tags, reason, updatedAt }) => ({ from, to, type, tags: tags || [], reason: reason || '', updatedAt: updatedAt || null })).sort((a, b) => `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`)),
        closerFriends: sortedRecord(r.closerFriends, known),
      }));
      for (const r of history) evidence.push({ id: `history:${r.id}`, kind: 'history', studentIds: [], roundId: r.id, roundName: r.name, updatedAt: at(r.closedAt) });
    }   // 비어 있으면 넣지 않아 이 기능 전에 저장한 분석의 지문이 그대로 유지돼요
    snapshot.roles = roomRoles(room);
    snapshot.previousRoles = previousRoleIds(room, round);
  }
  return {
    version: 1, kind, roundId: round.id, fingerprint: fingerprint(snapshot), capturedAt: now,
    historyRoundIds: Array.isArray(history) && kind !== 'seating' ? history.map((r) => r.id) : undefined,   // 함께 읽은 지난 회차 (없으면 키 자체가 저장되지 않음)
    sourceUpdatedAt: timestamps.sort().at(-1) || null,
    coverage: { submitted, total, percent: total ? Math.round(submitted / total * 100) : 0, complete: total > 0 && submitted === total, missingStudentIds },
    evidence,
  };
}

/** Old analyses have unknown provenance; partial submission is distinct from whether inputs changed. */
export function describeAnalysisContext(saved, current) {
  const verified = saved?.version === 1 && typeof saved.fingerprint === 'string' && saved.roundId === current.roundId && saved.kind === current.kind;
  const changed = verified ? saved.fingerprint !== current.fingerprint : null;
  return {
    status: !verified ? 'unknown' : changed ? 'stale' : 'fresh', changed,
    capturedAt: verified ? saved.capturedAt || null : null,
    sourceUpdatedAt: verified ? saved.sourceUpdatedAt || null : null,
    inputCoverage: verified ? saved.coverage : null,
    currentCoverage: current.coverage,
    evidence: verified && Array.isArray(saved.evidence) ? saved.evidence : [],
  };
}
