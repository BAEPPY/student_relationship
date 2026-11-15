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
export function captureAnalysisContext(room, round, { kind = 'relationships', extra = null, now = new Date().toISOString(), history = undefined, historyInFingerprint = false } = {}) {
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
  if (kind !== 'seating' && round.kind === 'intro') {
    for (const [from, targets] of Object.entries(sortedRecord(round.known, known))) {
      for (const [to, entry] of Object.entries(sortedRecord(targets, known))) evidence.push({ id: `known:${from}:${to}`, kind: 'known', studentIds: [from, to], from, to, updatedAt: at(entry?.updatedAt) });
    }
  }
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
    // 새 학기 첫 조사: 조사 종류와 '아는 사이' 표시도 분석 입력이에요 (평소 조사의 지문은 그대로)
    if (round.kind === 'intro') {
      snapshot.intro = true;
      snapshot.known = Object.fromEntries(Object.entries(sortedRecord(round.known, known)).map(([from, targets]) => [from, sortedRecord(targets, known)]));
    }
    // 지난 회차를 함께 읽은 분석은 그 회차들의 응답·돌아보기를 회차별 지문으로 따로 기록합니다 (아래 historyRounds).
    // 보관 기간이 지나 자동 삭제된 회차는 '바뀐 입력'이 아니라 비교에서 빠지고, 남아 있는 회차의 응답이 바뀌면 재분석 필요로 표시합니다.
    // historyInFingerprint 는 이 방식 전에 저장한(지난 회차를 전체 지문에 넣던) 분석과 비교할 때만 씁니다.
    if (Array.isArray(history)) {
      if (historyInFingerprint) snapshot.history = history.map((r) => historyRoundSnapshot(r, known));
      for (const r of history) evidence.push({ id: `history:${r.id}`, kind: 'history', studentIds: [], roundId: r.id, roundName: r.name, updatedAt: at(r.closedAt) });
    }
    snapshot.roles = roomRoles(room);
    snapshot.previousRoles = previousRoleIds(room, round);
  }
  return {
    version: 1, kind, roundId: round.id, fingerprint: fingerprint(snapshot), capturedAt: now,
    historyRoundIds: Array.isArray(history) && kind !== 'seating' ? history.map((r) => r.id) : undefined,   // 함께 읽은 지난 회차 (없으면 키 자체가 저장되지 않음)
    historyRounds: Array.isArray(history) && kind !== 'seating' && !historyInFingerprint ? history.map((r) => ({ id: r.id, name: r.name, fingerprint: fingerprint(historyRoundSnapshot(r, known)) })) : undefined,
    sourceUpdatedAt: timestamps.sort().at(-1) || null,
    coverage: { submitted, total, percent: total ? Math.round(submitted / total * 100) : 0, complete: total > 0 && submitted === total, missingStudentIds },
    evidence,
  };
}

/** Old analyses have unknown provenance; partial submission is distinct from whether inputs changed. */
/** 지난 회차 한 개의 지문 재료: 응답·제출자·돌아보기 (지금 명단에 있는 학생만) */
function historyRoundSnapshot(r, known) {
  return {
    id: r.id, name: r.name,
    submittedIds: (r.submittedIds || []).filter((id) => known.has(id)).sort(),
    relations: (r.relations || []).filter((x) => known.has(x.from) && known.has(x.to)).map(({ from, to, type, tags, reason, updatedAt }) => ({ from, to, type, tags: tags || [], reason: reason || '', updatedAt: updatedAt || null })).sort((a, b) => `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`)),
    closerFriends: sortedRecord(r.closerFriends, known),
  };
}

/** 함께 읽은 지난 회차 중 아직 남아 있는 회차의 응답이 바뀌었는지 (지워진 회차는 비교하지 않음) */
function historyChanged(saved, current) {
  if (!Array.isArray(saved?.historyRounds)) return false;
  const now = new Map((current.historyRounds || []).map((r) => [r.id, r.fingerprint]));
  return saved.historyRounds.some((r) => now.has(r.id) && now.get(r.id) !== r.fingerprint);
}

export function describeAnalysisContext(saved, current) {
  const verified = saved?.version === 1 && typeof saved.fingerprint === 'string' && saved.roundId === current.roundId && saved.kind === current.kind;
  const changed = verified ? saved.fingerprint !== current.fingerprint || historyChanged(saved, current) : null;
  return {
    status: !verified ? 'unknown' : changed ? 'stale' : 'fresh', changed,
    capturedAt: verified ? saved.capturedAt || null : null,
    sourceUpdatedAt: verified ? saved.sourceUpdatedAt || null : null,
    inputCoverage: verified ? saved.coverage : null,
    currentCoverage: current.coverage,
    evidence: verified && Array.isArray(saved.evidence) ? saved.evidence : [],
  };
}
