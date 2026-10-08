import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFollowup, updateFollowup, deleteFollowup, validateFollowup, followupSummary, followupToday, followupView, renameStudentFollowups, removeStudentFollowups, pruneFollowups } from '../server/followups.js';

const now = new Date('2026-10-08T15:00:00.000Z'); // Oct 9 in Korea
const classroom = () => ({ name: '상담반', adminToken: 'ADMIN_SECRET', students: [{ id: 'a', name: '가람', token: 'STUDENT_SECRET' }, { id: 'b', name: '나래' }, { id: 'c', name: '다온' }] });
const fields = (extra = {}) => ({ studentIds: ['a'], observedDate: '2026-10-08', observation: '쉬는 시간에 이야기를 들음', action: '다음 주 다시 만나기로 함', nextCheckDate: '2026-10-09', status: 'open', ...extra });
const errorStatus = (fn, status) => assert.throws(fn, (error) => error.status === status);

test('실제 달력 날짜, 한국 오늘, 학생 범위, 텍스트 길이를 검증한다', () => {
  const room = classroom();
  assert.equal(followupToday(now), '2026-10-09');
  assert.equal(validateFollowup(room, fields({ observedDate: '2024-02-29' }), now).observedDate, '2024-02-29');
  for (const observedDate of ['2026-02-29', '2026-04-31', '2026-2-01', 'bad', '2026-10-10']) errorStatus(() => validateFollowup(room, fields({ observedDate }), now), 400);
  for (const studentIds of [[], ['a', 'a'], ['other-room-student'], ['a', null]]) errorStatus(() => validateFollowup(room, fields({ studentIds }), now), 400);
  errorStatus(() => validateFollowup(room, fields({ nextCheckDate: '2026-10-07' }), now), 400);
  errorStatus(() => validateFollowup(room, fields({ observation: ' ' }), now), 400);
  errorStatus(() => validateFollowup(room, fields({ observation: '글'.repeat(2001) }), now), 400);
  errorStatus(() => validateFollowup(room, fields({ action: {} }), now), 400);
  errorStatus(() => validateFollowup(room, fields({ status: 'done' }), now), 400);
  assert.equal(validateFollowup(room, fields({ nextCheckDate: '' }), now).nextCheckDate, null);
});

test('완료·재개·수정·삭제는 버전을 지키고 충돌한 변경은 저장하지 않는다', () => {
  const room = classroom();
  const first = createFollowup(room, fields(), now);
  const completed = updateFollowup(room, first.id, { expectedVersion: 1, status: 'completed' }, '2026-10-09T01:00:00.000Z');
  assert.equal(completed.version, 2);
  assert.equal(completed.observation, first.observation);
  assert.equal(completed.completedAt, '2026-10-09T01:00:00.000Z');
  const before = structuredClone(room);
  assert.throws(() => updateFollowup(room, first.id, { expectedVersion: 1, observation: '덮어쓸 옛 내용' }, now), (error) => error.status === 409 && error.code === 'FOLLOWUP_CONFLICT' && error.entry.version === 2);
  errorStatus(() => deleteFollowup(room, first.id, 1), 409);
  assert.deepEqual(room, before);
  const reopened = updateFollowup(room, first.id, { expectedVersion: 2, status: 'open' }, now);
  assert.equal(reopened.completedAt, null);
  assert.equal(reopened.version, 3);
  errorStatus(() => updateFollowup(room, first.id, { expectedVersion: '3', status: 'completed' }, now), 400);
  deleteFollowup(room, first.id, 3);
  assert.equal(room.followups.length, 0);
  errorStatus(() => updateFollowup(room, first.id, { expectedVersion: 3, status: 'completed' }, now), 404);
});

test('저장 응답을 받지 못해 재시도해도 중복 기록을 만들지 않는다', () => {
  const room = classroom();
  const input = fields({ clientMutationId: 'retry_0123456789abcdef' });
  const first = createFollowup(room, input, now);
  assert.deepEqual(createFollowup(room, input, now), first);
  assert.equal(room.followups.length, 1);
  assert.throws(() => createFollowup(room, { ...input, observation: '응답 유실 뒤 더 적은 내용' }, now), (error) => error.status === 409 && error.entry.id === first.id);
  assert.equal(room.followups[0].observation, first.observation);
  assert.equal(room.followups.length, 1);
});

