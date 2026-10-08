// AI 자리 배정: 프롬프트(가명 처리·좌석 설명), 결과 매핑, 보정(repairSeating), API 흐름
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeatingPrompt, aiAssignSeats, createAiClient } from '../server/ai.js';
import { repairSeating, layoutSeats } from '../server/seating.js';
import { createApp } from '../server/app.js';
import { FileStore } from '../server/store.js';

const STUDENTS = [
  { id: 'st_a1', name: '김하늘' },
  { id: 'st_b2', name: '이도윤' },
  { id: 'st_c3', name: '박서연' },
  { id: 'st_d4', name: '최지우' },
];
const REAL_NAMES = STUDENTS.map((s) => s.name);
const REAL_IDS = STUDENTS.map((s) => s.id);
const GIVEN_NAMES = ['하늘', '도윤', '서연', '지우'];
const LAYOUT = { blocks: [{ cols: 2, rows: 2 }, { cols: 1, rows: 1 }] }; // 좌석 5개

function assertNoRealData(dump) {
  for (const n of [...REAL_NAMES, ...REAL_IDS, ...GIVEN_NAMES]) assert.ok(!dump.includes(n), `실명/학생 id 가 프롬프트에 들어감: ${n}`);
}

const input = (ai) => ({
  ai,
  students: STUDENTS,
  relations: [
    { from: 'st_a1', to: 'st_b2', type: 'bad', tags: ['tease'], reason: '이도윤이 자꾸 놀려요. 도윤이가 싫어요.' },
    { from: 'st_c3', to: 'st_a1', type: 'good', tags: ['fun'], reason: '하늘이랑 놀면 재밌어요' },
  ],
  pairs: [{ a: 'st_a1', b: 'st_b2', ab: 'bad', ba: 'none', probability: 61, level: 'high', factors: [{ label: '김하늘 → 이도윤 한쪽만 안 좋은 사이로 표시함', delta: 0, kind: 'base' }, { label: '안 좋은 이유의 심각도 (놀리거나 험담해요)', delta: 10, kind: 'severity' }] }],
  teacherNotes: {
    students: { st_c3: { front: true, memo: '최지우와 짝이면 수다가 많음' } },
    rules: [{ type: 'apart', a: 'st_a1', b: 'st_b2', note: '지난달 다툼' }, { type: 'together', a: 'st_c3', b: 'st_d4', note: '' }],
  },
  profiles: { st_a1: { traits: ['quiet'], partnerTraits: ['listens'], partnerText: '서연이랑 앉고 싶어요' } },
  bodies: { st_b2: { sight: 'poor', cold: 'yes', height: 'mid' }, st_d4: { height: 'tall' } },
  roles: [{ id: 'announcer', name: '오늘의 아나운서' }, { id: 'door', name: '김하늘 도우미' }],
  roleAssignment: { door: ['st_d4'], announcer: ['st_b2'] },
  aiAnalysis: { pairs: [{ a: 'st_a1', b: 'st_b2', riskLevel: 'high', conflictType: '놀림', analysis: '김하늘이 이도윤의 장난에 속상해해요.', advice: '자리를 떨어뜨려요.' }] },
  layout: LAYOUT,
  fixedSeats: { 'b0-r1-c1': 'st_c3' },
  zones: { 'b0-r0-c1': 'ac' },
  climate: 'cool',
  roleSeats: { 'b1-r0-c0': 'door' },
  options: { friends: 'near' },
  isolated: ['st_b2'],
});

function fakeClient(reply) {
  const calls = [];
  const create = async (params) => {
    calls.push(params);
    if (typeof reply === 'function') return reply(params);
    return reply;
  };
  return { client: { beta: { messages: { create } } }, calls };
}
const textMessage = (obj, stop_reason = 'end_turn') => ({ stop_reason, content: [{ type: 'text', text: JSON.stringify(obj) }] });

