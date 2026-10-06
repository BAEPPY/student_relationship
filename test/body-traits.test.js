// 몸 특징(시력·키·추위·더위)과 자리 환경(냉난방기 바람 자리) 테스트
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { FileStore } from '../server/store.js';
import { BODY_TRAITS, validateBody, bodyLabels } from '../server/roles.js';

describe('몸 특징 검증', () => {
  test('정해진 선택지만 받고, 비운 값은 빼고, 모르는 항목·값은 거절', () => {
    assert.deepEqual(validateBody(undefined), {});
    assert.deepEqual(validateBody({ sight: 'poor', height: '', cold: null, heat: 'ok' }), { sight: 'poor', heat: 'ok' });
    assert.throws(() => validateBody({ sight: 'blind' }), /몸 특징/);
    assert.throws(() => validateBody({ wings: 'yes' }), /몸 특징/);
    assert.throws(() => validateBody(['sight']), /몸 특징/);
    assert.equal(BODY_TRAITS.length, 4);
    for (const t of BODY_TRAITS) assert.equal(t.options.length, 3, `${t.id} 선택지 3개`);
    assert.deepEqual(bodyLabels({ sight: 'poor', height: 'mid', cold: 'yes', heat: 'no' }), ['👓 눈 나쁨', '❄️ 추위 잘 탐', '더위 안 탐']);
    assert.deepEqual(bodyLabels({}), []);
  });
});

