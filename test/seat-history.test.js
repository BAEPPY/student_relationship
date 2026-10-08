// 지난 자리표 보관(seatingHistory)과 다양한 짝: 좌석 기하 공유 모듈, 저장 시 보관 규칙, 보관/지우기 API,
// variety 옵션 검증, 학생 삭제·보관 기간 정리, AI 자리 배정 프롬프트의 "지난 자리표의 짝꿍" 섹션
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { layoutSeats, neighborPairs, seatedPairs, deskmatePairs } from '../public/js/seat-geometry.js';
import * as seating from '../server/seating.js';
import { buildSeatingPrompt } from '../server/ai.js';
import { purgeExpired, roomLastActivity } from '../server/retention.js';
import { createApp } from '../server/app.js';
import { FileStore } from '../server/store.js';

const SMALL = { blocks: [{ cols: 2, rows: 2 }, { cols: 1, rows: 1 }] };          // 좌석 5개
const CLASSROOM = { blocks: [{ cols: 2, rows: 4 }, { cols: 2, rows: 5 }, { cols: 2, rows: 4 }] };   // 기본 배치 (좌석 26개)
const countBy = (pairs) => pairs.reduce((m, p) => { const label = Array.isArray(p) ? p[3] : p.label; m[label] = (m[label] || 0) + 1; return m; }, {});

describe('seat-geometry (브라우저·서버 공용)', () => {
  test('layoutSeats: 분단 → 줄 → 칸 순서, 서버 seating.js 는 같은 함수를 다시 내보냄', () => {
    assert.deepEqual(layoutSeats(SMALL).map((s) => s.id), ['b0-r0-c0', 'b0-r0-c1', 'b0-r1-c0', 'b0-r1-c1', 'b1-r0-c0']);
    assert.deepEqual(layoutSeats(null), []);
    assert.deepEqual(layoutSeats({ blocks: [{ cols: '2', rows: '1' }] }).length, 2, '문자열 숫자도 허용');
    assert.equal(seating.layoutSeats, layoutSeats);
    assert.equal(seating.neighborPairs, neighborPairs);
    assert.equal(seating.seatedPairs, seatedPairs);
    assert.equal(seating.deskmatePairs, deskmatePairs);
  });

  test('neighborPairs: 짝꿍 1.0 · 앞뒤 0.6 · 대각선 0.3 양쪽 · 통로 건너 0.35 (짧은 분단 줄 수까지)', () => {
    const pairs = neighborPairs(SMALL);
    assert.deepEqual(countBy(pairs), { '짝꿍': 2, '앞뒤': 2, '대각선': 2, '통로 건너': 1 });
    assert.ok(pairs.some(([a, b, w, l]) => a === 'b0-r0-c0' && b === 'b0-r0-c1' && w === 1 && l === '짝꿍'));
    assert.ok(pairs.some(([a, b, w, l]) => a === 'b0-r0-c0' && b === 'b0-r1-c0' && w === 0.6 && l === '앞뒤'));
    assert.ok(pairs.some(([a, b, w, l]) => a === 'b0-r0-c0' && b === 'b0-r1-c1' && w === 0.3 && l === '대각선'));
    assert.ok(pairs.some(([a, b, w, l]) => a === 'b0-r0-c1' && b === 'b0-r1-c0' && w === 0.3 && l === '대각선'));
    assert.ok(pairs.some(([a, b, w, l]) => a === 'b0-r0-c1' && b === 'b1-r0-c0' && w === 0.35 && l === '통로 건너'), '1분단 오른쪽 끝 ↔ 2분단 왼쪽 끝');
    assert.ok(!pairs.some(([a, b]) => a === 'b0-r1-c1' && b === 'b1-r1-c0'), '2분단에 없는 줄은 통로 건너 쌍이 아님');
    // 기본 배치 2x4, 2x5, 2x4: 짝꿍 4+5+4, 앞뒤 6+8+6, 대각선 6+8+6, 통로 건너 4+4
    assert.deepEqual(countBy(neighborPairs(CLASSROOM)), { '짝꿍': 13, '앞뒤': 20, '대각선': 20, '통로 건너': 8 });
    assert.deepEqual(neighborPairs({ blocks: [{ cols: 1, rows: 3 }] }).map((p) => p[3]), ['앞뒤', '앞뒤'], '한 칸짜리 분단은 짝꿍이 없음');
    assert.deepEqual(neighborPairs(null), []);
  });

  test('seatedPairs · deskmatePairs: 두 자리 모두 학생이 있는 이웃 쌍만, 짝꿍만 골라내기', () => {
    const seats = { 'b0-r0-c0': 'a', 'b0-r0-c1': 'b', 'b0-r1-c1': 'c', 'b1-r0-c0': 'd', 'b0-r1-c0': '' };
    const pairs = seatedPairs(SMALL, seats);
    assert.deepEqual(pairs, [
      { a: 'a', b: 'b', label: '짝꿍', weight: 1 },
      { a: 'a', b: 'c', label: '대각선', weight: 0.3 },
      { a: 'b', b: 'c', label: '앞뒤', weight: 0.6 },
      { a: 'b', b: 'd', label: '통로 건너', weight: 0.35 },
    ]);
    assert.deepEqual(deskmatePairs(SMALL, seats), [['a', 'b']]);
    assert.deepEqual(deskmatePairs(SMALL, { 'b0-r0-c0': 'a', 'b0-r1-c0': 'b', 'b0-r1-c1': 'c' }), [['b', 'c']]);
    assert.deepEqual(deskmatePairs(SMALL, {}), []);
    assert.deepEqual(deskmatePairs(null, { 'b0-r0-c0': 'a' }), []);
  });
});

