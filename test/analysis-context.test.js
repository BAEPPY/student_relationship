import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureAnalysisContext, describeAnalysisContext } from '../server/analysis-context.js';
import { buildSeatingPrompt } from '../server/ai.js';
import { listRelations } from '../server/analysis.js';

const time = '2026-10-08T01:00:00.000Z';
function fixture() {
  const round = {
    id: 'october', name: '2026년 10월',
    submissions: { a: { submittedAt: time } },
    relations: { a: { b: { type: 'bad', reason: '함께 놀다 말다툼했어요', tags: ['fight'], updatedAt: time } } },
    profiles: { a: { traits: ['quiet'], partnerTraits: [], partnerText: '잘 듣는 친구', updatedAt: time } },
    applications: { a: { choices: [{ roleId: 'library', reason: '책을 함께 정리하고 싶어요' }], updatedAt: time } },
  };
  const room = {
    students: [{ id: 'a', name: '가학생', token: 'private-a' }, { id: 'b', name: '나학생', token: 'private-b' }],
    teacherNotes: { students: { a: { memo: '자리에서 관찰해 보기', front: true } }, rules: [{ a: 'a', b: 'b', type: 'apart', note: '교사 확인' }], updatedAt: time },
    roles: [{ id: 'library', name: '도서관 역할', slots: 1, description: '책 정리' }],
    roleHistory: [{ month: '2026년 9월', assignments: { library: ['b'] }, updatedAt: time }],
    rounds: [round],
  };
  return { room, round };
}
const capture = (room, round, options = {}) => captureAnalysisContext(room, round, { now: time, ...options });

test('제출 자료와 서버가 연결한 근거만 기록하고 원문·실명·토큰은 중복 저장하지 않는다', () => {
  const { room, round } = fixture();
  const context = capture(room, round);
  assert.deepEqual(context.coverage, { submitted: 1, total: 2, percent: 50, complete: false, missingStudentIds: ['b'] });
  assert.equal(context.sourceUpdatedAt, time);
  assert.ok(context.evidence.some((ref) => ref.id === 'relation:a:b' && ref.from === 'a' && ref.to === 'b' && ref.updatedAt === time));
  assert.deepEqual(new Set(context.evidence.map((ref) => ref.kind)), new Set(['submission', 'relation', 'profile', 'application', 'teacher-note', 'teacher-rule']));
  const json = JSON.stringify(context);
  for (const secret of ['private-a', 'private-b', '가학생', '나학생', '함께 놀다', '잘 듣는 친구', '자리에서 관찰']) assert.ok(!json.includes(secret));
});

test('임시 저장·링크 재발급·조회 시각은 분석 자료 변경으로 보지 않는다', () => {
  const { room, round } = fixture();
  const saved = capture(room, round);
  round.studentDrafts = { a: { revision: 9, updatedAt: '2026-10-09T01:00:00.000Z', sections: { relations: { b: { type: 'good', reason: '임시 글' } } } } };
  room.students[0].token = 'rotated-secret';
  room.adminToken = 'admin-secret';
  room.seating = { updatedAt: '2026-10-10T01:00:00.000Z' };
  const current = capture(room, round, { now: '2026-10-11T01:00:00.000Z' });
  assert.equal(current.fingerprint, saved.fingerprint);
  assert.equal(current.sourceUpdatedAt, time);
  assert.equal(describeAnalysisContext(saved, current).status, 'fresh');
});

test('실제 분석 입력의 수정은 모두 재분석 필요 상태로 바뀐다', () => {
  const changes = [
    ({ room }) => { room.students[0].name = '변경학생'; },
    ({ round }) => { round.relations.a.b.reason = '지금은 다른 상황이에요'; },
    ({ round }) => { round.submissions.b = { submittedAt: time }; },
    ({ round }) => { round.profiles.a.partnerText = '차분한 친구'; },
    ({ round }) => { round.applications.a.choices[0].reason = '이번 달에는 다른 일을 하고 싶어요'; },
    ({ room }) => { room.teacherNotes.students.a.memo = '수정한 관찰'; },
    ({ room }) => { room.teacherNotes.rules[0].type = 'together'; },
    ({ room }) => { room.roles[0].description = '책과 서가 정리'; },
    ({ room }) => { room.roleHistory[0].assignments.library = ['a']; },
  ];
  for (const change of changes) {
    const input = fixture();
    const saved = capture(input.room, input.round);
    change(input);
    assert.equal(describeAnalysisContext(saved, capture(input.room, input.round)).status, 'stale', change.toString());
  }
});

