import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { FileStore } from '../server/store.js';
import { PgStore } from '../server/pgstore.js';
import { FakePool } from './fake-pg.js';
import { purgeExpired, roomLastActivity } from '../server/retention.js';
import { followupToday } from '../server/followups.js';

async function fixture(t, store) {
  const app = createApp({ store });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, method = 'GET', body, status = 200) => {
    const response = await fetch(origin + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    assert.equal(response.status, status, JSON.stringify(data));
    return data;
  };
  const created = await call('/api/rooms', 'POST', { name: '교사 기능 통합 검증', students: ['가학생', '나학생', '다학생', '라학생'], minGood: 0, minBad: 0 }, 201);
  const root = `/api/teacher/${created.adminToken}`;
  const view = await call(root);
  return { origin, call, root, view, store, created };
}

for (const [kind, makeStore] of [['File', () => new FileStore(null)], ['Postgres', () => new PgStore(new FakePool()).init()]]) {
  test(`${kind}: 모둠·상담·역할 자료를 저장하고 학생 화면에는 노출하지 않음`, async t => {
    const { call, root, view, store, created, origin } = await fixture(t, await makeStore());
    const [a, b] = view.students;
    const today = followupToday();
    await call(`${root}/notes`, 'PUT', { notes: {}, rules: [{ a: a.id, b: b.id, type: 'apart', note: '교사 전용 규칙' }] });
    const preview = await call(`${root}/groups/preview`, 'POST', { title: '협력 활동', activityDate: today, roundId: view.round.id, groupSize: 2, absentIds: [], apartPairs: [], avoidRepeats: true });
    assert.ok(preview.candidate);
    const saved = await call(`${root}/groups`, 'POST', preview.candidate, 201);
    assert.equal(saved.activities.length, 1);
    const recorded = await call(`${root}/followups`, 'POST', { studentIds: [a.id], observedDate: today, observation: '교사 전용 관찰 기록', action: '개별 대화', nextCheckDate: today }, 201);
    assert.equal(recorded.entry.version, 1);
    const dashboard = await call(root);
    assert.equal(dashboard.followupSummary.dueToday.length, 1);
    await call(`${root}/followups/${recorded.entry.id}`, 'PUT', { expectedVersion: 1, status: 'completed' });
    assert.equal((await call(root)).followupSummary.openCount, 0);
    await call(`${root}/followups/${recorded.entry.id}`, 'PUT', { expectedVersion: 1, status: 'open' }, 409);
    await call(`${root}/groups/${saved.activity.id}`, 'PUT', { ...saved.activity, title: '바꾼 활동', expectedVersion: 1 });
    await call(`${root}/groups/${saved.activity.id}`, 'DELETE', { expectedVersion: 1 }, 409);

    const roles = [{ id: 'clean', name: '청소', slots: 4, description: '청소하기' }];
    await call(`${root}/roles`, 'PUT', { roles });
    // Historical intent is copied only when the teacher publishes, never from later edits.
    await store.updateRoom(created.id, room => { room.rounds[0].applications = { [a.id]: { choices: [{ roleId: 'clean', reason: '학생 개인 지원 이유' }] } }; });
    const published = await call(`${root}/roles/assignment`, 'PUT', { roundId: view.round.id, assignments: { clean: view.students.map(s => s.id) }, published: true });
    assert.equal(published.roleBalance.students.find(s => s.id === a.id).knownApplicationCount, 1);
    assert.equal(published.roleBalance.students.find(s => s.id === b.id).unknownDataCount, 1);
    assert.doesNotMatch(JSON.stringify(published.roleAssignment.balanceSnapshot), /학생 개인 지원 이유/);
    await call(`${root}/roles/balance?semester=invalid`, 'GET', undefined, 400);
    await call(`${root}/roles/assign`, 'POST', { roundId: view.round.id, method: 'ai', balancePreference: true }, 400);
    const student = await call(`/api/student/${a.token}`);
    for (const key of ['groupActivities', 'groups', 'followups', 'followupSummary', 'roleBalance', 'balanceSnapshot']) assert.equal(Object.hasOwn(student, key), false, key);
    assert.doesNotMatch(JSON.stringify(student), /교사 전용/);
    for (const suffix of ['groups', 'followups', 'roles/balance']) await call(`/api/teacher/${a.token}/${suffix}`, 'GET', undefined, 404);
    for (const path of ['groups', 'followups']) {
      const response = await fetch(`${origin}/t/${created.adminToken}/${path}`);
      assert.equal(response.status, 200);
      assert.match(await response.text(), new RegExp(`/js/${path}\\.js`));
    }
    const exported = await call(`${root}/export.json`);
    assert.equal(exported.groupActivities.length, 1);
    assert.equal(exported.followups.length, 1);
    assert.equal(exported.students.some(s => s.token), false);
    await call(`${root}/followups`, 'POST', { studentIds: [b.id], observedDate: today, observation: `${a.name} 학생과 함께 대화함`, action: '', nextCheckDate: today }, 201);
    await call(`${root}/students/${a.id}`, 'PATCH', { name: '이름을바꾼학생' });
    const renamed = await call(`${root}/followups`);
    assert.ok(renamed.entries.some(entry => entry.observation.includes('이름을바꾼학생')));
    assert.equal(renamed.entries.some(entry => entry.observation.includes(a.name)), false);
    await call(`${root}/students/${a.id}`, 'DELETE');
    const after = await call(`${root}/export.json`);
    assert.equal(after.followups.length, 0);
    assert.doesNotMatch(JSON.stringify(after.groupActivities), new RegExp(a.id));
    for (const record of [...after.roleHistory, ...after.rounds.map(r => r.roleAssignment).filter(Boolean)]) assert.equal(Object.hasOwn(record.balanceSnapshot?.choicesByStudent || {}, a.id), false);
  });
}

test('새 모둠·상담 기록은 보관 기간을 따르고 예정일만으로 연장하지 않음', () => {
  const room = { id: 'retention', createdAt: '2024-01-01T00:00:00.000Z', students: [], currentRoundId: 'new', rounds: [
    { id: 'old', name: '오래된 회차', startedAt: '2024-01-01T00:00:00.000Z', relations: {}, submissions: {} },
    { id: 'new', name: '새 회차', startedAt: '2026-09-01T00:00:00.000Z', relations: {}, submissions: {} },
  ], groupActivities: [
    { id: 'old-source', roundId: 'old', updatedAt: '2026-10-01T00:00:00.000Z' },
    { id: 'expired', roundId: 'new', updatedAt: '2024-01-01T00:00:00.000Z' },
    { id: 'current', roundId: 'new', updatedAt: '2026-10-06T00:00:00.000Z' },
  ], followups: [
    { id: 'expired', updatedAt: '2024-01-01T00:00:00.000Z', nextCheckDate: '2030-10-08' },
    { id: 'current', updatedAt: '2026-10-07T00:00:00.000Z' },
  ] };
  assert.equal(roomLastActivity(room), '2026-10-07T00:00:00.000Z');
  const result = purgeExpired(room, new Date('2026-10-08T00:00:00.000Z'));
  assert.equal(result.changed, true);
  assert.deepEqual(room.groupActivities.map(a => a.id), ['current']);
  assert.deepEqual(room.followups.map(a => a.id), ['current']);
  assert.equal(purgeExpired(room, new Date('2026-10-08T00:00:00.000Z')).changed, false);
});
