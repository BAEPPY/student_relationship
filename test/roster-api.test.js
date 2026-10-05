// 명단 파일 올리기(/api/roster/parse)와 학생 여러 명 추가(/students/bulk) API 테스트
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { FileStore } from '../server/store.js';
import { makeHwpx, makeDocx } from './helpers/docgen.js';

let server;
let url;

describe('명단 파일 · 학생 여러 명 추가 API', () => {
  before(async () => {
    const app = createApp({ store: new FileStore(null), baseUrl: 'https://example.test' });
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    url = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  async function call(path, method = 'GET', body) {
    const res = await fetch(url + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text };
  }
  async function upload(path, buf, fileName) {
    const res = await fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(fileName) }, body: buf });
    return { status: res.status, json: await res.json() };
  }

  const ROSTER = [{ type: 'p', text: '3학년 2반 명단' }, { type: 'table', rows: [['번호', '이름', '성별'], ['1', '김하늘', '남'], ['2', '이도윤', '남'], ['3', '박서연', '여'], ['4', '최지우', '여']] }];

  test('POST /api/roster/parse: 한글(hwpx)·워드(docx)·텍스트 파일에서 이름 목록을 돌려준다 (저장하지 않음)', async () => {
    const hwpx = await upload('/api/roster/parse', makeHwpx(ROSTER), '명단.hwpx');
    assert.equal(hwpx.status, 200);
    assert.equal(hwpx.json.format, 'hwpx');
    assert.equal(hwpx.json.source, 'table');
    assert.deepEqual(hwpx.json.names, ['김하늘', '이도윤', '박서연', '최지우']);
    assert.deepEqual(hwpx.json.warnings, []);

    const docx = await upload('/api/roster/parse', makeDocx(ROSTER), '명단.docx');
    assert.equal(docx.json.format, 'docx');
    assert.deepEqual(docx.json.names, ['김하늘', '이도윤', '박서연', '최지우']);

    const txt = await upload('/api/roster/parse', Buffer.from('1. 김하늘\n2. 이도윤\n2. 김하늘\n', 'utf8'), '명단.txt');
    assert.equal(txt.json.format, 'txt');
    assert.equal(txt.json.source, 'lines');
    assert.deepEqual(txt.json.names, ['김하늘', '이도윤']);
    assert.match(txt.json.warnings[0], /같은 이름/);

    const none = await upload('/api/roster/parse', Buffer.from('안녕하세요\n반갑습니다\n', 'utf8'), '메모.txt');
    assert.equal(none.status, 200);
    assert.deepEqual(none.json.names, []);
    assert.equal(none.json.source, null);
    assert.match(none.json.warnings[0], /명단을 찾지 못했어요/);
  });

  test('POST /api/roster/parse: 읽을 수 없는 파일은 400 과 안내 문구', async () => {
    const notHwp = await upload('/api/roster/parse', Buffer.from('this is not a hwp file at all'), '명단.hwp');
    assert.equal(notHwp.status, 400);
    assert.match(notHwp.json.error, /한글/);
    const exe = await upload('/api/roster/parse', Buffer.from('x'), 'a.exe');
    assert.equal(exe.status, 400);
    assert.match(exe.json.error, /지원하지 않아요/);
    const pdf = await upload('/api/roster/parse', Buffer.from('%PDF-1.4 ...'), 'a.pdf');
    assert.equal(pdf.status, 400);
    assert.match(pdf.json.error, /PDF/);
    const empty = await fetch(`${url}/api/roster/parse`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' } });
    assert.equal(empty.status, 400);
    assert.match((await empty.json()).error, /비어/);
  });

  test('POST /students/bulk: 새 이름만 추가하고 이미 있는 이름은 건너뛰며, 교사 화면에도 반영된다', async () => {
    const created = await call('/api/rooms', 'POST', { name: '3학년 2반', students: '김하늘\n이도윤', minGood: 1, minBad: 1 });
    assert.equal(created.status, 201);
    const t = created.json.adminToken;

    const r = await call(`/api/teacher/${t}/students/bulk`, 'POST', { names: ['김하늘', '박서연', '최지우'] });
    assert.equal(r.status, 201);
    assert.deepEqual(r.json.added, ['박서연', '최지우']);
    assert.deepEqual(r.json.skipped, ['김하늘']);
    assert.deepEqual(r.json.students.map((s) => s.name), ['김하늘', '이도윤', '박서연', '최지우']);
    assert.ok(r.json.room && r.json.round, '교사 화면(view) 모양으로 돌려줌');

    const again = await call(`/api/teacher/${t}/students/bulk`, 'POST', { names: ['박서연'] });
    assert.equal(again.status, 200, '추가된 학생이 없으면 200');
    assert.deepEqual(again.json.added, []);
    assert.deepEqual(again.json.skipped, ['박서연']);

    const view = await call(`/api/teacher/${t}`);
    assert.equal(view.status, 200);
    assert.deepEqual(view.json.students.map((s) => s.name), ['김하늘', '이도윤', '박서연', '최지우']);
    assert.ok(view.json.students.every((s) => s.id && s.url), '새 학생도 링크(QR)를 가짐');

    // 잘못된 요청: 빈 목록, 요청 안의 중복, 너무 긴 이름, 80명 초과
    assert.equal((await call(`/api/teacher/${t}/students/bulk`, 'POST', { names: [] })).status, 400);
    const dup = await call(`/api/teacher/${t}/students/bulk`, 'POST', { names: ['한지민', '한지민'] });
    assert.equal(dup.status, 400);
    assert.match(dup.json.error, /같은 이름이 두 번/);
    const long = await call(`/api/teacher/${t}/students/bulk`, 'POST', { names: ['가'.repeat(31)] });
    assert.equal(long.status, 400);
    assert.match(long.json.error, /이하로/);
    const many = await call(`/api/teacher/${t}/students/bulk`, 'POST', { names: Array.from({ length: 77 }, (_, i) => `학생${i + 1}`) });
    assert.equal(many.status, 400, '4명 + 77명 > 80명');
    assert.match(many.json.error, /최대 80명/);
    assert.equal((await call(`/api/teacher/${t}`)).json.students.length, 4, '거부된 요청은 아무것도 바꾸지 않음');
    assert.equal((await call('/api/teacher/wrong-token/students/bulk', 'POST', { names: ['김하늘'] })).status, 404);
  });
});
