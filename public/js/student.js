import { api, el, svgEl, toast, TYPE_LABEL, TYPE_ICON, avatarColor } from './common.js';

const token = decodeURIComponent(location.pathname.split('/')[2] || '');
const app = document.getElementById('app');

let data = null;            // 서버에서 받은 원본
let draft = {};             // 편집 중인 관계 { toId: { type, tags, reason } }
let dirty = false;

// ---------- 한국어 조사 ----------
function josa(word, [a, b]) {
  const ch = word[word.length - 1] || '';
  const code = ch.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 ? b : a;
  return `${a}(${b})`;
}

// ---------- 유효성 ----------
function relationValid(r) {
  if (!r) return true;
  if (r.type === 'bad') return Boolean(r.reason && r.reason.trim().length >= 2); // 안 좋은 사이는 직접 쓴 이유가 꼭 필요
  return true;
}
function selectedCount() { return Object.keys(draft).length; }
function countOf(type) { return Object.values(draft).filter((r) => r.type === type).length; }
function mins() { return { good: data.room.minGood ?? 0, bad: data.room.minBad ?? 0 }; }
function minsMet() { const m = mins(); return countOf('good') >= m.good && countOf('bad') >= m.bad; }
function invalidNames() {
  return Object.entries(draft).filter(([, r]) => !relationValid(r)).map(([id]) => nameOf(id));
}
function nameOf(id) { return data.classmates.find((c) => c.id === id)?.name || '?'; }
function canSubmit() { return minsMet() && invalidNames().length === 0 && !data.room.locked; }