describe('지난 자리표 보관 API', () => {
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
  async function makeRoom(name) {
    const created = await call('/api/rooms', 'POST', { name, students: '김하늘\n이도윤\n박서연\n최지우', minGood: 0, minBad: 0 });
    assert.equal(created.status, 201, created.text);
    const t = created.json.adminToken;
    const view = await call(`/api/teacher/${t}`);
    return { t, ids: view.json.students.map((s) => s.id), round: view.json.round };
  }
  const layout = { blocks: [{ cols: 2, rows: 2 }] };
  const put = (t, seats, extra = {}) => call(`/api/teacher/${t}/seating`, 'PUT', { layout, seats, ...extra });

  test('회차가 바뀐 뒤 저장하면 이전 자리표가 보관되고, 같은 회차 안의 재저장은 덮어쓴다', async () => {
    const { t, ids: [a, b, c, d], round: roundA } = await makeRoom('보관반');
    let r = await put(t, { 'b0-r0-c0': a, 'b0-r0-c1': b }, { roundId: roundA.id });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.seating.roundId, roundA.id);
    assert.equal(r.json.seating.roundName, roundA.name);
    assert.deepEqual(r.json.seatingHistory, [], '처음 저장은 보관할 것이 없음');
    const firstSavedAt = r.json.seating.updatedAt;

    // 같은 회차 재저장 → 덮어쓰기 (roundId 생략 = 지금 회차)
    r = await put(t, { 'b0-r0-c0': a, 'b0-r0-c1': c });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.seatingHistory, []);
    assert.equal(r.json.seating.seats['b0-r0-c1'], c);
    const seatsA = r.json.seating.seats;
    const savedAtA = r.json.seating.updatedAt;
    assert.notEqual(savedAtA, undefined);
    assert.ok(savedAtA >= firstSavedAt);

    // 새 회차에서 저장 → 지난 회차 자리표가 history 맨 앞에 (savedAt 은 지난 저장 시각)
    r = await call(`/api/teacher/${t}/rounds`, 'POST', { name: '2026년 11월' });
    assert.equal(r.status, 201, r.text);
    const roundB = r.json.round;
    r = await put(t, { 'b0-r0-c0': b, 'b0-r0-c1': a, 'b0-r1-c0': d }, { roundId: roundB.id });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.seating.roundId, roundB.id);
    assert.equal(r.json.seatingHistory.length, 1);
    assert.deepEqual(r.json.seatingHistory[0], { savedAt: savedAtA, roundId: roundA.id, roundName: roundA.name, layout, seats: seatsA });

    // 같은 회차에서 다시 저장해도 보관 수는 그대로
    r = await put(t, { 'b0-r0-c0': d, 'b0-r0-c1': a }, { roundId: roundB.id });
    assert.equal(r.json.seatingHistory.length, 1);
    // 자리를 그대로 두고 새 회차에서 저장해도 이전 회차의 자리표는 보관됨 (그 뒤 같은 회차에서 다시 짜도 남게)
    r = await call(`/api/teacher/${t}/rounds`, 'POST', { name: '2026년 12월' });
    const roundC = r.json.round;
    r = await put(t, { 'b0-r0-c0': d, 'b0-r0-c1': a }, { roundId: roundC.id });
    assert.equal(r.json.seatingHistory.length, 2);
    assert.equal(r.json.seatingHistory[0].roundId, roundB.id, '최신이 앞');
    assert.equal(r.json.seatingHistory[1].roundId, roundA.id);
    // 보관된 것과 같은 자리표는 두 번 보관하지 않음: 보관하기를 눌러도 history[0] 과 같으면 그대로
    r = await call(`/api/teacher/${t}/seating/archive`, 'POST');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.seatingHistory.length, 2, '같은 자리표는 중복 보관 안 함');
    // 없는 회차 id 는 404
    r = await put(t, { 'b0-r0-c0': a }, { roundId: 'nope' });
    assert.equal(r.status, 404);
    // 선생님 화면과 JSON 내보내기에 들어감
    const view = await call(`/api/teacher/${t}`);
    assert.equal(view.json.seatingHistory.length, 2);
    assert.equal(view.json.seating.roundName, roundC.name);
    const exported = await call(`/api/teacher/${t}/export.json`);
    assert.equal(exported.status, 200);
    assert.equal(exported.json.seatingHistory.length, 2);
    assert.equal(exported.json.seating.roundId, roundC.id);
  });

  test('보관은 최대 12개 (오래된 것부터 밀려남)', async () => {
    const { t, ids: [a, b, c, d] } = await makeRoom('열두개반');
    const seatsFor = (i) => (i % 2 ? { 'b0-r0-c0': a, 'b0-r0-c1': b, 'b0-r1-c0': c } : { 'b0-r0-c0': b, 'b0-r0-c1': a, 'b0-r1-c1': d });
    let r = await put(t, seatsFor(0));
    assert.equal(r.status, 200, r.text);
    const names = [];
    for (let i = 1; i <= 14; i++) {
      r = await call(`/api/teacher/${t}/rounds`, 'POST', { name: `회차 ${i}` });
      assert.equal(r.status, 201, r.text);
      r = await put(t, seatsFor(i), { roundId: r.json.round.id });
      assert.equal(r.status, 200, r.text);
      names.push(r.json.seating.roundName);
    }
    assert.equal(r.json.seatingHistory.length, 12);
    assert.equal(r.json.seatingHistory[0].roundName, '회차 13', '가장 최근에 밀려난 회차가 맨 앞');
    assert.equal(r.json.seatingHistory[11].roundName, '회차 2');
    assert.ok(!r.json.seatingHistory.some((h) => h.roundName === '회차 1' || h.roundName === null), '처음 두 자리표는 밀려남');
  });

  test('보관하기 / 기록 지우기 API', async () => {
    const { t, ids: [a, b, c] } = await makeRoom('수동보관반');
    let r = await call(`/api/teacher/${t}/seating/archive`, 'POST');
    assert.equal(r.status, 400);
    assert.equal(r.json.error, '보관할 자리표가 없어요. 먼저 자리를 저장해 주세요.');
    r = await put(t, {});
    assert.equal(r.status, 200, r.text);
    r = await call(`/api/teacher/${t}/seating/archive`, 'POST');
    assert.equal(r.status, 400, '빈 자리표도 보관할 수 없음');

    r = await put(t, { 'b0-r0-c0': a, 'b0-r0-c1': b });
    const saved = r.json.seating;
    r = await call(`/api/teacher/${t}/seating/archive`, 'POST');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.seatingHistory.length, 1);
    assert.deepEqual(r.json.seatingHistory[0], { savedAt: saved.updatedAt, roundId: saved.roundId, roundName: saved.roundName, layout, seats: saved.seats });
    assert.deepEqual(r.json.seating.seats, saved.seats, '지금 자리표는 그대로');
    r = await call(`/api/teacher/${t}/seating/archive`, 'POST');
    assert.equal(r.json.seatingHistory.length, 1, '같은 자리표는 다시 보관하지 않음');
    // 자리를 바꿔 저장(같은 회차)한 뒤 보관하면 하나 더
    r = await put(t, { 'b0-r0-c0': c, 'b0-r0-c1': b });
    assert.equal(r.json.seatingHistory.length, 1, '같은 회차 재저장은 자동 보관 안 함');
    r = await call(`/api/teacher/${t}/seating/archive`, 'POST');
    assert.equal(r.json.seatingHistory.length, 2);
    assert.equal(r.json.seatingHistory[0].seats['b0-r0-c0'], c);
    // 배치만 바뀌어도 다른 자리표
    r = await call(`/api/teacher/${t}/seating`, 'PUT', { layout: { blocks: [{ cols: 3, rows: 2 }] }, seats: { 'b0-r0-c0': c, 'b0-r0-c1': b } });
    r = await call(`/api/teacher/${t}/seating/archive`, 'POST');
    assert.equal(r.json.seatingHistory.length, 3);
    assert.deepEqual(r.json.seatingHistory[0].layout, { blocks: [{ cols: 3, rows: 2 }] });

    r = await call(`/api/teacher/${t}/seating/history`, 'DELETE');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.seatingHistory, []);
    assert.ok(r.json.seating.seats[('b0-r0-c0')], '지금 자리표는 남음');
    const view = await call(`/api/teacher/${t}`);
    assert.deepEqual(view.json.seatingHistory, []);
  });

  test('options.variety: 기본 on, off 저장, 다른 값은 거절', async () => {
    const { t, ids: [a] } = await makeRoom('옵션반');
    let r = await put(t, { 'b0-r0-c0': a });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.seating.options, { friends: 'any', variety: 'on' });
    r = await put(t, { 'b0-r0-c0': a }, { options: { friends: 'near', variety: 'off' } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.seating.options, { friends: 'near', variety: 'off' });
    r = await put(t, { 'b0-r0-c0': a }, { options: { variety: 'maybe' } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /지난 자리와 다른 짝/);
    r = await put(t, { 'b0-r0-c0': a }, { options: { variety: '' } });
    assert.equal(r.status, 400, '빈 문자열도 거절');
  });

  test('학생을 지우면 보관된 자리표에서도 그 학생이 빠진다', async () => {
    const { t, ids: [a, b, c], round } = await makeRoom('삭제반');
    let r = await put(t, { 'b0-r0-c0': a, 'b0-r0-c1': b, 'b0-r1-c0': c }, { roundId: round.id });
    r = await call(`/api/teacher/${t}/rounds`, 'POST', { name: '다음 회차' });
    r = await put(t, { 'b0-r0-c0': b, 'b0-r0-c1': c, 'b0-r1-c0': a }, { roundId: r.json.round.id });
    assert.equal(r.json.seatingHistory.length, 1);
    r = await call(`/api/teacher/${t}/students/${b}`, 'DELETE');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.seatingHistory[0].seats, { 'b0-r0-c0': a, 'b0-r1-c0': c });
    assert.deepEqual(r.json.seating.seats, { 'b0-r0-c1': c, 'b0-r1-c0': a });
    assert.ok(!JSON.stringify(r.json.seatingHistory).includes(b));
  });

  test('지난 회차 id 로 저장해도 자리표는 지금 회차의 것으로 기록된다 (?round= 로 옛 회차를 보다가 저장)', async () => {
    const { t, ids: [a, b, c, d], round: roundA } = await makeRoom('옛회차반');
    let r = await put(t, { 'b0-r0-c0': a, 'b0-r0-c1': b }, { roundId: roundA.id });
    assert.equal(r.status, 200, r.text);
    r = await call(`/api/teacher/${t}/rounds`, 'POST', { name: '2026년 11월' });
    const roundB = r.json.round;
    // 옛 회차 A 를 보던 화면에서 저장 → 지금 회차 B 의 자리표로 기록, A 회차 자리표는 한 번만 보관
    r = await put(t, { 'b0-r0-c0': c, 'b0-r0-c1': d }, { roundId: roundA.id });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.seating.roundId, roundB.id, '자리표의 회차는 지금 회차');
    assert.equal(r.json.seating.roundName, roundB.name);
    assert.equal(r.json.seatingHistory.length, 1);
    assert.equal(r.json.seatingHistory[0].roundId, roundA.id);
    assert.deepEqual(r.json.seatingHistory[0].seats, { 'b0-r0-c0': a, 'b0-r0-c1': b });
    // 다시 옛 회차 id 로 저장해도 지금 회차 안의 재저장이라 덮어쓰기 (방금 저장한 자리표가 '지난 자리표'로 밀려나지 않음)
    r = await put(t, { 'b0-r0-c0': d, 'b0-r0-c1': c }, { roundId: roundA.id });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.seating.roundId, roundB.id);
    assert.equal(r.json.seatingHistory.length, 1);
    assert.equal(r.json.seatingHistory[0].roundId, roundA.id);
    // roundId 를 아예 안 보내도 같음. 없는 회차 id 는 여전히 404
    r = await put(t, { 'b0-r0-c0': a, 'b0-r0-c1': c });
    assert.equal(r.json.seating.roundId, roundB.id);
    assert.equal(r.json.seatingHistory.length, 1);
    r = await put(t, { 'b0-r0-c0': a }, { roundId: 'nope' });
    assert.equal(r.status, 404);
  });

  test('회차 이름을 바꾸면 자리표와 보관본에 적힌 회차 이름이 따라간다', async () => {
    const { t, ids: [a, b, c], round: roundA } = await makeRoom('이름변경반');
    let r = await put(t, { 'b0-r0-c0': a, 'b0-r0-c1': b });
    assert.equal(r.json.seating.roundName, roundA.name);
    r = await call(`/api/teacher/${t}/rounds/${roundA.id}`, 'PATCH', { name: '9월 (1학기)' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.seating.roundName, '9월 (1학기)', '지금 저장된 자리표의 회차 이름');
    // 새 회차에서 저장해 A 회차 자리표가 보관된 뒤 A 이름을 또 바꾸면 보관본도 따라감 (지금 자리표는 B 회차라 그대로)
    r = await call(`/api/teacher/${t}/rounds`, 'POST', { name: '2026년 11월' });
    const roundB = r.json.round;
    r = await put(t, { 'b0-r0-c0': b, 'b0-r0-c1': c });
    assert.equal(r.json.seatingHistory[0].roundName, '9월 (1학기)');
    r = await call(`/api/teacher/${t}/rounds/${roundA.id}`, 'PATCH', { name: '1학기 첫 자리' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.seatingHistory[0].roundName, '1학기 첫 자리');
    assert.equal(r.json.seating.roundName, roundB.name);
    const view = await call(`/api/teacher/${t}`);
    assert.equal(view.json.seatingHistory[0].roundName, '1학기 첫 자리');
    const exported = await call(`/api/teacher/${t}/export.json`);
    assert.equal(exported.json.seatingHistory[0].roundName, '1학기 첫 자리');
    assert.equal(exported.json.rounds.find((x) => x.id === roundA.id)?.name, '1학기 첫 자리');
  });
});

