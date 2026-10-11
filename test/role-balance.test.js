import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRoleBalance, captureRoleBalanceSnapshot, roleBalancePriorities } from '../server/role-balance.js';
import { assignRoles, repairAssignment } from '../server/assign.js';
import { createApp } from '../server/app.js';
import { FileStore } from '../server/store.js';

const students = [{ id: 'a', name: '가람' }, { id: 'b', name: '나래' }, { id: 'c', name: '다온' }];
const roles = [{ id: 'x', name: '도서', slots: 1 }, { id: 'y', name: '청소', slots: 1 }, { id: 'z', name: '급식', slots: 1 }];
const app = (...ids) => ({ choices: ids.map((roleId) => ({ roleId, reason: '맡아 보고 싶은 역할이에요.' })) });
const round = (id, month) => ({ id, name: `2026년 ${month}월`, startedAt: `2026-${String(month).padStart(2, '0')}-01T00:00:00.000Z`, applications: {} });
const snapshot = (choicesByStudent) => ({ version: 1, capturedAt: '2026-03-01T00:00:00.000Z', choicesByStudent, roleNames: { x: '도서', y: '청소', z: '급식' } });
const history = (month, assignments, choices = null, extra = {}) => ({ month: `2026년 ${month}월`, assignments, source: 'published', updatedAt: `2026-${String(month).padStart(2, '0')}-10T00:00:00.000Z`, ...(choices ? { balanceSnapshot: snapshot(choices) } : {}), ...extra });
const room = (rounds, roleHistory = []) => ({ students, roles, rounds, roleHistory });
const row = (summary, id = 'a') => summary.students.find((student) => student.id === id);

test('학기 누적 횟수·지망 분모·역할 종류를 실제 확정 이력에서 계산한다', () => {
  const r = round('june', 6);
  const summary = summarizeRoleBalance(room([r], [
    history(3, { y: ['a'] }, { a: ['x'] }),
    history(4, { x: ['a'] }, { a: ['x', 'y'] }),
    history(5, { y: ['a'] }, { a: ['z', 'y'] }),
    history(6, { z: ['a'] }, { a: ['y'] }),
  ]), r);
  assert.deepEqual({ ...row(summary), roleCounts: { ...row(summary).roleCounts }, roleNames: { ...row(summary).roleNames } }, {
    id: 'a', name: '가람', assignmentCount: 4, firstChoiceCount: 1, anyWishCount: 2, knownApplicationCount: 4, unknownDataCount: 0, consecutiveNonWishCount: 1,
    distinctRoleCount: 3, roleCounts: { y: 2, x: 1, z: 1 }, roleNames: { y: '청소', x: '도서', z: '급식' },
  });
  assert.equal(row(summary, 'b').assignmentCount, 0);
});

test('스냅샷 없는 가져온 기록은 현재 지원서로 실패 또는 성공을 추정하지 않는다', () => {
  const r = round('may', 5);
  r.applications = { a: app('x') };
  const data = room([r], [history(3, { y: ['a'] }, { a: ['x'] }), history(4, { x: ['a'] }, null, { source: 'import' })]);
  const student = row(summarizeRoleBalance(data, r));
  assert.equal(student.assignmentCount, 2);
  assert.equal(student.knownApplicationCount, 1);
  assert.equal(student.unknownDataCount, 1);
  assert.equal(student.anyWishCount, 0);
  assert.equal(student.consecutiveNonWishCount, 0);
});

test('자료 없는 배정은 연속 희망 외를 끊고 이후 확인된 실패부터 다시 센다', () => {
  const r = round('june', 6);
  const data = room([r], [history(3, { y: ['a'] }, { a: ['x'] }), history(4, { y: ['a'] }), history(5, { y: ['a'] }, { a: ['x'] }), history(6, { y: ['a'] }, { a: ['x'] })]);
  const summary = summarizeRoleBalance(data, r);
  assert.equal(row(summary).consecutiveNonWishCount, 2);
  assert.equal(roleBalancePriorities(summary).a.bonus, 17);
});

test('공개되지 않은 초안은 집계하지 않고 공개 배정과 같은 달 이력을 중복하지 않는다', () => {
  const march = round('march', 3), april = round('april', 4);
  march.roleAssignment = { published: true, assignments: { x: ['a'] }, balanceSnapshot: snapshot({ a: ['x'] }), publishedAt: '2026-03-10T00:00:00.000Z' };
  april.roleAssignment = { published: false, assignments: { y: ['a'] }, balanceSnapshot: snapshot({ a: ['x'] }) };
  const data = room([march, april], [history(3, { x: ['a'] }, { a: ['x'] }, { roundId: 'march' })]);
  assert.equal(summarizeRoleBalance(data, april).recordCount, 1);
  assert.equal(row(summarizeRoleBalance(data, april)).assignmentCount, 1);
  data.roleHistory.push(history(3, { y: ['a'] }, null, { source: 'import', updatedAt: '2026-03-11T00:00:00.000Z' }));
  assert.equal(row(summarizeRoleBalance(data, april)).unknownDataCount, 1);
});

