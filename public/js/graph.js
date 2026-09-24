// 교사용 관계 그래프 (SVG). 관계가 많은 학생일수록 가운데에 배치합니다.
import { svgEl } from './common.js';

const NODE_W = 104;
const NODE_H = 40;
const RING_STEP = 165;
const X_STRETCH = 1.3;

export class RelationGraph {
  constructor(container, { onEdgeClick, onNodeClick, onBackgroundClick } = {}) {
    this.container = container;
    this.onEdgeClick = onEdgeClick;
    this.onNodeClick = onNodeClick;
    this.onBackgroundClick = onBackgroundClick;
    this.students = [];
    this.relations = [];
    this.stats = {};
    this.pos = {};
    this.filter = 'all';
    this.highlightIds = null;
    this.selectedEdgeKey = null;
    this.manualMoved = false;
    this.svg = svgEl('svg', { xmlns: 'http://www.w3.org/2000/svg' });
    this.container.append(this.svg);
    this.vb = { x: -500, y: -300, w: 1000, h: 600 };
    this.bindPanZoom();
  }

  setData({ students, relations, stats }) {
    const prevIds = new Set(this.students.map((s) => s.id));
    const sameSet = students.length === prevIds.size && students.every((s) => prevIds.has(s.id));
    this.students = students;
    this.relations = relations;
    this.stats = stats;
    if (!sameSet || Object.keys(this.pos).length === 0) this.computeLayout();
    this.render();
    if (!sameSet) this.fit();
  }

  setFilter(filter) { this.filter = filter; this.render(); }
  setHighlight(ids) { this.highlightIds = ids && ids.length ? ids : null; this.render(); }
  setSelectedEdge(key) { this.selectedEdgeKey = key; this.render(); }
  resetLayout() { this.manualMoved = false; this.computeLayout(); this.render(); this.fit(); }

