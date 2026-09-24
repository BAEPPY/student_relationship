import { api, el, svgEl, toast, TYPE_LABEL, TYPE_ICON } from './common.js';

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
  if (r.type === 'bad') return (r.tags && r.tags.length > 0) || (r.reason && r.reason.trim().length > 0);
  return true;
}
function selectedCount() { return Object.keys(draft).length; }
function invalidNames() {
  return Object.entries(draft).filter(([, r]) => !relationValid(r)).map(([id]) => nameOf(id));
}
function nameOf(id) { return data.classmates.find((c) => c.id === id)?.name || '?'; }
function canSubmit() { return selectedCount() >= data.room.minRelations && invalidNames().length === 0 && !data.room.locked; }

// ---------- 화면 ----------
function render() {
  const { me, room, classmates } = data;
  app.replaceChildren();
  document.getElementById('room-name').textContent = room.name;
  document.title = `${me.name}의 친구 관계 지도`;

  const intro = el('section', { class: 'card' }, [
    el('h1', { text: `${me.name}님, 안녕하세요 👋` }),
    el('p', {}, [
      '우리 반 친구들과 나의 관계를 표시해 주세요. ',
      el('b', { text: '좋은 사이' }), '는 빨간 화살표, ',
      el('b', { text: '안 좋은 사이' }), '는 검은 화살표로 이어져요.',
    ]),
    el('div', { class: 'alert info' }, [
      '🔒 이 페이지는 나만 볼 수 있어요. 친구들은 내가 표시한 내용을 볼 수 없고, 선생님만 확인해요. 솔직하게 표시해 주세요.',
    ]),
    room.locked ? el('div', { class: 'alert warn', text: '선생님이 제출을 마감했어요. 내가 표시한 내용을 확인만 할 수 있어요.' }) : null,
    data.submittedAt && !room.locked ? el('div', { class: 'alert success', text: '제출을 완료했어요. 마감 전까지는 언제든 수정하고 다시 제출할 수 있어요.' }) : null,
  ]);
  app.append(intro);

  // 진행 상황
  const n = selectedCount();
  const min = room.minRelations;
  const pct = Math.min(100, Math.round((n / Math.max(1, min)) * 100));
  const progress = el('section', { class: 'card' }, [
    el('div', { class: 'card-title' }, [
      el('h2', { text: '내 관계 지도' }),
      el('span', { class: `badge ${n >= min ? 'green' : 'warn'}`, text: `${n}명 표시 (최소 ${min}명)` }),
    ]),
    el('div', { class: 'progress' }, [el('div', { class: n >= min ? 'done' : '', style: { width: `${pct}%` } })]),
    el('div', { class: 'student-map', id: 'map', style: { marginTop: '10px' } }),
    el('div', { class: 'legend', style: { marginTop: '6px' } }, [
      el('span', {}, [el('span', { class: 'sw', style: { background: 'var(--red)', borderRadius: '50%', width: '14px', height: '14px' } }), '나']),
      el('span', {}, [el('span', { class: 'sw', style: { background: 'var(--node-fill)', border: '1.5px solid var(--node-border)' } }), '친구']),
      el('span', {}, [el('span', { class: 'line', style: { background: 'var(--red)' } }), '좋은 사이']),
      el('span', {}, [el('span', { class: 'line', style: { background: 'var(--black)' } }), '안 좋은 사이']),
    ]),
    el('p', { class: 'muted', style: { marginTop: '8px' }, text: '지도의 친구 이름을 누르거나, 아래 목록에서 친구를 골라 관계를 표시하세요.' }),
  ]);
  app.append(progress);
  drawMap(progress.querySelector('#map'));

  // 친구 목록
  const list = el('section', { class: 'card' }, [
    el('div', { class: 'card-title' }, [el('h2', { text: '우리 반 친구들' }), el('span', { class: 'muted', text: `${classmates.length}명` })]),
    el('div', { class: 'mate-list' }, classmates.map((c) => mateButton(c))),
    !room.locked ? stickyBar() : null,
  ]);
  app.append(list);
}

