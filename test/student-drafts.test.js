import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { FileStore } from '../server/store.js';
import { PgStore } from '../server/pgstore.js';
import { FakePool } from './fake-pg.js';
import { roundLastActivity, purgeExpired } from '../server/retention.js';

for (const [label, makeStore] of [
  ['FileStore', () => new FileStore(null)],
  ['PgStore', () => new PgStore(new FakePool()).init()],
]) describe(`학생 비공개 임시 저장 (${label})`, () => {
  let store, server, url;
  const aiRequests = [];
  before(async () => {
    store = await makeStore();
    const aiClient = { messages: { create: async (request) => {
      aiRequests.push(request);
      return { content: [{ type: 'text', text: JSON.stringify({ summary: '완료', pairs: [], students: [] }) }] };
    } } };
    server = createApp({ store, aiClient }).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((resolve) => server.close(resolve)));

  async function call(path, method = 'GET', body) {
    const response = await fetch(url + path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, json: await response.json(), headers: response.headers };
  }
  async function classroom() {
    const created = await call('/api/rooms', 'POST', { name: '초안 테스트', students: ['학생가', '학생나', '학생다'], minGood: 0, minBad: 0 });
    const teacher = `/api/teacher/${created.json.adminToken}`;
    const view = (await call(`${teacher}/roles/default`, 'POST')).json;
    return { id: created.json.id, teacher, roundId: view.round.id, students: view.students, roles: view.roles, student: `/api/student/${view.students[0].token}` };
  }
  const partial = (room) => ({
    profile: { traits: ['quiet'], partnerTraits: [], partnerText: '  아직 작성 중 PRIVATE_PROFILE ', body: { sight: 'poor' } },
    application: { choices: [{ roleId: '', reason: 'PRIVATE_APP', helpClass: '', helpSelf: '' }] },
    relations: { [room.students[1].id]: { type: 'bad', tags: [], reason: 'ㅇ' } },
  });
  const save = (room, revision, sections, step = 'profile') => call(`${room.student}/draft`, 'PUT', { roundId: room.roundId, revision, step, sections });

  // Hold a request after its token lookup but before its atomic update, allowing a real interleaving.
  function holdNextUpdate() {
    const original = store.updateRoom.bind(store);
    let release, entered;
    const wait = new Promise((resolve) => { release = resolve; });
    const ready = new Promise((resolve) => { entered = resolve; });
    let first = true;
    store.updateRoom = async (...args) => {
      if (first) { first = false; entered(); await wait; }
      return original(...args);
    };
    return { ready, release, restore: () => { store.updateRoom = original; } };
  }

  test('미완성 입력과 공백을 복원하고 교사·다른 학생·내보내기·AI에서는 숨긴다', async () => {
    const room = await classroom();
    const initial = await call(room.student);
    assert.deepEqual(initial.json.draft, { revision: 0, updatedAt: null, step: null, sections: {}, mutationId: null });
    assert.equal(initial.headers.get('cache-control'), 'no-store');
    const sections = partial(room);
    const saved = await save(room, 0, sections, 'application');
    assert.equal(saved.status, 200);
    assert.deepEqual(Object.keys(saved.json), ['draft']);
    assert.equal(saved.json.draft.revision, 1);
    assert.ok(saved.json.draft.updatedAt);
    const mine = (await call(room.student)).json;
    assert.deepEqual(mine.draft.sections, sections);
    assert.equal(mine.draft.step, 'application');
    assert.deepEqual(mine.me.body, {});
    assert.equal(mine.profile, null);
    assert.equal(mine.application, null);
    assert.equal(mine.submittedAt, null);
    assert.deepEqual(mine.relations, {});
    const peer = (await call(`/api/student/${room.students[1].token}`)).json;
    assert.deepEqual(peer.draft.sections, {});
    for (const path of [room.teacher, `${room.teacher}/export.json`]) {
      const response = await call(path);
      assert.equal(response.status, 200);
      assert.doesNotMatch(JSON.stringify(response.json), /PRIVATE_PROFILE|PRIVATE_APP|studentDrafts/);
      assert.deepEqual(response.json.students[0].body, {});
    }
    const analysis = await call(`${room.teacher}/ai/analyze`, 'POST', { roundId: room.roundId });
    assert.equal(analysis.status, 200);
    assert.doesNotMatch(JSON.stringify(aiRequests.at(-1)), /PRIVATE_PROFILE|PRIVATE_APP/);
  });

  test('전체 교체와 버전 충돌을 처리하며 동시에 저장해도 한 요청만 성공한다', async () => {
    const room = await classroom();
    assert.equal((await save(room, 0, partial(room))).status, 200);
    const results = await Promise.all([
      save(room, 1, { relations: {} }, 'relations'),
      save(room, 1, { application: { choices: [] } }, 'application'),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const current = (await call(room.student)).json.draft;
    assert.equal(current.revision, 2);
    assert.equal(Object.keys(current.sections).length, 1);
    assert.equal(current.sections.profile, undefined);
    const conflict = results.find((r) => r.status === 409);
    assert.equal(conflict.json.code, 'DRAFT_CONFLICT');
    assert.deepEqual(conflict.json.draft, current);
  });

  test('최종 저장은 자기 단계 초안만 지우고 늦게 도착한 초안의 부활을 막는다', async () => {
    const room = await classroom();
    assert.equal((await save(room, 0, partial(room))).status, 200);
    const profile = await call(`${room.student}/profile`, 'PUT', { roundId: room.roundId, traits: ['quiet'], body: { sight: 'poor' } });
    assert.equal(profile.status, 200);
    assert.equal(profile.json.draft.revision, 2);
    assert.equal(profile.json.draft.sections.profile, undefined);
    assert.ok(profile.json.draft.sections.application);
    assert.equal(profile.json.me.body.sight, 'poor');
    const application = await call(`${room.student}/application`, 'PUT', { roundId: room.roundId, choices: [{ roleId: room.roles[0].id, reason: '역할을 열심히 맡아보고 싶어요', helpClass: '', helpSelf: '' }] });
    assert.equal(application.status, 200);
    assert.equal(application.json.draft.revision, 3);
    assert.equal(application.json.draft.sections.application, undefined);
    assert.ok(application.json.draft.sections.relations);
    const held = holdNextUpdate();
    try {
      const delayed = save(room, 3, partial(room));
      await held.ready;
      const submitted = await call(`${room.student}/relations`, 'PUT', { roundId: room.roundId, relations: {} });
      assert.equal(submitted.status, 200);
      assert.deepEqual(submitted.json.draft.sections, {});
      assert.equal(submitted.json.draft.revision, 4);
      held.release();
      const stale = await delayed;
      assert.equal(stale.status, 409);
      assert.equal(stale.json.code, 'DRAFT_CONFLICT');
      assert.deepEqual((await call(room.student)).json.draft.sections, {});
    } finally { held.release(); held.restore(); }
    const again = await call(`${room.student}/relations`, 'PUT', { roundId: room.roundId, relations: {} });
    assert.equal(again.json.draft.revision, 5, '초안이 없어도 최종 제출마다 버전 증가');
  });

  test('최종 제출 검증에 실패하면 초안을 그대로 유지한다', async () => {
    const room = await classroom();
    const sections = partial(room);
    await save(room, 0, sections);
    assert.equal((await call(`${room.student}/relations`, 'PUT', { roundId: room.roundId, relations: sections.relations })).status, 400);
    assert.equal((await call(`${room.student}/application`, 'PUT', { roundId: room.roundId, choices: sections.application.choices })).status, 400);
    const draft = (await call(room.student)).json.draft;
    assert.equal(draft.revision, 1);
    assert.deepEqual(draft.sections, sections);
  });

  test('현재 회차 마감 직후도 초안은 보관하고 새 회차에는 섞지 않는다', async () => {
    const room = await classroom();
    await call(room.teacher, 'PATCH', { locked: true });
    assert.equal((await save(room, 0, partial(room))).status, 200);
    assert.equal((await call(`${room.student}/relations`, 'PUT', { roundId: room.roundId, relations: {} })).status, 403);
    const next = await call(`${room.teacher}/rounds`, 'POST', { name: '새 조사' });
    const stale = await save(room, 1, partial(room));
    assert.equal(stale.status, 409);
    assert.equal(stale.json.code, 'ROUND_CHANGED');
    assert.equal(stale.json.currentRoundId, next.json.round.id);
    assert.deepEqual((await call(room.student)).json.draft, { revision: 0, updatedAt: null, step: null, sections: {}, mutationId: null });
  });

  test('교사 초기화·학생 삭제는 초안을 지우고 이전 버전 재저장을 막는다', async () => {
    const room = await classroom();
    await save(room, 0, partial(room));
    await call(`${room.teacher}/students/${room.students[0].id}/reset`, 'POST', { roundId: room.roundId });
    let mine = (await call(room.student)).json;
    assert.equal(mine.draft.revision, 2);
    assert.deepEqual(mine.draft.sections, {});
    assert.equal((await save(room, 1, partial(room))).status, 409);
    await save(room, 2, partial(room));
    await call(`${room.teacher}/students/${room.students[1].id}`, 'DELETE');
    mine = (await call(room.student)).json;
    assert.equal(mine.draft.revision, 4);
    assert.deepEqual(mine.draft.sections.relations, {});
    assert.equal((await save(room, 3, partial(room))).json.code, 'DRAFT_CONFLICT');
    await call(`${room.teacher}/students/${room.students[0].id}`, 'DELETE');
    assert.equal((await call(room.student)).status, 404);
    const stored = await store.getRoom(room.id);
    assert.equal(stored.rounds[0].studentDrafts[room.students[0].id], undefined);
  });

  test('링크 재발급은 새 링크에서 초안을 복원하고 진행 중인 옛 링크 저장도 차단한다', async () => {
    const room = await classroom();
    await save(room, 0, partial(room));
    const held = holdNextUpdate();
    try {
      const delayed = save(room, 1, { relations: {} });
      await held.ready;
      const rotated = await call(`${room.teacher}/students/${room.students[0].id}/rotate`, 'POST');
      const token = rotated.json.students[0].token;
      held.release();
      assert.equal((await delayed).status, 404);
      assert.equal((await call(room.student)).status, 404);
      const next = await call(`/api/student/${token}`);
      assert.equal(next.status, 200);
      assert.equal(next.json.draft.revision, 1);
      assert.ok(next.json.draft.sections.profile);
    } finally { held.release(); held.restore(); }
  });

  test('응답을 못 받은 저장을 요청 번호로 식별하며 제출·초기화·삭제는 그 번호를 무효화한다', async () => {
    const room = await classroom();
    const write = (revision, mutationId, sections = partial(room)) => call(`${room.student}/draft`, 'PUT', { roundId: room.roundId, revision, mutationId, sections, step: 'profile' });
    assert.equal((await write(0, 'request-before-lid-close')).status, 200);
    const restored = (await call(room.student)).json.draft;
    assert.equal(restored.revision, 1);
    assert.equal(restored.mutationId, 'request-before-lid-close');
    const retry = await write(0, 'request-before-lid-close');
    assert.equal(retry.status, 409);
    assert.deepEqual(retry.json.draft, restored, '클라이언트는 이전 저장 성공과 다른 화면의 충돌을 구별할 수 있음');

    const profile = await call(`${room.student}/profile`, 'PUT', { roundId: room.roundId, traits: ['quiet'] });
    assert.equal(profile.json.draft.mutationId, null);
    await write(2, 'request-before-reset');
    await call(`${room.teacher}/students/${room.students[0].id}/reset`, 'POST', { roundId: room.roundId });
    assert.equal((await call(room.student)).json.draft.mutationId, null);
    await write(4, 'request-before-delete');
    await call(`${room.teacher}/students/${room.students[1].id}`, 'DELETE');
    const cleaned = (await call(room.student)).json.draft;
    assert.equal(cleaned.revision, 6);
    assert.equal(cleaned.mutationId, null);
  });

  test('크기·형식·다른 학생 참조를 제한하고 잘못된 요청은 저장 버전을 바꾸지 않는다', async () => {
    const room = await classroom();
    const valid = { roundId: room.roundId, revision: 0, step: null, sections: {} };
    const invalid = [
      { ...valid, roundId: undefined }, { ...valid, revision: undefined }, { ...valid, revision: '0' }, { ...valid, revision: -1 },
      { ...valid, mutationId: '' }, { ...valid, mutationId: 'x'.repeat(129) }, { ...valid, mutationId: 1 },
      { ...valid, step: 'teacher' }, { ...valid, sections: { unknown: {} } },
      { ...valid, sections: { profile: { partnerText: 'x'.repeat(301) } } },
      { ...valid, sections: { profile: { traits: ['unknown'] } } },
      { ...valid, sections: { profile: { body: { sight: 'unknown' } } } },
      { ...valid, sections: { application: { choices: [{ reason: 'x'.repeat(601) }] } } },
      { ...valid, sections: { application: { choices: Array.from({ length: 4 }, () => ({})) } } },
      { ...valid, sections: { relations: { [room.students[0].id]: { type: 'good' } } } },
      { ...valid, sections: { relations: { unknown: { type: 'good' } } } },
      { ...valid, sections: { relations: { [room.students[1].id]: { type: 'bad', reason: 'x'.repeat(301) } } } },
    ];
    for (const body of invalid) assert.equal((await call(`${room.student}/draft`, 'PUT', body)).status, 400);
    assert.equal((await call(room.student)).json.draft.revision, 0);
    assert.equal((await save(room, 0, { application: { choices: [{ roleId: 'removed-role', reason: '', helpClass: '', helpSelf: '' }] } })).status, 200);
  });
});

test('최근 임시 저장 활동이 있는 회차는 보관 기간 만료로 삭제하지 않는다', () => {
  const round = { id: 'round', name: '조사', startedAt: '2020-01-01T00:00:00.000Z', relations: {}, submissions: {}, studentDrafts: { student: { revision: 1, updatedAt: '2026-10-01T00:00:00.000Z', step: 'profile', sections: {} } } };
  assert.equal(roundLastActivity(round), '2026-10-01T00:00:00.000Z');
  const room = { createdAt: round.startedAt, rounds: [round], currentRoundId: round.id };
  assert.equal(purgeExpired(room, new Date('2026-10-08T00:00:00.000Z')).deleteRoom, false);
  assert.equal(room.rounds.length, 1);
});