test('과거 회차를 볼 때 미래 달·미래 회차의 확정 결과를 제외한다', () => {
  const may = round('may', 5), later = round('later', 5), june = round('june', 6);
  later.roleAssignment = { published: true, assignments: { y: ['a'] }, balanceSnapshot: snapshot({ a: ['y'] }) };
  const data = room([may, later, june], [history(4, { x: ['a'] }, { a: ['x'] }), history(6, { x: ['a'] }, { a: ['x'] }, { roundId: 'june' })]);
  const summary = summarizeRoleBalance(data, may);
  assert.equal(summary.recordCount, 1);
  assert.equal(row(summary).firstChoiceCount, 1);
});

test('다음 배정 우선 고려는 현재 회차와 같은 달의 기존 공개 결과를 제외한다', () => {
  const r = round('may', 5), data = room([r], [history(4, { y: ['a'] }, { a: ['x'] }), history(5, { y: ['a'] }, { a: ['x'] }, { roundId: 'may' })]);
  assert.equal(row(summarizeRoleBalance(data, r)).assignmentCount, 2);
  assert.equal(row(summarizeRoleBalance(data, r, { beforeRound: true })).assignmentCount, 1);
});

test('3~8월은 1학기, 9~다음 해 2월은 같은 학년도 2학기다', () => {
  const r = { id: 'feb', name: '2027년 2월' };
  const data = room([r], [history(2, { x: ['a'] }), history(3, { x: ['a'] }), history(8, { x: ['a'] }), history(9, { x: ['a'] }), { ...history(1, { x: ['a'] }), month: '2027년 1월' }, { ...history(2, { x: ['a'] }), month: '2027년 2월' }]);
  const second = summarizeRoleBalance(data, r);
  assert.equal(second.semester.id, '2026-2');
  assert.equal(second.recordCount, 3);
  assert.equal(summarizeRoleBalance(data, r, { semester: '2026-1' }).recordCount, 2);
  assert.throws(() => summarizeRoleBalance(data, r, { semester: '2026-3' }), { status: 400 });
});

test('사용자 지정 회차 이름은 startedAt의 한국시간 학기 경계를 따른다', () => {
  const r = { id: 'custom', name: '새 학기', startedAt: '2026-02-28T15:00:00.000Z', roleAssignment: { published: true, assignments: { x: ['a'] } } };
  const data = room([r]);
  const summary = summarizeRoleBalance(data, r, { now: '2030-10-01T00:00:00.000Z' });
  assert.equal(summary.semester.id, '2026-1');
  assert.equal(summary.recordCount, 1);
  r.startedAt = '2026-08-31T15:00:00.000Z';
  assert.equal(summarizeRoleBalance(data, r).semester.id, '2026-2');
});

test('시기를 알 수 없는 외부 기록은 임의 학기에 넣지 않는다', () => {
  const r = round('march', 3);
  const summary = summarizeRoleBalance(room([r], [{ month: '지난번', assignments: { x: ['a'] }, source: 'import' }]), r);
  assert.equal(summary.recordCount, 0);
  assert.equal(summary.undatedRecordCount, 1);
});

test('스냅샷은 당시 역할 지망만 복사하고 지원서 원문·임시저장·학생 이름을 보관하지 않는다', () => {
  const r = round('march', 3);
  r.applications = { a: app('x', 'y') };
  r.studentDrafts = { b: { sections: { application: app('z') } } };
  const data = room([r]);
  const saved = captureRoleBalanceSnapshot(data, r, '2026-03-01T00:00:00.000Z');
  r.applications.a.choices[0].roleId = 'z';
  assert.deepEqual(saved.choicesByStudent.a, ['x', 'y']);
  assert.equal(saved.choicesByStudent.b, undefined);
  assert.doesNotMatch(JSON.stringify(saved), /맡아 보고|가람|studentDrafts/);
});

