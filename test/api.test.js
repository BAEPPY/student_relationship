import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { FileStore } from '../server/store.js';
import { PgStore } from '../server/pgstore.js';
import { FakePool } from './fake-pg.js';

let server;
let url;

const STORES = [
  ['FileStore', async () => new FileStore(null)],
  ['PgStore', async () => new PgStore(new FakePool()).init()],
];

for (const [label, makeStore] of STORES) describe(`API (${label})`, () => {
let store;
before(async () => {
  store = await makeStore();
  const app = createApp({ store, baseUrl: 'https://example.test' });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function call(path, method = 'GET', body) {
  const res = await fetch(url + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}

test('교실 생성 → 학생 응답 → 교사 조회 전체 흐름', async () => {
  const created = await call('/api/rooms', 'POST', { name: '3학년 2반', students: '김하늘\n이도윤, 박서연\n최지우\n', minGood: 1, minBad: 1 });
  assert.equal(created.status, 201);
  assert.equal(created.json.studentCount, 4);
  assert.equal(created.json.adminUrl, `https://example.test/t/${created.json.adminToken}`);
  const t = created.json.adminToken;

  const teacher = await call(`/api/teacher/${t}`);
  assert.equal(teacher.status, 200);
  assert.equal(teacher.json.students.length, 4);
  assert.equal(teacher.json.room.minGood, 1);
  assert.equal(teacher.json.room.minBad, 1);
  const [s1, s2, s3] = teacher.json.students;
  assert.match(s1.url, /^https:\/\/example\.test\/s\//);

  // 학생 페이지: 다른 학생의 토큰이나 관계는 노출되지 않음
  const me = await call(`/api/student/${s1.token}`);
  assert.equal(me.status, 200);
  assert.equal(me.json.me.name, '김하늘');
  assert.equal(me.json.classmates.length, 3);
  assert.ok(me.json.classmates.every((c) => c.token === undefined));
  assert.equal(me.json.room.minGood, 1);
  assert.equal(me.json.room.minBad, 1);
  assert.ok(Array.isArray(me.json.catalog.good) && Array.isArray(me.json.catalog.bad));

  // 최소 인원 미달 (안 좋은 사이가 없음)
  let r = await call(`/api/student/${s1.token}/relations`, 'PUT', { relations: { [s2.id]: { type: 'good', tags: [], reason: '' } } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /안 좋은 사이를 1명 이상/);

  // 안 좋은 사이인데 직접 쓴 이유가 없음 (선택지만 고른 경우도 안 됨)
  r = await call(`/api/student/${s1.token}/relations`, 'PUT', { relations: { [s2.id]: { type: 'good', tags: [], reason: '' }, [s3.id]: { type: 'bad', tags: ['tease'], reason: '  ' } } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /이유를 직접 적어/);
  r = await call(`/api/student/${s1.token}/relations`, 'PUT', { relations: { [s2.id]: { type: 'good', tags: [], reason: '' }, [s3.id]: { type: 'bad', tags: [], reason: 'ㅇ' } } });
  assert.equal(r.status, 400);

  // 잘못된 태그
  r = await call(`/api/student/${s1.token}/relations`, 'PUT', { relations: { [s2.id]: { type: 'good', tags: ['hurt'], reason: '' }, [s3.id]: { type: 'bad', tags: ['tease'], reason: '자꾸 놀려요' } } });
  assert.equal(r.status, 400);

  // 자기 자신 / 남의 반 학생
  r = await call(`/api/student/${s1.token}/relations`, 'PUT', { relations: { [s1.id]: { type: 'good' }, [s3.id]: { type: 'bad', tags: ['tease'], reason: '자꾸 놀려요' } } });
  assert.equal(r.status, 400);

  // 정상 제출
  r = await call(`/api/student/${s1.token}/relations`, 'PUT', { relations: { [s2.id]: { type: 'good', tags: ['fun'], reason: '' }, [s3.id]: { type: 'bad', tags: ['tease'], reason: '자꾸 놀려요' } } });
  assert.equal(r.status, 200);
  assert.ok(r.json.submittedAt);
  assert.equal(r.json.relations[s3.id].type, 'bad');

  // 교사 조회에 반영
  const after1 = await call(`/api/teacher/${t}`);
  assert.equal(after1.json.relations.length, 2);
  assert.equal(after1.json.analysis.submittedCount, 1);
  assert.equal(after1.json.stats[s3.id].inBad.length, 1);
  assert.equal(after1.json.analysis.pairs[0].ab === 'bad' || after1.json.analysis.pairs[0].ba === 'bad', true);
  assert.ok(after1.json.students.find((s) => s.id === s1.id).submitted);

  // 다른 학생은 s1 의 관계를 볼 수 없음
  const other = await call(`/api/student/${s2.token}`);
  assert.deepEqual(other.json.relations, {});

  // 마감 후에는 수정 불가
  const locked = await call(`/api/teacher/${t}`, 'PATCH', { locked: true });
  assert.equal(locked.json.room.locked, true);
  r = await call(`/api/student/${s1.token}/relations`, 'PUT', { relations: { [s2.id]: { type: 'good' }, [s3.id]: { type: 'bad', tags: ['tease'], reason: '자꾸 놀려요' } } });
  assert.equal(r.status, 403);
  await call(`/api/teacher/${t}`, 'PATCH', { locked: false });

  // QR / 내보내기
  const qr = await call(`/api/teacher/${t}/qr/${s1.id}.svg`);
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get('content-type'), /svg/);
  assert.match(qr.text, /<svg/);
  const csv = await call(`/api/teacher/${t}/export.csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.text, /김하늘/);
  assert.match(csv.text, /안 좋은 사이/);
  const json = await call(`/api/teacher/${t}/export.json`);
  assert.equal(json.status, 200);
  assert.ok(json.json.students.every((s) => s.token === undefined));

  // 링크 재발급: 기존 토큰 무효화
  const rotated = await call(`/api/teacher/${t}/students/${s1.id}/rotate`, 'POST');
  assert.equal(rotated.status, 200);
  assert.equal((await call(`/api/student/${s1.token}`)).status, 404);
  const newToken = rotated.json.students.find((s) => s.id === s1.id).token;
  assert.equal((await call(`/api/student/${newToken}`)).status, 200);

  // 응답 초기화
  const reset = await call(`/api/teacher/${t}/students/${s1.id}/reset`, 'POST');
  assert.equal(reset.json.relations.length, 0);
  assert.equal(reset.json.students.find((s) => s.id === s1.id).submitted, false);

  // 학생 추가/이름 변경/삭제
  const added = await call(`/api/teacher/${t}/students`, 'POST', { name: '한지민, 오준서' });
  assert.equal(added.status, 201);
  assert.equal(added.json.students.length, 6);
  const dup = await call(`/api/teacher/${t}/students`, 'POST', { name: '한지민' });
  assert.equal(dup.status, 400);
  const renamed = await call(`/api/teacher/${t}/students/${s2.id}`, 'PATCH', { name: '이도윤B' });
  assert.equal(renamed.json.students.find((s) => s.id === s2.id).name, '이도윤B');
  const removed = await call(`/api/teacher/${t}/students/${s3.id}`, 'DELETE');
  assert.equal(removed.json.students.length, 5);

  // 교실 삭제
  assert.equal((await call(`/api/teacher/${t}`, 'DELETE')).status, 200);
  assert.equal((await call(`/api/teacher/${t}`)).status, 404);
});

test('입력 검증: 이름 중복, 학생 수, 잘못된 토큰', async () => {
  let r = await call('/api/rooms', 'POST', { name: '반', students: '김민준\n김민준' });
  assert.equal(r.status, 400);
  r = await call('/api/rooms', 'POST', { name: '반', students: '한명' });
  assert.equal(r.status, 400);
  r = await call('/api/rooms', 'POST', { name: '', students: '가\n나' });
  assert.equal(r.status, 400);
  r = await call('/api/student/nope');
  assert.equal(r.status, 404);
  r = await call('/api/teacher/nope');
  assert.equal(r.status, 404);
  r = await call('/api/nothing');
  assert.equal(r.status, 404);
});

test('예시 교실 생성', async () => {
  const demo = await call('/api/rooms/demo', 'POST');
  assert.equal(demo.status, 201);
  const view = await call(`/api/teacher/${demo.json.adminToken}`);
  assert.equal(view.json.students.length, 12);
  assert.ok(view.json.relations.length > 20);
  assert.ok(view.json.analysis.pairs.length > 0);
  assert.equal(view.json.analysis.submittedCount, 11);
});

test('페이지 라우팅', async () => {
  for (const p of ['/', '/t/abc', '/t/abc/print', '/s/abc']) {
    const r = await call(p);
    assert.equal(r.status, 200, p);
    assert.match(r.text, /<!doctype html>/i);
  }
  const nf = await call('/no-such-page');
  assert.equal(nf.status, 404);
});

test('자리 배정 저장과 검증', async () => {
  const created = await call('/api/rooms', 'POST', { name: '배정반', students: '가\n나\n다' });
  const t = created.json.adminToken;
  const view = await call(`/api/teacher/${t}`);
  const [a, b] = view.json.students;
  let r = await call(`/api/teacher/${t}/seating`, 'PUT', { layout: { blocks: [{ cols: 2, rows: 2 }] }, seats: { 'b0-r0-c0': a.id, 'b0-r0-c1': b.id }, pinned: ['b0-r0-c0'], options: { friends: 'near' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.seating.seats['b0-r0-c1'], b.id);
  assert.deepEqual(r.json.seating.pinned, ['b0-r0-c0']);
  assert.equal(r.json.seating.options.friends, 'near');
  r = await call(`/api/teacher/${t}/seating`, 'PUT', { layout: { blocks: [{ cols: 2, rows: 2 }] }, seats: { 'b0-r0-c0': a.id, 'b0-r0-c1': a.id } });
  assert.equal(r.status, 400);
  r = await call(`/api/teacher/${t}/seating`, 'PUT', { layout: { blocks: [{ cols: 9, rows: 2 }] }, seats: {} });
  assert.equal(r.status, 400);
  r = await call(`/api/teacher/${t}/seating`, 'PUT', { layout: { blocks: [{ cols: 2, rows: 2 }] }, seats: { 'b0-r0-c0': 'nope' } });
  assert.equal(r.status, 400);
  const page = await call(`/t/${t}/seats`);
  assert.equal(page.status, 200);
});

test('교사 메모와 지정 규칙 저장', async () => {
  const created = await call('/api/rooms', 'POST', { name: '메모반', students: '가\n나\n다' });
  const t = created.json.adminToken;
  const view = await call(`/api/teacher/${t}`);
  const [a, b, c] = view.json.students;
  let r = await call(`/api/teacher/${t}/notes`, 'PUT', { notes: { [a.id]: { memo: '시력이 나빠요', front: true }, [b.id]: { memo: '', front: false } }, rules: [{ type: 'apart', a: a.id, b: b.id, note: '다툼' }, { type: 'together', a: b.id, b: c.id }] });
  assert.equal(r.status, 200);
  assert.equal(r.json.teacherNotes.students[a.id].front, true);
  assert.equal(r.json.teacherNotes.students[b.id], undefined);
  assert.equal(r.json.teacherNotes.rules.length, 2);
  r = await call(`/api/teacher/${t}/notes`, 'PUT', { notes: {}, rules: [{ type: 'apart', a: a.id, b: a.id }] });
  assert.equal(r.status, 400);
  r = await call(`/api/teacher/${t}/notes`, 'PUT', { notes: {}, rules: [{ type: 'apart', a: a.id, b: b.id }, { type: 'together', a: b.id, b: a.id }] });
  assert.equal(r.status, 400);
  r = await call(`/api/teacher/${t}/notes`, 'PUT', { notes: { zzz: { memo: 'x' } }, rules: [] });
  assert.equal(r.status, 400);
  // 학생 삭제 시 관련 메모/규칙 정리
  const removed = await call(`/api/teacher/${t}/students/${a.id}`, 'DELETE');
  assert.equal(removed.json.teacherNotes.students[a.id], undefined);
  assert.equal(removed.json.teacherNotes.rules.length, 1);
});

test('회차: 새 회차 시작, 이전 회차 잠김, 오래된 화면의 제출 거부, 회차별 조회', async () => {
  const created = await call('/api/rooms', 'POST', { name: '회차반', students: '가\n나\n다', minGood: 0, minBad: 0 });
  const t = created.json.adminToken;
  let view = await call(`/api/teacher/${t}`);
  assert.equal(view.json.rounds.length, 1);
  assert.match(view.json.round.name, /^\d{4}년 \d{1,2}월$/);
  const [a, b] = view.json.students;
  const round1 = view.json.round.id;

  // 1회차 제출
  let r = await call(`/api/student/${a.token}/relations`, 'PUT', { roundId: round1, relations: { [b.id]: { type: 'good', tags: [], reason: '' } } });
  assert.equal(r.status, 200);
  assert.equal(r.json.round.id, round1);

  // 새 회차 시작 → 1회차 마감, 2회차 열림, 학생 화면은 빈 상태
  r = await call(`/api/teacher/${t}/rounds`, 'POST', { name: '2026년 11월' });
  assert.equal(r.status, 201);
  const round2 = r.json.round.id;
  assert.notEqual(round2, round1);
  assert.equal(r.json.rounds.length, 2);
  assert.equal(r.json.rounds[0].open, false);
  assert.equal(r.json.rounds[1].open, true);
  const me = await call(`/api/student/${a.token}`);
  assert.equal(me.json.round.id, round2);
  assert.equal(me.json.round.name, '2026년 11월');
  assert.deepEqual(me.json.relations, {});
  assert.equal(me.json.submittedAt, null);

  // 옛 회차 번호로 제출하면 거부 (데이터 섞임 방지)
  r = await call(`/api/student/${a.token}/relations`, 'PUT', { roundId: round1, relations: { [b.id]: { type: 'bad', tags: ['tease'], reason: '자꾸 놀려요' } } });
  assert.equal(r.status, 409);
  // 2회차로 제출
  r = await call(`/api/student/${a.token}/relations`, 'PUT', { roundId: round2, relations: { [b.id]: { type: 'bad', tags: ['tease'], reason: '자꾸 놀려요' } } });
  assert.equal(r.status, 200);

  // 1회차 데이터는 그대로
  view = await call(`/api/teacher/${t}?round=${round1}`);
  assert.equal(view.json.relations.length, 1);
  assert.equal(view.json.relations[0].type, 'good');
  view = await call(`/api/teacher/${t}`);
  assert.equal(view.json.round.id, round2);
  assert.equal(view.json.relations[0].type, 'bad');
  assert.equal(view.json.history.trend.length, 2);
  assert.equal(view.json.history.changes.newConflicts.length, 1);

  // 같은 이름 회차 거부, 지난 회차 다시 열기 거부, 이름 바꾸기
  assert.equal((await call(`/api/teacher/${t}/rounds`, 'POST', { name: '2026년 11월' })).status, 400);
  assert.equal((await call(`/api/teacher/${t}/rounds/${round1}`, 'PATCH', { closed: false })).status, 400);
  r = await call(`/api/teacher/${t}/rounds/${round2}`, 'PATCH', { name: '11월 조사', closed: true });
  assert.equal(r.json.round.name, '11월 조사');
  assert.equal(r.json.round.open, false);
  assert.equal((await call(`/api/student/${a.token}/relations`, 'PUT', { roundId: round2, relations: { [b.id]: { type: 'good' } } })).status, 403);
  r = await call(`/api/teacher/${t}/rounds/${round2}`, 'PATCH', { closed: false });
  assert.equal(r.json.round.open, true);

  // CSV 에 회차 열 포함, 회차 삭제
  const csv = await call(`/api/teacher/${t}/export.csv`);
  assert.match(csv.text, /회차/);
  assert.match(csv.text, /11월 조사/);
  r = await call(`/api/teacher/${t}/rounds/${round1}`, 'DELETE');
  assert.equal(r.json.rounds.length, 1);
  assert.equal((await call(`/api/teacher/${t}/rounds/${round2}`, 'DELETE')).status, 400);
});

test('예전 구조(relations/submissions/locked)의 교실도 회차로 자동 변환된다', async () => {
  const created = await call('/api/rooms', 'POST', { name: '옛반', students: '가\n나' });
  const t = created.json.adminToken;
  const legacy = await call(`/api/teacher/${t}`);
  const [a, b] = legacy.json.students;
  // 저장소에 예전 구조로 직접 써 넣음
  const room = await store.findRoomByAdminToken(t);
  await store.updateRoom(room.id, (rm) => {
    delete rm.rounds; delete rm.currentRoundId;
    rm.relations = { [a.id]: { [b.id]: { type: 'good', tags: [], reason: '' } } };
    rm.submissions = { [a.id]: { submittedAt: '2026-09-01T00:00:00.000Z' } };
    rm.locked = true;
  });
  const view = await call(`/api/teacher/${t}`);
  assert.equal(view.json.rounds.length, 1);
  assert.equal(view.json.round.open, false);
  assert.equal(view.json.relations.length, 1);
  assert.equal(view.json.room.locked, true);
});

test('최소 인원: 좋은 사이 3명과 안 좋은 사이 3명을 각각 채워야 제출된다', async () => {
  const created = await call('/api/rooms', 'POST', { name: '규칙반', students: '가\n나\n다\n라\n마\n바\n사\n아' });
  const t = created.json.adminToken;
  const view = await call(`/api/teacher/${t}`);
  assert.equal(view.json.room.minGood, 3);
  assert.equal(view.json.room.minBad, 1);
  const [me, ...others] = view.json.students;
  const good = (id) => [id, { type: 'good', tags: [], reason: '' }];
  const badr = (id) => [id, { type: 'bad', tags: ['tease'], reason: '자꾸 놀려요' }];
  // 좋은 사이만 6명
  let rel = Object.fromEntries(others.slice(0, 6).map((s) => good(s.id)));
  let r = await call(`/api/student/${me.token}/relations`, 'PUT', { relations: rel });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /안 좋은 사이를 1명 이상/);
  // 좋은 2 + 안 좋은 3
  rel = Object.fromEntries([...others.slice(0, 2).map((s) => good(s.id)), ...others.slice(2, 5).map((s) => badr(s.id))]);
  r = await call(`/api/student/${me.token}/relations`, 'PUT', { relations: rel });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /좋은 사이를 3명 이상/);
  // 좋은 3 + 안 좋은 1
  rel = Object.fromEntries([...others.slice(0, 3).map((s) => good(s.id)), ...others.slice(3, 4).map((s) => badr(s.id))]);
  r = await call(`/api/student/${me.token}/relations`, 'PUT', { relations: rel });
  assert.equal(r.status, 200);
  // 선생님이 숫자 조정
  r = await call(`/api/teacher/${t}`, 'PATCH', { minGood: 2, minBad: 1 });
  assert.equal(r.json.room.minGood, 2);
  assert.equal(r.json.room.minBad, 1);
  assert.equal((await call(`/api/teacher/${t}`, 'PATCH', { minGood: 0, minBad: 0 })).status, 200);
  assert.equal((await call(`/api/teacher/${t}`, 'PATCH', { minGood: 11, minBad: 0 })).status, 400);
  // 반 인원이 적으면 자동으로 줄어듦 (친구 2명 → 합쳐서 2명)
  const small = await call('/api/rooms', 'POST', { name: '작은반', students: '가\n나\n다' });
  const sv = await call(`/api/student/${(await call(`/api/teacher/${small.json.adminToken}`)).json.students[0].token}`);
  assert.equal(sv.json.room.minGood + sv.json.room.minBad <= 2, true);
});

test('보관 정책: 오래된 회차는 접근할 때 삭제되고, 경고와 기록이 보인다', async () => {
  const created = await call('/api/rooms', 'POST', { name: '보관반', students: '가\n나\n다' });
  const t = created.json.adminToken;
  const view = await call(`/api/teacher/${t}`);
  const [a, b] = view.json.students;
  const room = await store.findRoomByAdminToken(t);
  const old = (m) => new Date(Date.now() - m * 30.5 * 86400000).toISOString();
  await store.updateRoom(room.id, (rm) => {
    rm.rounds.unshift(
      { id: 'old1', name: '아주 옛날', startedAt: old(17), closedAt: old(16), relations: { [a.id]: { [b.id]: { type: 'good', tags: [], reason: '' } } }, submissions: { [a.id]: { submittedAt: old(16) } } },
      { id: 'soon', name: '곧 삭제', startedAt: old(13.5), closedAt: old(13.2), relations: {}, submissions: {} },
    );
  });
  const after = await call(`/api/teacher/${t}`);
  assert.equal(after.status, 200);
  assert.deepEqual(after.json.rounds.map((r) => r.name).includes('아주 옛날'), false);
  assert.equal(after.json.rounds.some((r) => r.name === '곧 삭제'), true);
  assert.equal(after.json.retention.months, 14);
  assert.deepEqual(after.json.retention.expiring.map((r) => r.name), ['곧 삭제']);
  assert.equal(after.json.retention.log.length, 1);
  assert.equal(after.json.retention.log[0].name, '아주 옛날');
  assert.ok(after.json.rounds.every((r) => r.expiresAt));

  // 예약 작업 엔드포인트
  const purge = await call('/api/maintenance/purge');
  assert.equal(purge.status, 200);
  assert.equal(purge.json.retentionMonths, 14);
  assert.ok(purge.json.rooms >= 1);

  // 14개월 동안 아무 활동이 없는 교실은 통째로 삭제
  const dead = await call('/api/rooms', 'POST', { name: '잠든반', students: '가\n나' });
  const deadRoom = await store.findRoomByAdminToken(dead.json.adminToken);
  await store.updateRoom(deadRoom.id, (rm) => {
    rm.createdAt = old(20);
    rm.rounds = [{ id: 'x', name: '옛날', startedAt: old(20), closedAt: old(19), relations: {}, submissions: {} }];
    rm.currentRoundId = 'x';
  });
  const gone = await call(`/api/teacher/${dead.json.adminToken}`);
  assert.equal(gone.status, 410);
  assert.match(gone.json.error, /14개월/);
  assert.equal((await call(`/api/teacher/${dead.json.adminToken}`)).status, 404);
});

test('보관 정책 엔드포인트는 CRON_SECRET 이 있으면 비밀값을 요구한다', async () => {
  process.env.CRON_SECRET = 'shh';
  try {
    assert.equal((await call('/api/maintenance/purge')).status, 401);
    const res = await fetch(`${url}/api/maintenance/purge`, { headers: { authorization: 'Bearer shh' } });
    assert.equal(res.status, 200);
  } finally {
    delete process.env.CRON_SECRET;
  }
});
});
