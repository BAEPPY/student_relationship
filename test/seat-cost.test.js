// 자동 배정 비용 모델(public/js/seat-cost.js)의 우선순위 고정:
// ① 고정·역할·선생님 규칙 > ② 갈등 회피 > ③ 선생님 👓 앞자리 > ④ 다양한 짝(지난 짝꿍) > ⑤ 학생 몸 특징
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { neighborPairs, layoutSeats, deskmatePairs, seatedPairs } from '../public/js/seat-geometry.js';
import { COST, buildPastPenalty, makeCostModel, teacherFrontCost, sightCost } from '../public/js/seat-cost.js';

/** 좌석 목록에 학생을 모든 순서로 앉힌 배정들 (n! 개) */
function allAssignments(seatIds, students) {
  const out = [];
  const perm = (rest, acc) => {
    if (!rest.length) { out.push(Object.fromEntries(seatIds.map((id, i) => [id, acc[i]]))); return; }
    rest.forEach((s, i) => perm([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, s]));
  };
  perm(students, []);
  return out;
}
const groupsOf = (layout) => layout.blocks.map((_, bi) => layoutSeats(layout).filter((s) => s.b === bi).map((s) => s.id));
/** 두 학생이 어떤 이웃(짝꿍·앞뒤·대각선·통로 건너)으로든 붙어 있는지 */
const adjacent = (layout, assign, x, y) => seatedPairs(layout, assign).some((p) => (p.a === x && p.b === y) || (p.a === y && p.b === x));

describe('seat-cost: 비용 숫자의 순서', () => {
  test('갈등 > 지난 짝꿍 > 몸 특징, 선생님 규칙 > 갈등, 선생님 👓 > 지난 짝꿍', () => {
    const minConflict = COST.CONFLICT_BASE + 40;   // 분석 BASE 에서 안 좋은 사이의 가장 낮은 값(bad/good 40)
    assert.ok(0.3 * minConflict > COST.PAST_MATE, '대각선(0.3)으로 붙은 갈등 쌍도 지난 짝꿍 반복 한 쌍보다 비싸요');
    assert.ok(minConflict > 3 * COST.PAST_MATE, '갈등 쌍 짝꿍은 지난 짝꿍 세 쌍 반복보다 비싸요');
    assert.ok(COST.RULE_APART > COST.CONFLICT_BASE + 97, '떨어뜨리기 규칙은 가장 큰 갈등 비용보다 커요');
    assert.ok(teacherFrontCost(COST.FRONT_ROWS) > COST.PAST_MATE, '선생님 👓 앞자리(3번째 줄부터)는 지난 짝꿍 반복보다 먼저');
    assert.ok(teacherFrontCost(0) === 0 && teacherFrontCost(1) < COST.PAST_MATE, '앞 두 줄 안에서는 다양한 짝이 먼저');
    assert.ok(COST.PAST_MATE > Math.max(sightCost(9), COST.ZONE_MISMATCH), '학생이 고른 몸 특징(눈 나쁨 10줄까지·바람 자리)은 지난 짝꿍 반복보다 낮아요');
    assert.ok(sightCost(COST.FRONT_ROWS) > sightCost(1) && sightCost(9) > sightCost(2), '눈 나쁨은 뒤로 갈수록 비싸요');
  });

  test('buildPastPenalty: 최근 자리표일수록 크고 절반씩 약해지며 최소값이 있고, 양방향 같은 객체', () => {
    const layout = { blocks: [{ cols: 2, rows: 2 }] };
    const arr = { layout, seats: { 'b0-r0-c0': 'a', 'b0-r0-c1': 'b', 'b0-r1-c0': 'c' } };
    const p0 = buildPastPenalty([arr]);
    assert.deepEqual(p0.a.b, { mate: 80, near: 0, block: 4 });
    assert.equal(p0.a.b, p0.b.a, '양방향 같은 객체');
    assert.deepEqual(p0.a.c, { mate: 0, near: 16, block: 4 }, '앞뒤');
    assert.deepEqual(p0.b.c, { mate: 0, near: 16, block: 4 }, '대각선');
    const p1 = buildPastPenalty([{ layout, seats: {} }, arr]);
    assert.deepEqual(p1.a.b, { mate: 40, near: 0, block: 2 }, '두 번째 자리표는 절반');
    const p5 = buildPastPenalty([{}, {}, {}, {}, {}, arr]);
    assert.deepEqual(p5.a.b, { mate: 5, near: 0, block: 0.5 }, '최소 5 · 0.5');
    assert.deepEqual(p5.a.c, { mate: 0, near: 1, block: 0.5 }, '이웃 최소 1');
    const twice = buildPastPenalty([arr, arr]);
    assert.deepEqual(twice.a.b, { mate: 120, near: 0, block: 6 }, '여러 자리표에서 반복되면 합산');
    assert.deepEqual(buildPastPenalty([]), {});
    assert.deepEqual(buildPastPenalty(null), {});
  });
});