test('같은 역할 재공개는 당시 지원서를 보존하고 바뀐 역할은 새 지망을 기록한다', () => {
  const r = round('march', 3);
  r.applications = { a: app('y'), b: app('z'), c: app('x') };
  r.roleAssignment = { assignments: { y: ['a'], z: ['b'], x: ['c'] } };
  const old = history(3, { y: ['a'], x: ['b'], x2: ['c'] }, { a: ['x'], b: ['x'] }, { roundId: r.id });
  const saved = captureRoleBalanceSnapshot(room([r], [old]), r);
  assert.deepEqual(saved.choicesByStudent.a, ['x']);
  assert.deepEqual(saved.choicesByStudent.b, ['z']);
  assert.deepEqual(saved.choicesByStudent.c, ['x']);
  delete old.balanceSnapshot;
  assert.equal(captureRoleBalanceSnapshot(room([r], [old]), r).choicesByStudent.a, undefined);
});

test('이력이 없는 이전 공개 배정도 동일 역할 재공개 시 스냅샷을 보존한다', () => {
  const r = round('march', 3);
  r.applications = { a: app('y') };
  r.roleAssignment = { assignments: { y: ['a'] } };
  const previous = { published: true, assignments: { y: ['a'] }, balanceSnapshot: snapshot({ a: ['x'] }) };
  assert.deepEqual(captureRoleBalanceSnapshot(room([r]), r, undefined, previous).choicesByStudent.a, ['x']);
});

test('삭제된 학생은 집계에 나오지 않고 삭제된 역할 경험은 당시 역할명으로 남는다', () => {
  const r = round('march', 3), data = room([r], [history(3, { x: ['a', 'deleted'] }, { a: ['x'] })]);
  data.roles = [];
  const summary = summarizeRoleBalance(data, r);
  assert.equal(summary.students.length, 3);
  assert.equal(row(summary).roleNames.x, '도서');
  assert.equal(summary.students.some((student) => student.id === 'deleted'), false);
});

test('확인된 희망 외 배정 우선 고려가 경쟁하는 희망 역할 배정에 실제 영향을 준다', () => {
  const input = { students: students.slice(0, 2), roles: roles.slice(0, 2), applications: { a: app('x'), b: app('x') }, seed: 7 };
  const baseline = assignRoles(input), deprived = baseline.assignments.y[0];
  const r = round('may', 5);
  const summary = summarizeRoleBalance(room([r], [history(3, { y: [deprived] }, { [deprived]: ['x'] }), history(4, { y: [deprived] }, { [deprived]: ['x'] })]), r, { beforeRound: true });
  const result = assignRoles({ ...input, balancePriority: roleBalancePriorities(summary) });
  assert.deepEqual(result.assignments.x, [deprived]);
  assert.match(result.explanations[deprived], /희망 외 배정 2회.*추가로 고려/);
  assert.equal(result.unassigned.length, 0);
});

test('자료 없음만 있는 학생에게는 우선 점수를 부여하지 않고 과거 실패 점수는 20점으로 제한한다', () => {
  const r = round('july', 7);
  const summary = summarizeRoleBalance(room([r], [3, 4, 5, 6].map((month) => history(month, { y: ['a', 'b'] }, { a: ['x'] }))), r);
  const priorities = roleBalancePriorities(summary);
  assert.equal(priorities.a.bonus, 20);
  assert.equal(priorities.b, undefined);
});

test('우선 고려를 켜도 정원·지난달 제외·중복 금지와 관계 감점을 유지한다', () => {
  const input = { students, roles: [{ ...roles[0], slots: 2 }, roles[1]], applications: { a: app('x'), b: app('x', 'y'), c: app('y', 'x') }, relations: [{ from: 'a', to: 'b', type: 'bad' }], balancePriority: { b: { bonus: 999, nonWishCount: 20 } } };
  for (let seed = 1; seed <= 25; seed++) {
    const result = assignRoles({ ...input, seed });
    assert.ok(result.assignments.x.length <= 2);
    assert.ok(result.assignments.y.length <= 1);
    assert.equal(new Set(Object.values(result.assignments).flat()).size, 3);
    assert.equal(result.assignments.x.includes('a') && result.assignments.x.includes('b'), false);
    assert.match(result.explanations.b, /희망 외 배정 20회/);
    const excluded = assignRoles({ ...input, seed, excluded: { b: ['x'] } });
    assert.equal(excluded.assignments.x.includes('b'), false);
  }
});

test('규칙 보조 점수는 비정상 큰 입력에도 20점으로 제한해 3지망이 1지망을 뒤집지 않는다', () => {
  const input = { students: students.slice(0, 2), roles: roles.slice(0, 1), applications: { a: app('x'), b: app('missing', 'alsoMissing', 'x') }, balancePriority: { b: { bonus: 999999 } } };
  assert.deepEqual(assignRoles(input).assignments.x, ['a']);
});

