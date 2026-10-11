// 선생님 관계도 물리 배치(public/js/force-layout.js): 수렴·NaN 없음·겹침 없음·연결/연결 수에 따른 배치·고정/포커스·명단 갱신·결정성
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSimulation, FORCE_DEFAULTS, hash01 } from '../public/js/force-layout.js';

const R = FORCE_DEFAULTS.collide;
const MIN_GAP = 2 * R - 0.5; // 충돌 반지름 두 개(중심 거리) — 반복 풀이의 오차 0.5px 허용

/** 결정적 난수 (테스트 그래프 생성용) */
function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
/** 앞 번호 학생이 더 인기 있는 무작위 교실 (n 명, 관계 m 개 시도) */
function randomGraph(n, m, seed) {
  const rnd = lcg(seed);
  const nodes = Array.from({ length: n }, (_, i) => ({ id: `s${i}` }));
  const links = [];
  for (let i = 0; i < m; i++) {
    const a = Math.floor(Math.pow(rnd(), 1.6) * n);
    const b = Math.floor(rnd() * n);
    if (a !== b) links.push({ source: `s${a}`, target: `s${b}`, type: rnd() < 0.7 ? 'good' : 'bad' });
  }
  return { nodes, links };
}
/** 허브 1 + 고리 6 + 잎 6 + 외톨이 2 — 연결 수 차이가 뚜렷한 교실 */
function classroom() {
  const nodes = [{ id: 'hub' }];
  const links = [];
  for (let i = 1; i <= 6; i++) {
    nodes.push({ id: `r${i}` }, { id: `l${i}` });
    links.push({ source: 'hub', target: `r${i}`, type: 'good' }, { source: `r${i}`, target: `r${(i % 6) + 1}`, type: 'good' }, { source: `l${i}`, target: `r${i}`, type: 'bad' });
  }
  nodes.push({ id: 'i1' }, { id: 'i2' });
  return { nodes, links };
}
/** graph.js 의 고리 배치와 같은 시작 위치 (연결 수 많은 순으로 안쪽부터) */
function ringLayout(nodes, links) {
  const deg = degreeOf(links);
  const sorted = [...nodes].sort((a, b) => (deg[b.id] || 0) - (deg[a.id] || 0) || a.id.localeCompare(b.id));
  const pos = {};
  let idx = 0;
  let k = 0;
  while (idx < sorted.length) {
    const r = k * 165;
    const cap = k === 0 ? 1 : Math.max(1, Math.floor((2 * Math.PI * r) / 144));
    const count = Math.min(cap, sorted.length - idx);
    for (let j = 0; j < count; j++) { const ang = (2 * Math.PI * j) / count - Math.PI / 2; pos[sorted[idx++].id] = { x: r * 1.3 * Math.cos(ang), y: r * Math.sin(ang) }; }
    k++;
  }
  return nodes.map((n) => ({ id: n.id, ...pos[n.id], degree: deg[n.id] || 0 }));
}
function degreeOf(links) { const d = {}; for (const l of links) { d[l.source] = (d[l.source] || 0) + 1; d[l.target] = (d[l.target] || 0) + 1; } return d; }
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const fromCenter = (sim, nd) => dist(nd, sim.gravityCenter());
const mean = (arr) => arr.reduce((s, v) => s + v, 0) / (arr.length || 1);
const snapshot = (sim) => sim.nodes().map((n) => [n.id, n.x, n.y]);
const allFinite = (sim) => sim.nodes().every((n) => [n.x, n.y, n.vx, n.vy].every(Number.isFinite));
function pairDistances(sim) {
  const ns = sim.nodes();
  const out = [];
  for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) out.push({ a: ns[i], b: ns[j], d: dist(ns[i], ns[j]) });
  return out;
}
const pairKey = (x, y) => (x < y ? `${x}|${y}` : `${y}|${x}`);
const settled = (spec) => { const sim = createSimulation(spec); sim.settle(); return sim; };

