import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewGroups, validateGroupActivity, createGroupActivity, updateGroupActivity, deleteGroupActivity, removeStudentGroups, renameStudentGroups, pruneGroupActivities, groupMetrics } from '../server/groups.js';

const now = '2026-10-08T00:00:00.000Z';
function fixture(count = 12) {
  return { students: Array.from({ length: count }, (_, i) => ({ id: `s${i}`, name: `학생${i}`, token: `secret-${i}` })), teacherNotes: { rules: [] }, rounds: [{ id: 'r1' }], groupActivities: [] };
}
const options = (changes = {}) => ({ title: '과학 실험', activityDate: '2026-10-08', roundId: 'r1', groupSize: 4, avoidRepeats: true, absentIds: [], apartPairs: [], ...changes });
function assertValid(room, activity) {
  assert.ok(activity);
  assert.doesNotThrow(() => validateGroupActivity(room, activity));
  const flat = activity.groups.flatMap((group) => group.studentIds);
  assert.equal(new Set(flat).size, flat.length);
  const expected = room.students.filter(({ id }) => !activity.absentIds.includes(id)).map(({ id }) => id).sort();
  assert.deepEqual([...flat].sort(), expected);
  const sizes = activity.groups.map((group) => group.studentIds.length);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1);
  for (const { a, b } of activity.apartPairs) assert.ok(activity.groups.every((group) => !(group.studentIds.includes(a) && group.studentIds.includes(b))));
}

test('짝부터 8명 모둠까지 중복·누락 없이 균형 있게 편성한다', () => {
  for (const count of [2, 3, 5, 13, 28, 80]) for (const groupSize of [2, 3, 4, 8]) {
    const room = fixture(count);
    const result = previewGroups(room, options({ groupSize }), { seed: 20 });
    assertValid(room, result.candidate);
    assert.equal(result.candidate.groups.length, Math.ceil(count / groupSize));
    assert.ok(result.candidate.groups.every((group) => group.studentIds.length <= groupSize));
  }
});

test('결석자는 제외하고 기존 교사 규칙과 활동별 추가 분리를 모두 지킨다', () => {
  const room = fixture(15);
  room.teacherNotes.rules = [{ a: 's0', b: 's1', type: 'apart', note: '비공개 사유' }, { a: 's0', b: 's2', type: 'together' }];
  const result = previewGroups(room, options({ absentIds: ['s14', 's13'], apartPairs: [{ a: 's2', b: 's3' }, { a: 's13', b: 's0' }] }));
  assertValid(room, result.candidate);
  assert.equal(result.metrics.participants, 13);
  assert.ok(result.candidate.apartPairs.some(({ a, b }) => a === 's0' && b === 's1'));
  assert.ok(!JSON.stringify(result).includes('비공개 사유'));
  assert.ok(!JSON.stringify(result).includes('secret-'));
});

test('고정 seed로 재현하고 미리보기는 저장 자료를 수정하지 않는다', () => {
  const room = fixture(20), before = JSON.stringify(room);
  assert.deepEqual(previewGroups(room, options(), { seed: 123 }), previewGroups(room, options(), { seed: 123 }));
  assert.equal(JSON.stringify(room), before);
});

test('모든 학생을 분리해야 하지만 모둠 수가 적으면 조건을 어기지 않고 후보 없음을 반환한다', () => {
  const room = fixture(5);
  const apartPairs = room.students.flatMap((a, i) => room.students.slice(i + 1).map((b) => ({ a: a.id, b: b.id })));
  const result = previewGroups(room, options({ groupSize: 2, apartPairs }));
  assert.equal(result.candidate, null);
  assert.match(result.warnings[0], /찾지 못했어요/);
  assert.ok(result.searched <= 24 * 5001);
});

test('한 명이 생기는 홀수 짝 편성은 명확히 알린다', () => {
  const result = previewGroups(fixture(5), options({ groupSize: 2 }));
  assert.match(result.warnings.join(' '), /1명인 모둠/);
});

test('반복 회피는 과거에 함께한 짝을 피하고 자기 활동 수정·미래 활동은 제외한다', () => {
  const room = fixture(8);
  const original = createGroupActivity(room, previewGroups(room, options({ groupSize: 2, avoidRepeats: false })).candidate, { now, id: 'old' });
  const rotated = previewGroups(room, options({ groupSize: 2 }), { seed: 17 });
  assertValid(room, rotated.candidate);
  assert.equal(rotated.metrics.repeatedPairs, 0);
  assert.equal(groupMetrics(room, original).repeatedPairs, 4);
  assert.equal(groupMetrics(room, original, 'old').repeatedPairs, 0);
  room.groupActivities[0].activityDate = '2026-10-09';
  assert.equal(groupMetrics(room, original).repeatedPairs, 0);
});