// ---------- 화면 ----------
function render() {
  const { me, room, classmates } = data;
  app.replaceChildren();
  document.getElementById('room-name').textContent = room.name;
  document.title = `${me.name}의 친구 관계 지도 · ${data.round?.name || ''}`;

  const m0 = mins();
  const g0 = Math.min(countOf('good'), m0.good);
  const b0 = Math.min(countOf('bad'), m0.bad);
  const need0 = m0.good + m0.bad;
  const pct0 = need0 ? (g0 + b0) / need0 : 1;
  const leftGood = Math.max(0, m0.good - countOf('good'));
  const leftBad = Math.max(0, m0.bad - countOf('bad'));
  const leftText = [leftGood ? `❤️ ${leftGood}명` : '', leftBad ? `⚡ ${leftBad}명` : ''].filter(Boolean).join(', ');
  const bubble = room.locked ? '조사가 끝났어요!' : selectedCount() === 0 ? '친구를 골라 볼까요?' : !minsMet() ? `${leftText} 더 골라 줘!` : data.submittedAt && !dirty ? '제출 완료! 멋져요' : '다 됐어요! 제출해요';
  const ring = el('div', { class: 'ring' }, [
    svgEl('svg', { viewBox: '0 0 112 112' }),
    el('div', { class: 'ring-text' }, [el('b', { text: `${g0 + b0}` }), el('span', { text: `/ ${need0}명` })]),
  ]);
  const rsvg = ring.querySelector('svg');
  rsvg.append(svgEl('circle', { cx: 56, cy: 56, r: 48, fill: 'none', stroke: '#f1ebe3', 'stroke-width': 12 }));
  rsvg.append(svgEl('circle', { cx: 56, cy: 56, r: 48, fill: 'none', stroke: pct0 >= 1 ? '#8bc34a' : '#ffd54f', 'stroke-width': 12, 'stroke-linecap': 'round', 'stroke-dasharray': `${(2 * Math.PI * 48 * pct0).toFixed(1)} ${(2 * Math.PI * 48).toFixed(1)}` }));
  const intro = el('section', { class: 'card hello-card' }, [
    ring,
    el('div', {}, [
      el('div', { class: 'badge blue', style: { marginBottom: '6px' }, text: `${data.round?.name || ''} 조사` }),
      el('h1', { text: `${me.name}, 안녕! 👋` }),
      el('p', { style: { marginBottom: '4px' } }, ['친구들과 나의 관계를 표시해 줘. ', el('b', { text: `❤️ 좋은 사이 ${m0.good}명` }), '과 ', el('b', { text: `⚡ 안 좋은 사이 ${m0.bad}명` }), ' 이상 꼭 골라야 해!']),
      el('div', { class: `speech ${pct0 >= 1 ? 'done' : ''}`, text: bubble }),
    ]),
  ]);
  app.append(intro);
  app.append(el('section', { class: 'card', style: { padding: '14px 18px' } }, [
    el('div', { class: 'alert info', style: { margin: 0 } }, ['🔒 이 페이지는 나만 볼 수 있어. 친구들은 내가 표시한 걸 볼 수 없고, 선생님만 확인해. 솔직하게 표시해 줘!']),
    room.locked ? el('div', { class: 'alert warn', style: { margin: '10px 0 0' }, text: `${data.round?.name || '이번'} 조사가 끝났어. 내가 표시한 내용을 확인만 할 수 있고, 선생님이 다음 조사를 시작하면 다시 표시할 수 있어.` }) : null,
    data.submittedAt && !room.locked ? el('div', { class: 'alert success', style: { margin: '10px 0 0' }, text: '제출 완료! 끝나기 전까지는 언제든 바꾸고 다시 제출할 수 있어.' }) : null,
  ]));

  // 진행 상황
  const m = mins();
  const gc = countOf('good');
  const bc = countOf('bad');
  const done = minsMet();
  const progress = el('section', { class: 'card' }, [
    el('div', { class: 'card-title' }, [
      el('h2', { text: '🗺️ 내 관계 지도' }),
      el('div', { class: 'btn-row', style: { gap: '6px' } }, [
        el('span', { class: `badge ${gc >= m.good ? 'green' : 'warn'}`, text: `❤️ ${gc} / ${m.good}명` }),
        el('span', { class: `badge ${bc >= m.bad ? 'green' : 'warn'}`, text: `⚡ ${bc} / ${m.bad}명` }),
      ]),
    ]),
    el('div', { class: 'progress' }, [el('div', { class: done ? 'done' : '', style: { width: `${Math.round(pct0 * 100)}%` } })]),
    el('div', { class: 'student-map', id: 'map', style: { marginTop: '10px' } }),
    el('div', { class: 'legend', style: { marginTop: '6px' } }, [
      el('span', {}, [el('span', { class: 'sw', style: { background: 'var(--kid-coral)', borderRadius: '50%', width: '16px', height: '16px', border: '2px solid #fff' } }), '나']),
      el('span', {}, [el('span', { class: 'sw', style: { background: '#fff', border: '2px solid #e8dfd3', borderRadius: '8px' } }), '친구']),
      el('span', {}, [el('span', { class: 'line', style: { background: 'var(--kid-coral)' } }), '❤️ 좋은 사이']),
      el('span', {}, [el('span', { class: 'line', style: { background: 'var(--kid-slate)' } }), '⚡ 안 좋은 사이']),
    ]),
    el('p', { class: 'muted', style: { marginTop: '8px' }, text: '지도에서 친구 이름을 누르거나, 아래 목록에서 친구를 골라 봐.' }),
  ]);
  app.append(progress);
  drawMap(progress.querySelector('#map'));

  // 친구 목록
  const list = el('section', { class: 'card' }, [
    el('div', { class: 'card-title' }, [el('h2', { text: '🧒 우리 반 친구들' }), el('span', { class: 'muted', text: `${classmates.length}명` })]),
    el('div', { class: 'mate-list' }, classmates.map((c, i) => mateButton(c, i))),
    !room.locked ? stickyBar() : null,
  ]);
  app.append(list);
}

function mateButton(c, i = 0) {
  const r = draft[c.id];
  const type = r?.type;
  const invalid = r && !relationValid(r);
  const sub = r
    ? invalid
      ? '⚠️ 이유를 꼭 적어 줘'
      : [...(r.tags || []).map((t) => tagLabel(type, t)), r.reason].filter(Boolean).join(', ') || '이유 없음'
    : '눌러서 표시하기';
  return el('button', {
    type: 'button',
    class: `mate ${type || ''}`,
    onClick: () => openEditor(c.id),
    disabled: data.room.locked ? true : null,
  }, [
    el('span', { class: 'avatar', style: { background: avatarColor(i) }, text: (c.name.length === 3 ? c.name.slice(1, 2) : c.name.slice(0, 1)) }),
    el('span', { class: 'name' }, [c.name, el('span', { class: 'sub', text: sub })]),
    type ? el('span', { class: `badge ${type}`, text: `${TYPE_ICON[type]} ${TYPE_LABEL[type]}` }) : el('span', { class: 'badge gray', text: '선택 안 함' }),
  ]);
}

