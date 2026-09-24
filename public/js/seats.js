import { api, el, toast, setChildren, TYPE_ICON } from './common.js';

const adminToken = decodeURIComponent(location.pathname.split('/')[2] || '');
const base = `/api/teacher/${encodeURIComponent(adminToken)}`;
const app = document.getElementById('app');
document.getElementById('back-link').href = `/t/${encodeURIComponent(adminToken)}`;

// ---------- 상태 ----------
let data = null;                 // 교사 API 응답
let layout = { blocks: [{ cols: 2, rows: 4 }, { cols: 2, rows: 5 }, { cols: 2, rows: 4 }] };
let seats = {};                  // seatId -> studentId
let pinned = new Set();
let options = { friends: 'any' };
let selected = null;             // 선택된 seatId
let dirty = false;
let layoutText = '2x4, 2x5, 2x4';

const nameOf = (id) => data.stats[id]?.name || '?';

// ---------- 배치 계산 ----------
function seatList() {
  const list = [];
  layout.blocks.forEach((b, bi) => {
    for (let r = 0; r < b.rows; r++) for (let c = 0; c < b.cols; c++) list.push({ id: `b${bi}-r${r}-c${c}`, b: bi, r, c });
  });
  return list;
}

// 인접 관계: [seatA, seatB, weight, label]
function neighborPairs() {
  const pairs = [];
  const id = (b, r, c) => `b${b}-r${r}-c${c}`;
  layout.blocks.forEach((blk, bi) => {
    for (let r = 0; r < blk.rows; r++) {
      for (let c = 0; c < blk.cols; c++) {
        if (c + 1 < blk.cols) pairs.push([id(bi, r, c), id(bi, r, c + 1), 1.0, '짝꿍']);
        if (r + 1 < blk.rows) pairs.push([id(bi, r, c), id(bi, r + 1, c), 0.6, '앞뒤']);
        if (r + 1 < blk.rows && c + 1 < blk.cols) pairs.push([id(bi, r, c), id(bi, r + 1, c + 1), 0.3, '대각선']);
        if (r + 1 < blk.rows && c > 0) pairs.push([id(bi, r, c), id(bi, r + 1, c - 1), 0.3, '대각선']);
      }
    }
    const next = layout.blocks[bi + 1];
    if (next) {
      const rows = Math.min(blk.rows, next.rows);
      for (let r = 0; r < rows; r++) pairs.push([id(bi, r, blk.cols - 1), id(bi + 1, r, 0), 0.35, '통로 건너']);
    }
  });
  return pairs;
}

// ---------- 관계 비용 ----------
let relType = {};   // relType[a][b] = 'good' | 'bad'
let prob = {};      // 'a|b' (정렬) -> 갈등 확률
let isolated = new Set();
function buildRelations() {
  relType = {};
  for (const r of data.relations) (relType[r.from] ||= {})[r.to] = r.type;
  prob = {};
  for (const p of data.analysis.pairs) prob[[p.a, p.b].sort().join('|')] = p;
  isolated = new Set(Object.values(data.analysis.studentRisk).filter((s) => s.flags.includes('isolated')).map((s) => s.id));
}
const rel = (a, b) => relType[a]?.[b] || 'none';

function pairCost(a, b) {
  if (!a || !b) return 0;
  const ab = rel(a, b);
  const ba = rel(b, a);
  let cost = 0;
  if (ab === 'bad' || ba === 'bad') cost += prob[[a, b].sort().join('|')]?.probability ?? 50;
  const mutualGood = ab === 'good' && ba === 'good';
  const anyGood = ab === 'good' || ba === 'good';
  if (options.friends === 'near') cost -= mutualGood ? 10 : anyGood ? 4 : 0;
  if (options.friends === 'apart') cost += mutualGood ? 8 : anyGood ? 3 : 0;
  if (isolated.has(a) && ba === 'good') cost -= 8;
  if (isolated.has(b) && ab === 'good') cost -= 8;
  return cost;
}

function totalCost(assign, pairs) {
  let sum = 0;
  for (const [x, y, w] of pairs) sum += w * pairCost(assign[x], assign[y]);
  // 학생이 자리보다 적으면 앞줄부터 채우도록 뒷줄에 작은 비용
  for (const [seatId, sid] of Object.entries(assign)) if (sid) sum += 0.8 * Number(seatId.split('-')[1].slice(1));
  return sum;
}