describe('몸 특징 · 자리 환경 API', () => {
  let server;
  let url;
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

  test('학생이 설문에서 고른 몸 특징은 학생 정보에 남고, 회차가 바뀌어도 유지된다', async () => {
    const created = await call('/api/rooms', 'POST', { name: '특징반', students: '김하늘\n이도윤\n박서연', minGood: 0, minBad: 0 });
    const t = created.json.adminToken;
    let view = await call(`/api/teacher/${t}`);
    const [s1, s2] = view.json.students;
    const roundId = view.json.round.id;
    assert.deepEqual(s1.body, {}, '처음엔 비어 있음');
    assert.equal(view.json.bodyTraits.length, 4, '선생님 화면에도 항목 정의');

    let me = await call(`/api/student/${s1.token}`);
    assert.deepEqual(me.json.me.body, {});
    assert.equal(me.json.bodyTraits.length, 4, '학생 화면에 항목 정의');

    const profile = { traits: ['quiet'], partnerTraits: [], partnerText: '', roundId };
    let r = await call(`/api/student/${s1.token}/profile`, 'PUT', { ...profile, body: { sight: 'poor', cold: 'yes', height: 'mid' } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.me.body, { sight: 'poor', cold: 'yes', height: 'mid' });
    assert.deepEqual(r.json.profile.traits, ['quiet'], '성향 설문도 같이 저장');

    r = await call(`/api/student/${s1.token}/profile`, 'PUT', { ...profile, body: { sight: 'super' } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /몸 특징/);
    r = await call(`/api/student/${s1.token}/profile`, 'PUT', { ...profile, body: { nope: 'yes' } });
    assert.equal(r.status, 400);

    // body 를 보내지 않으면 그대로 둠 (예전 화면 호환)
    r = await call(`/api/student/${s1.token}/profile`, 'PUT', profile);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.me.body, { sight: 'poor', cold: 'yes', height: 'mid' });

    view = await call(`/api/teacher/${t}`);
    assert.deepEqual(view.json.students[0].body, { sight: 'poor', cold: 'yes', height: 'mid' });
    assert.deepEqual(view.json.students[1].body, {});

    // 새 회차를 시작해도 몸 특징은 그대로, 성향 설문은 새로
    r = await call(`/api/teacher/${t}/rounds`, 'POST', { name: '2026년 11월' });
    assert.equal(r.status, 201, r.text);
    view = await call(`/api/teacher/${t}`);
    assert.deepEqual(view.json.students[0].body, { sight: 'poor', cold: 'yes', height: 'mid' });
    assert.equal(view.json.profiles[s1.id], undefined);
    me = await call(`/api/student/${s2.token}`);
    assert.deepEqual(me.json.me.body, {});
    // 다른 학생이 값을 지우면 빈 값으로
    r = await call(`/api/student/${s1.token}/profile`, 'PUT', { ...profile, roundId: view.json.round.id, body: {} });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.me.body, {});
  });

  test('자리 환경: 바람 자리와 냉난방 상태를 저장하고, 잘못된 값은 거절', async () => {
    const created = await call('/api/rooms', 'POST', { name: '바람반', students: '김하늘\n이도윤', minGood: 0, minBad: 0 });
    const t = created.json.adminToken;
    const view = await call(`/api/teacher/${t}`);
    const [a] = view.json.students;
    let r = await call(`/api/teacher/${t}/seating`, 'PUT', { layout: { blocks: [{ cols: 2, rows: 2 }] }, seats: { 'b0-r0-c0': a.id }, zones: { 'b0-r1-c1': 'ac', 'b0-r0-c1': '' }, climate: 'cool' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.seating.zones, { 'b0-r1-c1': 'ac' });
    assert.equal(r.json.seating.climate, 'cool');
    r = await call(`/api/teacher/${t}/seating`, 'PUT', { layout: { blocks: [{ cols: 2, rows: 2 }] }, seats: {}, zones: { 'b0-r1-c1': 'window' } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /자리 환경/);
    r = await call(`/api/teacher/${t}/seating`, 'PUT', { layout: { blocks: [{ cols: 2, rows: 2 }] }, seats: {}, zones: { 'x': 'ac' } });
    assert.equal(r.status, 400);
    r = await call(`/api/teacher/${t}/seating`, 'PUT', { layout: { blocks: [{ cols: 2, rows: 2 }] }, seats: {}, climate: 'tropical' });
    assert.equal(r.status, 200);
    assert.equal(r.json.seating.climate, 'off', '모르는 값은 꺼짐으로');
    assert.deepEqual(r.json.seating.zones, {});
  });

  test('종합 보고서에 학생 특징과 바람 자리가 들어간다', async () => {
    const created = await call('/api/rooms', 'POST', { name: '보고반', students: '김하늘\n이도윤\n박서연', minGood: 0, minBad: 0 });
    const t = created.json.adminToken;
    let view = await call(`/api/teacher/${t}`);
    const [a, b] = view.json.students;
    const roundId = view.json.round.id;
    await call(`/api/student/${a.token}/profile`, 'PUT', { traits: ['quiet'], partnerTraits: [], partnerText: '', roundId, body: { sight: 'poor', cold: 'yes' } });
    await call(`/api/student/${b.token}/profile`, 'PUT', { traits: ['quiet'], partnerTraits: [], partnerText: '', roundId, body: { height: 'tall', heat: 'yes' } });
    await call(`/api/teacher/${t}/seating`, 'PUT', { layout: { blocks: [{ cols: 2, rows: 1 }] }, seats: { 'b0-r0-c0': a.id, 'b0-r0-c1': b.id }, zones: { 'b0-r0-c1': 'ac' }, climate: 'warm' });
    const r = await call(`/api/teacher/${t}/report.json`);
    assert.equal(r.status, 200, r.text);
    const doc = r.json;
    const seatmap = doc.blocks.find((x) => x.type === 'seatmap');
    assert.equal(seatmap.climate, 'warm');
    assert.deepEqual(seatmap.blocks[0].zones, [['', 'ac']]);
    assert.ok(doc.blocks.some((x) => x.type === 'paragraph' && /🌀 표시는 냉난방기 바람 자리\(1개\) · 지금 난방 중/.test(x.text)));
    const memo = doc.blocks.find((x) => x.type === 'list' && x.items.some((i) => /눈이 나쁜 편/.test(i)));
    assert.ok(memo, '학생 특징 목록');
    assert.deepEqual(memo.items, ['👓 눈이 나쁜 편: 김하늘', '📏 키가 큰 편: 이도윤', '❄️ 추위를 잘 타는 편: 김하늘', '🔥 더위를 잘 타는 편: 이도윤']);
    assert.ok(doc.blocks.some((x) => x.type === 'heading' && x.level === 3 && /자리 배정 참고/.test(x.text)));
    // 한글 파일: 바람 자리 표시가 글로
    const res = await fetch(`${url}/api/teacher/${t}/report.hwpx`);
    const buf = Buffer.from(await res.arrayBuffer());
    const { extractDocument, documentToText } = await import('../server/docfiles.js');
    const text = documentToText(extractDocument(buf, 'a.hwpx'));
    assert.ok(text.includes('(냉난방 바람)'), '한글 파일 자리표에 바람 자리 표시');
    assert.ok(text.includes('눈이 나쁜 편: 김하늘'));
  });
});