describe('force-layout: 기본값과 옵션', () => {
  test('FORCE_DEFAULTS 가 계약의 숫자를 노출하고 얼어 있음', () => {
    assert.equal(FORCE_DEFAULTS.charge, -1600);
    assert.equal(FORCE_DEFAULTS.linkDistance, 190);
    assert.equal(FORCE_DEFAULTS.linkStrength, 0.08);
    assert.equal(FORCE_DEFAULTS.gravity, 0.03);
    assert.equal(FORCE_DEFAULTS.gravityDegree, 0.12);
    assert.equal(FORCE_DEFAULTS.collide, 66);
    assert.equal(FORCE_DEFAULTS.focusStrength, 0.18);
    assert.equal(FORCE_DEFAULTS.velocityDecay, 0.55);
    assert.equal(FORCE_DEFAULTS.alphaDecay, 0.028);
    assert.equal(FORCE_DEFAULTS.alphaMin, 0.001);
    assert.ok(Object.isFrozen(FORCE_DEFAULTS));
  });

  test('options 로 덮어쓰고, 숫자가 아니면 기본값', () => {
    const sim = createSimulation({ nodes: [{ id: 'a' }], options: { alphaDecay: 0.5, charge: 'nope', collide: NaN } });
    assert.equal(sim.options().alphaDecay, 0.5);
    assert.equal(sim.options().charge, FORCE_DEFAULTS.charge);
    assert.equal(sim.options().collide, FORCE_DEFAULTS.collide);
    sim.tick(10);
    assert.ok(Math.abs(sim.alpha() - 0.5 ** 10) < 1e-12, 'alpha 는 tick 마다 (alphaTarget - alpha)·alphaDecay 만큼');
  });

  test('hash01: 결정적이고 [0, 1) 범위', () => {
    assert.equal(hash01('철수'), hash01('철수'));
    assert.notEqual(hash01('철수'), hash01('영희'));
    for (const s of ['', 'a', 'abc', '학생-12']) { const v = hash01(s); assert.ok(v >= 0 && v < 1); }
  });
});

describe('force-layout: 입력 정리', () => {
  test('입력을 복사해 내부 노드 { id, x, y, vx, vy, fx, fy, degree } 로 들고, nodes() 는 매 tick 같은 객체', () => {
    const input = [{ id: 1, x: 10, y: 20, degree: 3 }, { id: 'b' }];
    const sim = createSimulation({ nodes: input, links: [{ source: 1, target: 'b', type: 'good' }] });
    const [a, b] = sim.nodes();
    assert.notEqual(a, input[0], '입력 객체를 그대로 쓰지 않음');
    assert.deepEqual(a, { id: '1', x: 10, y: 20, vx: 0, vy: 0, fx: null, fy: null, degree: 3 }, 'id 는 문자열, degree 는 준 값 유지');
    assert.equal(b.degree, 1, 'degree 를 안 주면 연결 수로');
    assert.equal(sim.node(1), a, 'node(id) 는 숫자 id 도 찾음');
    sim.tick(5);
    assert.equal(sim.nodes()[0], a);
    assert.ok(allFinite(sim));
  });

  test('같은 두 노드 사이 간선 여러 개는 한 번만, 모르는 id·자기 자신·빈 값은 무시', () => {
    const sim = createSimulation({
      nodes: [{ id: 'a' }, { id: 'a' }, { id: 'b' }, null, { id: 'c', x: 'bad', y: 3 }],
      links: [{ source: 'a', target: 'b', type: 'good' }, { source: 'b', target: 'a', type: 'bad' }, { source: 'a', target: 'a' }, { source: 'zz', target: 'b' }, null],
    });
    assert.deepEqual(sim.nodes().map((n) => n.id), ['a', 'b', 'c']);
    assert.deepEqual(sim.links(), [{ source: 'a', target: 'b' }]);
    assert.deepEqual(sim.nodes().map((n) => n.degree), [1, 1, 0]);
    sim.settle();
    assert.ok(allFinite(sim), '좌표가 숫자가 아니어도 NaN 없이 자리 잡음');
  });

  test('빈 시뮬레이션도 동작', () => {
    const sim = createSimulation({});
    assert.ok(sim.settle() <= 400);
    assert.equal(sim.tick(), false);
    assert.equal(sim.isActive(), false);
    assert.deepEqual(sim.nodes(), []);
  });
});

