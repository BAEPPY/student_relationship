// 교사용 관계 그래프 (SVG). 힘 기반(force-directed) 물리 배치로, 학생 상자끼리는 밀어내고
// 화살표는 스프링처럼 당겨서 연결이 많은 학생일수록 가운데에 모입니다.
// - 상자에 마우스를 올리면 연결된 친구만 밝게(이웃 강조), 누르면 그 학생이 가운데로 모이고(focusNode),
//   끌어서 놓으면 출렁이며 자리를 다시 잡습니다.
// - 서로 표시한 사이(둘 다 좋은 사이 또는 둘 다 안 좋은 사이)는 화살표 두 개 대신 양쪽에 화살촉이 있는 곧은 선 하나(.edge.mutual)로 그려요.
// - 움직임(출렁임)은 setMotion(on/off) 으로 켜고 끌 수 있어요. 기본값은 localStorage 'relmap.graphMotion'('on'|'off'), 없으면
//   운영체제·브라우저의 "애니메이션 줄이기"(prefers-reduced-motion) 설정을 따라요 — 윈도우 '애니메이션 효과' 를 끈 컴퓨터의 Edge 는 처음에 꺼져 있어요.
// - 공개 API: setData / setFilter / setHighlight / setSelectedEdge / resetLayout / fit / zoom / focusNode / shake / setMotion / isMotion / destroy
import { svgEl } from './common.js';
import { createSimulation } from './force-layout.js';

/** 움직임 켬/끔 저장 키 (선생님 페이지 툴바가 저장하고, 그래프는 처음 만들 때 읽어요) */
export const GRAPH_MOTION_KEY = 'relmap.graphMotion';

const NODE_W = 104;
const NODE_H = 40;
const NODE_RX = 20;
const RING_STEP = 165;
const X_STRETCH = 1.3;
const DRAG_ALPHA_TARGET = 0.3;