test('오늘·기한 지남·예정·날짜 미정은 한국 날짜로 분류하고 완료 기록은 제외한다', () => {
  const room = classroom();
  for (const nextCheckDate of ['2026-10-08', '2026-10-09', '2026-10-11', null]) createFollowup(room, fields({ nextCheckDate }), now);
  createFollowup(room, fields({ nextCheckDate: '2026-10-08', status: 'completed' }), now);
  const result = followupSummary(room, now);
  assert.equal(result.openCount, 4);
  assert.equal(result.overdue.length, 1);
  assert.equal(result.dueToday.length, 1);
  assert.equal(result.upcoming.length, 1);
  assert.equal(result.unscheduled.length, 1);
  assert.equal(followupSummary(room, '2026-10-08T14:59:59.000Z').overdue.length, 0);
});

test('응답은 토큰과 임의 속성을 제거하고 외부 변경으로 저장 자료가 바뀌지 않는다', () => {
  const room = classroom();
  createFollowup(room, fields({ studentToken: 'NO_INPUT', arbitrary: 'NO_INPUT' }), now);
  room.followups[0].adminToken = 'NO_INTERNAL';
  const view = followupView(room, now);
  assert.doesNotMatch(JSON.stringify(view), /SECRET|NO_INPUT|NO_INTERNAL/);
  view.entries[0].studentIds.push('b');
  assert.deepEqual(room.followups[0].studentIds, ['a']);
  assert.deepEqual(Object.keys(view.students[0]).sort(), ['id', 'name']);
});

test('학생 삭제는 연결된 기록과 자유 문장 속 이름까지 제거한다', () => {
  const room = classroom();
  createFollowup(room, fields({ studentIds: ['a', 'b'] }), now);
  createFollowup(room, fields({ studentIds: ['b'], observation: '가람과 함께 활동함' }), now);
  createFollowup(room, fields({ studentIds: ['c'], action: '가람에게 확인' }), now);
  const keep = createFollowup(room, fields({ studentIds: ['b'], observation: '혼자 상담함' }), now);
  assert.equal(removeStudentFollowups(room, room.students[0]), 3);
  assert.deepEqual(room.followups.map((entry) => entry.id), [keep.id]);
  assert.equal(removeStudentFollowups(room, room.students[0]), 0);
});

test('이름을 바꾼 뒤 삭제해도 다른 학생 기록 속 옛 이름이 남지 않으며 오래된 수정은 거절한다', () => {
  const room = classroom();
  const entry = createFollowup(room, fields({ studentIds: ['b'], observation: '가람과 함께 이야기함. 가람의 이야기도 들음.', action: '가람에게 다음 시간 확인' }), now);
  const untouched = createFollowup(room, fields({ studentIds: ['c'], observation: '자기 생각을 이야기함' }), now);
  const renamedAt = '2026-10-10T00:00:00.000Z';
  room.students[0].name = '가람새이름';
  assert.equal(renameStudentFollowups(room, room.students[0], '가람', '가람새이름', renamedAt), 1);
  const changed = room.followups.find((record) => record.id === entry.id);
  assert.equal(changed.observation, '가람새이름과 함께 이야기함. 가람새이름의 이야기도 들음.');
  assert.equal(changed.action, '가람새이름에게 다음 시간 확인');
  assert.equal(changed.version, entry.version + 1);
  assert.equal(changed.updatedAt, renamedAt);
  assert.equal(room.followups.find((record) => record.id === untouched.id).version, untouched.version);
  errorStatus(() => updateFollowup(room, entry.id, { expectedVersion: entry.version, observation: '가람의 옛 이름을 다시 저장' }, renamedAt), 409);
  errorStatus(() => deleteFollowup(room, entry.id, entry.version), 409);
  assert.equal(removeStudentFollowups(room, room.students[0]), 1);
  assert.deepEqual(room.followups.map((record) => record.id), [untouched.id]);
});

test('보관 기간은 수정일 기준이며 미래 확인일로 연장하지 않는다', () => {
  const room = classroom();
  createFollowup(room, fields({ observedDate: '2024-01-01', nextCheckDate: '2030-01-01' }), '2024-01-01T00:00:00.000Z');
  const current = createFollowup(room, fields(), now);
  assert.equal(pruneFollowups(room, '2025-08-09T00:00:00.000Z'), 1);
  assert.deepEqual(room.followups.map((entry) => entry.id), [current.id]);
  assert.equal(pruneFollowups(room, now), 0); // exact cutoff retained
});
