// 선생님 관계도용 포스 다이렉티드(force-directed) 물리 배치 — 순수 모듈(DOM 없음). 브라우저·Node 양쪽에서 import 할 수 있고 의존성이 없어요.
//
// createSimulation({ nodes, links, options }) → sim
//   nodes: [{ id, x?, y?, degree? }]   links: [{ source, target, type? }] (source/target 는 id 문자열)
//   입력 객체는 복사해서 내부 노드 { id, x, y, vx, vy, fx, fy, degree } 로 들고 있고, sim.nodes() 가 그 배열을 돌려줘요(같은 객체를 매 tick 갱신).
//
// 힘 (d3-force 와 비슷하게; 숫자는 FORCE_DEFAULTS, options 로 덮어쓰기)
//   charge   모든 노드 쌍이 서로 밀어냄: 변위 벡터 × |charge| × alpha / 거리² (거리는 chargeMinDistance 아래로 clamp)
//   link     간선이 스프링처럼 linkDistance 로 당김 (같은 두 노드 사이 간선이 여러 개면 한 번만, 연결 많은 쪽이 덜 움직임)
//   gravity  gravityCenter 로 당김, 연결 수가 많을수록 조금 더 세게: × (1 + gravityDegree·degree)
//   focus    focus(id) 노드를 gravityCenter 로 세게 당김 (센터링) — alpha 와 상관없이 같은 세기라 settle 뒤엔 가운데에 닿아요
//   collide  반지름 collide 원끼리 겹치면 밀어냄 — 겹침은 alpha 와 상관없이 그대로 풀어 주어 멈춘 뒤에도 겹치지 않아요
//            (charge·link·gravity 는 alpha 에 비례)
//   alpha 는 1 에서 시작해 tick 마다 alpha += (alphaTarget - alpha)·alphaDecay, alphaMin 아래면 멈춘 것으로 봐요(tick 이 false).
//   속도는 tick 마다 (1 - velocityDecay) 를 곱해 줄여요(d3 와 같은 뜻).
//   Math.random 을 쓰지 않아요 — 같은 입력이면 항상 같은 결과(겹친 노드를 떼는 지터도 id 문자열 해시로 정함).
//
// sim API
//   nodes() / node(id) / links()        내부 노드 배열 · id 로 찾기 · 중복 제거한 간선 쌍 [{ source, target }]
//   tick(n = 1) → boolean               n 번 진행, 남은 alpha 가 alphaMin 보다 크면 true
//   alpha([v]) / alphaTarget([v])       getter/setter
//   reheat(v = 0.6)                     alpha = max(alpha, v)
//   isActive()                          alpha > alphaMin 또는 alphaTarget > 0
//   fix(id, x, y) / release(id)         드래그 중 고정 / 해제
//   focus(id | null)                    센터링 대상 (인수 없이 부르면 현재 값)
//   setGravityCenter(x, y) / gravityCenter()
//   settle(maxTicks = 400) → 진행한 tick 수   alpha 가 alphaMin 아래로 내려갈 때까지 동기 진행 (초기 배치·reduced-motion 용)
//   update({ nodes, links })            있던 id 는 위치·속도 유지(입력의 x·y 는 무시), 새 노드는 x·y 를 줬으면 그 자리, 아니면 이웃 평균 근처
//                                       (이웃 없으면 기존 노드 바깥 고리), 없어진 노드 제거. alpha 는 그대로(호출자가 reheat)

export const FORCE_DEFAULTS = Object.freeze({
  charge: -1600,          // 반발 세기 (음수가 밀어냄)
  chargeMinDistance: 40,  // 이보다 가까운 쌍은 이 거리로 보고 계산 (가까울 때 힘이 터지지 않게)
  linkDistance: 190,      // 간선 스프링의 목표 길이
  linkStrength: 0.08,
  gravity: 0.03,          // 중심 중력
  gravityDegree: 0.12,    // 연결 1개당 중력 가산 비율
  collide: 66,            // 노드 반지름 (이름 상자 104×40 을 넉넉히 덮음) — 두 노드 중심은 2·collide 이상 떨어짐
  collideStrength: 1,
  collideIterations: 2,
  focusStrength: 0.18,    // 센터링 스프링
  focusLinkBoost: 3,      // 포커스 노드에 붙은 간선은 이만큼 더 세게 당겨 이웃이 따라 모이게
  velocityDecay: 0.55,
  alphaDecay: 0.028,
  alphaMin: 0.001,
  maxSpeed: 240,          // 한 tick 에 움직일 수 있는 최대 거리
  jitter: 1,              // 같은 자리에 놓인 노드를 떼어 놓는 거리
});

