// 다양한 짝: 지난 회차 자리표(pastSeatings)와 options.variety, AI 프롬프트의 지난 짝꿍 섹션
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { FileStore } from '../server/store.js';
import { buildSeatingPrompt } from '../server/ai.js';
import { deskmatePairs, neighborPairs, seatedPairs } from '../public/js/seat-geometry.js';

const STUDENTS = [{ id: 'a', name: '김하늘' }, { id: 'b', name: '이도윤' }, { id: 'c', name: '박서연' }, { id: 'd', name: '최지우' }];
const LAYOUT = { blocks: [{ cols: 2, rows: 2 }] };

describe('좌석 인접 규칙 (seat-geometry)', () => {
  test('짝꿍·앞뒤·대각선·통로 건너와 짝꿍 쌍', () => {
    const layout = { blocks: [{ cols: 2, rows: 2 }, { cols: 1, rows: 2 }] };
    const labels = neighborPairs(layout).map((p) => p[3]);
    assert.deepEqual([...new Set(labels)].sort(), ['대각선', '앞뒤', '짝꿍', '통로 건너']);
    const seats = { 'b0-r0-c0': 'a', 'b0-r0-c1': 'b', 'b0-r1-c0': 'c', 'b1-r0-c0': 'd' };
    assert.deepEqual(deskmatePairs(layout, seats), [['a', 'b']]);
    assert.deepEqual(seatedPairs(layout, seats).map((p) => `${p.a}-${p.b}:${p.label}`).sort(), ['a-b:짝꿍', 'a-c:앞뒤', 'b-c:대각선', 'b-d:통로 건너']);
  });
});

describe('AI 프롬프트의 지난 짝꿍', () => {
  const base = { students: STUDENTS, relations: [], pairs: [], teacherNotes: { students: {}, rules: [] }, profiles: {}, bodies: {}, roles: [], roleAssignment: {}, aiAnalysis: null, layout: LAYOUT, fixedSeats: {}, zones: {}, climate: 'off', roleSeats: {} };
  test('가명으로 회차별 한 줄, 실명·id 없음, 최대 3개, 상관없음이면 섹션 없음', () => {
    const past = [
      { roundName: '2026년 9월 김하늘', pairs: [['a', 'b'], ['c', 'd'], ['a', 'b']] },
      { roundName: '2026년 8월', pairs: [['a', 'c']] },
      { roundName: '2026년 7월', pairs: [['b', 'd']] },
      { roundName: '2026년 6월', pairs: [['a', 'd']] },
    ];
    const { user, system } = buildSeatingPrompt({ ...base, options: { friends: 'any', variety: 'on' }, pastDeskmates: past });
    assert.ok(user.includes('## 지난 자리표의 짝꿍'));
    assert.ok(user.includes('- 2026년 9월 S1: S1·S2, S3·S4'), '회차 이름 속 실명도 가명, 중복 쌍 제거');
    assert.ok(user.includes('- 2026년 8월: S1·S3') && user.includes('- 2026년 7월: S2·S4'));
    assert.ok(!user.includes('2026년 6월'), '최대 3개');
    for (const n of ['김하늘', '이도윤', '박서연', '최지우']) assert.ok(!user.includes(n), n);
    assert.ok(user.includes('지난 자리와 다른 짝(다양한 짝): 우선'));
    assert.ok(system.includes('다양한 짝') && system.includes('③ 선생님이 표시한 앞자리 필요 ④ 지난 회차 자리표와 다른 짝꿍'));
    const off = buildSeatingPrompt({ ...base, options: { friends: 'any', variety: 'off' }, pastDeskmates: past }).user;
    assert.ok(!off.includes('지난 자리표의 짝꿍') && off.includes('지난 자리와 다른 짝(다양한 짝): 상관없음'));
    const first = buildSeatingPrompt({ ...base, options: { friends: 'any' }, pastDeskmates: [] }).user;
    assert.ok(first.includes('(없음 · 처음 자리표라 몸 특징을 그대로 반영해요)'));
  });
});

