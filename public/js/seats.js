import { api, el, toast, setChildren, TYPE_ICON } from './common.js';
import { parseTeacherNotes } from './notes-parser.js';

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
let notes = {};                  // studentId -> { memo, front }
let rules = [];                  // [{ type: 'apart'|'together', a, b, note }]
let selected = null;             // 선택된 seatId
let dirty = false;
let layoutText = '2x4, 2x5, 2x4';
let notesOpen = true;
let pasteText = '';
let parsed = null;              // { items: [{...item, checked}], unmatched }

const nameOf = (id) => data.stats[id]?.name || '?';
const RULE_LABEL = { apart: '떨어뜨리기', together: '가까이 앉히기' };
const FRONT_ROWS = 2;            // 앞자리로 인정하는 줄 수

// ---------- 좌석 ----------
function seatList() {
  const list = [];
  layout.blocks.forEach((b, bi) => {
    for (let r = 0; r < b.rows; r++) for (let c = 0; c < b.cols; c++) list.push({ id: `b${bi}-r${r}-c${c}`, b: bi, r, c });
  });
  return list;
}
const rowOf = (seatId) => Number(seatId.split('-')[1].slice(1));

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
let prob = {};      // 'a|b' (정렬) -> 갈등 분석 결과
let isolated = new Set();
const pairKey = (a, b) => [a, b].sort().join('|');
function buildRelations() {
  relType = {};
  for (const r of data.relations) (relType[r.from] ||= {})[r.to] = r.type;
  prob = {};
  for (const p of data.analysis.pairs) prob[pairKey(p.a, p.b)] = p;
  isolated = new Set(Object.values(data.analysis.studentRisk).filter((s) => s.flags.includes('isolated')).map((s) => s.id));
}
const rel = (a, b) => relType[a]?.[b] || 'none';
const ruleOf = (a, b) => rules.find((r) => pairKey(r.a, r.b) === pairKey(a, b)) || null;
const needsFront = (sid) => Boolean(notes[sid]?.front);