function tagLabel(type, id) {
  return data.catalog[type]?.find((t) => t.id === id)?.label || id;
}

function stickyBar() {
  const m = mins();
  const leftGood = Math.max(0, m.good - countOf('good'));
  const leftBad = Math.max(0, m.bad - countOf('bad'));
  const invalid = invalidNames();
  let status;
  if (invalid.length) status = `⚠️ ${invalid.join(', ')}${josa(invalid[invalid.length - 1], ['와', '과'])} 안 좋은 사이인 이유를 적어 줘.`;
  else if (leftGood || leftBad) status = `${[leftGood ? `❤️ 좋은 사이 ${leftGood}명` : '', leftBad ? `⚡ 안 좋은 사이 ${leftBad}명` : ''].filter(Boolean).join(', ')} 더 골라 줘!`;
  else if (dirty) status = '🌟 다 됐어! 제출 버튼을 눌러 줘.';
  else if (data.submittedAt) status = '제출 완료! 바꾼 게 있으면 다시 제출해 줘.';
  else status = '🌟 다 됐어! 제출 버튼을 눌러 줘.';
  return el('div', { class: 'sticky-bar' }, [
    el('div', { class: 'status', text: status }),
    el('button', { type: 'button', class: 'btn primary', text: data.submittedAt ? '다시 제출하기 ▶' : '제출하기 ▶', disabled: canSubmit() ? null : true, onClick: submit }),
  ]);
}

