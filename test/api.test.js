import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';

let server;
let url;

before(async () => {
  const app = createApp({ store: new Store(null), baseUrl: 'https://example.test' });
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
  const created = await call('/api/rooms', 'POST', { name: '3학년 2반', students: '김하늘\n이도윤, 박서연\n최지우\n', minRelations: 2 });
  assert.equal(created.status, 201);
  assert.equal(created.json.studentCount, 4);
  assert.equal(created.json.adminUrl, `https://example.test/t/${created.json.adminToken}`);
  const t = created.json.adminToken;

  const teacher = await call(`/api/teacher/${t}`);
  assert.equal(teacher.status, 200);
  assert.equal(teacher.json.students.length, 4);
  assert.equal(teacher.json.room.minRelations, 2);
  const [s1, s2, s3] = teacher.json.students;
  assert.match(s1.url, /^https:\/\/example\.test\/s\//);

  // 학생 페이지: 다른 학생의 토큰이나 관계는 노출되지 않음
  const me = await call(`/api/student/${s1.token}`);
  assert.equal(me.status, 200);
  assert.equal(me.json.me.name, '김하늘');
  assert.equal(me.json.classmates.length, 3);
  assert.ok(me.json.classmates.every((c) => c.token === undefined));
  assert.equal(me.json.room.minRelations, 2);
  assert.ok(Array.isArray(me.json.catalog.good) && Array.isArray(me.json.catalog.bad));

  // 최소 인원 미달
  let r = await call(`/api/student/${s1.token}/relations`, 'PUT', { relations: { [s2.id]: { type: 'good', tags: [], reason: '' } } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /2명 이상/);

  // 안 좋은 사이인데 이유 없음
  r = await call(`/api/student/${s1.token}/relations`, 'PUT', { relations: { [s2.id]: { type: 'good', tags: [], reason: '' }, [s3.id]: { type: 'bad', tags: [], reason: '  ' } } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /이유를 꼭/);

  // 잘못된 태그
  r = await call(`/api/student/${s1.token}/relations`, 'PUT', { relations: { [s2.id]: { type: 'good', tags: ['hurt'], reason: '' }, [s3.id]: { type: 'bad', tags: ['tease'], reason: '' } } });
  assert.equal(r.status, 400);

  // 자기 자신 / 남의 반 학생
  r = await call(`/api/student/${s1.token}/relations`, 'PUT', { relations: { [s1.id]: { type: 'good' }, [s3.id]: { type: 'bad', tags: ['tease'] } } });
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
  r = await call(`/api/student/${s1.token}/relations`, 'PUT', { relations: { [s2.id]: { type: 'good' }, [s3.id]: { type: 'bad', tags: ['tease'] } } });
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