export class RelationGraph {
  constructor(container, { onEdgeClick, onNodeClick, onBackgroundClick, onMotionChange } = {}) {
    this.container = container;
    this.onEdgeClick = onEdgeClick;
    this.onNodeClick = onNodeClick;
    this.onBackgroundClick = onBackgroundClick;
    this.onMotionChange = onMotionChange;
    this.students = [];
    this.relations = [];
    this.stats = {};
    this.pos = {};
    this.sim = null;
    this.linkSig = '';
    this.filter = 'all';
    this.highlightIds = null;
    this.hoverId = null;
    this.focusId = null;
    this.selectedEdgeKey = null;
    this.centerId = null;
    this.nodeEls = new Map();
    this.edgeEls = new Map();
    this.raf = null;
    this.drag = null;
    // this.reduced = "움직임 꺼짐": 저장된 선택이 있으면 그 값, 없으면 운영체제·브라우저의 "애니메이션 줄이기" 설정
    const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    const saved = readMotionPref();
    this.reduced = saved ? saved === 'off' : !!mq?.matches;
    this.svg = svgEl('svg', { xmlns: 'http://www.w3.org/2000/svg' });
    this.container.append(this.svg);
    this.vb = { x: -500, y: -300, w: 1000, h: 600 };
    this.bindPanZoom();
    this.bindHover();
    // 운영체제 설정이 바뀌면(저장된 선택이 없을 때만) 따라가요. 화면에서 떼어진 그래프(오류 카드가 앱을 덮은 뒤 등)는 무시해
    // 사라진 툴바를 다시 그리려다 오류가 나지 않게 해요. 리스너는 필드에 두어 destroy() 에서 뗄 수 있어요.
    this.mq = mq;
    this.onMqChange = (e) => { if (this.svg.isConnected && !readMotionPref()) this.setMotion(!e.matches); };
    mq?.addEventListener?.('change', this.onMqChange);
    this.onVisibility = () => { if (document.hidden) this.stopLoop(); else if (this.sim?.isActive()) this.startLoop(); };
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  /** 그래프를 버릴 때(선생님 페이지가 뼈대를 다시 만들 때) 루프를 멈추고 document·matchMedia 리스너를 떼요 — 떼어진 SVG 가 몰래 계속 움직이지 않게 */
  destroy() {
    this.stopLoop();
    this.mq?.removeEventListener?.('change', this.onMqChange);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  setData({ students, relations, stats }) {
    const prevIds = new Set(this.students.map((s) => s.id));
    const sameSet = students.length === prevIds.size && students.every((s) => prevIds.has(s.id));
    const linkSig = relations.map((r) => `${r.from}>${r.to}:${r.type}`).sort().join('|');
    const sameLinks = linkSig === this.linkSig;
    this.students = students;
    this.relations = relations;
    this.stats = stats;
    this.linkSig = linkSig;
    this.centerId = this.sortedByDegree()[0]?.id || null;
    if (this.focusId && !students.some((s) => s.id === this.focusId)) this.focusId = null;
    if (!this.sim) {
      this.buildSim();
    } else if (!sameSet || !sameLinks) {
      // 명단·관계가 바뀌면 있던 학생은 자리를 지키고 새 학생만 이웃 곁에 끼워 넣은 뒤 살짝 흔들어 정리
      this.sim.update(this.simInput());
      this.syncPos();
      this.sim.reheat(sameSet ? 0.3 : 0.4);
    }
    this.render();
    if (!sameSet) this.fit();
    this.animate();
  }

  setFilter(filter) { if (filter === this.filter && this.nodeEls.size) return; this.filter = filter; this.render(); }
  setHighlight(ids) {
    this.highlightIds = ids && ids.length ? ids : null;
    // 가운데 모으기는 강조된 학생 한 명에게만: 강조가 풀리거나 다른 학생(들)로 바뀌면(회차 변경·강조 해제) 센터링도 함께 풀어요
    if (this.focusId && !(this.highlightIds?.length === 1 && this.highlightIds[0] === this.focusId)) this.focusNode(null);
    this.applyClasses();
  }
  setSelectedEdge(key) { this.selectedEdgeKey = key; this.applyClasses(); }
  resetLayout() { this.buildSim(); this.render(); this.fit(); this.animate(); }

  /** 누른 학생을 화면 가운데로 모읍니다(null 이면 풀어 줌). 이웃이 함께 따라와요. */
  focusNode(id) {
    const next = id || null;
    if (!this.sim) { this.focusId = next; return; }
    if (!next && !this.focusId) return;
    this.focusId = next;
    if (next) {
      // 같은 학생을 다시 요청해도(학생 표·분석 목록 링크) 지금 보고 있는 화면 가운데로 다시 모아요 — 이동·확대로 화면 밖에 나갔을 때
      this.sim.setGravityCenter(this.vb.x + this.vb.w / 2, this.vb.y + this.vb.h / 2);
      this.sim.focus(next);
      this.sim.reheat(0.5);
    } else {
      this.sim.focus(null);
      this.sim.reheat(0.3);
    }
    this.animate();
  }

  /** 그래프를 한 번 흔들어 다시 정리합니다("🔀 흔들어 정리" 버튼). */
  shake(v = 0.8) { if (!this.sim) return; this.sim.reheat(v); this.animate(); }

  /** 움직임(출렁임)이 켜져 있는지. 꺼져 있으면 드래그·센터링·흔들기 결과를 애니메이션 없이 바로 그려요. */
  isMotion() { return !this.reduced; }

  /**
   * 움직임을 켜거나 꺼요("🫧 움직임" 버튼). 켜면 살짝 데워 출렁이며 자리를 잡고, 끄면 루프를 멈추고 안정된 결과를 한 번에 그려요.
   * 저장(localStorage)은 호출하는 쪽(툴바)이 해요 — 운영체제 설정 변화로 따라갈 때는 저장하지 않기 위해서예요.
   */
  setMotion(enabled) {
    const on = !!enabled;
    if (on === !this.reduced) return;
    this.reduced = !on;
    if (this.sim) {
      if (on) {
        // 상자를 끌던 중에 켜지면(터치로 끌며 🫧 버튼 클릭, OS 설정 변화) 드래그용 alphaTarget 도 같이 켜야 놓을 때까지 루프가 살아 상자가 포인터를 따라와요
        if (this.drag?.id) this.sim.alphaTarget(DRAG_ALPHA_TARGET);
        this.sim.reheat(0.3);
        this.startLoop();
      } else { this.stopLoop(); this.sim.alphaTarget(0); this.sim.settle(); this.updatePositions(); }
    }
    this.onMotionChange?.(on);
  }

  // ---------- 물리 시뮬레이션 ----------
  sortedByDegree() {
    return [...this.students].sort((a, b) => {
      const da = this.stats[a.id]?.degree || 0;
      const db = this.stats[b.id]?.degree || 0;
      return db - da || a.name.localeCompare(b.name, 'ko');
    });
  }

  simInput(start = null) {
    const nodes = this.students.map((s) => ({ id: s.id, degree: this.stats[s.id]?.degree || 0, ...(start?.[s.id] ? { x: start[s.id].x, y: start[s.id].y } : {}) }));
    const links = this.relations.map((r) => ({ source: r.from, target: r.to, type: r.type }));
    return { nodes, links };
  }

  /** 고리 배치를 시작점으로 시뮬레이션을 새로 만들고, 첫 화면이 요동치지 않도록 미리 안정시킵니다. */
  buildSim() {
    this.sim = createSimulation({ ...this.simInput(this.computeLayout()), options: {} });
    if (this.focusId) this.sim.focus(this.focusId);
    this.sim.settle();
    this.syncPos();
    this.sim.alpha(0.25);
  }

  syncPos() {
    this.pos = {};
    for (const n of this.sim.nodes()) this.pos[n.id] = n;
  }

  // ---------- 시작 배치: 연결 수(degree)가 많은 순으로 안쪽 링부터 채움 ----------
  computeLayout() {
    const sorted = this.sortedByDegree();
    const pos = {};
    let idx = 0;
    let k = 0;
    while (idx < sorted.length) {
      const r = k * RING_STEP;
      const cap = k === 0 ? 1 : Math.max(1, Math.floor((2 * Math.PI * r) / (NODE_W + 40)));
      const count = Math.min(cap, sorted.length - idx);
      for (let j = 0; j < count; j++) {
        const angle = (2 * Math.PI * j) / count - Math.PI / 2 + (k % 2 ? Math.PI / count : 0);
        const s = sorted[idx++];
        pos[s.id] = { x: r * X_STRETCH * Math.cos(angle), y: r * Math.sin(angle) };
      }
      k++;
    }
    return pos;
  }

  // ---------- 애니메이션 루프: 시뮬레이션이 살아 있는 동안만 rAF 로 위치를 갱신 ----------
  animate() {
    if (!this.sim) return;
    if (this.reduced) { this.sim.settle(); this.updatePositions(); return; }
    this.startLoop();
  }

  startLoop() {
    // 시뮬레이션이 이미 멈춰 있으면(주기적 새로고침 등) 프레임을 잡지 않아 idle 에 CPU 0
    if (this.raf || !this.sim || this.reduced || document.hidden || !this.sim.isActive()) return;
    const step = () => {
      this.raf = null;
      this.sim.tick();
      this.updatePositions();
      if (this.sim.isActive()) this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  stopLoop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = null; }

  updatePositions() {
    for (const [id, g] of this.nodeEls) {
      const p = this.pos[id];
      if (p) g.setAttribute('transform', `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`);
    }
    for (const { r, line, hit, mutual } of this.edgeEls.values()) {
      const pa = this.pos[r.from];
      const pb = this.pos[r.to];
      if (!pa || !pb) continue;
      const d = mutual ? straightPath(pa, pb) : curvePath(pa, pb);
      line.setAttribute('d', d);
      hit.setAttribute('d', d);
    }
  }

  fit() {
    const ids = Object.keys(this.pos);
    if (!ids.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of ids) {
      const p = this.pos[id];
      minX = Math.min(minX, p.x - NODE_W * 0.7); maxX = Math.max(maxX, p.x + NODE_W * 0.7);
      minY = Math.min(minY, p.y - NODE_H); maxY = Math.max(maxY, p.y + NODE_H);
    }
    const rect = this.svg.getBoundingClientRect();
    const aspect = rect.width && rect.height ? rect.width / rect.height : 16 / 9;
    let w = maxX - minX;
    let h = maxY - minY;
    if (w / h < aspect) w = h * aspect; else h = w / aspect;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    this.vb = { x: cx - w / 2, y: cy - h / 2, w, h };
    this.applyViewBox();
  }

  applyViewBox() {
    this.svg.setAttribute('viewBox', `${this.vb.x} ${this.vb.y} ${this.vb.w} ${this.vb.h}`);
  }

  clientToSvg(clientX, clientY) {
    const rect = this.svg.getBoundingClientRect();
    return {
      x: this.vb.x + ((clientX - rect.left) / rect.width) * this.vb.w,
      y: this.vb.y + ((clientY - rect.top) / rect.height) * this.vb.h,
    };
  }

  // ---------- 이웃 강조: 마우스/펜을 올린 학생과 연결된 친구만 밝게 ----------
  bindHover() {
    const svg = this.svg;
    const setHover = (id) => { if (id !== this.hoverId) { this.hoverId = id; this.applyClasses(); } };
    svg.addEventListener('pointerover', (e) => {
      if (this.drag || e.pointerType === 'touch') return;
      setHover(e.target.closest('.node')?.dataset.id || null);
    });
    svg.addEventListener('pointerout', (e) => {
      if (this.drag || e.pointerType === 'touch') return;
      const nodeEl = e.target.closest('.node');
      if (nodeEl && !(e.relatedTarget && nodeEl.contains(e.relatedTarget))) setHover(null);
    });
    svg.addEventListener('pointerleave', () => { if (!this.drag) setHover(null); });
  }

  // ---------- 확대/이동/드래그 ----------
  bindPanZoom() {
    const svg = this.svg;
    svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      // 드래그는 포인터 하나만: 두 번째 손가락·마우스+터치는 무시해요 (같은 포인터가 또 내려오면 남아 있던 드래그를 먼저 정리)
      if (this.drag) { if (e.pointerId !== this.drag.pointerId) return; this.endDrag(this.drag); }
      const nodeEl = e.target.closest('.node');
      const id = nodeEl?.dataset.id || null;
      const start = this.clientToSvg(e.clientX, e.clientY);
      // setPointerCapture 이후에는 이벤트 target 이 svg 로 바뀌므로, 처음 누른 요소를 기억해 둡니다.
      this.drag = { pointerId: e.pointerId, id, target: e.target, startClient: { x: e.clientX, y: e.clientY }, start, vb: { ...this.vb }, origin: id && this.pos[id] ? { x: this.pos[id].x, y: this.pos[id].y } : null, moved: false };
      svg.setPointerCapture(e.pointerId);
      svg.classList.add('dragging');
      if (id && this.sim && this.drag.origin) {
        // 누른 상자는 포인터에 붙잡아 두고, 놓을 때까지 시뮬레이션을 살려 둬 이웃이 따라오게 합니다.
        if (e.pointerType !== 'touch') this.hoverId = id;
        this.sim.fix(id, this.drag.origin.x, this.drag.origin.y);
        if (!this.reduced) { this.sim.alphaTarget(DRAG_ALPHA_TARGET); this.startLoop(); }
        this.applyClasses();
      }
    });
    svg.addEventListener('pointermove', (e) => {
      const drag = this.drag;
      if (!drag || e.pointerId !== drag.pointerId) return;
      const dxc = e.clientX - drag.startClient.x;
      const dyc = e.clientY - drag.startClient.y;
      if (!drag.moved && Math.hypot(dxc, dyc) < 4) return;
      drag.moved = true;
      const rect = svg.getBoundingClientRect();
      const dx = (dxc / rect.width) * drag.vb.w;
      const dy = (dyc / rect.height) * drag.vb.h;
      if (drag.id && drag.origin && this.sim) {
        this.sim.fix(drag.id, drag.origin.x + dx, drag.origin.y + dy);
        if (this.reduced) { this.sim.reheat(0.1); this.sim.settle(30); this.updatePositions(); }
        else this.startLoop();
      } else if (!drag.id) {
        this.vb.x = drag.vb.x - dx;
        this.vb.y = drag.vb.y - dy;
        this.applyViewBox();
      }
    });
    const end = (e) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.pointerId) return;
      this.endDrag(d);
      if (d.moved) return;
      const edgeEl = d.target.closest('.edge');
      const nodeEl = d.target.closest('.node');
      if (edgeEl) {
        const edge = this.relations.find((r) => `${r.from}>${r.to}` === edgeEl.dataset.key);
        const rect = this.container.getBoundingClientRect();
        this.onEdgeClick?.(edge, { x: e.clientX - rect.left, y: e.clientY - rect.top });
      } else if (nodeEl) {
        this.onNodeClick?.(d.id);
      } else {
        this.onBackgroundClick?.();
      }
    };
    svg.addEventListener('pointerup', end);
    // 취소되거나 캡처를 잃어도(브라우저가 제스처를 가져감 등) 붙잡은 상자가 영영 고정되지 않게 같은 정리를 해요
    const cancel = (e) => { const d = this.drag; if (d && e.pointerId === d.pointerId) this.endDrag(d); };
    svg.addEventListener('pointercancel', cancel);
    svg.addEventListener('lostpointercapture', cancel);
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12;
      const p = this.clientToSvg(e.clientX, e.clientY);
      const nw = Math.min(8000, Math.max(300, this.vb.w * factor));
      const nh = this.vb.h * (nw / this.vb.w);
      this.vb = { x: p.x - (p.x - this.vb.x) * (nw / this.vb.w), y: p.y - (p.y - this.vb.y) * (nh / this.vb.h), w: nw, h: nh };
      this.applyViewBox();
    }, { passive: false });
  }

  /** 드래그 끝(놓음·취소·캡처 잃음): 붙잡은 상자를 풀고 시뮬레이션을 식혀 자연스럽게 자리 잡게 합니다. */
  endDrag(d) {
    this.svg.classList.remove('dragging');
    this.drag = null;
    if (!d.id || !this.sim) return;
    // 가운데로 모아 둔 학생을 직접 끌어 놓았으면 센터링만 풀어 놓은 자리에 자리 잡게 해요 (강조·선택은 그대로)
    if (d.moved && d.id === this.focusId) { this.focusId = null; this.sim.focus(null); }
    this.sim.release(d.id);
    this.sim.alphaTarget(0);
    if (this.reduced && d.moved) { this.sim.reheat(0.3); this.sim.settle(); this.updatePositions(); }
  }

  zoom(factor) {
    const cx = this.vb.x + this.vb.w / 2;
    const cy = this.vb.y + this.vb.h / 2;
    const nw = Math.min(8000, Math.max(300, this.vb.w * factor));
    const nh = this.vb.h * (nw / this.vb.w);
    this.vb = { x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh };
    this.applyViewBox();
  }

  // ---------- 강조 상태(class 만 갱신): hover 가 있으면 hover, 없으면 바깥에서 준 highlightIds ----------
  edgeVisible(r) { return this.filter === 'all' || r.type === this.filter; }

  applyClasses() {
    const hl = this.highlightIds;
    const eff = this.hoverId ? [this.hoverId] : hl;
    const edgeInFocus = (r) => {
      if (!eff) return true;
      if (eff.length >= 2) return eff.includes(r.from) && eff.includes(r.to);
      return r.from === eff[0] || r.to === eff[0];
    };
    const connected = new Set();
    if (eff) {
      for (const id of eff) connected.add(id);
      if (eff.length === 1) for (const r of this.relations) { if (this.edgeVisible(r) && (r.from === eff[0] || r.to === eff[0])) { connected.add(r.from); connected.add(r.to); } }
    }
    for (const [id, g] of this.nodeEls) {
      g.classList.toggle('dim', !!eff && !connected.has(id));
      g.classList.toggle('selected', !!hl?.includes(id));
      g.classList.toggle('hover', id === this.hoverId);
    }
    // 양쪽 화살표 선은 두 방향 키 중 어느 쪽을 골라도 같은 선이 선택돼요. dim 은 양쪽 끝이 같으니 첫 방향(r) 기준이면 충분해요
    for (const { r, g, keys } of this.edgeEls.values()) {
      g.classList.toggle('dim', !edgeInFocus(r));
      g.classList.toggle('selected', keys.includes(this.selectedEdgeKey));
    }
  }

  // ---------- 그리기: 데이터·필터가 바뀔 때만 DOM 을 다시 만들고, 매 프레임은 위치 속성만 바꿉니다 ----------
  render() {
    const svg = this.svg;
    svg.replaceChildren();
    this.nodeEls = new Map();
    this.edgeEls = new Map();
    const defs = svgEl('defs');
    for (const [id, color] of [['g-arrow-good', '#ef5b6b'], ['g-arrow-bad', '#2d2f3a']]) {
      const m = svgEl('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse', markerUnits: 'strokeWidth' });
      m.append(svgEl('path', { d: 'M0,0 L10,5 L0,10 z', fill: color }));
      defs.append(m);
    }
    svg.append(defs);
    svg.append(svgEl('rect', { x: -100000, y: -100000, width: 200000, height: 200000, fill: 'transparent' }));

    // 보이는 관계만 모은 뒤, 두 방향이 모두 보이고 종류가 같으면(서로 좋은 사이·서로 안 좋은 사이) 양쪽 화살촉이 있는 선 하나로 합쳐요.
    // 종류가 다르면(한쪽 좋음·한쪽 안 좋음) 지금처럼 서로 반대쪽으로 휘는 곡선 화살표 두 개예요.
    const edges = svgEl('g');
    const visible = this.relations.filter((r) => this.edgeVisible(r) && this.pos[r.from] && this.pos[r.to]);
    const byKey = new Map(visible.map((r) => [`${r.from}>${r.to}`, r]));
    const done = new Set();
    for (const r of visible) {
      const key = `${r.from}>${r.to}`;
      if (done.has(key)) continue;
      done.add(key);
      const key2 = `${r.to}>${r.from}`;
      const r2 = byKey.get(key2);
      const mutual = !!r2 && r2.type === r.type && r.from !== r.to;
      const g = svgEl('g', { class: `edge ${r.type}${mutual ? ' mutual' : ''}` });
      g.dataset.key = key;
      const marker = `url(#${r.type === 'good' ? 'g-arrow-good' : 'g-arrow-bad'})`;
      // marker 가 orient="auto-start-reverse" 라 시작 쪽 화살촉은 자동으로 뒤집혀 양쪽 다 바깥을 가리켜요
      const line = svgEl('path', { class: 'line', 'marker-end': marker, 'marker-start': mutual ? marker : null });
      const hit = svgEl('path', { class: 'hit' });
      g.append(line, hit);
      edges.append(g);
      if (mutual) {
        g.dataset.key2 = key2;
        done.add(key2);
        this.edgeEls.set(key, { r, r2, g, line, hit, mutual: true, keys: [key, key2] });
      } else {
        this.edgeEls.set(key, { r, g, line, hit, mutual: false, keys: [key] });
      }
    }
    svg.append(edges);

    const nodes = svgEl('g');
    for (const s of this.students) {
      if (!this.pos[s.id]) continue;
      const st = this.stats[s.id] || {};
      const cls = ['node', st.submitted ? '' : 'pending', s.id === this.centerId ? 'center' : ''].filter(Boolean).join(' ');
      const g = svgEl('g', { class: cls });
      g.dataset.id = s.id;
      g.append(svgEl('rect', { x: -NODE_W / 2, y: -NODE_H / 2, width: NODE_W, height: NODE_H, rx: NODE_RX }));
      g.append(svgEl('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', text: shorten(s.name, 7) }));
      const deg = st.degree || 0;
      const badge = svgEl('g', { transform: `translate(${NODE_W / 2 - 2},${-NODE_H / 2 + 2})` });
      badge.append(svgEl('circle', { r: 11, fill: '#fff', stroke: '#b9b3ff', 'stroke-width': 1.5 }));
      badge.append(svgEl('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', text: String(deg), style: 'fill:#5145cd;font-size:11px;font-weight:700' }));
      g.append(badge);
      const title = svgEl('title', { text: `${s.name} · 연결 ${deg}개 · 받은 ❤️ ${st.inGood?.length || 0} · 받은 ⚡ ${st.inBad?.length || 0}${st.submitted ? '' : ' · 미제출'}` });
      g.append(title);
      nodes.append(g);
      this.nodeEls.set(s.id, g);
    }
    svg.append(nodes);
    this.updatePositions();
    this.applyClasses();
    this.applyViewBox();
  }
}