describe('force-layout: 수렴과 배치 품질', () => {
  const cases = [
    ['12명 · 고리 배치 시작', () => { const g = randomGraph(12, 40, 1); return { nodes: ringLayout(g.nodes, g.links), links: g.links }; }],
    ['12명 · 시작 위치 없음', () => randomGraph(12, 60, 2)],
    ['25명 · 시작 위치 없음', () => randomGraph(25, 90, 3)],
    ['40명 · 관계 ~200', () => { const g = randomGraph(40, 200, 4); return { nodes: ringLayout(g.nodes, g.links), links: g.links }; }],
    ['허브 교실', () => classroom()],
    ['6명 · 관계 3개 (외톨이 포함)', () => randomGraph(6, 3, 6)],
  ];

  for (const [label, make] of cases) {
    test(`${label}: settle 뒤 alpha ≤ alphaMin, NaN 없음, 멈춤`, () => {
      const sim = createSimulation(make());
      const ticks = sim.settle();
      assert.ok(ticks <= 400 && ticks > 0);
      assert.ok(sim.alpha() <= FORCE_DEFAULTS.alphaMin, `alpha ${sim.alpha()}`);
      assert.equal(sim.tick(), false);
      assert.equal(sim.isActive(), false);
      assert.ok(allFinite(sim));
    });

    test(`${label}: 노드끼리 겹치지 않음 (중심 거리 ≥ 2·collide)`, () => {
      const sim = settled(make());
      for (const p of pairDistances(sim)) assert.ok(p.d >= MIN_GAP, `${p.a.id}–${p.b.id} 거리 ${p.d.toFixed(1)}`);
    });
  }

  test('연결된 쌍이 연결 안 된 쌍보다 평균 가까움', () => {
    for (const spec of [randomGraph(12, 40, 1), randomGraph(25, 90, 3), randomGraph(40, 200, 5), classroom()]) {
      const sim = settled(spec);
      const linked = new Set(sim.links().map((l) => pairKey(l.source, l.target)));
      const conn = []; const other = [];
      for (const p of pairDistances(sim)) (linked.has(pairKey(p.a.id, p.b.id)) ? conn : other).push(p.d);
      assert.ok(mean(conn) < mean(other), `연결 ${mean(conn).toFixed(0)} vs 비연결 ${mean(other).toFixed(0)}`);
    }
  });

  test('연결 수(degree)가 큰 노드가 중심에 더 가까움', () => {
    const sim = settled(classroom());
    const hub = fromCenter(sim, sim.node('hub'));
    for (const nd of sim.nodes()) if (nd.id !== 'hub') assert.ok(hub < fromCenter(sim, nd), `hub ${hub.toFixed(0)} < ${nd.id} ${fromCenter(sim, nd).toFixed(0)}`);
    const leaves = mean(['l1', 'l2', 'l3', 'l4', 'l5', 'l6'].map((id) => fromCenter(sim, sim.node(id))));
    const ring = mean(['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map((id) => fromCenter(sim, sim.node(id))));
    assert.ok(ring < leaves, `고리(연결 4) ${ring.toFixed(0)} < 잎(연결 1) ${leaves.toFixed(0)}`);
    for (const spec of [randomGraph(12, 60, 2), randomGraph(40, 200, 4)]) {
      const s = settled(spec);
      const byDeg = [...s.nodes()].sort((a, b) => b.degree - a.degree);
      const q = Math.max(1, Math.floor(byDeg.length / 4));
      const top = mean(byDeg.slice(0, q).map((nd) => fromCenter(s, nd)));
      const bottom = mean(byDeg.slice(-q).map((nd) => fromCenter(s, nd)));
      assert.ok(top < bottom, `상위 ${top.toFixed(0)} < 하위 ${bottom.toFixed(0)}`);
    }
  });

  test('연결된 두 노드는 linkDistance 와 1.5배 사이(반발과 균형), 외톨이는 바깥', () => {
    const sim = settled({ nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], links: [{ source: 'a', target: 'b', type: 'good' }] });
    const ab = dist(sim.node('a'), sim.node('b'));
    assert.ok(ab >= FORCE_DEFAULTS.linkDistance && ab <= FORCE_DEFAULTS.linkDistance * 1.5, `a–b ${ab.toFixed(0)}`);
    assert.ok(dist(sim.node('a'), sim.node('c')) > ab && dist(sim.node('b'), sim.node('c')) > ab);
  });

  test('같은 자리(거리 0)에 놓인 노드들은 id 해시 지터로 떼어 놓고 결정적으로 자리 잡음 (Math.random 없음)', () => {
    const make = () => ({ nodes: Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, x: 0, y: 0 })), links: [{ source: 's0', target: 's1' }, { source: 's2', target: 's3' }] });
    const a = createSimulation(make());
    const start = pairDistances(a);
    assert.ok(start.every((p) => p.d > 0), '만들자마자 겹친 쌍이 없음');
    assert.ok(start.every((p) => p.d < 10), '지터는 작음');
    const b = createSimulation(make());
    assert.deepEqual(snapshot(a), snapshot(b));
    a.settle(); b.settle();
    assert.ok(allFinite(a));
    for (const p of pairDistances(a)) assert.ok(p.d >= MIN_GAP, `${p.a.id}–${p.b.id} ${p.d.toFixed(1)}`);
    assert.deepEqual(snapshot(a), snapshot(b));
  });

  test('결정적: 같은 입력 두 번 → 같은 결과 (드래그·포커스를 섞어도)', () => {
    const run = () => {
      const g = randomGraph(20, 70, 9);
      const sim = createSimulation({ nodes: ringLayout(g.nodes, g.links), links: g.links });
      sim.settle();
      sim.focus('s7').reheat(0.5).tick(40);
      sim.alphaTarget(0.3);
      for (let i = 0; i < 20; i++) { sim.fix('s3', 100 + i * 5, -50 + i * 3); sim.tick(); }
      sim.release('s3').alphaTarget(0).focus(null).settle();
      return snapshot(sim);
    };
    assert.deepEqual(run(), run());
  });

  test('40명 · 관계 200: settle 이 빠름', () => {
    const g = randomGraph(40, 200, 4);
    const t0 = performance.now();
    settled({ nodes: ringLayout(g.nodes, g.links), links: g.links });
    assert.ok(performance.now() - t0 < 500, `${(performance.now() - t0).toFixed(0)}ms`);
  });
});