test('저장 순서가 다른 동일 객체와 교사 메모의 불필요한 재저장은 fingerprint를 바꾸지 않는다', () => {
  const { room, round } = fixture();
  const saved = capture(room, round);
  room.teacherNotes.students.a = { front: true, memo: '자리에서 관찰해 보기' };
  room.teacherNotes.updatedAt = '2026-10-10T01:00:00.000Z';
  round.relations.a.b = { updatedAt: time, tags: ['fight'], reason: '함께 놀다 말다툼했어요', type: 'bad' };
  assert.equal(capture(room, round).fingerprint, saved.fingerprint);
});

test('분석이 끝나기 전에 응답이 바뀌어도 저장해 둔 입력 기록은 원래 상태를 설명한다', () => {
  const { room, round } = fixture();
  const saved = capture(room, round);
  round.submissions.b = { submittedAt: '2026-10-08T01:01:00.000Z' };
  const view = describeAnalysisContext(saved, capture(room, round));
  assert.equal(view.status, 'stale');
  assert.equal(view.inputCoverage.complete, false);
  assert.equal(view.currentCoverage.complete, true);
  assert.equal(view.inputCoverage.submitted, 1);
  assert.equal(view.currentCoverage.submitted, 2);
  assert.equal(view.capturedAt, time);
});

test('메모와 규칙을 모두 삭제한 시각도 최근 응답·메모 기록에 포함한다', () => {
  const { room, round } = fixture();
  const saved = capture(room, round);
  room.teacherNotes = { students: {}, rules: [], updatedAt: '2026-10-09T01:00:00.000Z' };
  const current = capture(room, round);
  assert.equal(current.sourceUpdatedAt, room.teacherNotes.updatedAt);
  assert.equal(describeAnalysisContext(saved, current).status, 'stale');
  assert.ok(current.evidence.every((ref) => !ref.kind.startsWith('teacher-')));
});

test('이전 분석과 다른 회차·종류의 입력 기록은 최신 여부 확인 불가로 표시한다', () => {
  const { room, round } = fixture();
  const current = capture(room, round);
  for (const saved of [null, {}, { ...current, version: 0 }, { ...current, roundId: 'september' }, { ...current, kind: 'seating' }]) {
    const view = describeAnalysisContext(saved, current);
    assert.equal(view.status, 'unknown');
    assert.equal(view.changed, null);
    assert.equal(view.inputCoverage, null);
    assert.deepEqual(view.evidence, []);
  }
});

test('자리 분석은 몸 특징·역할 배정·이전 AI 내용·요청 설정도 변경 검사에 포함한다', () => {
  const input = fixture();
  input.round.aiAnalysis = { summary: '처음 분석', pairs: [{ a: 'a', b: 'b', riskLevel: 'high', analysis: '대화를 확인해 주세요' }], students: [] };
  input.round.roleAssignment = { assignments: { library: ['a'] } };
  const extra = { layout: { blocks: [{ rows: 1, cols: 2 }] }, options: { friend: 'near' } };
  const saved = capture(input.room, input.round, { kind: 'seating', extra });
  const relationSaved = capture(input.room, input.round);
  input.room.students[0].body = { sight: 'poor' };
  assert.equal(describeAnalysisContext(saved, capture(input.room, input.round, { kind: 'seating', extra })).status, 'stale');
  assert.equal(capture(input.room, input.round).fingerprint, relationSaved.fingerprint, '몸 특징은 관계 AI의 입력이 아님');
  delete input.room.students[0].body;
  input.round.roleAssignment.assignments.library = ['b'];
  assert.notEqual(capture(input.room, input.round, { kind: 'seating', extra }).fingerprint, saved.fingerprint);
  input.round.roleAssignment.assignments.library = ['a'];
  input.round.aiAnalysis.pairs[0].analysis = '달라진 분석';
  assert.notEqual(capture(input.room, input.round, { kind: 'seating', extra }).fingerprint, saved.fingerprint);
  input.round.aiAnalysis.pairs[0].analysis = '대화를 확인해 주세요';
  extra.layout.blocks[0].cols = 3;
  assert.notEqual(capture(input.room, input.round, { kind: 'seating', extra }).fingerprint, saved.fingerprint);
});

