import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { FileStore } from '../server/store.js';

async function setup(t) {
  const store = new FileStore(null);
  const server = createApp({ store }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function call(path, method = 'GET', body) {
    const response = await fetch(origin + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, headers: response.headers, json: await response.json() };
  }
  const made = (await call('/api/rooms', 'POST', { name: '후속 확인 반', students: ['가람', '나래'], minGood: 0, minBad: 0 })).json;
  const teacher = `/api/teacher/${made.adminToken}`;
  const view = (await call(teacher)).json;
  const base = `${teacher}/followups`;
  const initial = (await call(base)).json;
  const fields = { studentIds: [view.students[0].id], observedDate: initial.today, observation: 'PRIVATE_COUNSELING', action: 'PRIVATE_ACTION', nextCheckDate: initial.today, status: 'open' };
  return { call, teacher, base, made, view, fields, store };
}

test('교사 전용 CRUD: 학생 토큰으로 읽기·쓰기 불가, 학생 응답·보고서에 내용 없음', async (t) => {
  const { call, teacher, base, view, fields } = await setup(t);
  for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
    const suffix = ['PUT', 'DELETE'].includes(method) ? '/missing' : '';
    assert.equal((await call(`/api/teacher/${view.students[0].token}/followups${suffix}`, method, method === 'GET' ? undefined : fields)).status, 404);
  }
  const create = await call(base, 'POST', fields);
  assert.equal(create.status, 201);
  assert.equal(create.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(JSON.stringify(create.json), /adminToken|"token"/);
  const { id } = create.json.entry;
  const complete = await call(`${base}/${id}`, 'PUT', { expectedVersion: 1, status: 'completed' });
  assert.equal(complete.status, 200);
  assert.equal(complete.json.entry.observation, fields.observation);
  assert.equal((await call(teacher)).json.followupSummary.openCount, 0);
  assert.equal((await call(`${base}/${id}`, 'PUT', { expectedVersion: 2, status: 'open' })).status, 200);
  const summary = (await call(teacher)).json.followupSummary;
  assert.equal(summary.dueToday[0].id, id);
  assert.equal(summary.dueToday[0].version, 3);
  for (const path of [`/api/student/${view.students[0].token}`, `/api/student/${view.students[1].token}`, `${teacher}/report.json`]) {
    const result = await call(path);
    assert.equal(result.status, 200);
    assert.doesNotMatch(JSON.stringify(result.json), /PRIVATE_COUNSELING|PRIVATE_ACTION|followups|followupSummary/);
  }
  assert.equal((await call(`${base}/${id}`, 'DELETE', { expectedVersion: 3 })).status, 200);
  assert.deepEqual((await call(base)).json.entries, []);
});

test('경합하는 수정은 하나만 저장되고 오래된 삭제도 거절한다', async (t) => {
  const { call, base, fields } = await setup(t);
  const entry = (await call(base, 'POST', fields)).json.entry;
  const results = await Promise.all(['첫 수정', '둘째 수정'].map((observation) => call(`${base}/${entry.id}`, 'PUT', { expectedVersion: 1, observation })));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const conflict = results.find((result) => result.status === 409).json;
  assert.equal(conflict.code, 'FOLLOWUP_CONFLICT');
  assert.equal(conflict.entry.version, 2);
  assert.equal((await call(`${base}/${entry.id}`, 'DELETE', { expectedVersion: 1 })).status, 409);
  assert.equal((await call(base)).json.entries.length, 1);
  assert.equal((await call(`${base}/${entry.id}`, 'DELETE', {})).status, 400);
});

test('잘못된 날짜·외부 학생·문자 길이를 거절하고 기존 기록을 보존한다', async (t) => {
  const { call, base, fields, teacher, view } = await setup(t);
  for (const patch of [{ observedDate: '2026-02-30' }, { studentIds: ['foreign-student'] }, { action: '글'.repeat(2001) }, { nextCheckDate: '2000-01-01' }]) {
    assert.equal((await call(base, 'POST', { ...fields, ...patch })).status, 400);
  }
  assert.equal((await call(base)).json.entries.length, 0);
  const entry = (await call(base, 'POST', fields)).json.entry;
  assert.equal((await call(`${base}/${entry.id}`, 'PUT', { expectedVersion: 1, studentIds: [] })).status, 400);
  assert.equal((await call(base)).json.entries[0].version, 1);
  assert.equal((await call(`${teacher}/students/${view.students[0].id}`, 'DELETE')).status, 200);
  assert.equal((await call(base)).json.entries.length, 0);
  assert.equal((await call(`${base}/${entry.id}`, 'PUT', { expectedVersion: 1, action: '늦게 저장' })).status, 404);
});
