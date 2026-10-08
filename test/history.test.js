import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeHistory } from '../server/history.js';

const students = [
  { id: 'a', name: '가학생' }, { id: 'b', name: '나학생' },
  { id: 'c', name: '다학생' }, { id: 'd', name: '라학생' },
];
const bad = () => ({ type: 'bad', tags: ['tease'], reason: '테스트 응답' });
const good = () => ({ type: 'good', tags: [], reason: '' });
function round(id, relations, submitted) {
  return {
    id, name: id === 'previous' ? '이전 조사' : '이번 조사',
    startedAt: id === 'previous' ? '2026-09-01T00:00:00.000Z' : '2026-10-01T00:00:00.000Z', closedAt: null,
    relations, submissions: Object.fromEntries(submitted.map((sid) => [sid, { submittedAt: '2026-10-01T00:00:00.000Z' }])),
  };
}
const history = (previous, current) => analyzeHistory({ students, rounds: [previous, current], currentRoundId: 'current' });
const pairs = (entries) => entries.map((entry) => [entry.a, entry.b].sort().join(''));
const studentChange = (entries, id) => entries.find((entry) => entry.id === id);

test('이전 부정 응답자는 미제출이고 반대쪽만 제출했으면 해소를 보류한다', () => {
  const { changes } = history(
    round('previous', { a: { b: bad() } }, ['a', 'b']),
    round('current', { b: { a: good() } }, ['b']),
  );
  assert.deepEqual(changes.resolved, []);
  assert.deepEqual(pairs(changes.pending), ['ab']);
  const pending = changes.pending[0];
  assert.equal(pending.reasonCode, 'missing_current_response');
  assert.deepEqual(pending.missingStudentIds, ['a']);
  assert.deepEqual(pending.missingStudentNames, ['가학생']);
  assert.equal(pending.missingRoundId, 'current');
  assert.equal(pending.missingRoundName, '이번 조사');
  assert.match(pending.reason, /응답하지 않아 해소 판단을 보류/);
});

test('서로 부정 표시했던 쌍은 두 응답자 모두 이번에 제출해야 해소로 분류한다', () => {
  const previous = round('previous', { a: { b: bad() }, b: { a: bad() } }, ['a', 'b']);
  const partial = history(previous, round('current', {}, ['a'])).changes;
  assert.deepEqual(partial.resolved, []);
  assert.deepEqual(partial.pending[0].missingStudentIds, ['b']);
  const complete = history(previous, round('current', {}, ['a', 'b'])).changes;
  assert.deepEqual(pairs(complete.resolved), ['ab']);
  assert.deepEqual(complete.pending, []);
});

test('이전 부정 응답자 본인이 제출해 표시를 없앤 경우 반대쪽 미제출만으로 보류하지 않는다', () => {
  const { changes } = history(
    round('previous', { a: { b: bad() } }, ['a', 'b']),
    round('current', {}, ['a']),
  );
  assert.deepEqual(pairs(changes.resolved), ['ab']);
  assert.deepEqual(changes.pending, []);
});

test('이번에 아무도 제출하지 않았으면 이전 갈등마다 해소 대신 판단보류를 제공한다', () => {
  const { changes } = history(
    round('previous', { a: { b: bad() }, c: { d: bad() } }, ['a', 'c']),
    round('current', {}, []),
  );
  assert.deepEqual(changes.resolved, []);
  assert.deepEqual(pairs(changes.pending).sort(), ['ab', 'cd']);
  assert.deepEqual(changes.improved, []);
  assert.deepEqual(changes.worsened, []);
  assert.equal(changes.studentPending.length, students.length);
});

test('처음 응답한 학생의 부정 표시를 새로 생긴 갈등으로 단정하지 않는다', () => {
  const { changes } = history(
    round('previous', {}, ['b']),
    round('current', { a: { b: bad() } }, ['a', 'b']),
  );
  assert.deepEqual(changes.newConflicts, []);
  assert.deepEqual(pairs(changes.pending), ['ab']);
  assert.equal(changes.pending[0].reasonCode, 'missing_previous_response');
  assert.deepEqual(changes.pending[0].missingStudentIds, ['a']);
  assert.equal(changes.pending[0].missingRoundId, 'previous');
});

test('두 회차에 실제 부정 표시가 있으면 응답자가 바뀌어도 관측된 갈등은 계속으로 표시한다', () => {
  const { changes } = history(
    round('previous', { a: { b: bad() } }, ['a']),
    round('current', { b: { a: bad() } }, ['b']),
  );
  assert.deepEqual(pairs(changes.persistent), ['ab']);
  assert.deepEqual(changes.pending, []);
});