test('자리 프롬프트가 읽지 않는 지원서·역할 설명·공개 시각·개별 AI 조언은 재분석을 요구하지 않는다', () => {
  const { room, round } = fixture();
  round.roleAssignment = { assignments: { library: ['a'] }, publishedAt: null, updatedAt: time };
  round.aiAnalysis = {
    summary: '학급 요약', students: [{ id: 'a', summary: '개별 조언' }],
    pairs: Array.from({ length: 16 }, () => ({ a: 'a', b: 'b', riskLevel: 'high', conflictType: '말다툼', analysis: '대화를 확인해 주세요', probability: 70 })),
  };
  const extra = { layout: { blocks: [{ rows: 1, cols: 2 }] }, options: { friends: 'near' } };
  const prompt = () => buildSeatingPrompt({
    students: room.students, relations: listRelations({ students: room.students, relations: round.relations }),
    profiles: round.profiles, teacherNotes: room.teacherNotes, roles: room.roles,
    roleAssignment: round.roleAssignment.assignments, aiAnalysis: round.aiAnalysis, ...extra,
  }).user;
  const saved = capture(room, round, { kind: 'seating', extra });
  const relationshipSaved = capture(room, round);
  const originalPrompt = prompt();
  round.applications.a.choices[0].reason = '지원서만 변경';
  round.applications.a.updatedAt = '2026-10-09T01:00:00.000Z';
  room.roleHistory[0].assignments.library = ['a'];
  room.roles[0].description = '바뀐 역할 설명';
  room.roles[0].slots = 2;
  round.roleAssignment.publishedAt = '2026-10-09T01:00:00.000Z';
  round.roleAssignment.updatedAt = '2026-10-09T01:00:00.000Z';
  round.aiAnalysis.summary = '바뀐 학급 요약';
  round.aiAnalysis.students[0].summary = '바뀐 개별 조언';
  round.aiAnalysis.pairs[0].probability = 90;
  round.aiAnalysis.pairs[15].analysis = '프롬프트에 포함되지 않는 16번째 쌍';
  const current = capture(room, round, { kind: 'seating', extra });
  assert.equal(prompt(), originalPrompt);
  assert.equal(current.fingerprint, saved.fingerprint);
  assert.equal(current.sourceUpdatedAt, time, '자리 AI에 쓰지 않은 지원서 시각은 제외');
  assert.ok(current.evidence.every((ref) => ref.kind !== 'application'));
  assert.notEqual(capture(room, round).fingerprint, relationshipSaved.fingerprint, '관계 분석의 지원서·역할 입력 추적은 유지');
  for (const [key, value] of [['riskLevel', 'low'], ['conflictType', '새 갈등 성격'], ['analysis', '새 확인 내용']]) {
    const before = round.aiAnalysis.pairs[0][key];
    round.aiAnalysis.pairs[0][key] = value;
    assert.notEqual(prompt(), originalPrompt, key);
    assert.notEqual(capture(room, round, { kind: 'seating', extra }).fingerprint, saved.fingerprint, key);
    round.aiAnalysis.pairs[0][key] = before;
  }
});

test('AI provenance와 표시용 context 자체를 저장해도 자기 자신을 변경 자료로 세지 않는다', () => {
  const { room, round } = fixture();
  const saved = capture(room, round);
  round.aiAnalysis = { summary: '생성 결과', provenance: saved, context: describeAnalysisContext(saved, saved) };
  assert.equal(capture(room, round).fingerprint, saved.fingerprint);
  const seats = capture(room, round, { kind: 'seating' });
  round.aiAnalysis.context = { status: 'stale' };
  round.aiAnalysis.provenance = { fingerprint: 'different' };
  assert.equal(capture(room, round, { kind: 'seating' }).fingerprint, seats.fingerprint);
});

test('없는 학생의 제출은 제출률을 부풀리지 않고 빈 학급은 자료가 충분하지 않다', () => {
  const { room, round } = fixture();
  round.submissions.deleted = { submittedAt: time };
  assert.equal(capture(room, round).coverage.submitted, 1);
  assert.equal(capture({ ...room, students: [] }, round).coverage.complete, false);
});