test('분리 규칙상 같은 짝밖에 가능하지 않으면 반복을 허용하고 그 수를 알린다', () => {
  const room = fixture(4);
  const apartPairs = [{ a: 's0', b: 's2' }, { a: 's0', b: 's3' }, { a: 's1', b: 's2' }, { a: 's1', b: 's3' }];
  createGroupActivity(room, previewGroups(room, options({ groupSize: 2, apartPairs })).candidate, { now });
  const result = previewGroups(room, options({ groupSize: 2, apartPairs }));
  assertValid(room, result.candidate);
  assert.equal(result.metrics.repeatedPairs, 2);
  assert.match(result.warnings.join(' '), /2쌍/);
});

test('80명과 분리 조건·이전 구성에서도 제한 시간 안에 유효한 후보를 만든다', () => {
  const room = fixture(80);
  for (let i = 0; i < 40; i++) room.teacherNotes.rules.push({ a: `s${i}`, b: `s${i + 40}`, type: 'apart' });
  createGroupActivity(room, previewGroups(room, options({ groupSize: 8 }), { seed: 11 }).candidate, { now });
  const start = performance.now();
  const result = previewGroups(room, options({ groupSize: 8 }), { seed: 55 });
  assertValid(room, result.candidate);
  assert.ok(performance.now() - start < 2500, '80명 편성은 2.5초 안에 완료');
});

test('수동 이동은 균형 인원과 분리 규칙을 지켜야 하고 누락·중복·초과는 저장하지 않는다', () => {
  const room = fixture(7);
  const activity = previewGroups(room, options()).candidate;
  const [large, small] = [...activity.groups].sort((a, b) => b.studentIds.length - a.studentIds.length);
  const moved = structuredClone(activity);
  moved.groups.find(({ id }) => id === small.id).studentIds.push(moved.groups.find(({ id }) => id === large.id).studentIds.pop());
  assertValid(room, validateGroupActivity(room, moved));
  const duplicate = structuredClone(activity); duplicate.groups[1].studentIds[0] = duplicate.groups[0].studentIds[0];
  assert.throws(() => validateGroupActivity(room, duplicate), /두 번/);
  const missing = structuredClone(activity); missing.groups[0].studentIds.pop();
  assert.throws(() => validateGroupActivity(room, missing), /배정되지/);
  const apart = { ...activity, apartPairs: [{ a: activity.groups[0].studentIds[0], b: activity.groups[0].studentIds[1] }] };
  assert.throws(() => validateGroupActivity(room, apart), /반드시 분리/);
  const absent = { ...activity, absentIds: [activity.groups[0].studentIds[0]] };
  assert.throws(() => validateGroupActivity(room, absent), /빠지는 학생/);
  const over = structuredClone(activity); over.groups[0].studentIds.push(over.groups[1].studentIds.pop());
  assert.throws(() => validateGroupActivity(room, over), /최대 인원/);
});

test('서버는 후보 생성 후 바뀐 명단과 추가된 교사 규칙을 저장 시 다시 검증한다', () => {
  const room = fixture(8), candidate = previewGroups(room, options()).candidate;
  room.teacherNotes.rules.push({ a: candidate.groups[0].studentIds[0], b: candidate.groups[0].studentIds[1], type: 'apart' });
  assert.throws(() => createGroupActivity(room, candidate), /반드시 분리/);
  room.teacherNotes.rules = [];
  room.students.push({ id: 'new', name: '새학생' });
  assert.throws(() => createGroupActivity(room, candidate), /모둠|배정되지/);
});

test('잘못된 날짜·정원·회차·결석자·분리 쌍을 거부한다', () => {
  const room = fixture(5);
  for (const patch of [{ activityDate: '2026-02-30' }, { title: '' }, { groupSize: 1 }, { groupSize: 3.5 }, { roundId: '' }, { absentIds: ['s0', 's0'] }, { absentIds: ['unknown'] }, { apartPairs: [{ a: 's0', b: 's0' }] }, { absentIds: ['s0', 's1', 's2', 's3'] }]) {
    assert.throws(() => previewGroups(room, options(patch)));
  }
});

test('저장·수정·삭제는 버전을 검사하고 변경 충돌은 기존 기록을 보존한다', () => {
  const room = fixture(8), candidate = previewGroups(room, options()).candidate;
  const created = createGroupActivity(room, candidate, { now, id: 'activity-1' });
  const updated = updateGroupActivity(room, created.id, { ...created, title: '바꾼 제목', expectedVersion: 1 }, now);
  assert.equal(updated.version, 2);
  assert.throws(() => updateGroupActivity(room, created.id, { ...created, expectedVersion: 1 }), { status: 409 });
  assert.throws(() => deleteGroupActivity(room, created.id, 1), { status: 409 });
  assert.equal(room.groupActivities[0].title, '바꾼 제목');
  deleteGroupActivity(room, created.id, 2);
  assert.deepEqual(room.groupActivities, []);
});