describe('force-layout: alpha · reheat · alphaTarget · settle', () => {
  test('alpha/alphaTarget getter·setter 와 reheat', () => {
    const sim = createSimulation(classroom());
    assert.equal(sim.alpha(), 1);
    assert.equal(sim.alphaTarget(), 0);
    sim.settle();
    assert.ok(sim.alpha() <= FORCE_DEFAULTS.alphaMin);
    assert.equal(sim.reheat().alpha(), 0.6, 'reheat() 기본 0.6');
    assert.equal(sim.reheat(0.2).alpha(), 0.6, 'reheat 는 max(alpha, v) — 낮추지 않음');
    assert.equal(sim.reheat(1.5).alpha(), 1, '1 로 clamp');
    assert.equal(sim.alpha(0.4).alpha(), 0.4);
    assert.equal(sim.alpha(-1).alpha(), 0);
    assert.equal(sim.alphaTarget(0.3).alphaTarget(), 0.3);
    assert.equal(sim.alphaTarget(2).alphaTarget(), 1);
  });

  test('alphaTarget > 0 이면 alpha 가 그 값으로 가고 tick 이 계속 true, 0 으로 돌리면 식어서 멈춤', () => {
    const sim = createSimulation(classroom());
    sim.settle();
    sim.alphaTarget(0.3);
    assert.equal(sim.isActive(), true, 'alpha 가 작아도 alphaTarget > 0 이면 살아 있음');
    for (let i = 0; i < 300; i++) assert.equal(sim.tick(), true);
    assert.ok(Math.abs(sim.alpha() - 0.3) < 1e-3, `alpha ${sim.alpha()}`);
    assert.equal(sim.settle(50), 50, 'alphaTarget 이 있으면 maxTicks 만큼 돌고 끝');
    sim.alphaTarget(0);
    assert.equal(sim.isActive(), true, '식는 중에도 alpha > alphaMin 이면 살아 있음');
    const ticks = sim.settle();
    assert.ok(ticks > 100 && ticks < 400, `${ticks}`);
    assert.equal(sim.isActive(), false);
    assert.equal(sim.tick(), false);
  });

  test('tick(n) 은 n 번 진행하고, settle(maxTicks) 는 그만큼만 돌고 진행한 수를 돌려줌', () => {
    const sim = createSimulation(classroom());
    sim.tick(10);
    assert.ok(Math.abs(sim.alpha() - (1 - FORCE_DEFAULTS.alphaDecay) ** 10) < 1e-12);
    assert.equal(sim.settle(20), 20);
    assert.ok(sim.alpha() > FORCE_DEFAULTS.alphaMin);
    assert.equal(sim.tick(), true);
    const rest = sim.settle();
    assert.ok(rest > 0 && rest + 31 <= 400);
    assert.equal(sim.settle(), 1, '이미 멈춰 있으면 한 번 보고 끝');
  });
});