const TAU = Math.PI * 2;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const EPS2 = 1e-12;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, d) => (isNum(v) ? v : d);

/** 문자열 → [0, 1) 결정적 해시 (FNV-1a) */
export function hash01(str) {
  let h = 2166136261;
  const s = String(str);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

/** 두 노드가 정확히 같은 자리일 때 쓰는 아주 작은 변위 (id 쌍 해시로 방향을 정함) */
function jiggle(a, b) {
  const t = hash01(`${a.id}\u0001${b.id}`) * TAU;
  return [Math.cos(t) * 1e-3, Math.sin(t) * 1e-3];
}

/** i 번째 노드의 기본 자리: 중심에서 바깥으로 도는 해바라기 나선 */
function spiralPos(i, center, step) {
  if (i === 0) return { x: center.x, y: center.y };
  const r = step * Math.sqrt(i);
  const t = i * GOLDEN_ANGLE;
  return { x: center.x + r * Math.cos(t), y: center.y + r * Math.sin(t) };
}

function resolveOptions(options) {
  const o = {};
  for (const k of Object.keys(FORCE_DEFAULTS)) o[k] = num(options?.[k], FORCE_DEFAULTS[k]);
  o.velocityDecay = Math.min(0.99, Math.max(0, o.velocityDecay));
  o.alphaDecay = Math.min(1, Math.max(0, o.alphaDecay));
  o.collideIterations = Math.max(0, Math.round(o.collideIterations));
  return o;
}

class ForceSimulation {
  constructor({ nodes = [], links = [], options = {} } = {}) {
    this.o = resolveOptions(options);
    this._alpha = 1;
    this._alphaTarget = 0;
    this._center = { x: 0, y: 0 };
    this._focusId = null;
    this._nodes = [];
    this._byId = new Map();
    this._pairs = [];
    this.update({ nodes, links });
  }

  // ---------- 조회 ----------
  nodes() { return this._nodes; }
  node(id) { return this._byId.get(String(id)) || null; }
  links() { return this._pairs.map((p) => ({ source: p.a.id, target: p.b.id })); }
  options() { return { ...this.o }; }

  // ---------- alpha ----------
  alpha(v) {
    if (v === undefined) return this._alpha;
    this._alpha = Math.min(1, Math.max(0, num(v, this._alpha)));
    return this;
  }
  alphaTarget(v) {
    if (v === undefined) return this._alphaTarget;
    this._alphaTarget = Math.min(1, Math.max(0, num(v, this._alphaTarget)));
    return this;
  }
  reheat(v = 0.6) { this._alpha = Math.max(this._alpha, Math.min(1, Math.max(0, num(v, 0.6)))); return this; }
  isActive() { return this._alpha > this.o.alphaMin || this._alphaTarget > 0; }

  // ---------- 고정 · 포커스 · 중심 ----------
  fix(id, x, y) {
    const nd = this.node(id);
    if (!nd) return this;
    nd.fx = num(x, nd.x);
    nd.fy = num(y, nd.y);
    nd.x = nd.fx; nd.y = nd.fy;
    nd.vx = 0; nd.vy = 0;
    return this;
  }
  release(id) {
    const nd = this.node(id);
    if (nd) { nd.fx = null; nd.fy = null; }
    return this;
  }
  focus(id) {
    if (arguments.length === 0) return this._focusId;
    this._focusId = id == null || !this._byId.has(String(id)) ? null : String(id);
    return this;
  }
  setGravityCenter(x, y) { this._center = { x: num(x, this._center.x), y: num(y, this._center.y) }; return this; }
  gravityCenter() { return { ...this._center }; }

  // ---------- 진행 ----------
  tick(n = 1) {
    const times = Math.max(1, Math.floor(num(n, 1)));
    for (let i = 0; i < times; i++) this._step();
    return this._alpha > this.o.alphaMin;
  }

  settle(maxTicks = 400) {
    const max = Math.max(0, Math.floor(num(maxTicks, 400)));
    let i = 0;
    for (; i < max; i++) if (!this.tick()) { i++; break; }
    return i;
  }

  _step() {
    const o = this.o;
    this._alpha += (this._alphaTarget - this._alpha) * o.alphaDecay;
    const alpha = this._alpha;
    const nodes = this._nodes;
    const n = nodes.length;
    const c = this._center;

    // link: 스프링 (예상 위치 기준, 연결 많은 쪽이 덜 움직임). 포커스 노드에 붙은 간선은 더 세게, 이웃 쪽만 움직여서 따라 모이게
    const focus = this._focusId ? this._byId.get(this._focusId) : null;
    for (const p of this._pairs) {
      const a = p.a; const b = p.b;
      let dx = b.x + b.vx - a.x - a.vx;
      let dy = b.y + b.vy - a.y - a.vy;
      let d2 = dx * dx + dy * dy;
      if (d2 < EPS2) { [dx, dy] = jiggle(a, b); d2 = dx * dx + dy * dy; }
      const d = Math.sqrt(d2);
      const focused = focus && (a === focus || b === focus);
      const f = ((d - o.linkDistance) / d) * o.linkStrength * alpha * (focused ? o.focusLinkBoost : 1);
      const bias = focused ? (a === focus ? 1 : 0) : p.bias;
      dx *= f; dy *= f;
      b.vx -= dx * bias; b.vy -= dy * bias;
      a.vx += dx * (1 - bias); a.vy += dy * (1 - bias);
    }

    // charge: 모든 쌍 반발
    const k = -o.charge * alpha;
    const min2 = o.chargeMinDistance * o.chargeMinDistance;
    if (k !== 0) {
      for (let i = 0; i < n; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < n; j++) {
          const b = nodes[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < EPS2) { [dx, dy] = jiggle(a, b); d2 = dx * dx + dy * dy; }
          if (d2 < min2) d2 = min2;
          const w = k / d2;
          a.vx += dx * w; a.vy += dy * w;
          b.vx -= dx * w; b.vy -= dy * w;
        }
      }
    }

    // gravity: 중심으로, 연결 많을수록 조금 더 세게 / focus: 센터링
    for (const nd of nodes) {
      const g = o.gravity * (1 + o.gravityDegree * nd.degree) * alpha;
      nd.vx += (c.x - nd.x) * g;
      nd.vy += (c.y - nd.y) * g;
    }
    // focus: 센터링 스프링 — alpha 와 상관없이 같은 세기로 당겨서, 멀리 있던 노드도 멈추기 전에 가운데에 닿아요
    if (focus && focus.fx == null) {
      focus.vx += (c.x - focus.x) * o.focusStrength;
      focus.vy += (c.y - focus.y) * o.focusStrength;
    }

    // collide: 예상 위치에서 겹치면 밀어냄 (고정·포커스 노드는 비켜 주지 않고 상대가 다 움직임)
    const r = o.collide * 2;
    const r2 = r * r;
    for (let it = 0; it < o.collideIterations; it++) {
      for (let i = 0; i < n; i++) {
        const a = nodes[i];
        const ax = a.x + a.vx; const ay = a.y + a.vy;
        for (let j = i + 1; j < n; j++) {
          const b = nodes[j];
          let dx = ax - (b.x + b.vx);
          let dy = ay - (b.y + b.vy);
          let d2 = dx * dx + dy * dy;
          if (d2 >= r2) continue;
          if (d2 < EPS2) { [dx, dy] = jiggle(a, b); d2 = dx * dx + dy * dy; }
          const d = Math.sqrt(d2);
          const l = ((r - d) / d) * o.collideStrength;
          dx *= l; dy *= l;
          const wa = a.fx != null || a === focus ? 0 : b.fx != null || b === focus ? 1 : 0.5;
          a.vx += dx * wa; a.vy += dy * wa;
          b.vx -= dx * (1 - wa); b.vy -= dy * (1 - wa);
        }
      }
    }

    // 적분
    const keep = 1 - o.velocityDecay;
    const max = o.maxSpeed;
    for (let i = 0; i < n; i++) {
      const nd = nodes[i];
      if (nd.fx != null) { nd.x = nd.fx; nd.y = nd.fy; nd.vx = 0; nd.vy = 0; continue; }
      nd.vx *= keep; nd.vy *= keep;
      const sp = Math.hypot(nd.vx, nd.vy);
      if (sp > max) { nd.vx *= max / sp; nd.vy *= max / sp; }
      nd.x += nd.vx; nd.y += nd.vy;
      if (!Number.isFinite(nd.x) || !Number.isFinite(nd.y)) {
        const p = spiralPos(i + 1, c, o.collide * 1.5);
        nd.x = p.x; nd.y = p.y; nd.vx = 0; nd.vy = 0;
      }
    }
  }

  // ---------- 명단 갱신 ----------
  update({ nodes = [], links = [] } = {}) {
    const prev = this._byId;
    const next = [];
    const byId = new Map();
    const fresh = [];
    for (const input of Array.isArray(nodes) ? nodes : []) {
      if (input == null || input.id == null) continue;
      const id = String(input.id);
      if (byId.has(id)) continue;
      let nd = prev.get(id);
      if (!nd) { nd = { id, x: num(input.x, NaN), y: num(input.y, NaN), vx: 0, vy: 0, fx: null, fy: null, degree: 0 }; fresh.push(nd); }
      nd.degree = isNum(input.degree) ? Math.max(0, input.degree) : null;
      next.push(nd);
      byId.set(id, nd);
    }
    this._nodes = next;
    this._byId = byId;
    this._buildPairs(links);
    this._placeFresh(fresh);
    if (this._focusId && !byId.has(this._focusId)) this._focusId = null;
    return this;
  }

  _buildPairs(links) {
    const seen = new Set();
    const pairs = [];
    const count = new Map();
    for (const l of Array.isArray(links) ? links : []) {
      if (l == null) continue;
      const a = this._byId.get(String(l.source));
      const b = this._byId.get(String(l.target));
      if (!a || !b || a === b) continue;
      const key = a.id < b.id ? `${a.id}\u0001${b.id}` : `${b.id}\u0001${a.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ a, b, bias: 0.5 });
      count.set(a, (count.get(a) || 0) + 1);
      count.set(b, (count.get(b) || 0) + 1);
    }
    for (const p of pairs) { const ca = count.get(p.a); const cb = count.get(p.b); p.bias = ca / (ca + cb); }
    for (const nd of this._nodes) if (nd.degree == null) nd.degree = count.get(nd) || 0;
    this._pairs = pairs;
  }

  /** 새 노드 자리: x·y 를 줬으면 그대로, 아니면 이웃 평균 근처 → (이웃 없으면) 기존 노드 바깥 고리 → (기존 노드도 없으면) 중심 나선 */
  _placeFresh(fresh) {
    if (!fresh.length) return;
    const o = this.o;
    const c = this._center;
    const placed = this._nodes.filter((nd) => Number.isFinite(nd.x) && Number.isFinite(nd.y));
    const unplaced = fresh.filter((nd) => !(Number.isFinite(nd.x) && Number.isFinite(nd.y)));
    if (!placed.length) {
      unplaced.forEach((nd, i) => { const p = spiralPos(i, c, o.collide * 1.5); nd.x = p.x; nd.y = p.y; });
    } else if (unplaced.length) {
      const freshSet = new Set(unplaced);
      let radius = 0;
      for (const nd of placed) radius = Math.max(radius, Math.hypot(nd.x - c.x, nd.y - c.y));
      radius += o.linkDistance;
      const neighborsOf = new Map(unplaced.map((nd) => [nd, []]));
      for (const p of this._pairs) {
        if (freshSet.has(p.a) && !freshSet.has(p.b)) neighborsOf.get(p.a).push(p.b);
        if (freshSet.has(p.b) && !freshSet.has(p.a)) neighborsOf.get(p.b).push(p.a);
      }
      let k = 0;
      for (const nd of unplaced) {
        const nb = neighborsOf.get(nd);
        const t = hash01(nd.id) * TAU;
        if (nb.length) {
          let sx = 0; let sy = 0;
          for (const m of nb) { sx += m.x; sy += m.y; }
          nd.x = sx / nb.length + Math.cos(t) * o.collide;
          nd.y = sy / nb.length + Math.sin(t) * o.collide;
        } else {
          const ang = (TAU * k) / unplaced.length + (t / unplaced.length) * 0.5;
          nd.x = c.x + radius * Math.cos(ang);
          nd.y = c.y + radius * Math.sin(ang);
        }
        k++;
      }
    }
    this._separateCoincident();
  }

  /** 정확히 같은 자리에 놓인 노드를 id 해시로 정한 작은 지터만큼 떼어 놓음 */
  _separateCoincident() {
    const nodes = this._nodes;
    const j = this.o.jitter;
    for (let pass = 0; pass < 4; pass++) {
      let moved = false;
      for (let i = 0; i < nodes.length; i++) {
        for (let k = i + 1; k < nodes.length; k++) {
          const a = nodes[i]; const b = nodes[k];
          if (Math.abs(a.x - b.x) > 1e-9 || Math.abs(a.y - b.y) > 1e-9) continue;
          const t = hash01(`${b.id}\u0001${a.id}\u0001${pass}`) * TAU;
          b.x += Math.cos(t) * j; b.y += Math.sin(t) * j;
          moved = true;
        }
      }
      if (!moved) break;
    }
  }
}

export function createSimulation(spec = {}) { return new ForceSimulation(spec); }