describe('지난 회차 자리표 API', () => {
  const calls = [];
  const fake = { beta: { messages: { create: async (params) => {
    calls.push(params);
    const schema = params.output_config?.format?.schema?.properties || {};
    const body = schema.assignment
      ? { pairs: [], assignment: [{ seat: 'b0-r0-c0', student: 'S1' }, { seat: 'b0-r0-c1', student: 'S3' }, { seat: 'b0-r1-c0', student: 'S2' }, { seat: 'b0-r1-c1', student: 'S4' }], explanations: [], notes: '다른 짝으로 앉혔어요.' }
      : { summary: '', pairs: [], students: [] };
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(body) }] };
  } } } };
  let server;
  let url;
  before(async () => {
    const app = createApp({ store: new FileStore(null), baseUrl: 'https://example.test', aiClient: fake });
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

  test('variety 검증과 기본값, 지난 회차 자리표는 앞선 회차만 최신 순, AI 프롬프트에 지난 짝꿍', async () => {
    const created = await call('/api/rooms', 'POST', { name: '다양한 짝반', students: STUDENTS.map((s) => s.name).join('\n'), minGood: 0, minBad: 0 });
    const t = created.json.adminToken;
    let view = await call(`/api/teacher/${t}`);
    const [a, b, c, d] = view.json.students;
    const r1 = view.json.round.id;
    assert.deepEqual(view.json.pastSeatings, [], '처음엔 지난 자리표 없음');

    let r = await call(`/api/teacher/${t}/seating`, 'PUT', { roundId: r1, layout: LAYOUT, seats: {}, options: { friends: 'any', variety: 'maybe' } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /다른 짝 옵션/);
    r = await call(`/api/teacher/${t}/seating`, 'PUT', { roundId: r1, layout: LAYOUT, seats: { 'b0-r0-c0': a.id, 'b0-r0-c1': b.id, 'b0-r1-c0': c.id, 'b0-r1-c1': d.id }, options: { friends: 'near' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.seating.options.variety, 'on', '기본값 on');
    assert.deepEqual(r.json.pastSeatings, [], '지금 회차의 자리표는 지난 자리표가 아님');

    // 2회차: 1회차 자리표가 지난 자리표로
    r = await call(`/api/teacher/${t}/rounds`, 'POST', { name: '2026년 11월' });
    assert.equal(r.status, 201, r.text);
    const r2 = r.json.round.id;
    view = await call(`/api/teacher/${t}?round=${r2}`);
    assert.equal(view.json.pastSeatings.length, 1);
    assert.equal(view.json.pastSeatings[0].roundId, r1);
    assert.equal(view.json.pastSeatings[0].seats['b0-r0-c1'], b.id);
    assert.ok(view.json.pastSeatings[0].layout.blocks.length === 1 && view.json.pastSeatings[0].savedAt);
    // 1회차를 보면 지난 자리표 없음 (앞선 회차가 없음)
    view = await call(`/api/teacher/${t}?round=${r1}`);
    assert.deepEqual(view.json.pastSeatings, []);

    // 3회차: 2회차 자리표(상관없음으로 저장)와 1회차 자리표가 최신 순. 비어 있는 자리표는 뺌
    r = await call(`/api/teacher/${t}/seating`, 'PUT', { roundId: r2, layout: LAYOUT, seats: { 'b0-r0-c0': a.id, 'b0-r0-c1': c.id }, options: { variety: 'off' } });
    assert.equal(r.json.seating.options.variety, 'off');
    r = await call(`/api/teacher/${t}/rounds`, 'POST', { name: '2026년 12월' });
    const r3 = r.json.round.id;
    r = await call(`/api/teacher/${t}/seating`, 'PUT', { roundId: r3, layout: LAYOUT, seats: {} });
    assert.equal(r.status, 200, r.text);
    r = await call(`/api/teacher/${t}/rounds`, 'POST', { name: '2027년 1월' });
    const r4 = r.json.round.id;
    view = await call(`/api/teacher/${t}?round=${r4}`);
    assert.deepEqual(view.json.pastSeatings.map((p) => p.roundId), [r2, r1], '빈 3회차는 빠지고 최신 순');

    // AI 자리 배정: 지난 짝꿍이 가명으로 들어가고 실명·id 는 없음
    calls.length = 0;
    r = await call(`/api/teacher/${t}/ai/seating`, 'POST', { roundId: r4, layout: LAYOUT, seats: {}, options: { friends: 'any', variety: 'on' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(calls.length, 1);
    const user = calls[0].messages[0].content;
    assert.ok(user.includes('## 지난 자리표의 짝꿍'));
    assert.ok(user.includes('- 2026년 11월: S1·S3'), user.slice(user.indexOf('지난 자리표의 짝꿍'), user.indexOf('지난 자리표의 짝꿍') + 200));
    assert.ok(user.includes('S1·S2') && user.includes('S3·S4'), '1회차 짝꿍');
    const dump = JSON.stringify(calls[0]);
    for (const n of [...STUDENTS.map((s) => s.name), a.id, b.id, c.id, d.id]) assert.ok(!dump.includes(n), `실명/번호가 요청에 들어감: ${n}`);
    assert.equal(r.json.aiSeating.notes, '다른 짝으로 앉혔어요.');
    // 상관없음이면 섹션 없음
    calls.length = 0;
    r = await call(`/api/teacher/${t}/ai/seating`, 'POST', { roundId: r4, layout: LAYOUT, seats: {}, options: { friends: 'any', variety: 'off' } });
    assert.equal(r.status, 200, r.text);
    assert.ok(!calls[0].messages[0].content.includes('지난 자리표의 짝꿍'));
  });
});