function shorten(s, n) { return s.length > n ? `${s.slice(0, n - 1)}…` : s; }

/** 저장된 움직임 선택('on'|'off'), 없거나 localStorage 를 못 쓰면 null */
function readMotionPref() {
  try {
    const v = localStorage.getItem(GRAPH_MOTION_KEY);
    return v === 'on' || v === 'off' ? v : null;
  } catch { return null; }
}

// 서로 표시한 사이: 두 상자 테두리 사이를 곧은 선으로 잇고, 양쪽 모두 화살촉이 들어갈 자리(pad 6)를 띄워요.
function straightPath(pa, pb) {
  const start = rectEdge(pa, NODE_W, NODE_H, pb, 6);
  const end = rectEdge(pb, NODE_W, NODE_H, pa, 6);
  return `M${start.x.toFixed(1)},${start.y.toFixed(1)} L${end.x.toFixed(1)},${end.y.toFixed(1)}`;
}

// 두 노드 사이를 살짝 휘어진 곡선으로 잇습니다. 진행 방향의 오른쪽으로 휘기 때문에
// A→B 와 B→A 가 서로 다른 쪽으로 갈라져 겹치지 않습니다.
function curvePath(pa, pb) {
  const dx = pb.x - pa.x;
  const dy = pb.y - pa.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const bend = Math.min(40, 14 + len * 0.06);
  const cx = (pa.x + pb.x) / 2 + nx * bend;
  const cy = (pa.y + pb.y) / 2 + ny * bend;
  const start = rectEdge(pa, NODE_W, NODE_H, { x: cx, y: cy }, 3);
  const end = rectEdge(pb, NODE_W, NODE_H, { x: cx, y: cy }, 6);
  return `M${start.x.toFixed(1)},${start.y.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${end.x.toFixed(1)},${end.y.toFixed(1)}`;
}

function rectEdge(c, w, h, t, pad) {
  const dx = t.x - c.x;
  const dy = t.y - c.y;
  if (dx === 0 && dy === 0) return { x: c.x, y: c.y };
  const sx = dx !== 0 ? (w / 2) / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? (h / 2) / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  const ex = dx * s;
  const ey = dy * s;
  const l = Math.hypot(ex, ey) || 1;
  return { x: c.x + ex + (ex / l) * pad, y: c.y + ey + (ey / l) * pad };
}