describe('seat-cost: 담금질이 고르는 자리표', () => {
  // 선생님 보고: 1회차 a·b, c·d 짝꿍 → 새 회차에 a 가 c·d 를 안 좋은 사이로 표시. 좌석 4개(2x1, 2x1)라 모두 다른 짝으로 앉히려면 갈등 쌍을 붙여야 해요
  const layout = { blocks: [{ cols: 2, rows: 1 }, { cols: 2, rows: 1 }] };
  const seatIds = layoutSeats(layout).map((s) => s.id);
  const pairs = neighborPairs(layout);
  const groups = groupsOf(layout);
  const past = buildPastPenalty([{ layout, seats: { 'b0-r0-c0': 'a', 'b0-r0-c1': 'b', 'b1-r0-c0': 'c', 'b1-r0-c1': 'd' } }]);

  function bestOf(model) {
    const scored = allAssignments(seatIds, ['a', 'b', 'c', 'd']).map((assign) => ({ assign, cost: model.totalCost(assign, pairs, groups) }));
    const min = Math.min(...scored.map((s) => s.cost));
    return { min, best: scored.filter((s) => s.cost <= min + 1e-9).map((s) => s.assign), scored };
  }
  const conflictNear = (assign) => adjacent(layout, assign, 'a', 'c') || adjacent(layout, assign, 'a', 'd');
  const repeats = (assign) => deskmatePairs(layout, assign).filter(([x, y]) => [x, y].sort().join() === 'a,b' || [x, y].sort().join() === 'c,d').length;

  test('안 좋은 사이(한쪽만 표시, 51)는 지난 짝꿍 두 쌍을 반복하더라도 붙이지 않는다', () => {
    const model = makeCostModel({ rel: (x, y) => (x === 'a' && (y === 'c' || y === 'd') ? 'bad' : 'none'), prob: () => 51, pastPenalty: () => past });
    const { best, scored } = bestOf(model);
    assert.ok(best.length > 0);
    for (const assign of best) {
      assert.ok(!conflictNear(assign), `가장 싼 자리표에 갈등 쌍이 붙어 있음: ${JSON.stringify(assign)}`);
      assert.equal(repeats(assign), 2, '좌석이 넷뿐이라 지난 짝꿍 두 쌍을 그대로 반복하는 것이 정답');
    }
    const worst = scored.filter((s) => deskmatePairs(layout, s.assign).some(([x, y]) => x === 'a' ? ['c', 'd'].includes(y) : y === 'a' && ['c', 'd'].includes(x)));
    assert.ok(Math.min(...worst.map((s) => s.cost)) > Math.min(...scored.map((s) => s.cost)) + 100, '갈등 쌍 짝꿍은 어떤 반복보다 100 넘게 비싸요');
  });

  test('서로 표시한 안 좋은 사이(94)와 AI 예측 값도 마찬가지', () => {
    const mutual = makeCostModel({ rel: (x, y) => ((x === 'a' && (y === 'c' || y === 'd')) || (y === 'a' && (x === 'c' || x === 'd')) ? 'bad' : 'none'), prob: () => 94, pastPenalty: () => past });
    for (const assign of bestOf(mutual).best) assert.ok(!conflictNear(assign));
    const ai = makeCostModel({ rel: (x, y) => (x === 'a' && (y === 'c' || y === 'd') ? 'bad' : 'none'), prob: () => 51, aiProb: () => 30, pastPenalty: () => past });
    for (const assign of bestOf(ai).best) assert.ok(!conflictNear(assign), 'AI 가 낮게 봐도 학생이 표시한 안 좋은 사이는 붙이지 않아요');
  });

  test('다양한 짝이 꺼져 있거나(pastPenalty null) 지난 자리표가 없으면 반복 비용이 없다', () => {
    const model = makeCostModel({ pastPenalty: () => null });
    const assign = { 'b0-r0-c0': 'a', 'b0-r0-c1': 'b', 'b1-r0-c0': 'c', 'b1-r0-c1': 'd' };
    assert.equal(model.totalCost(assign, pairs, groups), 0);
    const on = makeCostModel({ pastPenalty: () => past });
    assert.equal(on.totalCost(assign, pairs, groups), 80 + 80 + 16 * 0.35 + 4 + 4, '짝꿍 반복 두 쌍 + 통로 건너 반복 + 같은 분단 두 쌍');
  });

  test('갈등 가능성이 높을수록 더 멀리 (비용의 기울기는 남아요)', () => {
    const model = makeCostModel({ rel: () => 'bad', prob: () => 90 });
    const low = makeCostModel({ rel: () => 'bad', prob: () => 45 });
    assert.equal(model.pairCost('a', 'b') - low.pairCost('a', 'b'), 45);
    assert.equal(makeCostModel({ rel: () => 'bad' }).pairCost('a', 'b'), COST.CONFLICT_BASE + 50, '분석값이 없으면 50');
    assert.equal(makeCostModel({ aiProb: () => 50 }).pairCost('a', 'b'), 30, '학생이 표시하지 않은 AI 경고 쌍은 가능성 × 0.6 만 (지난 짝꿍보다 낮음)');
    assert.equal(makeCostModel({ aiProb: () => 39 }).pairCost('a', 'b'), 0, 'AI_WARN(40) 미만은 무시');
  });

  test('선생님 규칙: 가까이 앉히기는 안 좋은 사이·지난 짝꿍 비용을 덮고, 떨어뜨리기는 갈등보다 크다', () => {
    const together = { type: 'together' };
    const model = makeCostModel({ rule: (x, y) => (new Set([x, y]).has('a') && new Set([x, y]).has('b') ? together : null), rel: () => 'bad', prob: () => 97, aiProb: () => 97, pastPenalty: () => buildPastPenalty([{ layout: { blocks: [{ cols: 2, rows: 2 }] }, seats: { 'b0-r0-c0': 'a', 'b0-r0-c1': 'b' } }]) });
    assert.equal(model.pairCost('a', 'b'), -COST.RULE_TOGETHER);
    const sq = { blocks: [{ cols: 2, rows: 2 }] };
    const mates = model.totalCost({ 'b0-r0-c0': 'a', 'b0-r0-c1': 'b' }, neighborPairs(sq), groupsOf(sq));
    const diag = model.totalCost({ 'b0-r0-c0': 'a', 'b0-r1-c1': 'b' }, neighborPairs(sq), groupsOf(sq));
    assert.ok(mates < diag, '지난 짝꿍이고 안 좋은 사이여도 가까이 앉히기 규칙이면 짝꿍이 가장 싸요');
    const apart = makeCostModel({ rule: () => ({ type: 'apart' }), rel: () => 'bad', prob: () => 97 });
    assert.ok(apart.pairCost('a', 'b') >= COST.RULE_APART + COST.CONFLICT_BASE + 97);
  });

  test('선생님 👓 앞자리 필요는 지난 짝꿍보다 먼저, 학생이 고른 눈 나쁨은 지난 짝꿍 뒤', () => {
    // 한 분단 2x3. 지난 자리표에서 X·Y 짝꿍. Y 는 r0-c0, A·B 는 r1 에 고정 → X 는 Y 옆(짝꿍 반복)이나 3번째 줄 중 하나
    const sq = { blocks: [{ cols: 2, rows: 3 }] };
    const pastXY = buildPastPenalty([{ layout: sq, seats: { 'b0-r0-c0': 'X', 'b0-r0-c1': 'Y' } }]);
    const front = { 'b0-r0-c0': 'Y', 'b0-r0-c1': 'X', 'b0-r1-c0': 'A', 'b0-r1-c1': 'B' };
    const back = { 'b0-r0-c0': 'Y', 'b0-r1-c0': 'A', 'b0-r1-c1': 'B', 'b0-r2-c0': 'X' };
    const teacher = makeCostModel({ needsFront: (sid) => sid === 'X', pastPenalty: () => pastXY, blockRows: () => 3 });
    assert.ok(teacher.totalCost(front, neighborPairs(sq), groupsOf(sq)) < teacher.totalCost(back, neighborPairs(sq), groupsOf(sq)), '👓 는 짝꿍을 반복하더라도 앞줄');
    const student = makeCostModel({ body: (sid) => (sid === 'X' ? { sight: 'poor' } : {}), pastPenalty: () => pastXY, blockRows: () => 3 });
    assert.ok(student.totalCost(back, neighborPairs(sq), groupsOf(sq)) < student.totalCost(front, neighborPairs(sq), groupsOf(sq)), '학생이 고른 눈 나쁨은 다른 짝을 먼저 봐서 뒤로');
    const first = makeCostModel({ body: (sid) => (sid === 'X' ? { sight: 'poor' } : {}), pastPenalty: () => null, blockRows: () => 3 });
    assert.ok(first.totalCost(front, neighborPairs(sq), groupsOf(sq)) < first.totalCost(back, neighborPairs(sq), groupsOf(sq)), '지난 자리표가 없는 처음 자리표면 눈 나쁜 학생이 앞줄');
  });
});