test('미제출로 받은 부정 표시가 줄어든 학생을 좋아짐 또는 고립 회복으로 표시하지 않는다', () => {
  const { changes, students: rows } = history(
    round('previous', { a: { b: bad() } }, ['a', 'c', 'd']),
    round('current', {}, ['c', 'd']),
  );
  assert.equal(rows.find((student) => student.id === 'b').rounds[0].flags.includes('isolated'), true);
  assert.equal(studentChange(changes.improved, 'b'), undefined);
  assert.equal(studentChange(changes.worsened, 'b'), undefined);
  const pending = studentChange(changes.studentPending, 'b');
  assert.equal(pending.reasonCode, 'response_cohort_changed');
  assert.deepEqual(pending.missingCurrentStudentIds, ['a']);
  assert.equal(pending.comparableRespondentCount, 2);
  assert.equal(pending.previousRespondentCount, 3);
  assert.equal(pending.currentRespondentCount, 2);
});

test('추가 제출로 좋은 표시가 늘어난 학생은 비교 응답자가 달라졌다는 보류 사유를 받는다', () => {
  const { changes } = history(
    round('previous', {}, ['c', 'd']),
    round('current', { a: { b: good() } }, ['a', 'c', 'd']),
  );
  assert.equal(studentChange(changes.improved, 'b'), undefined);
  const pending = studentChange(changes.studentPending, 'b');
  assert.deepEqual(pending.missingPreviousStudentIds, ['a']);
  assert.deepEqual(pending.missingStudentNames, ['가학생']);
});

test('좋은 표시를 했던 학생의 미제출을 악화나 새 고립으로 표시하지 않는다', () => {
  const { changes } = history(
    round('previous', { a: { b: good() }, c: { b: bad() } }, ['a', 'c', 'd']),
    round('current', { c: { b: bad() } }, ['c', 'd']),
  );
  assert.equal(studentChange(changes.worsened, 'b'), undefined);
  assert.ok(studentChange(changes.studentPending, 'b'));
});

test('제출자 수가 같아도 응답자가 바뀌면 학생 변화는 비교하지 않는다', () => {
  const { changes } = history(
    round('previous', { c: { b: good() } }, ['a', 'c']),
    round('current', { d: { b: bad() } }, ['a', 'd']),
  );
  const pending = studentChange(changes.studentPending, 'b');
  assert.equal(pending.previousRespondentCount, pending.currentRespondentCount);
  assert.deepEqual(pending.missingPreviousStudentIds, ['d']);
  assert.deepEqual(pending.missingCurrentStudentIds, ['c']);
  assert.equal(studentChange(changes.worsened, 'b'), undefined);
});

test('같은 응답자들의 실제 변화는 좋아짐·악화·고립 회복과 기존 필드로 반환한다', () => {
  const { changes } = history(
    round('previous', { a: { d: bad() }, b: { c: good() } }, ['a', 'b', 'c']),
    round('current', { a: { d: good() }, b: { c: bad() } }, ['a', 'b', 'c']),
  );
  assert.deepEqual(changes.pending, []);
  assert.deepEqual(changes.studentPending, []);
  assert.deepEqual(pairs(changes.resolved), ['ad']);
  assert.deepEqual(pairs(changes.newConflicts), ['bc']);
  const improved = studentChange(changes.improved, 'd');
  assert.equal(improved.inGoodDelta, 1);
  assert.equal(improved.inBadDelta, -1);
  assert.equal(improved.recovered, true);
  assert.equal(improved.comparableRespondentCount, 3);
  const worsened = studentChange(changes.worsened, 'c');
  assert.equal(worsened.inGoodDelta, -1);
  assert.equal(worsened.inBadDelta, 1);
  assert.equal(worsened.newlyIsolated, true);
  assert.equal(changes.comparison.method, 'same_respondents');
});

test('본인 제출로 고립 판단의 전체 제출 수 임계값만 넘어도 새 고립으로 분류하지 않는다', () => {
  const { changes, students: rows } = history(
    round('previous', { a: { b: bad() } }, ['a', 'c']),
    round('current', { a: { b: bad() } }, ['a', 'b', 'c']),
  );
  const b = rows.find((student) => student.id === 'b');
  assert.equal(b.rounds[0].flags.includes('isolated'), false);
  assert.equal(b.rounds[1].flags.includes('isolated'), true);
  assert.equal(studentChange(changes.worsened, 'b'), undefined);
  assert.equal(studentChange(changes.improved, 'b'), undefined);
  assert.equal(studentChange(changes.studentPending, 'b'), undefined, '받은 관계를 평가할 동료 응답자는 동일');
});

test('양쪽 회차 모두 동료 응답이 없으면 학생별 자료 부족을 명시한다', () => {
  const { changes } = history(round('previous', {}, []), round('current', {}, []));
  assert.equal(changes.studentPending.length, students.length);
  assert.ok(changes.studentPending.every((entry) => entry.reasonCode === 'no_comparable_responses'));
  assert.deepEqual(studentChange(changes.studentPending, 'a').missingStudentIds, ['b', 'c', 'd']);
  assert.deepEqual(changes.improved, []);
  assert.deepEqual(changes.worsened, []);
});

test('한 회차만 있으면 기존 changes:null 계약과 회차 통계를 유지한다', () => {
  const result = analyzeHistory({ students, rounds: [round('previous', {}, ['a'])] });
  assert.equal(result.changes, null);
  assert.equal(result.trend[0].submitted, 1);
  assert.equal(result.students.length, students.length);
});