function pairCost(a, b) {
  if (!a || !b) return 0;
  let cost = 0;
  // 교사 지정 규칙이 가장 강함
  const rule = ruleOf(a, b);
  if (rule?.type === 'apart') cost += 400;
  if (rule?.type === 'together') cost -= 60;
  const ab = rel(a, b);
  const ba = rel(b, a);
  if (ab === 'bad' || ba === 'bad') cost += prob[pairKey(a, b)]?.probability ?? 50;
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
  for (const [seatId, sid] of Object.entries(assign)) {
    if (!sid) continue;
    const row = rowOf(seatId);
    sum += 0.8 * row;                                   // 학생이 자리보다 적으면 앞줄부터
    if (needsFront(sid)) sum += row < FRONT_ROWS ? row * 8 : 60 + row * 30;   // 앞자리 필요 학생
  }
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
    let T = 40;
    for (let it = 0; it < 14000; it++) {
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

// ---------- 평가 ----------
function evaluate() {
  const pairs = neighborPairs();
  const warnings = [];     // 가까이 앉은 갈등/분리 지정 쌍
  const infos = [];        // 참고 사항
  let goodPairs = 0;
  const conflictSeats = new Set();
  const seatOf = {};
  for (const [seatId, sid] of Object.entries(seats)) seatOf[sid] = seatId;

  for (const [x, y, , label] of pairs) {
    const a = seats[x];
    const b = seats[y];
    if (!a || !b) continue;
    const rule = ruleOf(a, b);
    const ab = rel(a, b);
    const ba = rel(b, a);
    if (rule?.type === 'apart') {
      warnings.push({ a, b, label, p: 100, teacher: true, note: rule.note, ab, ba });
      conflictSeats.add(x); conflictSeats.add(y);
    } else if (ab === 'bad' || ba === 'bad') {
      warnings.push({ a, b, label, p: prob[pairKey(a, b)]?.probability ?? null, ab, ba });
      conflictSeats.add(x); conflictSeats.add(y);
    } else if (ab === 'good' && ba === 'good' && label === '짝꿍') goodPairs++;
  }
  warnings.sort((p, q) => (q.p || 0) - (p.p || 0));

  // 가까이 앉히기 지정인데 떨어져 있는 쌍
  const adjacent = new Set(pairs.map(([x, y]) => pairKey(x, y)));
  for (const r of rules) {
    if (r.type !== 'together') continue;
    const sa = seatOf[r.a];
    const sb = seatOf[r.b];
    if (sa && sb && !adjacent.has(pairKey(sa, sb))) infos.push(`${nameOf(r.a)} · ${nameOf(r.b)}: 가까이 앉히기로 지정했지만 떨어져 있어요.`);
  }
  // 앞자리 필요 학생이 뒤에 앉음
  for (const [sid, n] of Object.entries(notes)) {
    if (!n.front) continue;
    const seatId = seatOf[sid];
    if (seatId && rowOf(seatId) >= FRONT_ROWS) { infos.push(`${nameOf(sid)}: 앞자리가 필요한데 ${rowOf(seatId) + 1}번째 줄이에요.`); conflictSeats.add(seatId); }
  }
  return { warnings, infos, goodPairs, conflictSeats };
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
  const friendsSelect = el('select', { class: 'select' }, [
    el('option', { value: 'any', text: '친한 친구: 상관없음', selected: options.friends === 'any' ? true : null }),
    el('option', { value: 'near', text: '친한 친구: 가까이 앉히기', selected: options.friends === 'near' ? true : null }),
    el('option', { value: 'apart', text: '친한 친구: 떨어뜨리기', selected: options.friends === 'apart' ? true : null }),
  ]);
  friendsSelect.addEventListener('change', () => { options.friends = friendsSelect.value; dirty = true; render(); });

  const header = el('section', { class: 'card no-print' }, [
    el('div', { class: 'card-title' }, [
      el('div', {}, [el('h1', { text: `${data.room.name} 자리 배정` }), el('div', { class: 'muted', text: `학생 ${data.students.length}명 · 자리 ${seatCount}개 · 응답 ${data.analysis.submittedCount}명 기준 · 교사 지정 규칙 ${rules.length}개` })]),
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
    el('p', { class: 'muted', style: { marginTop: '8px', marginBottom: 0 }, text: '배치는 "가로x세로" 블록을 쉼표로 나눠 적어요. 예: 2x4, 2x5, 2x4 는 2명씩 앉는 분단 세 개예요. 자리를 누른 뒤 다른 자리를 누르면 서로 바뀌고, 📍 을 누르면 자동 배정에서 그 자리를 고정해요. 👓 앞자리 필요, 📝 메모 있음.' }),
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
  const memoStudents = data.students.filter((s) => notes[s.id]?.memo || notes[s.id]?.front);
  const side = el('section', { class: 'card no-print' }, [
    el('div', { class: 'stat-row' }, [
      el('div', { class: 'stat' }, [el('div', { class: 'label', text: '가까이 앉은 갈등 쌍' }), el('div', { class: 'value', text: `${ev.warnings.length}쌍`, style: { color: ev.warnings.length ? '#d63d4f' : '#1e6b32' } })]),
      el('div', { class: 'stat' }, [el('div', { class: 'label', text: '서로 좋은 사이 짝꿍' }), el('div', { class: 'value', text: `${ev.goodPairs}쌍` })]),
      el('div', { class: 'stat' }, [el('div', { class: 'label', text: '아직 자리 없음' }), el('div', { class: 'value', text: `${unassigned.length}명` })]),
    ]),
    ev.warnings.length ? el('div', { style: { marginTop: '12px' } }, [
      el('h3', { text: '주의: 떨어뜨려야 할 학생이 가까이 있어요' }),
      el('ul', { style: { paddingLeft: '18px', margin: '6px 0' } }, ev.warnings.map((w) => el('li', {}, [
        el('b', { text: `${nameOf(w.a)} ↔ ${nameOf(w.b)}` }), ` · ${w.label} `,
        w.teacher
          ? el('span', { class: 'badge high', text: `교사 지정 분리${w.note ? ` · ${w.note}` : ''}` })
          : w.p !== null ? el('span', { class: `badge ${w.p >= 70 ? 'high' : w.p >= 40 ? 'medium' : 'low'}`, text: `갈등 ${w.p}%` }) : null,
        !w.teacher ? el('span', { class: 'muted', text: ` ${w.ab === 'bad' ? `${nameOf(w.a)} ${TYPE_ICON.bad}→ ${nameOf(w.b)}` : ''} ${w.ba === 'bad' ? `${nameOf(w.b)} ${TYPE_ICON.bad}→ ${nameOf(w.a)}` : ''}` }) : null,
      ]))),
    ]) : el('p', { class: 'muted', style: { marginTop: '10px' }, text: Object.keys(seats).length ? '가까운 자리에 안 좋은 사이나 분리 지정 쌍이 없어요. 👍' : '아직 배정된 자리가 없어요. "자동 배정"을 눌러 보세요.' }),
    ev.infos.length ? el('div', { style: { marginTop: '8px' } }, [
      el('h3', { text: '참고' }),
      el('ul', { style: { paddingLeft: '18px', margin: '6px 0' }, class: 'muted' }, ev.infos.map((t) => el('li', { text: t }))),
    ]) : null,
    unassigned.length ? el('div', { style: { marginTop: '12px' } }, [
      el('h3', { text: '자리 없는 학생' }),
      el('p', { class: 'muted', text: '빈 자리를 먼저 누른 뒤 이름을 누르면 그 자리에 앉아요.' }),
      el('div', { class: 'chips' }, unassigned.map((s) => el('button', { type: 'button', class: 'chip', text: s.name, onClick: () => {
        if (!selected || seats[selected]) return toast('먼저 빈 자리를 눌러 주세요.');
        seats[selected] = s.id; selected = null; dirty = true; render();
      } }))),
    ]) : null,
    memoStudents.length || rules.length ? el('div', { style: { marginTop: '12px' } }, [
      el('h3', { text: '미리 적어 둔 내용' }),
      el('ul', { style: { paddingLeft: '18px', margin: '6px 0', fontSize: '14px' } }, [
        ...rules.map((r) => el('li', {}, [el('b', { text: `${nameOf(r.a)} · ${nameOf(r.b)}` }), ` ${RULE_LABEL[r.type]}`, r.note ? el('span', { class: 'muted', text: ` · ${r.note}` }) : null])),
        ...memoStudents.map((s) => el('li', {}, [el('b', { text: s.name }), notes[s.id].front ? ' 👓 앞자리 필요' : '', notes[s.id].memo ? el('span', { class: 'muted', text: ` · ${notes[s.id].memo}` }) : null])),
      ]),
    ]) : null,
  ]);

  setChildren(app, header, el('div', { class: 'grid-2 seat-layout' }, [chart, side]), notesSection());
}

function seatCard(seatId, ev) {
  const sid = seats[seatId];
  const n = sid ? notes[sid] : null;
  const cls = ['seat', sid ? '' : 'empty', selected === seatId ? 'selected' : '', ev.conflictSeats.has(seatId) ? 'conflict' : '', pinned.has(seatId) ? 'pinned' : ''].filter(Boolean).join(' ');
  return el('button', { type: 'button', class: cls, title: n?.memo ? `${nameOf(sid)}: ${n.memo}` : null, onClick: () => onSeatClick(seatId) }, [
    el('span', { class: 'seat-name', text: sid ? nameOf(sid) : '빈 자리' }),
    n && (n.front || n.memo) ? el('span', { class: 'seat-marks', text: `${n.front ? '👓' : ''}${n.memo ? '📝' : ''}` }) : null,
    sid ? el('span', { class: 'pin no-print', text: pinned.has(seatId) ? '📌' : '📍', title: pinned.has(seatId) ? '고정 해제' : '이 자리 고정', onClick: (e) => { e.stopPropagation(); pinned.has(seatId) ? pinned.delete(seatId) : pinned.add(seatId); dirty = true; render(); } }) : null,
  ]);
}

// ---------- 교사 메모 · 지정 규칙 ----------
function notesSection() {
  const students = [...data.students].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  const studentSelect = (placeholder) => el('select', { class: 'select' }, [
    el('option', { value: '', text: placeholder }),
    ...students.map((s) => el('option', { value: s.id, text: s.name })),
  ]);
  const selA = studentSelect('학생 A');
  const selType = el('select', { class: 'select' }, [el('option', { value: 'apart', text: '떨어뜨리기' }), el('option', { value: 'together', text: '가까이 앉히기' })]);
  const selB = studentSelect('학생 B');
  const noteInput = el('input', { type: 'text', placeholder: '이유 메모 (선택, 예: 지난달 다툼)', maxlength: 100, style: { minWidth: '200px' } });
  const addRule = () => {
    if (!selA.value || !selB.value) return toast('두 학생을 골라 주세요.');
    if (selA.value === selB.value) return toast('서로 다른 두 학생을 골라 주세요.');
    const existing = ruleOf(selA.value, selB.value);
    if (existing) rules = rules.filter((r) => r !== existing);
    rules.push({ type: selType.value, a: selA.value, b: selB.value, note: noteInput.value.trim() });
    dirty = true;
    render();
    toast(existing ? '기존 규칙을 바꿨어요.' : '규칙을 추가했어요.');
  };

  const rows = students.map((s) => {
    const n = notes[s.id] || { memo: '', front: false };
    const front = el('input', { type: 'checkbox', checked: n.front ? true : null });
    front.addEventListener('change', () => { notes[s.id] = { ...(notes[s.id] || { memo: '' }), front: front.checked }; dirty = true; render(); });
    const memo = el('input', { type: 'text', value: n.memo || '', placeholder: '예: 시력이 나빠요 / 집중이 어려워요 / 도움 잘 줌', maxlength: 300, style: { width: '100%' } });
    memo.addEventListener('input', () => { notes[s.id] = { ...(notes[s.id] || { front: false }), memo: memo.value }; markDirty(); });
    return el('tr', {}, [
      el('td', { text: s.name, style: { fontWeight: 600, whiteSpace: 'nowrap' } }),
      el('td', { class: 'num' }, [el('label', { style: { cursor: 'pointer' } }, [front, ' 👓'])]),
      el('td', {}, [memo]),
    ]);
  });

  return el('section', { class: 'card no-print', id: 'notes-card' }, [
    el('div', { class: 'card-title' }, [
      el('div', {}, [el('h2', { text: '교사 메모 · 지정 규칙' }), el('div', { class: 'muted', text: '미리 적어 두면 자동 배정에 반영되고, 좌석표에서도 참고할 수 있어요. 학생에게는 보이지 않아요.' })]),
      el('button', { type: 'button', class: 'btn small', text: notesOpen ? '접기' : '펼치기', onClick: () => { notesOpen = !notesOpen; render(); } }),
    ]),
    notesOpen ? pastePanel() : null,
    notesOpen ? el('div', { class: 'grid-2' }, [
      el('div', {}, [
        el('h3', { text: '학생별 메모 · 앞자리 필요(👓)' }),
        el('p', { class: 'muted', text: '👓 를 체크한 학생은 자동 배정에서 앞 두 줄에 앉혀요. 메모는 좌석 위에 마우스를 올리면 보여요.' }),
        el('div', { class: 'table-wrap', style: { maxHeight: '420px', overflowY: 'auto' } }, [el('table', { class: 'table' }, [
          el('thead', {}, [el('tr', {}, [el('th', { text: '이름' }), el('th', { text: '앞자리' }), el('th', { text: '메모' })])]),
          el('tbody', {}, rows),
        ])]),
      ]),
      el('div', {}, [
        el('h3', { text: '두 학생 사이 규칙' }),
        el('p', { class: 'muted', text: '"떨어뜨리기"는 학생 응답보다 훨씬 강하게 적용돼서 자동 배정에서 짝꿍·앞뒤·대각선·통로 건너 자리에 두지 않아요.' }),
        el('div', { class: 'btn-row', style: { marginBottom: '10px' } }, [selA, selType, selB]),
        el('div', { class: 'btn-row', style: { marginBottom: '10px' } }, [noteInput, el('button', { type: 'button', class: 'btn primary', text: '규칙 추가', onClick: addRule })]),
        rules.length ? el('ul', { style: { paddingLeft: '0', listStyle: 'none', margin: 0 } }, rules.map((r) => el('li', { class: 'rule-item' }, [
          el('span', { class: `badge ${r.type === 'apart' ? 'high' : 'green'}`, text: RULE_LABEL[r.type] }),
          el('b', { text: ` ${nameOf(r.a)} · ${nameOf(r.b)}` }),
          r.note ? el('span', { class: 'muted', text: ` · ${r.note}` }) : null,
          el('span', { style: { flex: 1 } }),
          el('button', { type: 'button', class: 'btn small', text: '삭제', onClick: () => { rules = rules.filter((x) => x !== r); dirty = true; render(); } }),
        ]))) : el('p', { class: 'muted', text: '아직 규칙이 없어요.' }),
      ]),
    ]) : null,
  ]);
}

// ---------- 한 번에 붙여넣기 → 자동 분류 ----------
const ITEM_ICON = { front: '👓', memo: '📝', rule: '↔' };
function pastePanel() {
  const ta = el('textarea', {
    rows: 6,
    placeholder: '예시)\n김하늘은 시력이 나빠서 앞자리 필요\n이도윤과 박서연은 자주 싸움\n최지우, 정민준 짝으로 앉히면 좋겠음 (최지우가 잘 도와줌)\n한지민 - 발표를 잘하고 친구를 잘 챙김',
    style: { width: '100%', minHeight: '140px', padding: '10px 12px', border: '1.5px solid var(--gray-300)', borderRadius: '12px', fontSize: '15px' },
  });
  ta.value = pasteText;
  ta.addEventListener('input', () => { pasteText = ta.value; });

  const runParse = () => {
    if (!pasteText.trim()) return toast('먼저 메모를 붙여넣어 주세요.');
    const result = parseTeacherNotes(pasteText, data.students);
    parsed = { items: result.items.map((it) => ({ ...it, checked: true })), unmatched: result.unmatched };
    render();
    if (!parsed.items.length) toast('학생 이름을 찾지 못했어요. 반 명단과 같은 이름으로 적어 주세요.', 4000);
  };
  const applyParsed = () => {
    let n = 0;
    for (const it of parsed.items) {
      if (!it.checked) continue;
      n++;
      if (it.kind === 'front') notes[it.sid] = { ...(notes[it.sid] || { memo: '' }), front: true };
      else if (it.kind === 'memo') {
        const cur = notes[it.sid] || { memo: '', front: false };
        const memo = cur.memo && !cur.memo.includes(it.memo) ? `${cur.memo} / ${it.memo}` : cur.memo || it.memo;
        notes[it.sid] = { ...cur, memo: memo.slice(0, 300) };
      } else if (it.kind === 'rule') {
        rules = rules.filter((r) => !ruleOf(it.a, it.b) || r !== ruleOf(it.a, it.b));
        rules.push({ type: it.type, a: it.a, b: it.b, note: it.source.slice(0, 100) });
      }
    }
    parsed = null;
    pasteText = '';
    dirty = true;
    render();
    toast(`${n}개 항목을 반영했어요. 아래에서 확인하고 저장해 주세요.`);
  };

  const itemLabel = (it) => {
    if (it.kind === 'front') return el('span', {}, [el('b', { text: nameOf(it.sid) }), ' 앞자리 필요']);
    if (it.kind === 'memo') return el('span', {}, [el('b', { text: nameOf(it.sid) }), ` 메모: ${it.memo}`]);
    return el('span', {}, [el('b', { text: `${nameOf(it.a)} · ${nameOf(it.b)}` }), ' ', el('span', { class: `badge ${it.type === 'apart' ? 'high' : 'green'}`, text: RULE_LABEL[it.type] })]);
  };

  return el('div', { class: 'paste-panel' }, [
    el('h3', { text: '한 번에 붙여넣기 → 자동 분류' }),
    el('p', { class: 'muted', text: '메모장이나 수첩에 적어 둔 내용을 통째로 붙여넣으면, 문장마다 학생 이름을 찾아 앞자리 필요 / 떨어뜨리기 / 가까이 앉히기 / 일반 메모로 나눠요. 결과를 확인하고 필요한 것만 체크해서 반영하세요. 이 처리는 이 브라우저 안에서만 이루어져요.' }),
    ta,
    el('div', { class: 'btn-row', style: { marginTop: '8px' } }, [
      el('button', { type: 'button', class: 'btn primary', text: '자동 분류하기', onClick: runParse }),
      pasteText ? el('button', { type: 'button', class: 'btn', text: '지우기', onClick: () => { pasteText = ''; parsed = null; render(); } }) : null,
    ]),
    parsed ? el('div', { class: 'parse-preview' }, [
      el('div', { class: 'card-title' }, [
        el('h3', { text: `분류 결과 ${parsed.items.length}개` }),
        el('div', { class: 'btn-row' }, [
          el('button', { type: 'button', class: 'btn small', text: '모두 선택', onClick: () => { parsed.items.forEach((i) => { i.checked = true; }); render(); } }),
          el('button', { type: 'button', class: 'btn small', text: '모두 해제', onClick: () => { parsed.items.forEach((i) => { i.checked = false; }); render(); } }),
          el('button', { type: 'button', class: 'btn primary small', text: '체크한 항목 반영', disabled: parsed.items.some((i) => i.checked) ? null : true, onClick: applyParsed }),
        ]),
      ]),
      parsed.items.length ? el('ul', { class: 'parse-list' }, parsed.items.map((it) => {
        const cb = el('input', { type: 'checkbox', checked: it.checked ? true : null });
        cb.addEventListener('change', () => { it.checked = cb.checked; });
        return el('li', {}, [el('label', {}, [cb, el('span', { class: 'parse-icon', text: ITEM_ICON[it.kind] }), itemLabel(it), el('div', { class: 'muted parse-source', text: `“${it.source}”` })])]);
      })) : el('p', { class: 'muted', text: '분류된 항목이 없어요.' }),
      parsed.unmatched.length ? el('div', { style: { marginTop: '8px' } }, [
        el('div', { class: 'muted', style: { fontWeight: 600 }, text: `학생 이름을 찾지 못한 문장 ${parsed.unmatched.length}개 (필요하면 아래에서 직접 추가하세요)` }),
        el('ul', { class: 'muted', style: { margin: '4px 0 0', paddingLeft: '18px', fontSize: '13px' } }, parsed.unmatched.map((t) => el('li', { text: t }))),
      ]) : null,
    ]) : null,
  ]);
}

// 메모 입력 중에는 전체를 다시 그리지 않고 저장 버튼만 갱신
function markDirty() {
  if (dirty) return;
  dirty = true;
  const btn = [...document.querySelectorAll('.btn')].find((b) => b.textContent === '저장됨');
  if (btn) { btn.textContent = '저장하기 *'; btn.classList.add('orange'); }
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
    const cleanNotes = {};
    for (const [sid, n] of Object.entries(notes)) if (n.front || (n.memo || '').trim()) cleanNotes[sid] = { memo: (n.memo || '').trim(), front: Boolean(n.front) };
    await api(`${base}/notes`, { method: 'PUT', body: { notes: cleanNotes, rules } });
    data = await api(`${base}/seating`, { method: 'PUT', body: { layout, seats, pinned: [...pinned], options } });
    dirty = false;
    render();
    toast('자리 배정과 메모를 저장했어요.');
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
    notes = { ...(data.teacherNotes?.students || {}) };
    rules = [...(data.teacherNotes?.rules || [])];
    document.title = `${data.room.name} 자리 배정`;
    render();
  } catch (err) {
    setChildren(app, el('section', { class: 'card' }, [el('h1', { text: '교실을 열 수 없어요' }), el('p', { text: err.message })]));
  }
})();