function mateButton(c) {
  const r = draft[c.id];
  const type = r?.type;
  const invalid = r && !relationValid(r);
  const sub = r
    ? invalid
      ? '⚠️ 이유를 적어 주세요'
      : [...(r.tags || []).map((t) => tagLabel(type, t)), r.reason].filter(Boolean).join(', ') || '이유 없음'
    : '눌러서 표시하기';
  return el('button', {
    type: 'button',
    class: `mate ${type || ''}`,
    onClick: () => openEditor(c.id),
    disabled: data.room.locked ? true : null,
  }, [
    el('span', { class: 'name' }, [c.name, el('span', { class: 'sub', text: sub })]),
    type ? el('span', { class: `badge ${type}`, text: `${TYPE_ICON[type]} ${TYPE_LABEL[type]}` }) : el('span', { class: 'badge gray', text: '선택 안 함' }),
  ]);
}

function tagLabel(type, id) {
  return data.catalog[type]?.find((t) => t.id === id)?.label || id;
}

function stickyBar() {
  const n = selectedCount();
  const min = data.room.minRelations;
  const invalid = invalidNames();
  let status;
  if (invalid.length) status = `⚠️ ${invalid.join(', ')}${josa(invalid[invalid.length - 1], ['와', '과'])} 안 좋은 사이인 이유를 적어 주세요.`;
  else if (n < min) status = `친구를 ${min - n}명 더 표시해 주세요. (최소 ${min}명)`;
  else if (dirty) status = '✅ 준비 완료! 제출 버튼을 눌러 주세요.';
  else if (data.submittedAt) status = '제출 완료. 바꾼 내용이 있으면 다시 제출해 주세요.';
  else status = '✅ 준비 완료! 제출 버튼을 눌러 주세요.';
  return el('div', { class: 'sticky-bar' }, [
    el('div', { class: 'status', text: status }),
    el('button', { type: 'button', class: 'btn primary', text: data.submittedAt ? '다시 제출하기' : '제출하기', disabled: canSubmit() ? null : true, onClick: submit }),
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
  for (const [id, color] of [['arrow-good', '#ef5b6b'], ['arrow-bad', '#2d2f3a']]) {
    const m = svgEl('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    m.append(svgEl('path', { d: 'M0,0 L10,5 L0,10 z', fill: color }));
    defs.append(m);
  }
  svg.append(defs);

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
      stroke: r.type === 'good' ? '#ef5b6b' : '#2d2f3a', 'stroke-width': 2.5, fill: 'none', 'stroke-linecap': 'round',
      'marker-end': `url(#${r.type === 'good' ? 'arrow-good' : 'arrow-bad'})`,
    }));
  }
  svg.append(edges);

  const nodes = svgEl('g');
  for (const c of mates) {
    const p = pos[c.id];
    const r = draft[c.id];
    const g = svgEl('g', { class: 'node', transform: `translate(${p.x},${p.y})`, tabindex: 0, role: 'button', 'aria-label': c.name });
    const rect = svgEl('rect', { x: -NODE_W / 2, y: -NODE_H / 2, width: NODE_W, height: NODE_H, rx: 8 });
    if (r) rect.setAttribute('style', `stroke:${r.type === 'good' ? '#ef5b6b' : '#2d2f3a'};stroke-width:3`);
    g.append(rect, svgEl('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', text: shorten(c.name, 6), style: 'font-size:18px' }));
    if (!data.room.locked) {
      g.addEventListener('click', () => openEditor(c.id));
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEditor(c.id); } });
    }
    nodes.append(g);
  }
  // '나'는 빨간 동그라미로 강조
  const meNode = svgEl('g', { class: 'node me', transform: 'translate(0,0)' });
  meNode.append(svgEl('circle', { class: 'me-halo', r: ME_R + 10 }));
  meNode.append(svgEl('circle', { class: 'me-body', r: ME_R }));
  meNode.append(svgEl('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', text: '나', style: 'font-size:26px;fill:#fff;font-weight:800' }));
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
        '❤️ 좋은 사이', el('span', { class: 'desc', text: '빨간 화살표 · 이유는 선택' }),
      ]),
      el('button', { type: 'button', class: `type-btn bad ${state.type === 'bad' ? 'selected' : ''}`, onClick: () => { state.type = state.type === 'bad' ? null : 'bad'; state.tags.clear(); draw(); } }, [
        '⚡ 안 좋은 사이', el('span', { class: 'desc', text: '검은 화살표 · 이유는 꼭 적기' }),
      ]),
    ]);
    modal.append(choice);

    if (state.type) {
      const isBad = state.type === 'bad';
      modal.append(el('div', { class: 'field' }, [
        el('label', {}, [isBad ? '왜 안 좋은 사이인가요? ' : '왜 좋은 사이인가요? ', isBad ? el('span', { class: 'req', text: '(꼭 골라 주세요)' }) : el('span', { class: 'muted', text: '(골라도 되고 안 골라도 돼요)' })]),
        el('div', { class: 'chips' }, data.catalog[state.type].map((t) => el('button', {
          type: 'button',
          class: `chip ${state.tags.has(t.id) ? `selected ${isBad ? 'bad-theme' : 'good-theme'}` : ''}`,
          text: t.label,
          onClick: () => { state.tags.has(t.id) ? state.tags.delete(t.id) : state.tags.add(t.id); draw(); },
        }))),
      ]));
      const ta = el('textarea', { placeholder: isBad ? '예: 지난주에 내 물건을 허락 없이 가져갔어요.' : '예: 쉬는 시간에 항상 같이 놀아요.', maxlength: 300, style: { minHeight: '90px' } });
      ta.value = state.reason;
      ta.addEventListener('input', () => { state.reason = ta.value; updateHint(); });
      modal.append(el('div', { class: 'field' }, [
        el('label', {}, ['직접 적기 ', isBad ? el('span', { class: 'muted', text: '(위에서 하나도 고르지 않았다면 여기에 꼭 적어 주세요)' }) : el('span', { class: 'muted', text: '(선택)' })]),
        ta,
      ]));
      const hint = el('div', { class: 'alert warn hidden', id: 'editor-hint', text: '안 좋은 사이일 때는 이유를 꼭 알려주세요. 위에서 고르거나 직접 적어 주세요.' });
      modal.append(hint);
      var updateHint = () => hint.classList.toggle('hidden', !(isBad && state.tags.size === 0 && !state.reason.trim()));
      updateHint();
    } else {
      modal.append(el('p', { class: 'muted', text: '위에서 관계를 골라 주세요. 아직 잘 모르겠으면 표시하지 않아도 괜찮아요.' }));
    }

    modal.append(el('div', { class: 'btn-row', style: { marginTop: '8px' } }, [
      el('button', { type: 'button', class: 'btn primary', text: '저장', onClick: save }),
      current ? el('button', { type: 'button', class: 'btn', text: '표시 지우기', onClick: () => { delete draft[id]; dirty = true; close(); render(); } }) : null,
      el('button', { type: 'button', class: 'btn', text: '닫기', onClick: close }),
    ]));
  }

  function save() {
    if (!state.type) { delete draft[id]; dirty = true; close(); render(); return; }
    const r = { type: state.type, tags: [...state.tags], reason: state.reason.trim() };
    if (!relationValid(r)) { toast('안 좋은 사이일 때는 이유를 꼭 적어 주세요.'); return; }
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
    data = await api(`/api/student/${encodeURIComponent(token)}/relations`, { method: 'PUT', body: { relations: draft } });
    draft = JSON.parse(JSON.stringify(data.relations));
    dirty = false;
    render();
    toast('제출 완료! 고마워요 🎉');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    toast(err.message, 4000);
    if (err.status === 403) { try { data = await api(`/api/student/${encodeURIComponent(token)}`); render(); } catch { /* ignore */ } }
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