// ---------- 자동 배정 (담금질 기법) ----------
function autoAssign() {
  const all = seatList().map((s) => s.id);
  const free = all.filter((id) => !pinned.has(id));
  const pinnedStudents = new Set([...pinned].map((id) => seats[id]).filter(Boolean));
  const students = data.students.map((s) => s.id).filter((id) => !pinnedStudents.has(id));
  if (students.length > free.length) toast(`자리가 ${students.length - free.length}개 부족해요. 배치를 늘려 주세요.`, 4000);

  const pairs = neighborPairs();
  let best = null;
  let bestCost = Infinity;
  for (let restart = 0; restart < 6; restart++) {
    const assign = {};
    for (const id of pinned) if (seats[id]) assign[id] = seats[id];
    const shuffled = [...students].sort(() => Math.random() - 0.5);
    free.forEach((id, i) => { assign[id] = shuffled[i] || null; });
    let cost = totalCost(assign, pairs);
    let T = 30;
    for (let it = 0; it < 12000; it++) {
      const i = free[Math.floor(Math.random() * free.length)];
      const j = free[Math.floor(Math.random() * free.length)];
      if (i === j) continue;
      [assign[i], assign[j]] = [assign[j], assign[i]];
      const next = totalCost(assign, pairs);
      const delta = next - cost;
      if (delta <= 0 || Math.random() < Math.exp(-delta / T)) cost = next;
      else [assign[i], assign[j]] = [assign[j], assign[i]];
      T = Math.max(0.2, T * 0.9995);
    }
    if (cost < bestCost) { bestCost = cost; best = assign; }
  }
  seats = {};
  for (const [id, sid] of Object.entries(best)) if (sid) seats[id] = sid;
  dirty = true;
  selected = null;
  render();
  toast('자동으로 배정했어요. 마음에 안 들면 "다른 배치"를 눌러 보세요.');
}

// ---------- 분석 ----------
function evaluate() {
  const pairs = neighborPairs();
  const warnings = [];
  let goodPairs = 0;
  const conflictSeats = new Set();
  for (const [x, y, , label] of pairs) {
    const a = seats[x];
    const b = seats[y];
    if (!a || !b) continue;
    const ab = rel(a, b);
    const ba = rel(b, a);
    if (ab === 'bad' || ba === 'bad') {
      warnings.push({ a, b, label, p: prob[[a, b].sort().join('|')]?.probability ?? null, ab, ba });
      conflictSeats.add(x); conflictSeats.add(y);
    } else if (ab === 'good' && ba === 'good' && label === '짝꿍') goodPairs++;
  }
  warnings.sort((p, q) => (q.p || 0) - (p.p || 0));
  return { warnings, goodPairs, conflictSeats };
}

// ---------- 화면 ----------
function parseLayout(text) {
  const blocks = text.split(/[,/]+/).map((t) => t.trim()).filter(Boolean).map((t) => {
    const m = t.match(/^(\d+)\s*[x×*]\s*(\d+)$/i);
    if (!m) throw new Error(`"${t}" 를 이해하지 못했어요. 예: 2x4`);
    return { cols: Number(m[1]), rows: Number(m[2]) };
  });
  if (!blocks.length) throw new Error('배치를 입력해 주세요. 예: 2x4, 2x5, 2x4');
  return { blocks };
}

