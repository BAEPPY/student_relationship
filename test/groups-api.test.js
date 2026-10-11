import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { FileStore } from '../server/store.js';
import { PgStore } from '../server/pgstore.js';
import { FakePool } from './fake-pg.js';

async function setup(t, store = new FileStore(null)) {
  const app = createApp({ store });
  const server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const host = `http://127.0.0.1:${server.address().port}`;
  async function call(path, method = 'GET', body, status = 200) {
    const response = await fetch(`${host}${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const json = await response.json();
    assert.equal(response.status, status, JSON.stringify(json));
    return json;
  }
  const created = await call('/api/rooms', 'POST', { name: '모둠 검증반', students: Array.from({ length: 9 }, (_, i) => `학생${i + 1}`), minGood: 0, minBad: 0 }, 201);
  const teacher = `/api/teacher/${created.adminToken}`, base = `${teacher}/groups`;
  const view = await call(teacher);
  const options = { title: '과학 모둠', activityDate: '2026-10-08', roundId: view.round.id, groupSize: 4, absentIds: [view.students[8].id], apartPairs: [], avoidRepeats: true };
  return { call, host, store, created, view, teacher, base, options };
}

for (const [kind, makeStore] of [['File', () => new FileStore(null)], ['Postgres', () => new PgStore(new FakePool()).init()]]) {
  test(`${kind}: 모둠 생성·수정·복사·삭제와 오래된 화면의 버전 충돌`, async (t) => {
    const { call, base, options } = await setup(t, await makeStore());
    const preview = await call(`${base}/preview`, 'POST', options);
    assert.ok(preview.candidate);
    assert.equal((await call(base)).activities.length, 0);
    const first = await call(base, 'POST', preview.candidate, 201);
    const saved = await call(`${base}/${first.activity.id}`, 'PUT', { ...first.activity, title: '수정된 과학 모둠', expectedVersion: 1 });
    assert.equal(saved.activity.version, 2);
    await call(`${base}/${first.activity.id}`, 'PUT', { ...first.activity, expectedVersion: 1 }, 409);
    await call(`${base}/${first.activity.id}`, 'DELETE', { expectedVersion: 1 }, 409);
    const copy = await call(base, 'POST', { ...first.activity, title: '새 활동 복사' }, 201);
    assert.notEqual(copy.activity.id, first.activity.id);
    const deleted = await call(`${base}/${first.activity.id}`, 'DELETE', { expectedVersion: saved.activity.version });
    assert.equal(deleted.activities.length, 1);
    assert.equal(deleted.activities[0].title, '새 활동 복사');
  });

  test(`${kind}: 새 활동 POST 응답을 놓쳐 재시도해도 한 활동만 저장한다`, async (t) => {
    const { call, base, options } = await setup(t, await makeStore());
    const { candidate } = await call(`${base}/preview`, 'POST', options);
    const body = { ...candidate, clientMutationId: 'response-lost-api-test-01' };
    await call(base, 'POST', body, 201); // Simulate losing the successful response at the caller.
    const recovered = await call(base, 'POST', body, 201);
    assert.equal(recovered.activities.length, 1);
    assert.equal(recovered.activity.version, 1);
    await call(base, 'POST', { ...body, title: '수정한 재시도' }, 409);
    assert.equal((await call(base)).activities.length, 1);
    const separate = await call(base, 'POST', { ...body, title: '의도한 별도 활동', clientMutationId: 'intentional-new-api-test-02' }, 201);
    assert.equal(separate.activities.length, 2);
  });
}

test('모둠 API는 학생 이름·식별자만 주고 교사 규칙 이유·응답·토큰은 노출하지 않는다', async (t) => {
  const { call, host, teacher, base, options, view } = await setup(t);
  const [a, b] = view.students;
  await call(`${teacher}/notes`, 'PUT', { notes: { [a.id]: { memo: '비공개 교사 메모' } }, rules: [{ a: a.id, b: b.id, type: 'apart', note: '비공개 분리 이유' }] });
  const data = await call(base);
  assert.equal((await fetch(`${host}${base}`)).headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(data.students[0]).sort(), ['id', 'name']);
  const json = JSON.stringify(data);
  assert.ok(!json.includes('비공개'));
  assert.ok(!json.includes(a.token));
  assert.deepEqual(data.teacherApartPairs, [{ a: [a.id, b.id].sort()[0], b: [a.id, b.id].sort()[1] }]);
  const result = await call(`${base}/preview`, 'POST', options);
  assert.ok(result.candidate.groups.every((group) => !(group.studentIds.includes(a.id) && group.studentIds.includes(b.id))));
  await call('/api/teacher/not-a-token/groups', 'GET', null, 404);
  const student = await call(`/api/student/${a.token}`);
  assert.equal(Object.hasOwn(student, 'groupActivities'), false);
});

test('잘못된 기준 회차·누락·중복·최신 교사 분리 조건 위반은 저장하지 않는다', async (t) => {
  const { call, base, teacher, options } = await setup(t);
  await call(`${base}/preview`, 'POST', { ...options, roundId: '' }, 400);
  await call(`${base}/preview`, 'POST', { ...options, roundId: 'missing' }, 404);
  const { candidate } = await call(`${base}/preview`, 'POST', options);
  const duplicate = structuredClone(candidate); duplicate.groups[1].studentIds[0] = duplicate.groups[0].studentIds[0];
  await call(base, 'POST', duplicate, 400);
  const missing = structuredClone(candidate); missing.groups[0].studentIds.pop();
  await call(base, 'POST', missing, 400);
  const [a, b] = candidate.groups[0].studentIds;
  await call(`${teacher}/notes`, 'PUT', { notes: {}, rules: [{ a, b, type: 'apart' }] });
  await call(base, 'POST', candidate, 400);
  assert.equal((await call(base)).activities.length, 0);
});

test('학생·원본 회차 삭제와 JSON 내보내기가 모둠 기록에도 적용된다', async (t) => {
  const { call, base, teacher, view, options } = await setup(t);
  const student = view.students[0];
  const preview = await call(`${base}/preview`, 'POST', { ...options, title: `${student.name}의 활동` });
  const saved = await call(base, 'POST', preview.candidate, 201);
  await call(`${teacher}/students/${student.id}`, 'DELETE');
  const data = await call(base);
  assert.ok(!JSON.stringify(data.activities).includes(student.id));
  assert.ok(!JSON.stringify(data.activities).includes(student.name));
  const exported = await call(`${teacher}/export.json`);
  assert.equal(exported.groupActivities[0].id, saved.activity.id);
  await call(`${teacher}/rounds`, 'POST', { name: '다음 회차' }, 201);
  await call(`${teacher}/rounds/${view.round.id}`, 'DELETE');
  assert.equal((await call(base)).activities.length, 0);
});