describe('자리 배정 프롬프트 (buildSeatingPrompt)', () => {
  test('실명·id·메모 속 이름이 없고, 좌석 설명·고정·역할 자리·바람 자리·앞자리·갈등 % 가 들어감', () => {
    const { system, user, schema, truncated } = buildSeatingPrompt(input(null));
    assertNoRealData(system + user + JSON.stringify(schema));
    assert.equal(truncated, false);
    // 좌석 설명 (분단·줄·칸을 한국어로)
    assert.match(user, /- b0-r0-c0: 1분단 1번째 줄 왼쪽\(앞줄\)/);
    assert.match(user, /- b0-r0-c1: 1분단 1번째 줄 오른쪽\(앞줄\) · 🌀 바람 자리\(냉방 중\)/);
    assert.match(user, /- b0-r1-c1: 1분단 2번째 줄 오른쪽\(앞줄\) · 📌 고정\(S3\)/);
    assert.match(user, /- b1-r0-c0: 2분단 1번째 줄\(앞줄\) · 🎒 역할 자리\(\[door\] S1 도우미 → 담당 S4\)/, '역할 이름 속 실명도 가명으로');
    assert.match(user, /자리 수: 5개, 학생 수: 4명/);
    assert.match(user, /짝꿍: 같은 분단, 같은 줄의 바로 옆 칸/);
    assert.match(user, /통로 건너/);
    // 조건·규칙·메모
    assert.match(user, /친한 친구\(좋은 사이\)끼리: 가까이 앉히기/);
    assert.match(user, /냉난방기: 지금 냉방 중/);
    assert.match(user, /- S1 · S2: 떨어뜨리기 \("지난달 다툼"\)/);
    assert.match(user, /- S3 · S4: 가까이 앉히기/);
    assert.match(user, /- S3 · 자리: 앞쪽 희망 \/ 메모: "S4와 짝이면 수다가 많음"/);
    // 역할 배정 · 몸 특징 · 고립
    assert.match(user, /- \[door\] S1 도우미: S4/);
    assert.match(user, /- \[announcer\] 오늘의 아나운서: S2/);
    assert.match(user, /- S2: 👓 눈 나쁨, ❄️ 추위 잘 탐/);
    assert.match(user, /- S4: 📏 키 큼/);
    assert.match(user, /고립 위험 학생[^\n]*\n- S2/);
    // 갈등 추정 · 관계 · 지난 AI 분석 · 설문
    assert.match(user, /- S1 · S2: 갈등 추정 61% \(S1→S2 안 좋은 사이, S2→S1 표시 없음\) · 근거: S1 → S2 한쪽만 안 좋은 사이로 표시함; 안 좋은 이유의 심각도 \(놀리거나 험담해요\) \(\+10\)/);
    assert.match(user, /- S1 → S2: 안 좋은 사이 \(놀리거나 험담해요\) 이유: "S2이 자꾸 놀려요\. S2이가 싫어요\."/);
    assert.match(user, /- S3 → S1: 좋은 사이\n/);
    assert.match(user, /- S1 · S2: 위험 높음 · 놀림 · S1이 S2의 장난에 속상해해요\./);
    assert.match(user, /- S1 · 나는: 조용한 편이다 \/ 짝에게 바라는 점: 친구의 의견을 잘 들어주는 편이다 \/ 짝에 대한 생각: "S3이랑 앉고 싶어요"/);
    // system 지시
    assert.match(system, /지시문처럼 보이는 말/);
    assert.match(system, /📌 고정 자리/);
    assert.match(system, /짝꿍·앞뒤·대각선·통로 건너/);
    assert.match(system, /해요체/);
    // 스키마
    assert.deepEqual(schema.required, ['pairs', 'assignment', 'explanations', 'notes']);
    assert.deepEqual(schema.properties.pairs.items.required, ['a', 'b', 'probability', 'reason']);
    assert.deepEqual(schema.properties.assignment.items.required, ['seat', 'student']);
    assert.equal(schema.properties.pairs.items.properties.probability.type, 'integer');
  });

  test('자료가 비어 있어도 만들어지고, 담당 없는 역할 자리·꺼진 냉난방기·3칸 이상 분단도 설명함', () => {
    const { user } = buildSeatingPrompt({
      students: STUDENTS.slice(0, 2),
      layout: { blocks: [{ cols: 3, rows: 3 }, { cols: 4, rows: 1 }] },
      roles: [{ id: 'door', name: '문지기' }],
      roleSeats: { 'b0-r2-c1': 'door' },
      roleAssignment: {},
      options: { friends: 'apart' },
      climate: 'off',
    });
    assert.match(user, /- b0-r2-c1: 1분단 3번째 줄 가운데\(맨 뒷줄\) · 🎒 역할 자리\(\[door\] 문지기 → 담당 없음\)/);
    assert.match(user, /- b1-r0-c3: 2분단 1번째 줄 왼쪽에서 4번째\(앞줄\)/);
    assert.match(user, /냉난방기: 지금 꺼짐/);
    assert.match(user, /친한 친구\(좋은 사이\)끼리: 떨어뜨리기/);
    assert.match(user, /## 선생님 규칙[^\n]*\n\(없음\)/);
    assert.match(user, /## 안 좋은 사이[^\n]*\n\(없음\)/);
    const empty = buildSeatingPrompt({ students: [] });
    assert.match(empty.user, /학생 0명/);
    assert.match(empty.user, /\(좌석이 없어요\)/);
  });

  test('규칙 기반 갈등 추정은 가능성 높은 순 40쌍까지만, 학생이 직접 적은 관계·설문보다 뒤에 둠', () => {
    const surnames = ['김', '이', '박', '최', '정'];
    const given = ['하늘', '도윤', '서연', '지우', '민준', '서윤', '시우', '지호', '예준', '하은', '지민', '수아'];
    const students = surnames.flatMap((s) => given.map((g) => ({ id: `id_${s}${g}`, name: `${s}${g}` })));   // 60명
    const pairs = [];
    for (let i = 1; i <= 100; i++) {
      const a = students[i % 60].id;
      const b = students[(i * 7 + 1) % 60].id;
      if (a !== b) pairs.push({ a, b, ab: 'bad', ba: 'none', probability: i, level: 'low', factors: [{ label: `근거 ${i}`, delta: 1 }] });
    }
    const { user, truncated } = buildSeatingPrompt({
      students,
      pairs,
      relations: [{ from: students[0].id, to: students[1].id, type: 'bad', tags: ['tease'], reason: '자꾸 놀려요' }],
      profiles: { [students[2].id]: { traits: ['quiet'], partnerTraits: [], partnerText: '조용한 친구가 좋아요' } },
      aiAnalysis: { pairs: [{ a: students[0].id, b: students[1].id, riskLevel: 'high', conflictType: '놀림', analysis: '자주 다퉈요.' }] },
      layout: LAYOUT,
    });
    assert.equal(truncated, false);
    const estimateLines = user.match(/^- S\d+ · S\d+: 갈등 추정 \d+%/gm) || [];
    assert.equal(estimateLines.length, 40, '상위 40쌍만');
    assert.match(user, /갈등 추정 100%/);
    assert.match(user, /갈등 추정 61%/);
    assert.doesNotMatch(user, /갈등 추정 60%/);
    assert.match(user, /## 규칙 기반 갈등 추정 \(참고값 · 가능성 높은 순 최대 40쌍\)/);
    const at = (title) => { const i = user.indexOf(`## ${title}`); assert.ok(i >= 0, `${title} 섹션이 있어야 함`); return i; };
    assert.ok(at('안 좋은 사이') < at('좋은 사이'));
    assert.ok(at('좋은 사이') < at('성향 설문'));
    assert.ok(at('성향 설문') < at('규칙 기반 갈등 추정'), '학생이 적은 자료가 파생값보다 앞');
    assert.ok(at('규칙 기반 갈등 추정') < at('지난 AI 관계 분석'));
  });
});

describe('자리 배정 호출 (aiAssignSeats)', () => {
  const canned = {
    pairs: [
      { a: 'S1', b: 'S2', probability: 120, reason: 'S2가 S1을 자주 놀려요.' },
      { a: 'S2', b: 'S1', probability: 10, reason: '중복' },
      { a: 'S9', b: 'S1', probability: 50, reason: '모르는 가명' },
      { a: 'S3', b: 'S3', probability: 50, reason: '같은 학생' },
      { a: 'S3', b: 'S4', probability: -5, reason: '' },
      { a: 'S4', b: 'S1', probability: 'many', reason: '숫자 아님' },
    ],
    assignment: [
      { seat: 'b0-r0-c0', student: 'S1' },
      { seat: 'b0-r0-c1', student: 'S2' },
      { seat: 'b0-r0-c1', student: 'S3' },     // 같은 자리 두 번 → 뒤의 것은 버림
      { seat: 'b0-r1-c0', student: 'S1' },     // 같은 학생 두 번 → 버림
      { seat: 'b9-r9-c9', student: 'S4' },     // 없는 좌석
      { seat: 'b1-r0-c0', student: 'S77' },    // 모르는 가명
      { seat: 'b0-r1-c1', student: 'S4' },
    ],
    explanations: [
      { student: 'S1', text: 'S1은 앞줄이 필요해서 앞에 앉았어요.' },
      { student: 'S77', text: '유령' },
      { student: 'S1', text: '중복' },
      { student: 'S2', text: '' },
    ],
    notes: 'S2와 S1은 떨어뜨렸어요.',
  };

  test('요청 형식과 결과 매핑: 가명→id, 모르는 가명·좌석·중복은 버림, 확률은 2~97 정수, 글은 실명으로', async () => {
    const { client, calls } = fakeClient(textMessage(canned));
    const ai = createAiClient({ apiKey: '', client, model: 'test-model' });
    const result = await aiAssignSeats(input(ai));
    assert.equal(calls.length, 1);
    const params = calls[0];
    assert.equal(params.model, 'test-model');
    assert.equal(params.max_tokens, 24000);
    assert.equal(params.output_config.format.type, 'json_schema');
    assert.deepEqual(params.output_config.format.schema.required, ['pairs', 'assignment', 'explanations', 'notes']);
    assert.equal(params.fallbacks, 'default');
    assertNoRealData(JSON.stringify(params));

    assert.deepEqual(result.pairs, [
      { a: 'st_a1', b: 'st_b2', probability: 97, reason: '이도윤가 김하늘을 자주 놀려요.' },
      { a: 'st_d4', b: 'st_a1', probability: 50, reason: '숫자 아님' },
      { a: 'st_c3', b: 'st_d4', probability: 2, reason: '' },
    ]);
    assert.deepEqual(result.assignment, { 'b0-r0-c0': 'st_a1', 'b0-r0-c1': 'st_b2', 'b0-r1-c1': 'st_d4' });
    assert.deepEqual(result.explanations, { st_a1: '김하늘은 앞줄이 필요해서 앞에 앉았어요.' });
    assert.equal(result.notes, '이도윤와 김하늘은 떨어뜨렸어요.');
    assert.equal(result.truncated, false);
  });

  test('refusal → 422, max_tokens → 502, SDK 401 → 502(키 안내), ai 없음 → 503', async () => {
    await assert.rejects(aiAssignSeats(input(createAiClient({ apiKey: '', client: fakeClient({ stop_reason: 'refusal', content: [] }).client }))), (e) => e.status === 422);
    await assert.rejects(aiAssignSeats(input(createAiClient({ apiKey: '', client: fakeClient(textMessage(canned, 'max_tokens')).client }))), (e) => e.status === 502);
    const bad = fakeClient(() => { const e = new Error('401'); e.status = 401; return Promise.reject(e); }).client;
    await assert.rejects(aiAssignSeats(input(createAiClient({ apiKey: '', client: bad }))), (e) => e.status === 502 && /ANTHROPIC_API_KEY/.test(e.message));
    await assert.rejects(aiAssignSeats(input(null)), (e) => e.status === 503);
  });
});

describe('배정안 보정 (repairSeating)', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const students = ids.map((id) => ({ id, name: id }));

  test('layoutSeats: 분단 → 줄 → 칸 순서', () => {
    assert.deepEqual(layoutSeats(LAYOUT).map((s) => s.id), ['b0-r0-c0', 'b0-r0-c1', 'b0-r1-c0', 'b0-r1-c1', 'b1-r0-c0']);
    assert.deepEqual(layoutSeats(null), []);
  });

  test('고정 자리는 그대로, 역할 자리에는 담당 학생을 옮겨 앉히고, 밀려난 학생은 빈자리 앞줄부터', () => {
    const { seats, warnings } = repairSeating({
      assignment: { 'b0-r0-c0': 'a', 'b0-r0-c1': 'd', 'b0-r1-c0': 'c', 'b0-r1-c1': 'b', 'b1-r0-c0': 'a' },
      students,
      layout: LAYOUT,
      fixedSeats: { 'b0-r1-c1': 'c' },
      roleSeats: { 'b1-r0-c0': 'door' },
      roleAssignment: { door: ['d'] },
    });
    assert.deepEqual(seats, { 'b0-r0-c0': 'a', 'b0-r0-c1': 'b', 'b0-r1-c1': 'c', 'b1-r0-c0': 'd' });
    assert.deepEqual(warnings, []);
  });

  test('AI 가 역할 자리에 담당을 맞게 앉혔으면 유지하고, 담당이 여럿이면 둘 다 자리를 지킴', () => {
    const { seats } = repairSeating({
      assignment: { 'b0-r0-c0': 'c', 'b0-r0-c1': 'b', 'b0-r1-c0': 'a', 'b0-r1-c1': 'd' },
      students,
      layout: LAYOUT,
      fixedSeats: {},
      roleSeats: { 'b0-r0-c0': 'milk', 'b0-r1-c1': 'milk' },
      roleAssignment: { milk: ['d', 'c'] },
    });
    assert.deepEqual(seats, { 'b0-r0-c0': 'c', 'b0-r0-c1': 'b', 'b0-r1-c0': 'a', 'b0-r1-c1': 'd' }, '그대로');
  });

  test('담당이 없는 역할 자리는 보통 자리, 역할 자리보다 담당이 많거나 적어도 깨지지 않음', () => {
    const r1 = repairSeating({ assignment: { 'b1-r0-c0': 'a', 'b0-r0-c0': 'b' }, students, layout: LAYOUT, fixedSeats: {}, roleSeats: { 'b1-r0-c0': 'door' }, roleAssignment: {} });
    assert.equal(r1.seats['b1-r0-c0'], 'a', '담당 없음 → AI 배정 그대로');
    assert.equal(Object.keys(r1.seats).length, 4);
    // 담당 3명, 역할 자리 1개 → 한 명만 역할 자리, 나머지는 보통 자리
    const r2 = repairSeating({ assignment: {}, students, layout: LAYOUT, fixedSeats: {}, roleSeats: { 'b1-r0-c0': 'door' }, roleAssignment: { door: ['b', 'c', 'd', 'ghost'] } });
    assert.equal(r2.seats['b1-r0-c0'], 'b');
    assert.equal(new Set(Object.values(r2.seats)).size, 4);
    // 담당 1명, 역할 자리 3개 → 한 자리만 담당, 나머지는 보통 자리
    const r3 = repairSeating({ assignment: {}, students, layout: LAYOUT, fixedSeats: {}, roleSeats: { 'b0-r0-c0': 'door', 'b0-r0-c1': 'door', 'b1-r0-c0': 'door' }, roleAssignment: { door: ['d'] } });
    assert.equal(r3.seats['b0-r0-c0'], 'd');
    assert.equal(new Set(Object.values(r3.seats)).size, 4);
    // 고정 자리와 역할 자리가 겹치면 고정이 이김
    const r4 = repairSeating({ assignment: {}, students, layout: LAYOUT, fixedSeats: { 'b1-r0-c0': 'a' }, roleSeats: { 'b1-r0-c0': 'door' }, roleAssignment: { door: ['d'] } });
    assert.equal(r4.seats['b1-r0-c0'], 'a');
  });

  test('배치에 없는 좌석·명단에 없는 학생은 버리고, 자리 없는 학생은 앞줄부터 채움', () => {
    const { seats, warnings } = repairSeating({
      assignment: { 'b7-r0-c0': 'a', 'b0-r1-c1': 'zz', 'b0-r1-c0': 'b' },
      students,
      layout: LAYOUT,
    });
    // b 는 그대로, a·c·d 는 빈자리 앞줄부터 (b0-r0-c0, b0-r0-c1, b1-r0-c0)
    assert.deepEqual(seats, { 'b0-r1-c0': 'b', 'b0-r0-c0': 'a', 'b0-r0-c1': 'c', 'b1-r0-c0': 'd' });
    assert.deepEqual(warnings, []);
    const empty = repairSeating({ assignment: {}, students, layout: { blocks: [{ cols: 2, rows: 1 }, { cols: 1, rows: 2 }] } });
    assert.deepEqual(empty.seats, { 'b0-r0-c0': 'a', 'b0-r0-c1': 'b', 'b1-r0-c0': 'c', 'b1-r1-c0': 'd' }, '1번째 줄을 분단 순서로 먼저 채움');
  });

  test('자리가 모자라면 경고', () => {
    const { seats, warnings } = repairSeating({ assignment: { 'b0-r0-c0': 'd' }, students, layout: { blocks: [{ cols: 2, rows: 1 }] } });
    assert.deepEqual(seats, { 'b0-r0-c0': 'd', 'b0-r0-c1': 'a' });
    assert.deepEqual(warnings, ['자리가 2개 부족해요.']);
    const none = repairSeating({ students, layout: null });
    assert.deepEqual(none.seats, {});
    assert.deepEqual(none.warnings, ['자리가 4개 부족해요.']);
  });
});

describe('AI 자리 배정 API (가짜 클라이언트)', () => {
  const NAMES = ['김하늘', '이도윤', '박서연'];
  const calls = [];
  let reply = null;           // 자리 배정 스키마(assignment 가 있음)로 부르면 이 답을
  let analysisReply = null;   // 관계 분석 스키마(summary 가 있음)로 부르면 이 답을
  const fake = {
    beta: {
      messages: {
        create: async (params) => {
          calls.push(params);
          const schema = params.output_config?.format?.schema?.properties || {};
          assert.ok(schema.pairs, '자리 배정 또는 관계 분석 스키마로 호출');
          const body = schema.assignment ? reply : analysisReply;
          assert.ok(body, '가짜 응답이 준비돼 있어야 함');
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(body) }] };
        },
      },
    },
  };
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

  test('역할 자리 검증 · AI 배정안 저장 · room.seating 은 그대로 · 학생 삭제 시 정리', async () => {
    const created = await call('/api/rooms', 'POST', { name: 'AI 자리반', students: NAMES.join('\n'), minGood: 0, minBad: 0 });
    assert.equal(created.status, 201);
    const t = created.json.adminToken;
    let view = await call(`/api/teacher/${t}/roles/default`, 'POST');
    assert.equal(view.status, 200);
    assert.equal(view.json.aiSeating, null, '처음엔 AI 배정안 없음');
    const [s1, s2, s3] = view.json.students;
    const roundId = view.json.round.id;
    // 1인 1역: 아나운서 = 김하늘 (초안)
    view = await call(`/api/teacher/${t}/roles/assignment`, 'PUT', { roundId, assignments: { announcer: [s1.id] } });
    assert.equal(view.status, 200, view.text);
    await call(`/api/teacher/${t}/notes`, 'PUT', { notes: { [s3.id]: { front: true, memo: '박서연은 이도윤과 자주 다툼' } }, rules: [] });

    // 역할 자리 검증 (PUT /seating)
    const layout = { blocks: [{ cols: 2, rows: 2 }] };
    let r = await call(`/api/teacher/${t}/seating`, 'PUT', { layout, seats: {}, roleSeats: { 'b0-r0-c1': 'ghost' } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, '역할 자리에 없는 역할이 있어요.');
    r = await call(`/api/teacher/${t}/seating`, 'PUT', { layout, seats: {}, roleSeats: { 'x': 'announcer' } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, '좌석 정보가 올바르지 않아요.');
    r = await call(`/api/teacher/${t}/seating`, 'PUT', { layout, seats: { 'b0-r1-c0': s3.id }, pinned: ['b0-r1-c0'], roleSeats: { 'b0-r0-c1': 'announcer', 'b0-r1-c1': '' } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.seating.roleSeats, { 'b0-r0-c1': 'announcer' });
    assert.deepEqual(r.json.seating.seats, { 'b0-r1-c0': s3.id });
    r = await call(`/api/teacher/${t}/seating`, 'PUT', { layout, seats: {} });
    assert.deepEqual(r.json.seating.roleSeats, {}, '안 보내면 빈 객체');
    const savedSeating = { layout, seats: { 'b0-r1-c0': s3.id }, pinned: ['b0-r1-c0'], roleSeats: { 'b0-r0-c1': 'announcer' } };
    r = await call(`/api/teacher/${t}/seating`, 'PUT', savedSeating);
    assert.equal(r.status, 200);

    // AI 자리 배정: 화면의 배치(저장본과 다름)를 기준으로. 가짜 AI 는 고정·역할 자리를 틀리게 앉힘
    reply = {
      pairs: [{ a: 'S1', b: 'S2', probability: 72.4, reason: 'S1이 S2를 놀린 적이 있어요.' }, { a: 'S2', b: 'S3', probability: 35, reason: 'S3이 S2와 자주 다퉈요.' }],
      assignment: [{ seat: 'b0-r1-c0', student: 'S1' }, { seat: 'b0-r1-c1', student: 'S2' }, { seat: 'b0-r0-c1', student: 'S3' }],
      explanations: [{ student: 'S1', text: 'S1은 아나운서라 칠판 가까이 앉았어요.' }, { student: 'S3', text: 'S3은 앞자리가 필요해요.' }],
      notes: 'S2와 S3은 떨어뜨렸어요.',
    };
    calls.length = 0;
    r = await call(`/api/teacher/${t}/ai/seating`, 'POST', { roundId, layout, seats: { 'b0-r0-c0': s2.id }, pinned: ['b0-r0-c0'], zones: { 'b0-r1-c1': 'ac' }, climate: 'cool', roleSeats: { 'b0-r0-c1': 'announcer' }, options: { friends: 'near' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(calls.length, 1);
    const dump = JSON.stringify(calls[0]);
    for (const n of [...NAMES, '하늘', '도윤', '서연', s1.id, s2.id, s3.id, t]) assert.ok(!dump.includes(n), `실명/id/토큰이 요청에 들어감: ${n}`);
    const user = calls[0].messages[0].content;
    assert.match(user, /- b0-r0-c0: 1분단 1번째 줄 왼쪽\(앞줄\) · 📌 고정\(S2\)/);
    assert.match(user, /- b0-r0-c1: 1분단 1번째 줄 오른쪽\(앞줄\) · 🎒 역할 자리\(\[announcer\] 오늘의 아나운서 → 담당 S1\)/);
    assert.match(user, /- b0-r1-c1: [^\n]*🌀 바람 자리\(냉방 중\)/);
    assert.match(user, /- S3 · 자리: 앞쪽 희망 \/ 메모: "S3은 S2과 자주 다툼"/);
    assert.match(user, /친한 친구\(좋은 사이\)끼리: 가까이 앉히기/);

    const a = r.json.aiSeating;
    assert.equal(a.roundId, roundId);
    assert.equal(a.roundName, r.json.round.name);
    assert.equal(typeof a.createdAt, 'string');
    assert.equal(typeof a.model, 'string');
    assert.equal(a.truncated, false);
    assert.deepEqual(a.pairs, [
      { a: s1.id, b: s2.id, probability: 72, reason: '김하늘이 이도윤를 놀린 적이 있어요.' },
      { a: s2.id, b: s3.id, probability: 35, reason: '박서연이 이도윤와 자주 다퉈요.' },
    ]);
    // 보정: 고정 자리(S2 → b0-r0-c0) 유지, 역할 자리(b0-r0-c1)에 담당 S1 이동, 밀려난 S3 은 빈자리 앞줄부터
    assert.deepEqual(a.assignment, { 'b0-r0-c0': s2.id, 'b0-r0-c1': s1.id, 'b0-r1-c0': s3.id });
    assert.deepEqual(a.explanations, { [s1.id]: '김하늘은 아나운서라 칠판 가까이 앉았어요.', [s3.id]: '박서연은 앞자리가 필요해요.' });
    assert.equal(a.notes, '이도윤와 박서연은 떨어뜨렸어요.');
    assert.deepEqual(a.warnings, []);
    // 저장된 자리표는 그대로
    assert.deepEqual(r.json.seating.seats, savedSeating.seats);
    assert.deepEqual(r.json.seating.pinned, savedSeating.pinned);
    assert.deepEqual(r.json.seating.roleSeats, savedSeating.roleSeats);
    view = await call(`/api/teacher/${t}`);
    assert.deepEqual(view.json.seating.seats, savedSeating.seats);
    assert.deepEqual(view.json.aiSeating.assignment, a.assignment, '다시 열어도 AI 배정안이 남아 있음');

    // 검증 실패는 AI 를 부르기 전에 400
    calls.length = 0;
    r = await call(`/api/teacher/${t}/ai/seating`, 'POST', { roundId, layout, seats: {}, roleSeats: { 'b0-r0-c1': 'ghost' } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, '역할 자리에 없는 역할이 있어요.');
    r = await call(`/api/teacher/${t}/ai/seating`, 'POST', { roundId, layout: { blocks: [] }, seats: {} });
    assert.equal(r.status, 400);
    r = await call(`/api/teacher/${t}/ai/seating`, 'POST', { roundId: 'nope', layout, seats: {} });
    assert.equal(r.status, 404);
    assert.equal(calls.length, 0);

    // 자리가 모자라면 경고가 남음
    reply = { pairs: [], assignment: [{ seat: 'b0-r0-c0', student: 'S1' }], explanations: [], notes: '' };
    r = await call(`/api/teacher/${t}/ai/seating`, 'POST', { roundId, layout: { blocks: [{ cols: 2, rows: 1 }] }, seats: {} });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.aiSeating.warnings, ['자리가 1개 부족해요.']);
    assert.equal(Object.keys(r.json.aiSeating.assignment).length, 2);

    // 학생을 지우면 AI 배정안에서도 빠지고, 글 속 이름은 '(삭제된 학생)'
    reply = {
      pairs: [{ a: 'S1', b: 'S2', probability: 70, reason: 'S1이 S2를 놀려요.' }, { a: 'S2', b: 'S3', probability: 30, reason: '' }],
      assignment: [{ seat: 'b0-r0-c0', student: 'S1' }, { seat: 'b0-r0-c1', student: 'S2' }, { seat: 'b0-r1-c0', student: 'S3' }],
      explanations: [{ student: 'S1', text: 'S1은 S2와 떨어졌어요.' }, { student: 'S2', text: 'S2는 뒤에 앉았어요.' }],
      notes: 'S2를 눈여겨봐 주세요.',
    };
    r = await call(`/api/teacher/${t}/ai/seating`, 'POST', { roundId, layout, seats: {} });
    assert.equal(r.status, 200, r.text);
    view = await call(`/api/teacher/${t}/students/${s2.id}`, 'DELETE');
    assert.equal(view.status, 200, view.text);
    const after = view.json.aiSeating;
    assert.deepEqual(after.pairs, []);
    assert.deepEqual(after.assignment, { 'b0-r0-c0': s1.id, 'b0-r1-c0': s3.id });
    assert.deepEqual(after.explanations, { [s1.id]: '김하늘은 (삭제된 학생)와 떨어졌어요.' });
    assert.equal(after.notes, '(삭제된 학생)를 눈여겨봐 주세요.');
    assert.ok(!JSON.stringify(after).includes('이도윤'));
  });

  test('역할 목록에서 지운 역할의 역할 자리는 보통 자리로 돌아감', async () => {
    const created = await call('/api/rooms', 'POST', { name: '역할 자리반', students: NAMES.join('\n'), minGood: 0, minBad: 0 });
    const t = created.json.adminToken;
    let view = await call(`/api/teacher/${t}/roles/default`, 'POST');
    const roles = view.json.roles;
    const layout = { blocks: [{ cols: 2, rows: 1 }] };
    let r = await call(`/api/teacher/${t}/seating`, 'PUT', { layout, seats: {}, roleSeats: { 'b0-r0-c0': 'announcer', 'b0-r0-c1': 'door' } });
    assert.equal(r.status, 200, r.text);
    r = await call(`/api/teacher/${t}/roles`, 'PUT', { roles: roles.filter((x) => x.id !== 'door') });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.seating.roleSeats, { 'b0-r0-c0': 'announcer' });
    view = await call(`/api/teacher/${t}`);
    assert.deepEqual(view.json.seating.roleSeats, { 'b0-r0-c0': 'announcer' });
  });

  test('기본 역할 불러오기(POST /roles/default)도 없어진 역할의 역할 자리와 배정을 정리함', async () => {
    const created = await call('/api/rooms', 'POST', { name: '기본 역할반', students: NAMES.join('\n'), minGood: 0, minBad: 0 });
    const t = created.json.adminToken;
    let r = await call(`/api/teacher/${t}/roles`, 'PUT', { roles: [{ name: '창문 지킴이', slots: 1 }] });
    assert.equal(r.status, 200, r.text);
    const custom = r.json.roles[0].id;
    const roundId = r.json.round.id;
    const [s1] = r.json.students;
    r = await call(`/api/teacher/${t}/roles/assignment`, 'PUT', { roundId, assignments: { [custom]: [s1.id] } });
    assert.equal(r.status, 200, r.text);
    r = await call(`/api/teacher/${t}/seating`, 'PUT', { layout: { blocks: [{ cols: 2, rows: 1 }] }, seats: {}, roleSeats: { 'b0-r0-c0': custom } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.seating.roleSeats, { 'b0-r0-c0': custom });
    r = await call(`/api/teacher/${t}/roles/default`, 'POST');
    assert.equal(r.status, 200, r.text);
    assert.ok(!r.json.roles.some((x) => x.id === custom));
    assert.deepEqual(r.json.seating.roleSeats, {}, '없어진 역할의 역할 자리는 보통 자리로');
    assert.equal(r.json.roleAssignment.assignments[custom], undefined, '없어진 역할의 배정도 정리');
    assert.ok(r.json.roleAssignment.unassigned.includes(s1.id), '배정이 없어진 학생은 미배정으로');
    assert.ok(r.json.roleAssignment.warnings.some((w) => w.startsWith('역할 목록이 바뀌어')));
    const view = await call(`/api/teacher/${t}`);
    assert.deepEqual(view.json.seating.roleSeats, {});
    // 저장된 자리표를 다시 PUT 해도 거절당하지 않음 (없는 역할이 남아 있지 않으므로)
    r = await call(`/api/teacher/${t}/seating`, 'PUT', { ...view.json.seating, seats: {} });
    assert.equal(r.status, 200, r.text);
  });

  test('회차를 지우면 그 회차로 만든 AI 배정안도 지워지고, 다른 회차의 배정안은 남음', async () => {
    const created = await call('/api/rooms', 'POST', { name: '회차 삭제반', students: NAMES.join('\n'), minGood: 0, minBad: 0 });
    const t = created.json.adminToken;
    const layout = { blocks: [{ cols: 2, rows: 2 }] };
    let view = await call(`/api/teacher/${t}`);
    const roundA = view.json.round.id;
    reply = { pairs: [{ a: 'S1', b: 'S2', probability: 70, reason: 'S1이 S2를 놀려요.' }], assignment: [{ seat: 'b0-r0-c0', student: 'S1' }], explanations: [], notes: '' };
    let r = await call(`/api/teacher/${t}/ai/seating`, 'POST', { roundId: roundA, layout, seats: {} });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.aiSeating.roundId, roundA);
    assert.match(r.json.aiSeating.pairs[0].reason, /김하늘/);
    r = await call(`/api/teacher/${t}/rounds`, 'POST', { name: '다음 회차' });
    assert.equal(r.status, 201, r.text);
    const roundB = r.json.round.id;
    assert.equal(r.json.aiSeating.roundId, roundA, '회차를 새로 만들어도 배정안은 남음');
    r = await call(`/api/teacher/${t}/rounds/${roundA}`, 'DELETE');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.aiSeating, null, '지운 회차의 배정안은 함께 삭제');
    view = await call(`/api/teacher/${t}`);
    assert.equal(view.json.aiSeating, null);
    assert.ok(!JSON.stringify(view.json).includes('놀려요'));
    // 남아 있는 회차의 배정안은 다른 회차를 지워도 그대로
    r = await call(`/api/teacher/${t}/ai/seating`, 'POST', { roundId: roundB, layout, seats: {} });
    assert.equal(r.status, 200, r.text);
    r = await call(`/api/teacher/${t}/rounds`, 'POST', { name: '그다음 회차' });
    const roundC = r.json.round.id;
    r = await call(`/api/teacher/${t}/rounds/${roundC}`, 'DELETE');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.aiSeating.roundId, roundB);
  });

  test('학생 이름을 바꾸면 AI 분석·배정안 글의 옛 이름도 바뀌고, 다음 AI 요청에 옛 실명이 나가지 않음', async () => {
    const created = await call('/api/rooms', 'POST', { name: '이름 변경반', students: NAMES.join('\n'), minGood: 0, minBad: 0 });
    const t = created.json.adminToken;
    let view = await call(`/api/teacher/${t}/roles/default`, 'POST');
    const [s1, s2] = view.json.students;
    const roundId = view.json.round.id;
    const layout = { blocks: [{ cols: 2, rows: 2 }] };
    analysisReply = {
      summary: 'S2는 활발한 편이에요.',
      pairs: [{ a: 'S1', b: 'S2', riskLevel: 'high', conflictType: 'S2 놀림', analysis: 'S1이 S2의 장난에 속상해해요.', advice: 'S2를 S1과 떨어뜨려요.' }],
      students: [{ id: 'S2', summary: 'S2는 활발해요.', strengths: 'S2는 발표를 잘해요.', watch: 'S1을 놀리지 않게 살펴 주세요.', roleFit: [{ roleId: 'announcer', reason: 'S2는 목소리가 커요.' }] }],
    };
    let r = await call(`/api/teacher/${t}/ai/analyze`, 'POST', { roundId });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.aiAnalysis.pairs[0].analysis, '김하늘이 이도윤의 장난에 속상해해요.');
    reply = {
      pairs: [{ a: 'S1', b: 'S2', probability: 70, reason: 'S1이 S2를 놀려요.' }],
      assignment: [{ seat: 'b0-r0-c0', student: 'S1' }, { seat: 'b0-r1-c1', student: 'S2' }],
      explanations: [{ student: 'S2', text: 'S2는 뒤에 앉았어요.' }],
      notes: 'S2를 눈여겨봐 주세요.',
    };
    r = await call(`/api/teacher/${t}/ai/seating`, 'POST', { roundId, layout, seats: {} });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.aiSeating.notes, '이도윤를 눈여겨봐 주세요.');

    r = await call(`/api/teacher/${t}/students/${s2.id}`, 'PATCH', { name: '정우진' });
    assert.equal(r.status, 200, r.text);
    const a = r.json.aiAnalysis;
    assert.equal(a.summary, '정우진는 활발한 편이에요.');
    assert.equal(a.pairs[0].analysis, '김하늘이 정우진의 장난에 속상해해요.');
    assert.equal(a.pairs[0].conflictType, '정우진 놀림');
    assert.equal(a.pairs[0].advice, '정우진를 김하늘과 떨어뜨려요.');
    assert.equal(a.students[0].summary, '정우진는 활발해요.');
    assert.equal(a.students[0].strengths, '정우진는 발표를 잘해요.');
    assert.equal(a.students[0].roleFit[0].reason, '정우진는 목소리가 커요.');
    const b = r.json.aiSeating;
    assert.equal(b.pairs[0].reason, '김하늘이 정우진를 놀려요.');
    assert.equal(b.explanations[s2.id], '정우진는 뒤에 앉았어요.');
    assert.equal(b.notes, '정우진를 눈여겨봐 주세요.');
    assert.ok(!JSON.stringify({ a, b }).includes('이도윤'), '옛 이름이 AI 글에 남지 않음');

    // 다음 AI 자리 배정 요청: 지난 AI 분석 글이 프롬프트에 들어가도 옛 실명은 없어야 함
    calls.length = 0;
    r = await call(`/api/teacher/${t}/ai/seating`, 'POST', { roundId, layout, seats: {} });
    assert.equal(r.status, 200, r.text);
    assert.equal(calls.length, 1);
    const dump = JSON.stringify(calls[0]);
    for (const n of ['이도윤', '도윤', '정우진', '우진', '김하늘', '하늘', s1.id, s2.id]) assert.ok(!dump.includes(n), `실명/id 가 요청에 들어감: ${n}`);
    assert.match(calls[0].messages[0].content, /- S1 · S2: 위험 높음 · S2 놀림 · S1이 S2의 장난에 속상해해요\./, '지난 AI 분석은 새 이름이 가명 처리돼 들어감');
  });

  test('학생이 한 명도 없으면 AI 를 부르지 않고 400', async () => {
    const created = await call('/api/rooms', 'POST', { name: '빈 반', students: '김하늘\n이도윤', minGood: 0, minBad: 0 });
    const t = created.json.adminToken;
    const view = await call(`/api/teacher/${t}`);
    for (const s of view.json.students) assert.equal((await call(`/api/teacher/${t}/students/${s.id}`, 'DELETE')).status, 200);
    calls.length = 0;
    const r = await call(`/api/teacher/${t}/ai/seating`, 'POST', { layout: { blocks: [{ cols: 2, rows: 1 }] }, seats: {} });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, '학생이 없어요. 먼저 학생을 등록해 주세요.');
    assert.equal(calls.length, 0);
  });
});

describe('AI 자리 배정 API (AI 꺼짐)', () => {
  let server;
  let url;
  let savedKey;
  before(async () => {
    savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const app = createApp({ store: new FileStore(null), baseUrl: 'https://example.test' });
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    url = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => {
    server.close();
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey;
  });

  test('ANTHROPIC_API_KEY 가 없으면 400 안내', async () => {
    const created = await fetch(`${url}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '꺼짐반', students: '김하늘\n이도윤' }) });
    const { adminToken: t } = await created.json();
    const res = await fetch(`${url}/api/teacher/${t}/ai/seating`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ layout: { blocks: [{ cols: 2, rows: 1 }] }, seats: {} }) });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error, 'AI 자리 배정을 쓰려면 서버에 ANTHROPIC_API_KEY 를 설정해 주세요.');
    const view = await (await fetch(`${url}/api/teacher/${t}`)).json();
    assert.equal(view.ai.enabled, false);
    assert.equal(view.aiSeating, null);
  });
});