describe('보관 기간 정리 (retention)', () => {
  const NOW = new Date('2026-10-05T00:00:00.000Z');
  const monthsAgo = (n) => new Date(Date.UTC(2026, 9 - n, 5)).toISOString();
  const entry = (savedAt) => ({ savedAt, roundId: 'r', roundName: '회차', layout: { blocks: [{ cols: 2, rows: 1 }] }, seats: { 'b0-r0-c0': 'a' } });
  const room = (extra) => ({
    id: 'x', name: '반', adminToken: 't', createdAt: monthsAgo(20), students: [{ id: 'a', name: '가', token: 'k' }],
    rounds: [{ id: 'cur', name: '지금', startedAt: monthsAgo(1), closedAt: null, relations: {}, submissions: { a: { submittedAt: monthsAgo(1) } } }],
    currentRoundId: 'cur', ...extra,
  });

  test('오래된 보관 자리표만 지우고(변경 반영), 보관 시각이 없는 항목은 둔다', () => {
    const r = room({ seatingHistory: [entry(monthsAgo(2)), entry(monthsAgo(15)), { ...entry(undefined), savedAt: undefined }, entry(monthsAgo(30))] });
    const res = purgeExpired(r, NOW);
    assert.equal(res.changed, true);
    assert.equal(res.removed.length, 0);
    assert.deepEqual(r.seatingHistory.map((h) => h.savedAt), [monthsAgo(2), undefined]);
    assert.equal(purgeExpired(r, NOW).changed, false, '다시 돌려도 바뀌지 않음');
    const fresh = room({ seatingHistory: [entry(monthsAgo(1))] });
    assert.equal(purgeExpired(fresh, NOW).changed, false);
    assert.equal(fresh.seatingHistory.length, 1);
  });

  test('보관된 자리표는 교실 활동으로 세지 않는다', () => {
    const r = room({ seatingHistory: [entry(monthsAgo(0))], seating: { updatedAt: monthsAgo(3), seats: {} } });
    assert.equal(roomLastActivity(r), monthsAgo(1), '회차 제출(1개월 전)이 마지막 활동');
    // 회차가 모두 만료되고 보관 자리표만 최근이면 교실은 지워짐
    const dead = { ...room({ seatingHistory: [entry(monthsAgo(0))] }), rounds: [{ id: 'old', name: '옛', startedAt: monthsAgo(18), closedAt: monthsAgo(17), relations: {}, submissions: {} }], currentRoundId: 'old' };
    assert.equal(purgeExpired(dead, NOW).deleteRoom, true);
  });
});