test('역할 균형 교사 API: 공개 스냅샷·재공개 보존·기간·선택 설정·학생 비공개·삭제 정리', async (t) => {
  const store = new FileStore(null);
  const server = createApp({ store }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(url + path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, json: await response.json(), headers: response.headers };
  };
  const created = (await call('/api/rooms', 'POST', { name: '균형 검증반', students: ['학생가', '학생나'], minGood: 0, minBad: 0 })).json;
  const base = `/api/teacher/${created.adminToken}`;
  const initial = (await call(base)).json;
  const [a, b] = initial.students;
  const roundId = initial.round.id;
  store.updateRoom(created.id, (data) => {
    data.roles = roles;
    const r = data.rounds[0];
    r.name = '2026년 5월';
    r.applications = { [a.id]: app('x'), [b.id]: app('x') };
    data.roleHistory = [history(4, { z: [a.id] }, { [a.id]: ['x'] }, { updatedAt: new Date().toISOString() })];
  });
  const draft = await call(`${base}/roles/assignment`, 'PUT', { roundId, assignments: { x: [a.id], y: [b.id] }, published: false });
  assert.equal(draft.status, 200);
  assert.equal(draft.json.roleBalance.recordCount, 1);
  const published = await call(`${base}/roles/assignment`, 'PUT', { roundId, assignments: { x: [a.id], y: [b.id] }, published: true });
  assert.equal(published.status, 200);
  assert.equal(published.json.roleBalance.recordCount, 2);
  assert.equal(row(published.json.roleBalance, a.id).firstChoiceCount, 1);
  assert.deepEqual(store.getRoom(created.id).rounds[0].roleAssignment.balanceSnapshot.choicesByStudent[a.id], ['x']);
  store.updateRoom(created.id, (data) => { data.rounds[0].applications[a.id] = app('y'); });
  const repeated = await call(`${base}/roles/assignment`, 'PUT', { roundId, assignments: { x: [a.id], y: [b.id] }, published: true });
  assert.equal(row(repeated.json.roleBalance, a.id).firstChoiceCount, 1);
  const balance = await call(`${base}/roles/balance?round=${roundId}&semester=2026-1`);
  assert.equal(balance.status, 200);
  assert.equal(balance.headers.get('cache-control'), 'no-store');
  assert.equal(balance.json.roleBalance.semester.id, '2026-1');
  assert.equal((await call(`${base}/roles/balance?semester=oops`)).status, 400);
  assert.equal((await call(`/api/teacher/${a.token}/roles/balance`)).status, 404);
  assert.equal((await call(`${base}/roles/assign`, 'POST', { roundId, method: 'ai', balancePreference: true })).status, 400);
  assert.equal((await call(`${base}/roles/assign`, 'POST', { roundId, balancePreference: 'yes' })).status, 400);
  const studentView = await call(`/api/student/${a.token}`);
  assert.equal(studentView.status, 200);
  assert.doesNotMatch(JSON.stringify(studentView.json), /roleBalance|choicesByStudent|unknownDataCount|roleCounts/);
  const assigned = await call(`${base}/roles/assign`, 'POST', { roundId, method: 'rules', balancePreference: true, semester: '2026-1' });
  assert.equal(assigned.status, 200);
  assert.match(assigned.json.roleAssignment.explanations[a.id], /희망 외 배정 1회/);
  assert.equal(assigned.json.roleAssignment.published, false);
  assert.equal(assigned.json.roleBalance.recordCount, 2, '이전에 확정한 이력은 새 초안으로 바뀌어도 남는다');
  assert.equal((await call(`${base}/students/${a.id}`, 'DELETE')).status, 200);
  for (const record of store.getRoom(created.id).roleHistory) assert.equal(record.balanceSnapshot?.choicesByStudent?.[a.id], undefined);
});

test('기본·빈 우선 설정은 기존 결정과 설명을 바꾸지 않고 AI 복구 기본값도 유지한다', () => {
  const input = { students: students.slice(0, 2), roles: roles.slice(0, 2), applications: { a: app('x'), b: app('y') }, seed: 3 };
  const expected = assignRoles(input);
  assert.deepEqual(expected.assignments, { x: ['a'], y: ['b'] });
  assert.deepEqual(assignRoles({ ...input, balancePriority: {} }), expected);
  assert.deepEqual(assignRoles({ ...input, balancePriority: undefined }), expected);
  const repaired = repairAssignment({ ...input, assignments: expected.assignments, explanations: { a: '원래 설명', b: '원래 설명' } });
  assert.deepEqual(repaired.assignments, expected.assignments);
  assert.equal(repaired.explanations.a, '원래 설명');
});