test('학생 삭제는 제목·모둠명·구성·결석·분리 기록을 정리하고 옛 편집 버전을 무효화한다', () => {
  const room = fixture(8), student = room.students[0];
  const candidate = previewGroups(room, options({ title: `${student.name} 발표`, absentIds: [student.id], apartPairs: [{ a: student.id, b: 's1' }] })).candidate;
  candidate.groups[0].name = `${student.name}의 모둠`;
  createGroupActivity(room, candidate, { now });
  assert.equal(removeStudentGroups(room, student, now), 1);
  const saved = room.groupActivities[0];
  assert.ok(!JSON.stringify(saved).includes(student.name));
  assert.ok(!JSON.stringify(saved).includes(`"${student.id}"`));
  assert.equal(saved.version, 2);
  assert.equal(removeStudentGroups(room, student, now), 0);
});

test('활동 수정 시각을 기준으로 보관 기간이 지난 기록만 삭제한다', () => {
  const room = fixture(4), candidate = previewGroups(room, options()).candidate;
  createGroupActivity(room, candidate, { now: '2024-01-01T00:00:00.000Z', id: 'old' });
  createGroupActivity(room, candidate, { now, id: 'new' });
  assert.equal(pruneGroupActivities(room, '2025-08-08T00:00:00.000Z'), 1);
  assert.deepEqual(room.groupActivities.map(({ id }) => id), ['new']);
});

test('새 활동 저장 응답 유실 후 재시도는 활동·반복 조합을 중복 생성하지 않는다', () => {
  const room = fixture(8);
  const body = { ...previewGroups(room, options()).candidate, clientMutationId: 'lost-response-request-01' };
  createGroupActivity(room, body, { now, id: 'created-before-response-lost' }); // The caller never received this response.
  const repeatBeforeRetry = groupMetrics(room, body).repeatWeight;
  const recovered = createGroupActivity(room, body, { now: '2026-10-09T00:00:00.000Z', id: 'must-not-be-created' });
  assert.equal(recovered.id, 'created-before-response-lost');
  assert.equal(recovered.version, 1);
  assert.equal(recovered.updatedAt, now);
  assert.equal(room.groupActivities.length, 1);
  assert.equal(groupMetrics(room, body).repeatWeight, repeatBeforeRetry);
  assert.throws(() => createGroupActivity(room, { ...body, title: '응답 유실 후 바꾼 내용' }), { status: 409 });
  assert.equal(room.groupActivities.length, 1);
  const intentional = createGroupActivity(room, { ...body, title: '별도 활동', clientMutationId: 'intentional-new-request-02' });
  assert.notEqual(intentional.id, recovered.id);
  assert.equal(room.groupActivities.length, 2);
});

test('활동을 수정한 뒤에도 원래 저장 요청 ID를 유지해 지연 재시도를 중복 삽입하지 않는다', () => {
  const room = fixture(8), body = { ...previewGroups(room, options()).candidate, clientMutationId: 'creation-request-unique-01' };
  const first = createGroupActivity(room, body, { now });
  updateGroupActivity(room, first.id, { ...first, title: '다른 화면에서 수정', expectedVersion: 1 }, now);
  assert.throws(() => createGroupActivity(room, body), { status: 409 });
  assert.equal(room.groupActivities.length, 1);
  assert.throws(() => createGroupActivity(room, { ...body, clientMutationId: 'short' }), { status: 400 });
});

test('학생 이름 변경은 제목·모둠명과 버전을 갱신하고 이후 삭제까지 연결된다', () => {
  const room = fixture(8), student = room.students[0], oldName = student.name;
  const candidate = previewGroups(room, options({ title: `${oldName} 발표` })).candidate;
  candidate.groups[0].name = `${oldName} 모둠`;
  const created = createGroupActivity(room, candidate, { now });
  student.name = '변경된학생';
  assert.equal(renameStudentGroups(room, student, oldName, student.name, now), 1);
  assert.equal(room.groupActivities[0].version, 2);
  assert.equal(room.groupActivities[0].title, '변경된학생 발표');
  assert.equal(room.groupActivities[0].groups[0].name, '변경된학생 모둠');
  assert.throws(() => updateGroupActivity(room, created.id, { ...created, expectedVersion: 1 }), { status: 409 });
  assert.equal(renameStudentGroups(room, student, oldName, student.name, now), 0);
  removeStudentGroups(room, student, now);
  assert.ok(!JSON.stringify(room.groupActivities).includes(oldName));
  assert.ok(!JSON.stringify(room.groupActivities).includes(student.name));
});