// ---------- 마인드맵 ----------
function drawMap(container) {
  const mates = data.classmates;
  const n = mates.length;
  const NODE_W = 104, NODE_H = 42, GAP = 16;
  const rings = [];
  let idx = 0, k = 1;
  while (idx < n) {
    const r = 150 + (k - 1) * 120;
    const cap = Math.max(1, Math.floor((2 * Math.PI * r) / (NODE_W + GAP)));
    const count = Math.min(cap, n - idx);
    rings.push({ r, count, start: idx });
    idx += count;
    k++;
  }
  const pos = {};
  for (const ring of rings) {
    for (let j = 0; j < ring.count; j++) {
      const angle = (2 * Math.PI * j) / ring.count - Math.PI / 2;
      pos[mates[ring.start + j].id] = { x: ring.r * 1.15 * Math.cos(angle), y: ring.r * Math.sin(angle) };
    }
  }
  const maxR = rings.length ? rings[rings.length - 1].r : 150;
  const pad = 80;
  const vb = { x: -maxR * 1.15 - pad, y: -maxR - NODE_H, w: maxR * 2.3 + pad * 2, h: maxR * 2 + NODE_H * 2 };
  const svg = svgEl('svg', { viewBox: `${vb.x} ${vb.y} ${vb.w} ${vb.h}`, role: 'img', 'aria-label': '내 친구 관계 지도' });

  const defs = svgEl('defs');
  const sky = svgEl('linearGradient', { id: 'sky', x1: 0, y1: 0, x2: 0, y2: 1 });
  sky.append(svgEl('stop', { offset: '0', 'stop-color': '#8fcdf2' }), svgEl('stop', { offset: '1', 'stop-color': '#e6f5ff' }));
  defs.append(sky);
  const meGrad = svgEl('radialGradient', { id: 'me-grad', cx: '38%', cy: '32%', r: '72%' });
  meGrad.append(svgEl('stop', { offset: '0', 'stop-color': '#ff8585' }), svgEl('stop', { offset: '1', 'stop-color': '#ea5563' }));
  defs.append(meGrad);
  const sunGrad = svgEl('radialGradient', { id: 'sun-grad', cx: '50%', cy: '50%', r: '50%' });
  sunGrad.append(svgEl('stop', { offset: '0', 'stop-color': '#ffe08a' }), svgEl('stop', { offset: '0.55', 'stop-color': '#ffd454', 'stop-opacity': '.9' }), svgEl('stop', { offset: '1', 'stop-color': '#ffd454', 'stop-opacity': '0' }));
  defs.append(sunGrad);
  for (const [id, color] of [['arrow-good', '#ff6b6b'], ['arrow-bad', '#4a5568']]) {
    const m = svgEl('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    m.append(svgEl('path', { d: 'M0,0 L10,5 L0,10 z', fill: color }));
    defs.append(m);
  }
  svg.append(defs);

  // 배경: 하늘, 해, 구름, 언덕
  const deco = svgEl('g', { 'pointer-events': 'none' });
  deco.append(svgEl('rect', { x: vb.x, y: vb.y, width: vb.w, height: vb.h, fill: 'url(#sky)' }));
  deco.append(svgEl('circle', { cx: vb.x + vb.w - 80, cy: vb.y + 70, r: 60, fill: 'url(#sun-grad)' }));
  const cloud = (cx, cy, k) => {
    const g = svgEl('g', { fill: '#fff', opacity: '.85' });
    g.append(svgEl('circle', { cx: cx - 24 * k, cy: cy + 2 * k, r: 14 * k }), svgEl('circle', { cx: cx - 6 * k, cy: cy - 10 * k, r: 20 * k }), svgEl('circle', { cx: cx + 16 * k, cy: cy - 4 * k, r: 16 * k }), svgEl('circle', { cx: cx + 30 * k, cy: cy + 4 * k, r: 11 * k }), svgEl('rect', { x: cx - 36 * k, y: cy - 2 * k, width: 76 * k, height: 16 * k, rx: 8 * k }));
    return g;
  };
  deco.append(cloud(vb.x + 90, vb.y + 70, 1), cloud(vb.x + vb.w * 0.55, vb.y + 40, 0.8), cloud(vb.x + vb.w - 160, vb.y + vb.h * 0.35, 0.7));
  deco.append(svgEl('ellipse', { cx: vb.x + vb.w * 0.3, cy: vb.y + vb.h + 40, rx: vb.w * 0.55, ry: 120, fill: '#9ad04a' }));
  deco.append(svgEl('ellipse', { cx: vb.x + vb.w * 0.8, cy: vb.y + vb.h + 60, rx: vb.w * 0.5, ry: 130, fill: '#7cb342' }));
  svg.append(deco);

  const me = { x: 0, y: 0 };
  const ME_R = 36; // '나' 동그라미 반지름
  const edges = svgEl('g');
  for (const c of mates) {
    const r = draft[c.id];
    if (!r) continue;
    const p = pos[c.id];
    const start = circleEdge(me, ME_R + 4, p);
    const end = rectEdge(p, NODE_W, NODE_H, me);
    edges.append(svgEl('path', {
      d: `M${start.x},${start.y} L${end.x},${end.y}`,
      stroke: r.type === 'good' ? '#ff6b6b' : '#4a5568', 'stroke-width': 3.5, fill: 'none', 'stroke-linecap': 'round',
      'marker-end': `url(#${r.type === 'good' ? 'arrow-good' : 'arrow-bad'})`,
    }));
  }
  svg.append(edges);

  const nodes = svgEl('g');
  for (const c of mates) {
    const p = pos[c.id];
    const r = draft[c.id];
    const g = svgEl('g', { class: `node ${r ? r.type : ''}`, transform: `translate(${p.x},${p.y})`, tabindex: 0, role: 'button', 'aria-label': c.name });
    const rect = svgEl('rect', { x: -NODE_W / 2, y: -NODE_H / 2, width: NODE_W, height: NODE_H, rx: NODE_H / 2 });
    g.append(rect, svgEl('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', text: shorten(c.name, 6), style: 'font-size:18px' }));
    if (r) {
      const badge = svgEl('g', { class: 'node-badge', transform: `translate(${NODE_W / 2 - 6},${-NODE_H / 2 + 2})` });
      badge.append(svgEl('circle', { r: 13, fill: '#fff', stroke: r.type === 'good' ? '#ff6b6b' : '#4a5568', 'stroke-width': 2.5 }));
      badge.append(svgEl('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', text: r.type === 'good' ? '❤️' : '⚡', style: 'font-size:14px' }));
      g.append(badge);
    }
    if (!data.room.locked) {
      g.addEventListener('click', () => openEditor(c.id));
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEditor(c.id); } });
    }
    nodes.append(g);
  }
  // '나'는 빨간 동그라미로 강조
  const meNode = svgEl('g', { class: 'node me', transform: 'translate(0,0)' });
  meNode.append(svgEl('circle', { class: 'me-halo', r: ME_R + 10 }));
  meNode.append(svgEl('ellipse', { cx: 0, cy: ME_R + 4, rx: ME_R * 0.7, ry: 4, fill: '#4a3b2f', opacity: '.10' }));
  meNode.append(svgEl('circle', { class: 'me-body', r: ME_R, fill: 'url(#me-grad)' }));
  meNode.append(svgEl('ellipse', { cx: -ME_R * 0.3, cy: -ME_R * 0.42, rx: ME_R * 0.32, ry: ME_R * 0.2, fill: '#fff', opacity: '.28', transform: `rotate(-20 ${-ME_R * 0.3} ${-ME_R * 0.42})` }));
  // 눈, 볼, 입
  for (const sx of [-10, 10]) {
    meNode.append(svgEl('ellipse', { cx: sx, cy: -2, rx: 4, ry: 5.4, fill: '#2d2f3a' }));
    meNode.append(svgEl('circle', { cx: sx + 1.5, cy: -4, r: 1.4, fill: '#fff' }));
  }
  meNode.append(svgEl('circle', { cx: -20, cy: 8, r: 5, fill: '#ffd2d2', opacity: '.6' }), svgEl('circle', { cx: 20, cy: 8, r: 5, fill: '#ffd2d2', opacity: '.6' }));
  meNode.append(svgEl('path', { d: 'M-7 11 Q0 17 7 11', fill: 'none', stroke: '#2d2f3a', 'stroke-width': 3, 'stroke-linecap': 'round' }));
  const meLabel = svgEl('g', { transform: `translate(0,${ME_R + 16})` });
  meLabel.append(svgEl('rect', { x: -22, y: -12, width: 44, height: 24, rx: 12, fill: '#fff', stroke: '#ff6b6b', 'stroke-width': 2 }));
  meLabel.append(svgEl('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', text: '나', style: 'font-size:16px;fill:#4a3b2f' }));
  meNode.append(meLabel);
  nodes.append(meNode);
  svg.append(nodes);
  container.replaceChildren(svg);
}