function render() {
  const ev = evaluate();
  const assigned = new Set(Object.values(seats));
  const unassigned = data.students.filter((s) => !assigned.has(s.id));
  const seatCount = seatList().length;

  const layoutInput = el('input', { type: 'text', value: layoutText, placeholder: '예: 2x4, 2x5, 2x4', style: { minWidth: '200px' } });
  const friendsSelect = el('select', { style: { padding: '8px 10px', borderRadius: '10px', border: '1px solid var(--gray-300)' } }, [
    el('option', { value: 'any', text: '친한 친구: 상관없음', selected: options.friends === 'any' ? true : null }),
    el('option', { value: 'near', text: '친한 친구: 가까이 앉히기', selected: options.friends === 'near' ? true : null }),
    el('option', { value: 'apart', text: '친한 친구: 떨어뜨리기', selected: options.friends === 'apart' ? true : null }),
  ]);
  friendsSelect.addEventListener('change', () => { options.friends = friendsSelect.value; dirty = true; render(); });

  const header = el('section', { class: 'card no-print' }, [
    el('div', { class: 'card-title' }, [
      el('div', {}, [el('h1', { text: `${data.room.name} 자리 배정` }), el('div', { class: 'muted', text: `학생 ${data.students.length}명 · 자리 ${seatCount}개 · 응답 ${data.analysis.submittedCount}명 기준` })]),
      el('div', { class: 'btn-row' }, [
        el('button', { type: 'button', class: 'btn primary', text: '자동 배정', onClick: autoAssign }),
        el('button', { type: 'button', class: 'btn', text: '다른 배치', onClick: autoAssign }),
        el('button', { type: 'button', class: 'btn', text: '모두 비우기', onClick: () => { if (!confirm('고정한 자리를 포함해 모두 비울까요?')) return; seats = {}; pinned = new Set(); dirty = true; render(); } }),
        el('button', { type: 'button', class: `btn ${dirty ? 'orange' : ''}`, text: dirty ? '저장하기 *' : '저장됨', onClick: save }),
        el('button', { type: 'button', class: 'btn', text: '인쇄', onClick: () => window.print() }),
      ]),
    ]),
    el('div', { class: 'btn-row', style: { marginTop: '6px' } }, [
      el('form', { class: 'inline-form', onSubmit: (e) => {
        e.preventDefault();
        try { layout = parseLayout(layoutInput.value); layoutText = layoutInput.value; } catch (err) { return toast(err.message, 4000); }
        const valid = new Set(seatList().map((s) => s.id));
        for (const id of Object.keys(seats)) if (!valid.has(id)) delete seats[id];
        pinned = new Set([...pinned].filter((id) => valid.has(id)));
        dirty = true; render();
      } }, [el('label', { text: '교실 배치', style: { fontWeight: 600, alignSelf: 'center' } }), layoutInput, el('button', { type: 'submit', class: 'btn', text: '적용' })]),
      friendsSelect,
    ]),
    el('p', { class: 'muted', style: { marginTop: '8px', marginBottom: 0 }, text: '배치는 "가로x세로" 블록을 쉼표로 나눠 적어요. 예: 2x4, 2x5, 2x4 는 2명씩 앉는 분단 세 개예요. 자리를 누른 뒤 다른 자리를 누르면 서로 바뀌고, 📌 을 누르면 자동 배정에서 그 자리를 고정해요.' }),
  ]);

  // 좌석표
  const blocksEl = el('div', { class: 'seat-blocks' }, layout.blocks.map((b, bi) => {
    const grid = el('div', { class: 'seat-block', style: { gridTemplateColumns: `repeat(${b.cols}, 1fr)` } });
    for (let r = 0; r < b.rows; r++) for (let c = 0; c < b.cols; c++) grid.append(seatCard(`b${bi}-r${r}-c${c}`, ev));
    return grid;
  }));
  const chart = el('section', { class: 'card seat-chart' }, [
    el('div', { class: 'print-only', style: { fontWeight: 700, fontSize: '18px', marginBottom: '8px' }, text: `${data.room.name} 자리표` }),
    el('div', { class: 'podium', text: '교탁' }),
    blocksEl,
  ]);

  // 요약 & 주의
  const side = el('section', { class: 'card no-print' }, [
    el('div', { class: 'stat-row' }, [
      el('div', { class: 'stat' }, [el('div', { class: 'label', text: '가까이 앉은 갈등 쌍' }), el('div', { class: 'value', text: `${ev.warnings.length}쌍`, style: { color: ev.warnings.length ? '#d63d4f' : '#1e6b32' } })]),
      el('div', { class: 'stat' }, [el('div', { class: 'label', text: '서로 좋은 사이 짝꿍' }), el('div', { class: 'value', text: `${ev.goodPairs}쌍` })]),
      el('div', { class: 'stat' }, [el('div', { class: 'label', text: '아직 자리 없음' }), el('div', { class: 'value', text: `${unassigned.length}명` })]),
    ]),
    ev.warnings.length ? el('div', { style: { marginTop: '12px' } }, [
      el('h3', { text: '주의: 안 좋은 사이가 가까이 있어요' }),
      el('ul', { style: { paddingLeft: '18px', margin: '6px 0' } }, ev.warnings.map((w) => el('li', {}, [
        el('b', { text: `${nameOf(w.a)} ↔ ${nameOf(w.b)}` }), ` · ${w.label}`,
        w.p !== null ? el('span', { class: `badge ${w.p >= 70 ? 'high' : w.p >= 40 ? 'medium' : 'low'}`, style: { marginLeft: '6px' }, text: `갈등 ${w.p}%` }) : null,
        el('span', { class: 'muted', text: ` ${w.ab === 'bad' ? `${nameOf(w.a)} ${TYPE_ICON.bad}→ ${nameOf(w.b)}` : ''} ${w.ba === 'bad' ? `${nameOf(w.b)} ${TYPE_ICON.bad}→ ${nameOf(w.a)}` : ''}` }),
      ]))),
    ]) : el('p', { class: 'muted', style: { marginTop: '10px' }, text: Object.keys(seats).length ? '가까운 자리에 안 좋은 사이가 없어요. 👍' : '아직 배정된 자리가 없어요. "자동 배정"을 눌러 보세요.' }),
    unassigned.length ? el('div', { style: { marginTop: '12px' } }, [
      el('h3', { text: '자리 없는 학생' }),
      el('p', { class: 'muted', text: '빈 자리를 먼저 누른 뒤 이름을 누르면 그 자리에 앉아요.' }),
      el('div', { class: 'chips' }, unassigned.map((s) => el('button', { type: 'button', class: 'chip', text: s.name, onClick: () => {
        if (!selected || seats[selected]) return toast('먼저 빈 자리를 눌러 주세요.');
        seats[selected] = s.id; selected = null; dirty = true; render();
      } }))),
    ]) : null,
  ]);

  setChildren(app, header, el('div', { class: 'grid-2 seat-layout' }, [chart, side]));
}