describe('force-layout: 고정(드래그) · 포커스(센터링) · 중심', () => {
  test('fix 한 노드는 포인터 자리에 머물고 이웃이 따라오며, release 뒤 다시 움직여 자리를 잡음', () => {
    const sim = settled(classroom());
    const r1 = sim.node('r1');
    const before = snapshot(sim);
    sim.alphaTarget(0.3);
    for (let i = 1; i <= 30; i++) { sim.fix('r1', 500 + i * 10, 300 + i * 5); sim.tick(); assert.equal(r1.x, 500 + i * 10); assert.equal(r1.y, 300 + i * 5); }
    assert.deepEqual([r1.fx, r1.fy, r1.vx, r1.vy], [800, 450, 0, 0]);
    const l1 = sim.node('l1');
    const l1Before = before.find((p) => p[0] === 'l1');
    assert.ok(Math.hypot(l1.x - l1Before[1], l1.y - l1Before[2]) > 50, '잎 l1 이 끌려온 r1 을 따라옴');
    assert.equal(sim.isActive(), true);
    sim.release('r1').alphaTarget(0);
    assert.deepEqual([r1.fx, r1.fy], [null, null]);
    let moved = 0;
    let lastMoving = 0;
    let prev = { x: r1.x, y: r1.y };
    while (sim.tick()) { moved++; const step = dist(prev, r1); if (step > 0.5) lastMoving = moved; prev = { x: r1.x, y: r1.y }; }
    assert.ok(dist(r1, { x: 800, y: 450 }) > 30, '놓으면 다시 움직임');
    assert.ok(lastMoving >= 10, `놓은 뒤 여러 프레임 출렁임 (${lastMoving} 프레임)`);
    assert.ok(moved > lastMoving, '그 뒤 멈춤');
    for (const p of pairDistances(sim)) assert.ok(p.d >= MIN_GAP);
  });

  test('fix(id) 좌표 없이 부르면 지금 자리에 고정, 모르는 id 는 무시', () => {
    const sim = settled(classroom());
    const hub = sim.node('hub');
    const { x, y } = hub;
    sim.fix('hub').reheat(1).tick(50);
    assert.deepEqual([hub.x, hub.y], [x, y]);
    assert.doesNotThrow(() => sim.fix('없음', 1, 2).release('없음'));
  });

  test('focus 노드는 settle 뒤 gravityCenter 에서 collide 반지름 안, 이웃이 따라 모이고, 겹침 없음', () => {
    for (const spec of [classroom(), randomGraph(40, 200, 5)]) {
      const sim = settled(spec);
      const far = [...sim.nodes()].sort((a, b) => fromCenter(sim, b) - fromCenter(sim, a))[0];
      assert.ok(fromCenter(sim, far) > 2 * R, '가장 먼 노드로 시작');
      const nb = sim.links().filter((l) => l.source === far.id || l.target === far.id).map((l) => sim.node(l.source === far.id ? l.target : l.source));
      const nbBefore = mean(nb.map((n) => dist(n, far)));
      sim.setGravityCenter(120, -80);
      sim.focus(far.id).reheat(0.5);
      assert.equal(sim.focus(), far.id);
      sim.tick(30);
      assert.ok(fromCenter(sim, far) < 150, `0.5초(30 tick) 뒤 150px 안: ${fromCenter(sim, far).toFixed(0)}`);
      sim.settle();
      assert.ok(fromCenter(sim, far) <= R, `settle 뒤 ${fromCenter(sim, far).toFixed(1)}`);
      if (nb.length) assert.ok(mean(nb.map((n) => dist(n, far))) < nbBefore + 1, '이웃이 더 가까이 모임');
      for (const p of pairDistances(sim)) assert.ok(p.d >= MIN_GAP, `${p.a.id}–${p.b.id} ${p.d.toFixed(1)}`);
      assert.ok(allFinite(sim));
    }
  });

  test('focus(null) 로 풀면 reheat 뒤 제자리로 돌아가고, 모르는 id·없어진 노드는 null', () => {
    const sim = settled(classroom());
    sim.focus('l3').reheat(0.5).settle();
    assert.ok(fromCenter(sim, sim.node('l3')) <= R);
    sim.focus(null).reheat(0.3);
    assert.equal(sim.focus(), null);
    sim.settle();
    assert.ok(fromCenter(sim, sim.node('l3')) > R, '잎은 가운데를 허브에 내주고 바깥으로');
    assert.equal(sim.focus('없음').focus(), null);
    sim.focus('l3').update({ nodes: sim.nodes().filter((n) => n.id !== 'l3').map((n) => ({ id: n.id })), links: [] });
    assert.equal(sim.focus(), null);
  });

  test('fix 가 focus 보다 우선: 고정된 노드는 센터링돼도 안 움직임', () => {
    const sim = settled(classroom());
    sim.fix('l2', 900, 900).focus('l2').reheat(1).settle();
    assert.deepEqual([sim.node('l2').x, sim.node('l2').y], [900, 900]);
  });

  test('setGravityCenter / gravityCenter: 노드 하나는 중심으로 가고, 돌려주는 값은 복사본', () => {
    const sim = createSimulation({ nodes: [{ id: 'a', x: 5, y: 5 }] });
    sim.setGravityCenter(100, -50);
    const c = sim.gravityCenter();
    assert.deepEqual(c, { x: 100, y: -50 });
    c.x = 0;
    assert.deepEqual(sim.gravityCenter(), { x: 100, y: -50 });
    sim.settle();
    assert.ok(fromCenter(sim, sim.node('a')) < 60, `${fromCenter(sim, sim.node('a')).toFixed(1)}`);
    sim.setGravityCenter('x', NaN);
    assert.deepEqual(sim.gravityCenter(), { x: 100, y: -50 }, '숫자가 아니면 그대로');
  });
});