function shorten(s, n) { return s.length > n ? `${s.slice(0, n - 1)}…` : s; }

// 원(중심 c, 반지름 r)에서 목표점 t 방향으로 나가는 경계점
function circleEdge(c, r, t) {
  const dx = t.x - c.x, dy = t.y - c.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: c.x + (dx / len) * r, y: c.y + (dy / len) * r };
}

// 사각형(중심 c, 폭 w, 높이 h)에서 목표점 t 방향으로 나가는 경계점
function rectEdge(c, w, h, t) {
  const dx = t.x - c.x, dy = t.y - c.y;
  if (dx === 0 && dy === 0) return { x: c.x, y: c.y };
  const sx = dx !== 0 ? (w / 2) / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? (h / 2) / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  const padScale = 1 + 4 / Math.hypot(dx * s, dy * s);
  return { x: c.x + dx * s * padScale, y: c.y + dy * s * padScale };
}

// ---------- 편집 모달 ----------
function openEditor(id) {
  if (data.room.locked) return;
  const mate = data.classmates.find((c) => c.id === id);
  const current = draft[id] ? JSON.parse(JSON.stringify(draft[id])) : null;
  const state = { type: current?.type || null, tags: new Set(current?.tags || []), reason: current?.reason || '' };

  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' });
  backdrop.append(modal);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  function close() { document.removeEventListener('keydown', onKey); backdrop.remove(); }

  function draw() {
    modal.replaceChildren();
    modal.append(el('h2', { text: `${mate.name}${josa(mate.name, ['와', '과'])} 나는…` }));
    const choice = el('div', { class: 'type-choice' }, [
      el('button', { type: 'button', class: `type-btn good ${state.type === 'good' ? 'selected' : ''}`, onClick: () => { state.type = state.type === 'good' ? null : 'good'; state.tags.clear(); draw(); } }, [
        el('span', { class: 'big', text: '❤️' }), '좋은 사이', el('span', { class: 'desc', text: '빨간 화살표 · 이유는 골라도 되고 안 골라도 돼' }),
      ]),
      el('button', { type: 'button', class: `type-btn bad ${state.type === 'bad' ? 'selected' : ''}`, onClick: () => { state.type = state.type === 'bad' ? null : 'bad'; state.tags.clear(); draw(); } }, [
        el('span', { class: 'big', text: '⚡' }), '안 좋은 사이', el('span', { class: 'desc', text: '검은 화살표 · 이유를 꼭 적어야 해' }),
      ]),
    ]);
    modal.append(choice);

    if (state.type) {
      const isBad = state.type === 'bad';
      modal.append(el('div', { class: 'field' }, [
        el('label', {}, [isBad ? '어떤 점이 안 좋아? ' : '왜 좋은 사이야? ', el('span', { class: 'muted', text: '(골라도 되고 안 골라도 돼)' })]),
        el('div', { class: 'chips' }, data.catalog[state.type].map((t) => el('button', {
          type: 'button',
          class: `chip ${state.tags.has(t.id) ? `selected ${isBad ? 'bad-theme' : 'good-theme'}` : ''}`,
          text: `${t.emoji ? `${t.emoji} ` : ''}${t.label}`,
          onClick: () => { state.tags.has(t.id) ? state.tags.delete(t.id) : state.tags.add(t.id); draw(); },
        }))),
      ]));
      const ta = el('textarea', { placeholder: isBad ? '예: 지난주에 내 물건을 허락 없이 가져갔어요. 무슨 일이 있었는지 적어 줘.' : '예: 쉬는 시간에 항상 같이 놀아요.', maxlength: 300, style: isBad ? { minHeight: '110px', borderColor: 'var(--kid-coral)' } : { minHeight: '90px' } });
      ta.value = state.reason;
      ta.addEventListener('input', () => { state.reason = ta.value; updateHint(); });
      modal.append(el('div', { class: 'field' }, [
        el('label', {}, ['✏️ 이유 적기 ', isBad ? el('span', { class: 'req', text: '(꼭 적어 줘)' }) : el('span', { class: 'muted', text: '(선택)' })]),
        ta,
      ]));
      const hint = el('div', { class: 'alert warn hidden', id: 'editor-hint', text: '안 좋은 사이일 때는 무슨 일이 있었는지 이유를 꼭 적어 줘. 선생님만 볼 수 있어.' });
      modal.append(hint);
      var updateHint = () => hint.classList.toggle('hidden', !(isBad && state.reason.trim().length < 2));
      updateHint();
    } else {
      modal.append(el('p', { class: 'muted', text: '위에서 관계를 골라 줘. 아직 잘 모르겠으면 표시하지 않아도 괜찮아.' }));
    }

    modal.append(el('div', { class: 'btn-row', style: { marginTop: '8px' } }, [
      el('button', { type: 'button', class: 'btn primary', text: '저장 ✓', onClick: save }),
      current ? el('button', { type: 'button', class: 'btn', text: '표시 지우기', onClick: () => { delete draft[id]; dirty = true; close(); render(); } }) : null,
      el('button', { type: 'button', class: 'btn', text: '닫기', onClick: close }),
    ]));
  }

  function save() {
    if (!state.type) { delete draft[id]; dirty = true; close(); render(); return; }
    const r = { type: state.type, tags: [...state.tags], reason: state.reason.trim() };
    if (!relationValid(r)) { toast('안 좋은 사이일 때는 이유를 꼭 적어 줘! (2자 이상)'); return; }
    draft[id] = r;
    dirty = true;
    close();
    render();
  }

  draw();
  document.body.append(backdrop);
}

// ---------- 제출 ----------
async function submit() {
  if (!canSubmit()) return;
  try {
    data = await api(`/api/student/${encodeURIComponent(token)}/relations`, { method: 'PUT', body: { relations: draft, roundId: data.round?.id } });
    draft = JSON.parse(JSON.stringify(data.relations));
    dirty = false;
    render();
    toast('제출 완료! 정말 고마워 🎉');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    toast(err.message, 5000);
    if (err.status === 403 || err.status === 409) {
      // 마감되었거나 새 회차가 시작됨 → 최신 상태로 다시 불러오기
      try { data = await api(`/api/student/${encodeURIComponent(token)}`); draft = JSON.parse(JSON.stringify(data.relations || {})); dirty = false; render(); } catch { /* ignore */ }
    }
  }
}

window.addEventListener('beforeunload', (e) => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- 시작 ----------
(async () => {
  try {
    data = await api(`/api/student/${encodeURIComponent(token)}`);
    draft = JSON.parse(JSON.stringify(data.relations || {}));
    render();
  } catch (err) {
    app.replaceChildren(el('section', { class: 'card' }, [
      el('h1', { text: '페이지를 열 수 없어요' }),
      el('p', { text: err.message }),
    ]));
  }
})();
