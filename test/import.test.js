// JSON 가져오기: 전체 JSON 의 복원용 원본(backup)으로 교실 복원 · 새 학년 교실에 역할 목록 가져가기
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { FileStore } from '../server/store.js';
import { backupOf, restoreRoom, BACKUP_VERSION } from '../server/import.js';

let server; let base;
const call = async (path, method = 'GET', body) => {
  const res = await fetch(base + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* 본문 없음 */ }
  return { status: res.status, json };
};
const BAD = '체육 시간에 자꾸 내 탓을 해서 여러 번 말다툼을 했어요.';

before(async () => {
  const app = createApp({ store: new FileStore(null) });
  server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

/** 응답·메모·역할이 조금씩 들어 있는 교실 하나 */
async function seedRoom() {
  const created = await call('/api/rooms', 'POST', { name: '복원 반', students: ['가람', '나래', '다온', '라온'], minGood: 0, minBad: 0 });
  const t = created.json.adminToken;
  let view = (await call(`/api/teacher/${t}`)).json;
  const [a, b, c, d] = view.students;
  await call(`/api/student/${a.token}/relations`, 'PUT', { relations: { [b.id]: { type: 'good', tags: ['fun'], reason: '같이 놀아요' }, [c.id]: { type: 'bad', tags: [], reason: BAD } }, closerFriends: { ids: [b.id], text: '모둠에서 친해졌어요', review: '즐거웠어요', score: 4 } });
  await call(`/api/student/${b.token}/relations`, 'PUT', { relations: { [a.id]: { type: 'good', tags: [], reason: '' } } });
  await call(`/api/teacher/${t}/notes`, 'PUT', { notes: { [a.id]: { memo: '앞자리 희망', front: true } }, rules: [{ type: 'apart', a: a.id, b: c.id, note: '다툼' }] });
  await call(`/api/teacher/${t}/roles/default`, 'POST');
  const r2 = await call(`/api/teacher/${t}/rounds`, 'POST', { name: '2031년 1월' });
  assert.equal(r2.status, 201, JSON.stringify(r2.json).slice(0, 300));
  await call(`/api/student/${d.token}/relations`, 'PUT', { relations: { [a.id]: { type: 'good', tags: [], reason: '' } } });
  view = (await call(`/api/teacher/${t}`)).json;
  return { t, view, students: [a, b, c, d] };
}

describe('JSON 가져오기', () => {
  test('내보낸 파일의 backup 에는 선생님 열쇠 · 학생 링크가 없다', async () => {
    const { t, students } = await seedRoom();
    const exported = (await call(`/api/teacher/${t}/export.json`)).json;
    assert.equal(exported.backup.version, BACKUP_VERSION);
    const text = JSON.stringify(exported);
    assert.ok(!text.includes(t), '선생님 열쇠가 파일에 없어야 해요');
    assert.equal(exported.room.adminUrl, undefined);
    for (const s of students) assert.ok(!text.includes(s.token), '학생 링크가 파일에 없어야 해요');
    assert.equal(exported.backup.room.adminToken, undefined);
    assert.equal(exported.backup.room.students.length, 4);
    assert.ok(exported.backup.room.students.every((s) => s.token === undefined && s.id && s.name));
    assert.equal(exported.backup.room.rounds.length, 2);
  });

  test('내보낸 파일로 복원하면 회차 · 응답 · 메모 · 역할이 그대로이고 링크는 새로 나온다', async () => {
    const { t, view, students } = await seedRoom();
    const exported = (await call(`/api/teacher/${t}/export.json`)).json;
    const res = await call('/api/rooms/import', 'POST', { backup: exported.backup });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.restored, true);
    assert.equal(res.json.studentCount, 4);
    assert.equal(res.json.roundCount, 2);
    assert.equal(res.json.droppedRounds, 0);
    assert.notEqual(res.json.adminToken, t);
    assert.notEqual(res.json.id, view.room.id);

    const restored = (await call(`/api/teacher/${res.json.adminToken}`)).json;
    assert.equal(restored.room.name, '복원 반');
    assert.deepEqual(restored.students.map((s) => [s.id, s.name]), view.students.map((s) => [s.id, s.name]));
    assert.ok(restored.students.every((s) => !students.some((o) => o.token === s.token)), '학생 링크는 새로 발급');
    assert.deepEqual(restored.rounds.map((r) => r.name), view.rounds.map((r) => r.name));
    assert.equal(restored.round.name, '2031년 1월');
    assert.deepEqual(restored.teacherNotes.students, view.teacherNotes.students);
    assert.deepEqual(restored.teacherNotes.rules, view.teacherNotes.rules);
    assert.deepEqual(restored.roles, view.roles);

    // 두 교실을 다시 내보내 견줘 보면 회차별 자료가 같다
    const again = (await call(`/api/teacher/${res.json.adminToken}/export.json`)).json;
    const pick = (e) => e.rounds.map((r) => ({ name: r.name, closed: Boolean(r.closedAt), relations: r.relations, closerFriends: r.closerFriends, pairs: r.analysis.pairs.length }));
    assert.deepEqual(pick(again), pick(exported));
    assert.deepEqual(again.backup.room.rounds, exported.backup.room.rounds);

    // 예전 교실과 예전 학생 링크는 그대로 살아 있고, 새 학생 링크로도 들어갈 수 있다
    assert.equal((await call(`/api/teacher/${t}`)).status, 200);
    assert.equal((await call(`/api/student/${students[0].token}`)).status, 200);
    const me = await call(`/api/student/${restored.students[0].token}`);
    assert.equal(me.status, 200);
    assert.equal(me.json.me.name, '가람');
  });

  test('이름을 바꿔 복원할 수 있다', async () => {
    const { t } = await seedRoom();
    const exported = (await call(`/api/teacher/${t}/export.json`)).json;
    const res = await call('/api/rooms/import', 'POST', { backup: exported.backup, name: '  복원  연습  ' });
    assert.equal(res.status, 201);
    assert.equal(res.json.name, '복원 연습');
  });

  test('복원용 자료가 없는 예전 파일 · 다른 형식은 받지 않는다', async () => {
    const { t } = await seedRoom();
    const exported = (await call(`/api/teacher/${t}/export.json`)).json;
    const { backup, ...legacy } = exported;
    let res = await call('/api/rooms/import', 'POST', { backup: legacy.backup });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /복원용 자료가 없어요/);
    res = await call('/api/rooms/import', 'POST', { backup: { ...backup, version: 99 } });
    assert.equal(res.status, 400);
    res = await call('/api/rooms/import', 'POST', { backup: 'x' });
    assert.equal(res.status, 400);
    res = await call('/api/rooms/import', 'POST', {});
    assert.equal(res.status, 400);
  });

  test('고친 파일: 위험한 키 · 이상한 id · 명단 밖 학생은 걸러진다', async () => {
    const { t, students } = await seedRoom();
    const backup = (await call(`/api/teacher/${t}/export.json`)).json.backup;
    const clone = () => structuredClone(backup);
    const [a, b] = students;

    // __proto__ 키 (JSON 으로 보내면 실제 속성으로 들어옴)
    const raw = JSON.stringify({ backup }).replace(`"relations":{`, `"relations":{"__proto__":{"polluted":{"type":"good"}},`);
    const res = await fetch(`${base}/api/rooms/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
    assert.equal(res.status, 400);
    assert.equal({}.polluted, undefined);

    // Object 가 원래 갖고 있는 이름을 학생 id 로
    let bad = clone();
    bad.room.students[0].id = 'constructor';
    assert.equal((await call('/api/rooms/import', 'POST', { backup: bad })).status, 400);
    bad = clone();
    bad.room.students[0].id = 'has space';
    assert.equal((await call('/api/rooms/import', 'POST', { backup: bad })).status, 400);
    bad = clone();
    bad.room.students[1].id = bad.room.students[0].id;   // 같은 id 두 번
    assert.equal((await call('/api/rooms/import', 'POST', { backup: bad })).status, 400);
    bad = clone();
    bad.room.students[1].name = bad.room.students[0].name;   // 같은 이름 두 번
    assert.equal((await call('/api/rooms/import', 'POST', { backup: bad })).status, 400);

    // 명단 밖 학생 · 이상한 관계 종류 · 너무 긴 이유는 버리거나 잘라요
    const odd = clone();
    odd.room.rounds[0].relations[a.id].ghost = { type: 'good', tags: [], reason: '' };
    odd.room.rounds[0].relations.ghost = { [a.id]: { type: 'bad', tags: [], reason: BAD } };
    odd.room.rounds[0].relations[b.id][a.id] = { type: 'love', tags: [], reason: '' };
    odd.room.rounds[0].relations[a.id][b.id].reason = '가'.repeat(1000);
    odd.room.rounds[0].relations[a.id][b.id].tags = ['fun', 'nope', 'fun'];
    odd.room.rounds[0].submissions.ghost = { submittedAt: new Date().toISOString() };
    odd.room.rounds[0].submissions[b.id] = '2031-01-01';   // 모양이 다른 제출 기록은 버려요
    const ok = await call('/api/rooms/import', 'POST', { backup: odd });
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
    const exported = (await call(`/api/teacher/${ok.json.adminToken}/export.json`)).json;
    const first = exported.backup.room.rounds[0];
    assert.deepEqual(Object.keys(first.relations).sort(), [a.id, b.id].sort());
    assert.deepEqual(first.relations[b.id], {});   // 이상한 관계 종류는 빠지고 빈 칸만 남아요
    assert.deepEqual(Object.keys(first.relations[a.id]).sort(), [b.id, students[2].id].sort());
    assert.equal(first.relations[a.id][b.id].reason.length, 300);
    assert.deepEqual(first.relations[a.id][b.id].tags, ['fun']);
    assert.equal(first.submissions.ghost, undefined);
    assert.deepEqual(Object.keys(first.submissions), [a.id]);
  });

  test('학생 · 회차 수 한도와 망가진 속 내용', async () => {
    const { t } = await seedRoom();
    const backup = (await call(`/api/teacher/${t}/export.json`)).json.backup;
    let bad = structuredClone(backup);
    bad.room.students = Array.from({ length: 81 }, (_, i) => ({ id: `s${i}`, name: `학생${i}` }));
    assert.equal((await call('/api/rooms/import', 'POST', { backup: bad })).status, 400);
    bad = structuredClone(backup);
    bad.room.students = bad.room.students.slice(0, 1);
    assert.equal((await call('/api/rooms/import', 'POST', { backup: bad })).status, 400);
    bad = structuredClone(backup);
    bad.room.rounds = Array.from({ length: 37 }, (_, i) => ({ ...backup.room.rounds[0], id: `r${i}`, name: `회차 ${i}` }));
    assert.equal((await call('/api/rooms/import', 'POST', { backup: bad })).status, 400);
    bad = structuredClone(backup);
    bad.room.rounds = [];
    assert.equal((await call('/api/rooms/import', 'POST', { backup: bad })).status, 400);
    bad = structuredClone(backup);
    bad.room.rounds[0].startedAt = 'yesterday';
    assert.equal((await call('/api/rooms/import', 'POST', { backup: bad })).status, 400);
    // 속 내용이 망가진 덩어리(역할 배정 · AI 분석 등)는 서버 오류가 아니라 거절 또는 무시로 끝나야 해요
    for (const [key, value] of [['roleAssignment', { assignments: 'oops', published: true }], ['aiAnalysis', { pairs: 'x', students: 3 }], ['seating', { layout: 7, seats: 'y' }], ['applications', { [backup.room.students[0].id]: { choices: 'none' } }]]) {
      bad = structuredClone(backup);
      bad.room.rounds[1][key] = value;
      const res = await call('/api/rooms/import', 'POST', { backup: bad });
      assert.ok([201, 400].includes(res.status), `${key}: ${res.status} ${JSON.stringify(res.json)}`);
    }
  });

  test('보관 기간이 지난 회차는 빼고 복원하고, 모두 지났으면 거절한다', async () => {
    const { t } = await seedRoom();
    const backup = (await call(`/api/teacher/${t}/export.json`)).json.backup;
    const old = structuredClone(backup);
    const longAgo = '2020-03-05T00:00:00.000Z';
    const age = (round) => {
      round.startedAt = longAgo; round.closedAt = longAgo;
      for (const entry of Object.values(round.submissions)) { entry.submittedAt = longAgo; entry.firstSubmittedAt = longAgo; }
      for (const targets of Object.values(round.relations)) for (const r of Object.values(targets)) r.updatedAt = longAgo;
      for (const entry of Object.values(round.closerFriends || {})) entry.updatedAt = longAgo;
    };
    age(old.room.rounds[0]);
    let res = await call('/api/rooms/import', 'POST', { backup: old });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.roundCount, 1);
    assert.equal(res.json.droppedRounds, 1);
    age(old.room.rounds[1]);
    res = await call('/api/rooms/import', 'POST', { backup: old });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /보관 기간/);
  });

  test('복원 요청만 큰 본문을 받는다 (다른 요청은 300KB 까지)', async () => {
    const { t } = await seedRoom();
    const backup = (await call(`/api/teacher/${t}/export.json`)).json.backup;
    const big = structuredClone(backup);
    big.room.followups = [];
    big.padding = Array.from({ length: 40 }, () => '가'.repeat(5000));   // 약 600KB
    assert.ok(JSON.stringify({ backup: big }).length > 190000);
    const res = await call('/api/rooms/import', 'POST', { backup: big });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    const tooBig = await call('/api/rooms', 'POST', { name: '큰 반', students: ['가', '나'], padding: big.padding });
    assert.equal(tooBig.status, 413);
    const huge = await call('/api/rooms/import', 'POST', { backup: { ...big, padding: Array.from({ length: 400 }, () => '가'.repeat(5000)) } });
    assert.equal(huge.status, 413);
    assert.match(huge.json.error, /4MB/);
  });

  test('새 학년 교실: 교실을 만들 때 1인 1역 역할 목록을 함께 가져간다', async () => {
    const { view } = await seedRoom();
    assert.ok(view.roles.length > 3);
    const res = await call('/api/rooms', 'POST', { name: '새 학년 반', students: ['하나', '두리', '세찬'], roles: view.roles });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.roleCount, view.roles.length);
    const fresh = (await call(`/api/teacher/${res.json.adminToken}`)).json;
    assert.deepEqual(fresh.roles.map((r) => [r.name, r.slots, r.subtitle, r.description]), view.roles.map((r) => [r.name, r.slots, r.subtitle, r.description]));
    assert.ok(fresh.roles.every((r) => !view.roles.some((o) => o.id === r.id)), '역할 id 는 새로 붙여요');
    assert.equal(fresh.rounds.length, 1);
    assert.equal(fresh.relations.length, 0);
    // 역할 없이 만들면 예전과 같다
    const plain = await call('/api/rooms', 'POST', { name: '역할 없는 반', students: ['하나', '두리'] });
    assert.equal(plain.json.roleCount, 0);
    // 잘못된 역할 목록은 거절
    assert.equal((await call('/api/rooms', 'POST', { name: '이상한 반', students: ['하나', '두리'], roles: [{ name: '', slots: 1 }] })).status, 400);
    assert.equal((await call('/api/rooms', 'POST', { name: '이상한 반', students: ['하나', '두리'], roles: 'x' })).status, 400);
  });
});

describe('backupOf / restoreRoom (직접 호출)', () => {
  const room = () => ({
    id: 'room1', name: '직접 반', adminToken: 'ADMIN-SECRET', createdAt: '2031-01-02T00:00:00.000Z', minGood: 2, minBad: 0,
    students: [{ id: 'a', name: '가', token: 'TOKEN-A', createdAt: '2031-01-02T00:00:00.000Z', body: { vision: 'low' } }, { id: 'b', name: '나', token: 'TOKEN-B', createdAt: '2031-01-02T00:00:00.000Z' }],
    rounds: [{ id: 'r1', name: '2031년 1월', startedAt: '2031-01-02T00:00:00.000Z', closedAt: null, relations: { a: { b: { type: 'good', tags: [], reason: '', updatedAt: '2031-01-03T00:00:00.000Z' } } }, submissions: { a: { submittedAt: '2031-01-03T00:00:00.000Z', firstSubmittedAt: '2031-01-03T00:00:00.000Z' } }, studentDrafts: { b: { revision: 3 } } }],
    currentRoundId: 'r1', retentionLog: [{ name: '옛 회차' }],
  });

  test('backupOf 는 열쇠 · 링크 · 임시 저장 · 삭제 기록을 빼고 원본을 바꾸지 않는다', () => {
    const original = room();
    const backup = backupOf(original);
    const text = JSON.stringify(backup);
    assert.ok(!text.includes('ADMIN-SECRET') && !text.includes('TOKEN-A') && !text.includes('studentDrafts') && !text.includes('retentionLog'));
    assert.equal(original.adminToken, 'ADMIN-SECRET');
    assert.equal(original.students[0].token, 'TOKEN-A');
    assert.ok(original.rounds[0].studentDrafts);
    assert.deepEqual(backup.room.students[0], { id: 'a', name: '가', createdAt: '2031-01-02T00:00:00.000Z', body: { vision: 'low' } });
  });

  test('restoreRoom 은 새 id · 열쇠 · 링크를 붙이고 설정과 응답을 되살린다', () => {
    const restored = restoreRoom(backupOf(room()), { now: new Date('2031-02-01T00:00:00.000Z') });
    assert.notEqual(restored.id, 'room1');
    assert.ok(restored.adminToken.length >= 24);
    assert.ok(restored.students.every((s) => s.token.length >= 16 && !s.token.startsWith('TOKEN')));
    assert.equal(restored.restoredAt, '2031-02-01T00:00:00.000Z');
    assert.equal(restored.createdAt, '2031-01-02T00:00:00.000Z');
    assert.equal(restored.minGood, 2);
    assert.equal(restored.minBad, 0);
    assert.equal(restored.currentRoundId, 'r1');
    assert.deepEqual(restored.rounds[0].relations, { a: { b: { type: 'good', tags: [], reason: '', updatedAt: '2031-01-03T00:00:00.000Z' } } });
    assert.deepEqual(restored.rounds[0].submissions, { a: { submittedAt: '2031-01-03T00:00:00.000Z', firstSubmittedAt: '2031-01-03T00:00:00.000Z' } });
    assert.deepEqual(restored.students[0].body, { vision: 'low' });
  });
});