describe('force-layout: update (명단 바뀜)', () => {
  test('있던 id 는 위치·속도 유지(입력 x·y 무시), 새 노드는 이웃 평균 근처(x·y 를 주면 그 자리), 외톨이는 바깥 고리, 없어진 노드 제거, alpha 그대로', () => {
    const g = randomGraph(12, 40, 1);
    const sim = createSimulation(g);
    sim.tick(30); // 움직이는 중에 갱신 → 속도도 유지되는지
    const before = Object.fromEntries(sim.nodes().map((n) => [n.id, { ...n }]));
    const alpha = sim.alpha();
    const nodes = [...g.nodes.filter((n) => n.id !== 's11').map((n) => ({ ...n, x: 9999, y: 9999 })), { id: 'new1' }, { id: 'lonely' }, { id: 'placed', x: -1234, y: 567 }];
    const links = [...g.links.filter((l) => l.source !== 's11' && l.target !== 's11'), { source: 'new1', target: 's0', type: 'good' }, { source: 's3', target: 'new1', type: 'bad' }];
    sim.update({ nodes, links });
    assert.equal(sim.alpha(), alpha);
    assert.equal(sim.node('s11'), null);
    assert.deepEqual(sim.nodes().map((n) => n.id), nodes.map((n) => n.id), '순서는 입력 순서');
    for (const nd of sim.nodes()) if (before[nd.id]) assert.deepEqual({ x: nd.x, y: nd.y, vx: nd.vx, vy: nd.vy }, { x: before[nd.id].x, y: before[nd.id].y, vx: before[nd.id].vx, vy: before[nd.id].vy });
    assert.deepEqual([sim.node('placed').x, sim.node('placed').y], [-1234, 567], '새 노드에 x·y 를 주면 그 자리');
    const n1 = sim.node('new1');
    const s0 = sim.node('s0');
    const s3 = sim.node('s3');
    const mid = { x: (s0.x + s3.x) / 2, y: (s0.y + s3.y) / 2 };
    assert.ok(dist(n1, mid) <= R + 1e-9, `새 노드는 이웃 평균에서 collide 만큼: ${dist(n1, mid).toFixed(1)}`);
    assert.equal(n1.degree, 2);
    const lonely = sim.node('lonely');
    const maxR = Math.max(...sim.nodes().filter((n) => before[n.id]).map((n) => fromCenter(sim, n)));
    assert.ok(fromCenter(sim, lonely) > maxR, '이웃 없는 새 노드는 기존 노드 바깥 고리');
    assert.ok(allFinite(sim));
    sim.reheat(0.4).settle();
    assert.ok(dist(n1, s0) < 400 && dist(n1, s3) < 400);
    for (const p of pairDistances(sim)) assert.ok(p.d >= MIN_GAP);
  });

  test('update 로 degree 를 주면 그 값, 안 주면 다시 셈', () => {
    const sim = createSimulation({ nodes: [{ id: 'a', degree: 9 }, { id: 'b' }], links: [{ source: 'a', target: 'b' }] });
    assert.deepEqual(sim.nodes().map((n) => n.degree), [9, 1]);
    sim.update({ nodes: [{ id: 'a' }, { id: 'b', degree: 4 }, { id: 'c' }], links: [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }] });
    assert.deepEqual(sim.nodes().map((n) => n.degree), [2, 4, 1]);
    assert.deepEqual(sim.links(), [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }]);
  });

  test('전부 새 노드면(빈 시뮬레이션에 update) 나선으로 놓고 겹치지 않음', () => {
    const sim = createSimulation({});
    sim.update(classroom());
    assert.equal(sim.nodes().length, 15);
    assert.ok(pairDistances(sim).every((p) => p.d > 0));
    sim.settle();
    for (const p of pairDistances(sim)) assert.ok(p.d >= MIN_GAP);
  });

  test('고정 중인 노드는 update 뒤에도 고정 유지, 없어지면 release 할 것 없이 사라짐', () => {
    const sim = settled(classroom());
    sim.fix('r2', 700, 700);
    sim.update({ nodes: sim.nodes().map((n) => ({ id: n.id })), links: [] });
    assert.deepEqual([sim.node('r2').fx, sim.node('r2').fy], [700, 700]);
    sim.reheat(1).tick(20);
    assert.deepEqual([sim.node('r2').x, sim.node('r2').y], [700, 700]);
    sim.update({ nodes: [{ id: 'hub' }], links: [] });
    assert.deepEqual(sim.nodes().map((n) => n.id), ['hub']);
    assert.doesNotThrow(() => sim.release('r2').tick());
  });
});