  // ---------- 배치: 연결 수(degree)가 많은 순으로 안쪽 링부터 채움 ----------
  computeLayout() {
    const sorted = [...this.students].sort((a, b) => {
      const da = this.stats[a.id]?.degree || 0;
      const db = this.stats[b.id]?.degree || 0;
      return db - da || a.name.localeCompare(b.name, 'ko');
    });
    this.pos = {};
    let idx = 0;
    let k = 0;
    while (idx < sorted.length) {
      const r = k * RING_STEP;
      const cap = k === 0 ? 1 : Math.max(1, Math.floor((2 * Math.PI * r) / (NODE_W + 40)));
      const count = Math.min(cap, sorted.length - idx);
      for (let j = 0; j < count; j++) {
        const angle = (2 * Math.PI * j) / count - Math.PI / 2 + (k % 2 ? Math.PI / count : 0);
        const s = sorted[idx++];
        this.pos[s.id] = { x: r * X_STRETCH * Math.cos(angle), y: r * Math.sin(angle), ring: k };
      }
      k++;
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

  // ---------- 확대/이동/드래그 ----------
  bindPanZoom() {
    const svg = this.svg;
    let drag = null;
    svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      const nodeEl = e.target.closest('.node');
      const start = this.clientToSvg(e.clientX, e.clientY);
      // setPointerCapture 이후에는 이벤트 target 이 svg 로 바뀌므로, 처음 누른 요소를 기억해 둡니다.
      drag = { id: nodeEl?.dataset.id || null, target: e.target, startClient: { x: e.clientX, y: e.clientY }, start, vb: { ...this.vb }, origin: nodeEl ? { ...this.pos[nodeEl.dataset.id] } : null, moved: false };
      svg.setPointerCapture(e.pointerId);
      svg.classList.add('dragging');
    });
    svg.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dxc = e.clientX - drag.startClient.x;
      const dyc = e.clientY - drag.startClient.y;
      if (!drag.moved && Math.hypot(dxc, dyc) < 4) return;
      drag.moved = true;
      const rect = svg.getBoundingClientRect();
      const dx = (dxc / rect.width) * drag.vb.w;
      const dy = (dyc / rect.height) * drag.vb.h;
      if (drag.id) {
        this.pos[drag.id].x = drag.origin.x + dx;
        this.pos[drag.id].y = drag.origin.y + dy;
        this.manualMoved = true;
        this.render();
      } else {
        this.vb.x = drag.vb.x - dx;
        this.vb.y = drag.vb.y - dy;
        this.applyViewBox();
      }
    });
    const end = (e) => {
      if (!drag) return;
      svg.classList.remove('dragging');
      const wasClick = !drag.moved;
      const d = drag;
      drag = null;
      if (!wasClick) return;
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
    svg.addEventListener('pointercancel', () => { drag = null; svg.classList.remove('dragging'); });
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

  zoom(factor) {
    const cx = this.vb.x + this.vb.w / 2;
    const cy = this.vb.y + this.vb.h / 2;
    const nw = Math.min(8000, Math.max(300, this.vb.w * factor));
    const nh = this.vb.h * (nw / this.vb.w);
    this.vb = { x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh };
    this.applyViewBox();
  }

  // ---------- 그리기 ----------
  render() {
    const svg = this.svg;
    svg.replaceChildren();
    const defs = svgEl('defs');
    for (const [id, color] of [['g-arrow-good', '#ef5b6b'], ['g-arrow-bad', '#2d2f3a']]) {
      const m = svgEl('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse', markerUnits: 'strokeWidth' });
      m.append(svgEl('path', { d: 'M0,0 L10,5 L0,10 z', fill: color }));
      defs.append(m);
    }
    svg.append(defs);
    svg.append(svgEl('rect', { x: -100000, y: -100000, width: 200000, height: 200000, fill: 'transparent' }));

    const hl = this.highlightIds;
    const edgeVisible = (r) => {
      if (this.filter !== 'all' && r.type !== this.filter) return false;
      return true;
    };
    const edgeInFocus = (r) => {
      if (!hl) return true;
      if (hl.length >= 2) return hl.includes(r.from) && hl.includes(r.to);
      return r.from === hl[0] || r.to === hl[0];
    };
    const connected = new Set();
    if (hl) {
      for (const id of hl) connected.add(id);
      if (hl.length === 1) for (const r of this.relations) { if (edgeVisible(r) && (r.from === hl[0] || r.to === hl[0])) { connected.add(r.from); connected.add(r.to); } }
    }

    const edges = svgEl('g');
    for (const r of this.relations) {
      if (!edgeVisible(r)) continue;
      const pa = this.pos[r.from];
      const pb = this.pos[r.to];
      if (!pa || !pb) continue;
      const key = `${r.from}>${r.to}`;
      const focus = edgeInFocus(r);
      const g = svgEl('g', { class: `edge ${r.type} ${focus ? '' : 'dim'} ${this.selectedEdgeKey === key ? 'selected' : ''}` });
      g.dataset.key = key;
      const d = curvePath(pa, pb);
      g.append(svgEl('path', { class: 'line', d, 'marker-end': `url(#${r.type === 'good' ? 'g-arrow-good' : 'g-arrow-bad'})` }));
      g.append(svgEl('path', { class: 'hit', d }));
      edges.append(g);
    }
    svg.append(edges);

    const nodes = svgEl('g');
    for (const s of this.students) {
      const p = this.pos[s.id];
      if (!p) continue;
      const st = this.stats[s.id] || {};
      const dim = hl && !connected.has(s.id);
      const cls = ['node', st.submitted ? '' : 'pending', p.ring === 0 ? 'center' : '', hl?.includes(s.id) ? 'selected' : '', dim ? 'dim' : ''].filter(Boolean).join(' ');
      const g = svgEl('g', { class: cls, transform: `translate(${p.x},${p.y})` });
      g.dataset.id = s.id;
      g.append(svgEl('rect', { x: -NODE_W / 2, y: -NODE_H / 2, width: NODE_W, height: NODE_H, rx: 8 }));
      g.append(svgEl('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', text: shorten(s.name, 7) }));
      const deg = st.degree || 0;
      const badge = svgEl('g', { transform: `translate(${NODE_W / 2 - 2},${-NODE_H / 2 + 2})` });
      badge.append(svgEl('circle', { r: 11, fill: '#fff', stroke: '#b9b3ff', 'stroke-width': 1.5 }));
      badge.append(svgEl('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', text: String(deg), style: 'fill:#5145cd;font-size:11px;font-weight:700' }));
      g.append(badge);
      const title = svgEl('title', { text: `${s.name} · 연결 ${deg}개 · 받은 ❤️ ${st.inGood?.length || 0} · 받은 ⚡ ${st.inBad?.length || 0}${st.submitted ? '' : ' · 미제출'}` });
      g.append(title);
      nodes.append(g);
    }
    svg.append(nodes);
    this.applyViewBox();
  }
}

function shorten(s, n) { return s.length > n ? `${s.slice(0, n - 1)}…` : s; }

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