function seatCard(seatId, ev) {
  const sid = seats[seatId];
  const cls = ['seat', sid ? '' : 'empty', selected === seatId ? 'selected' : '', ev.conflictSeats.has(seatId) ? 'conflict' : '', pinned.has(seatId) ? 'pinned' : ''].filter(Boolean).join(' ');
  const card = el('button', { type: 'button', class: cls, onClick: () => onSeatClick(seatId) }, [
    el('span', { class: 'seat-name', text: sid ? nameOf(sid) : '빈 자리' }),
    sid ? el('span', { class: 'pin no-print', text: pinned.has(seatId) ? '📌' : '📍', title: pinned.has(seatId) ? '고정 해제' : '이 자리 고정', onClick: (e) => { e.stopPropagation(); pinned.has(seatId) ? pinned.delete(seatId) : pinned.add(seatId); dirty = true; render(); } }) : null,
  ]);
  return card;
}

function onSeatClick(seatId) {
  if (selected === null) { selected = seatId; render(); return; }
  if (selected === seatId) { selected = null; render(); return; }
  const a = seats[selected];
  const b = seats[seatId];
  if (a) seats[seatId] = a; else delete seats[seatId];
  if (b) seats[selected] = b; else delete seats[selected];
  selected = null;
  dirty = true;
  render();
}

async function save() {
  try {
    data = await api(`${base}/seating`, { method: 'PUT', body: { layout, seats, pinned: [...pinned], options } });
    dirty = false;
    render();
    toast('자리 배정을 저장했어요.');
  } catch (err) { toast(err.message, 4000); }
}

window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

(async () => {
  try {
    data = await api(base);
    buildRelations();
    if (data.seating) {
      layout = data.seating.layout;
      layoutText = layout.blocks.map((b) => `${b.cols}x${b.rows}`).join(', ');
      seats = { ...data.seating.seats };
      pinned = new Set(data.seating.pinned || []);
      options = { ...options, ...(data.seating.options || {}) };
    }
    document.title = `${data.room.name} 자리 배정`;
    render();
  } catch (err) {
    setChildren(app, el('section', { class: 'card' }, [el('h1', { text: '교실을 열 수 없어요' }), el('p', { text: err.message })]));
  }
})();