describe('AI 자리 배정 프롬프트: 지난 자리표의 짝꿍', () => {
  const STUDENTS = [{ id: 'st_a1', name: '김하늘' }, { id: 'st_b2', name: '이도윤' }, { id: 'st_c3', name: '박서연' }, { id: 'st_d4', name: '최지우' }];
  const past = [
    { roundName: '2026년 9월', pairs: [['st_a1', 'st_b2'], ['st_c3', 'st_d4'], ['st_a1', 'st_b2'], ['ghost', 'st_a1']] },
    { roundName: '김하늘 생일 주간', pairs: [['st_b2', 'st_c3']] },
    { roundName: '빈 회차', pairs: [] },
    { roundName: '2026년 6월', pairs: [['st_d4', 'st_a1']] },
    { roundName: '2026년 5월', pairs: [['st_a1', 'st_c3']] },
  ];

  test('variety 가 on(기본)이면 가명으로 회차별 한 줄씩(최대 3개), 우선순위가 system 에 들어감', () => {
    const { system, user } = buildSeatingPrompt({ students: STUDENTS, layout: SMALL, options: { friends: 'any' }, pastDeskmates: past });
    assert.match(user, /## 지난 자리표의 짝꿍 \(다양한 짝: 같은 짝은 피하기\)\n- 2026년 9월: S1·S2, S3·S4\n- S1 생일 주간: S2·S3\n- 2026년 6월: S4·S1\n/, '중복 쌍·모르는 학생은 빼고, 회차 이름 속 실명은 가명으로, 빈 회차는 건너뜀');
    assert.doesNotMatch(user, /2026년 5월/, '최근 3개까지만');
    assert.match(user, /지난 자리와 다른 짝\(다양한 짝\): 우선/);
    for (const n of ['김하늘', '이도윤', '박서연', '최지우', '하늘', '도윤', 'st_a1', 'st_b2', 'ghost']) assert.ok(!user.includes(n), `실명/id 가 프롬프트에 들어감: ${n}`);
    assert.match(system, /① 📌 고정·🎒 역할 자리·선생님 규칙\(떨어뜨리기\/가까이\) ② 갈등 회피\(안 좋은 사이, 갈등 가능성 높을수록 멀리\) ③ 지난 자리표와 다른 짝꿍\(다양한 짝\) ④ 선생님이 표시한 앞자리 필요 ⑤ 학생 몸 특징\(시력·추위·더위·키\)은 그 다음/);
    assert.match(system, /지난 자리표가 없는 처음 자리표면 시력 나쁜 학생을 앞줄에/);
    assert.match(system, /📌 고정 자리/);
    assert.match(system, /짝꿍·앞뒤·대각선·통로 건너/);
    // 지난 자리표가 없으면 처음 자리표라고 알려 줌
    const first = buildSeatingPrompt({ students: STUDENTS, layout: SMALL });
    assert.match(first.user, /## 지난 자리표의 짝꿍[^\n]*\n\(없음 · 처음 자리표라 몸 특징을 그대로 반영해요\)/);
    // 섹션 순서: 1인 1역 배정 뒤, 몸 특징 앞
    const at = (title) => { const i = user.indexOf(`## ${title}`); assert.ok(i >= 0, title); return i; };
    assert.ok(at('1인 1역 배정') < at('지난 자리표의 짝꿍'));
    assert.ok(at('지난 자리표의 짝꿍') < at('학생 몸 특징'));
  });

  test('variety 가 off 면 섹션이 없고 조건에 상관없음으로 적힘', () => {
    const { user } = buildSeatingPrompt({ students: STUDENTS, layout: SMALL, options: { friends: 'any', variety: 'off' }, pastDeskmates: past });
    assert.doesNotMatch(user, /지난 자리표의 짝꿍/);
    assert.doesNotMatch(user, /S1·S2/);
    assert.match(user, /지난 자리와 다른 짝\(다양한 짝\): 상관없음/);
  });
});

describe('AI 자리 배정 API: 지난 자리표를 프롬프트에 넣음 (가짜 클라이언트)', () => {
  const calls = [];
  const fake = {
    beta: {
      messages: {
        create: async (params) => {
          calls.push(params);
          const reply = { pairs: [], assignment: [{ seat: 'b0-r0-c0', student: 'S1' }], explanations: [], notes: '' };
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(reply) }] };
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
  const layout = { blocks: [{ cols: 2, rows: 2 }] };
  const userText = () => calls[calls.length - 1].messages[0].content;

  test('저장된 다른 회차 자리표 + 보관 기록 순으로 최대 3개, 같은 자리표가 이어지면 하나만, variety off 면 없음', async () => {
    const created = await call('/api/rooms', 'POST', { name: 'AI 다양한 짝반', students: '김하늘\n이도윤\n박서연\n최지우', minGood: 0, minBad: 0 });
    const t = created.json.adminToken;
    let view = await call(`/api/teacher/${t}`);
    const [a, b, c, d] = view.json.students.map((s) => s.id);   // S1..S4
    const put = (seats, roundId) => call(`/api/teacher/${t}/seating`, 'PUT', { layout, seats, roundId });
    const newRound = async (name) => { const r = await call(`/api/teacher/${t}/rounds`, 'POST', { name }); assert.equal(r.status, 201, r.text); return r.json.round.id; };

    // 처음 자리표: 지난 자리표 없음
    calls.length = 0;
    let r = await call(`/api/teacher/${t}/ai/seating`, 'POST', { layout, seats: {} });
    assert.equal(r.status, 200, r.text);
    assert.match(userText(), /## 지난 자리표의 짝꿍[^\n]*\n\(없음 · 처음 자리표라/);

    // 1회차: S1·S2 짝꿍, S3·S4 짝꿍 → 2회차: S1·S3, S2·S4 → 3회차: S1·S4, S2·S3 → 4회차(지금): 저장된 3회차 자리표 + 보관 2개
    await put({ 'b0-r0-c0': a, 'b0-r0-c1': b, 'b0-r1-c0': c, 'b0-r1-c1': d }, view.json.round.id);
    const r2 = await newRound('2회차');
    await put({ 'b0-r0-c0': a, 'b0-r0-c1': c, 'b0-r1-c0': b, 'b0-r1-c1': d }, r2);
    const r3 = await newRound('3회차');
    r = await put({ 'b0-r0-c0': a, 'b0-r0-c1': d, 'b0-r1-c0': b, 'b0-r1-c1': c }, r3);
    assert.equal(r.json.seatingHistory.length, 2);
    const r4 = await newRound('4회차');
    calls.length = 0;
    r = await call(`/api/teacher/${t}/ai/seating`, 'POST', { roundId: r4, layout, seats: {} });
    assert.equal(r.status, 200, r.text);
    assert.equal(calls.length, 1);
    let user = userText();
    assert.match(user, /## 지난 자리표의 짝꿍 \(다양한 짝: 같은 짝은 피하기\)\n- 3회차: S1·S4, S2·S3\n- 2회차: S1·S3, S2·S4\n- [^\n]+: S1·S2, S3·S4\n/, '저장된 자리표(3회차)가 먼저, 그다음 보관 기록');
    for (const n of ['김하늘', '이도윤', '박서연', '최지우', '하늘', '도윤', '서연', '지우', a, b, c, d]) assert.ok(!JSON.stringify(calls[0]).includes(n), `실명/id 가 요청에 들어감: ${n}`);

    // 같은 회차(4회차)에 저장된 자리표는 "지난" 자리표가 아니라 빠지고, 보관 기록 3개까지만
    r = await put({ 'b0-r0-c0': d, 'b0-r0-c1': c, 'b0-r1-c0': b, 'b0-r1-c1': a }, r4);
    assert.equal(r.json.seatingHistory.length, 3);
    calls.length = 0;
    r = await call(`/api/teacher/${t}/ai/seating`, 'POST', { roundId: r4, layout, seats: {} });
    user = userText();
    assert.match(user, /- 3회차: S1·S4, S2·S3\n- 2회차: S1·S3, S2·S4\n- [^\n]+: S1·S2, S3·S4\n/);
    assert.doesNotMatch(user, /S4·S3/, '지금 회차의 자리표는 지난 자리표가 아님');

    // 보관하기로 지금 자리표가 history[0] 에 들어간 뒤 새 회차에서 부르면, 저장된 자리표와 history[0] 이 같아 하나로만 셈
    r = await call(`/api/teacher/${t}/seating/archive`, 'POST');
    assert.equal(r.json.seatingHistory.length, 4);
    const r5 = await newRound('5회차');
    calls.length = 0;
    r = await call(`/api/teacher/${t}/ai/seating`, 'POST', { roundId: r5, layout, seats: {} });
    user = userText();
    assert.match(user, /\n- 4회차: S4·S3, S2·S1\n- 3회차: S1·S4, S2·S3\n- 2회차: S1·S3, S2·S4\n/);
    assert.equal((user.match(/- 4회차:/g) || []).length, 1, '같은 자리표는 한 번만');

    // variety off → 섹션 없음
    calls.length = 0;
    r = await call(`/api/teacher/${t}/ai/seating`, 'POST', { roundId: r5, layout, seats: {}, options: { variety: 'off' } });
    assert.equal(r.status, 200, r.text);
    assert.doesNotMatch(userText(), /지난 자리표의 짝꿍/);
    assert.match(userText(), /다양한 짝\): 상관없음/);
    r = await call(`/api/teacher/${t}/ai/seating`, 'POST', { roundId: r5, layout, seats: {}, options: { variety: 'sometimes' } });
    assert.equal(r.status, 400, 'AI 배정도 같은 검증');
  });
});
