import { api, el, toast, setChildren, setupPageNav, fmtDate, TYPE_ICON } from './common.js';
import { parseTeacherNotes } from './notes-parser.js';

const adminToken = decodeURIComponent(location.pathname.split('/')[2] || '');
const base = `/api/teacher/${encodeURIComponent(adminToken)}`;
const roundParam = new URLSearchParams(location.search).get('round');
const dataUrl = roundParam ? `${base}?round=${encodeURIComponent(roundParam)}` : base;
const app = document.getElementById('app');
setupPageNav(adminToken, roundParam);

// ---------- 상태 ----------
let data = null;                 // 교사 API 응답
let layout = { blocks: [{ cols: 2, rows: 4 }, { cols: 2, rows: 5 }, { cols: 2, rows: 4 }] };
let seats = {};                  // seatId -> studentId
let pinned = new Set();
let options = { friends: 'any' };
let zones = {};                  // seatId -> 'ac' (냉난방기 바람이 닿는 자리)
let climate = 'off';             // 'cool' 냉방 중 | 'warm' 난방 중 | 'off'
let zoneMode = false;            // 켜면 자리를 눌러 바람 자리를 표시/해제
let bodies = {};                 // studentId -> 학생이 고른 몸 특징 { sight, height, cold, heat }
let notes = {};                  // studentId -> { memo, front }
let rules = [];                  // [{ type: 'apart'|'together', a, b, note }]
let selected = null;             // 선택된 seatId
let dirty = false;
let layoutText = '2x4, 2x5, 2x4';
let notesOpen = true;
let pasteText = '';
let parsed = null;              // { items: [{...item, checked}], unmatched }
let staleNotice = false;        // 저장 뒤에 학생 응답이 바뀌었는지
let roleSeats = {};              // seatId -> roleId (1인 1역 담당 학생이 앉는 "역할 자리")
let roleMode = false;            // 켜면 자리를 눌러 역할 자리를 지정/해제
let roleModeRole = '';           // 역할 자리 지정 모드에서 고른 역할 id
let aiSeating = null;            // 서버에 저장된 마지막 AI 자리 배정 결과 (teacherView.aiSeating)
let aiBusy = false;              // AI 자리 배정 요청 중

// 자리표 보는 방향 (화면·인쇄 전용, 좌석 id와 배정 데이터는 그대로)
//  - student: 학생 시점, 칠판(교탁)이 위
//  - teacher: 교탁에서 학생들을 바라본 모습 = 180도 회전 (분단·열·줄 모두 뒤집고 교탁은 아래)
//  - flipV:   줄만 뒤집어 교탁을 아래에 (분단·열 순서는 그대로)
const SEAT_VIEWS = {
  student: { label: '학생 시점 · 칠판이 위', printLabel: '', flipRows: false, flipCols: false },
  teacher: { label: '교사 시점 · 교탁에서 본 모습 (위아래·좌우 뒤집음)', printLabel: '교사 시점(교탁에서 본 모습)', flipRows: true, flipCols: true },
  flipV: { label: '위아래만 뒤집기 (교탁이 아래)', printLabel: '위아래만 뒤집음', flipRows: true, flipCols: false },
};
const SEAT_VIEW_KEY = `relmap.seatView.${adminToken}`;
function loadSeatView() {
  try { const v = localStorage.getItem(SEAT_VIEW_KEY); return SEAT_VIEWS[v] ? v : 'student'; } catch { return 'student'; }
}
function saveSeatView(v) {
  try { localStorage.setItem(SEAT_VIEW_KEY, v); } catch { /* 저장 못 해도 보는 데는 지장 없음 */ }
}
let seatView = loadSeatView();   // 'student' | 'teacher' | 'flipV'

const nameOf = (id) => data.stats[id]?.name || '?';
const RULE_LABEL = { apart: '떨어뜨리기', together: '가까이 앉히기' };
const FRONT_ROWS = 2;            // 앞자리로 인정하는 줄 수
const AI_WARN = 40;              // 학생이 표시하지 않은 쌍이라도 AI 예측 갈등 가능성이 이 값 이상이면 떨어뜨려요
const AI_CONFIRM = 'AI 자리 배정은 30초~1분 걸리고 API 사용량(비용)이 들어요. 지금 화면의 배치·고정·바람 자리·역할 자리와 교사 메모·규칙을 기준으로 배정안을 받아요 (메모·규칙은 먼저 저장돼요). 계속할까요?';

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
let aiProb = {};    // 'a|b' (정렬) -> AI 자리 배정이 예측한 갈등 가능성 { a, b, probability, reason }
let isolated = new Set();
const pairKey = (a, b) => [a, b].sort().join('|');
function buildRelations() {
  relType = {};
  for (const r of data.relations) (relType[r.from] ||= {})[r.to] = r.type;
  prob = {};
  for (const p of data.analysis.pairs) prob[pairKey(p.a, p.b)] = p;
  isolated = new Set(Object.values(data.analysis.studentRisk).filter((s) => s.flags.includes('isolated')).map((s) => s.id));
  bodies = Object.fromEntries(data.students.map((s) => [s.id, s.body || {}]));
  // AI 자리 배정 결과(서버 저장분)와 그 안의 갈등 예측. 없는 학생이 섞여 있으면 뺀다
  aiSeating = data.aiSeating || null;
  aiProb = {};
  const known = new Set(data.students.map((s) => s.id));
  for (const p of aiSeating?.pairs || []) if (known.has(p.a) && known.has(p.b) && p.a !== p.b) aiProb[pairKey(p.a, p.b)] = p;
}
const rel = (a, b) => relType[a]?.[b] || 'none';
const ruleOf = (a, b) => rules.find((r) => pairKey(r.a, r.b) === pairKey(a, b)) || null;
const needsFront = (sid) => Boolean(notes[sid]?.front);
const bodyOf = (sid) => bodies[sid] || {};
const blockRowsOf = (seatId) => layout.blocks[Number(seatId.slice(1).split('-')[0])]?.rows || 1;
/** 바람 자리가 지금 어떻게 느껴지는지: 냉방 중이면 '시원함', 난방 중이면 '따뜻함', 꺼져 있으면 null */
const zoneFeel = (seatId) => (zones[seatId] === 'ac' && climate !== 'off' ? (climate === 'cool' ? 'cool' : 'warm') : null);
const CLIMATE_LABEL = { cool: '냉방 중 · 바람 자리가 시원해요', warm: '난방 중 · 바람 자리가 따뜻해요', off: '냉난방기 꺼짐 · 바람 자리 영향 없음' };
/** 학생이 고른 몸 특징의 짧은 표시 (예: ['👓 눈 나쁨', '❄️ 추위 잘 탐']) */
function bodyLabels(sid) {
  const body = bodyOf(sid);
  const out = [];
  for (const t of data.bodyTraits || []) {
    const opt = t.options.find((o) => o.id === body[t.id]);
    if (opt?.short) out.push(`${opt.icon ? `${opt.icon} ` : ''}${opt.short}`);
  }
  return out;
}

// ---------- 1인 1역 역할 자리 ----------
const roleList = () => (Array.isArray(data.roles) ? data.roles : []);
const roleOf = (roleId) => roleList().find((r) => r.id === roleId) || null;
const roleNameOf = (roleId) => roleOf(roleId)?.name || '(없는 역할)';
/** 지금 저장된 1인 1역 배정(초안이든 공개든)에서 그 역할을 맡은 학생 id 들 */
function roleHolders(roleId) {
  const known = new Set(data.students.map((s) => s.id));
  return (data.roleAssignment?.assignments?.[roleId] || []).filter((sid) => known.has(sid));
}
const holderNames = (roleId) => { const h = roleHolders(roleId); return h.length ? h.map(nameOf).join(', ') : '아직 없음'; };
/** 좌석 id 를 사람이 읽는 말로: b0-r1-c0 → "1분단 2번째 줄 1번째 자리" */
function seatLabel(seatId) {
  const [b, r, c] = seatId.split('-').map((p) => Number(p.slice(1)));
  return `${b + 1}분단 ${r + 1}번째 줄 ${c + 1}번째 자리`;
}
/** 자동 배정에서 움직이지 않는 자리: 📌 고정 자리 + 🎒 역할 자리(그 역할 담당 학생이 있을 때). seatId -> studentId */
function fixedSeats() {
  const valid = new Set(seatList().map((s) => s.id));
  const fixed = {};
  const taken = new Set();
  for (const id of pinned) if (valid.has(id) && seats[id]) { fixed[id] = seats[id]; taken.add(seats[id]); }
  const roleSeatIds = Object.keys(roleSeats).filter((seatId) => valid.has(seatId) && !fixed[seatId]);
  // 1) 이미 자기 역할 자리에 앉아 있는 담당은 그대로 (역할 자리 순서와 상관없이 먼저 지켜요)
  for (const seatId of roleSeatIds) {
    const sid = seats[seatId];
    if (sid && !taken.has(sid) && roleHolders(roleSeats[seatId]).includes(sid)) { fixed[seatId] = sid; taken.add(sid); }
  }
  // 2) 남은 역할 자리에는 아직 자리가 정해지지 않은 담당을 차례로. 담당이 없으면(또는 모두 앉았으면) 보통 자리처럼 씀
  for (const seatId of roleSeatIds) {
    if (fixed[seatId]) continue;
    const sid = roleHolders(roleSeats[seatId]).find((h) => !taken.has(h));
    if (sid) { fixed[seatId] = sid; taken.add(sid); }
  }
  return fixed;
}

function pairCost(a, b) {
  if (!a || !b) return 0;
  let cost = 0;
  // 교사 지정 규칙이 가장 강함
  const rule = ruleOf(a, b);
  if (rule?.type === 'apart') cost += 400;
  if (rule?.type === 'together') cost -= 60;
  const ab = rel(a, b);
  const ba = rel(b, a);
  const key = pairKey(a, b);
  const aiP = aiProb[key]?.probability;
  // 안 좋은 사이: AI 가 예측한 갈등 가능성이 있으면 그걸, 없으면 규칙 기반 분석값을 써요
  if (ab === 'bad' || ba === 'bad') cost += aiP ?? prob[key]?.probability ?? 50;
  // 학생은 안 좋은 사이로 표시하지 않았지만 AI 가 갈등이 생길 수 있다고 본 쌍도 조금 떨어뜨려요
  else if (aiP >= AI_WARN) cost += aiP * 0.6;
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
    if (needsFront(sid)) sum += row < FRONT_ROWS ? row * 8 : 60 + row * 30;   // 앞자리 필요 학생 (교사 지정)
    // 학생이 고른 몸 특징: 눈이 나쁘면 앞줄, 키가 작으면 앞쪽·크면 뒤쪽을 조금 선호
    const body = bodyOf(sid);
    if (body.sight === 'poor') sum += row < FRONT_ROWS ? row * 4 : 30 + row * 12;
    if (body.height === 'short') sum += row * 3;
    if (body.height === 'tall') sum += (blockRowsOf(seatId) - 1 - row) * 3;
    // 냉난방기 바람 자리: 추위를 잘 타면 냉방 바람을, 더위를 잘 타면 난방 바람을 피하고 반대쪽은 조금 선호
    const feel = zoneFeel(seatId);
    if (feel === 'cool') { if (body.cold === 'yes') sum += 45; if (body.heat === 'yes') sum -= 12; }
    if (feel === 'warm') { if (body.heat === 'yes') sum += 45; if (body.cold === 'yes') sum -= 12; }
  }
  return sum;
}

// ---------- 자동 배정 (담금질 기법) ----------
function autoAssign(message = '자동으로 배정했어요. 마음에 안 들면 "다른 배치"를 눌러 보세요.') {
  const all = seatList().map((s) => s.id);
  // 📌 고정 자리와 🎒 역할 자리(담당 학생)는 먼저 앉히고 나머지 자리만 섞어요
  const fixed = fixedSeats();
  const free = all.filter((id) => !(id in fixed));
  const fixedStudents = new Set(Object.values(fixed));
  const students = data.students.map((s) => s.id).filter((id) => !fixedStudents.has(id));
  if (students.length > free.length) toast(`자리가 ${students.length - free.length}개 부족해요. 배치를 늘려 주세요.`, 4000);

  const pairs = neighborPairs();
  let best = null;
  let bestCost = Infinity;
  for (let restart = 0; restart < 6; restart++) {
    const assign = { ...fixed };
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
  staleNotice = false;
  render();
  toast(message);
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
    const ai = aiProb[pairKey(a, b)] || null;      // AI 자리 배정이 예측한 갈등 가능성 (있으면)
    if (rule?.type === 'apart') {
      warnings.push({ a, b, label, p: 100, teacher: true, note: rule.note, ab, ba });
      conflictSeats.add(x); conflictSeats.add(y);
    } else if (ab === 'bad' || ba === 'bad') {
      warnings.push({ a, b, label, p: prob[pairKey(a, b)]?.probability ?? null, aiP: ai?.probability ?? null, aiReason: ai?.reason || '', ab, ba });
      conflictSeats.add(x); conflictSeats.add(y);
    } else if (ai && ai.probability >= AI_WARN) {
      // 학생은 안 좋은 사이로 표시하지 않았지만 AI 가 갈등이 생길 수 있다고 본 쌍
      warnings.push({ a, b, label, p: null, aiP: ai.probability, aiReason: ai.reason || '', aiOnly: true, ab, ba });
      conflictSeats.add(x); conflictSeats.add(y);
    } else if (ab === 'good' && ba === 'good' && label === '짝꿍') goodPairs++;
  }
  const severity = (w) => Math.max(w.p || 0, w.aiP || 0);
  warnings.sort((p, q) => severity(q) - severity(p));

  // 🎒 역할 자리: 담당이 아닌 학생이 앉았거나, 역할 자리가 비어 있는데 담당 학생이 다른 자리에 앉은 경우.
  // 담당보다 역할 자리가 많으면 남는 역할 자리는 보통 자리라서(자동 배정·서버 보정과 같은 기준) 경고하지 않아요
  const byRole = {};
  for (const [seatId, roleId] of Object.entries(roleSeats)) (byRole[roleId] ||= []).push(seatId);
  for (const [roleId, seatIds] of Object.entries(byRole)) {
    const holders = roleHolders(roleId);
    if (!holders.length) continue;                          // 담당이 없으면 보통 자리
    const name = roleNameOf(roleId);
    const isHolderSeat = (seatId) => Boolean(seats[seatId]) && holders.includes(seats[seatId]);
    const seatedHolders = seatIds.filter(isHolderSeat).length;   // 자기 역할 자리에 앉은 담당 수
    // 담당이 앉지 않은 역할 자리 가운데 '아직 역할 자리에 앉지 못한 담당 수'만큼만 담당 몫이에요. 빈자리를 먼저 담당 몫으로 쳐요
    const open = seatIds.filter((seatId) => !isHolderSeat(seatId)).sort((x, y) => Number(Boolean(seats[x])) - Number(Boolean(seats[y])));
    let unmet = Math.min(holders.length - seatedHolders, open.length);   // 담당이 들어가야 할 역할 자리 수
    if (unmet <= 0) continue;
    for (const seatId of open.slice(0, unmet)) {
      const sid = seats[seatId];
      if (sid) { infos.push(`${seatLabel(seatId)}: ${name} 자리인데 담당이 아닌 ${nameOf(sid)}이(가) 앉아 있어요.`); conflictSeats.add(seatId); }
    }
    for (const sid of holders) {
      if (unmet <= 0) break;
      const seatId = seatOf[sid];
      if (!seatId || seatIds.includes(seatId)) continue;
      unmet--;
      infos.push(`${nameOf(sid)}: ${name} 담당인데 역할 자리가 아닌 ${seatLabel(seatId)}에 앉아 있어요.`);
      conflictSeats.add(seatId);
    }
  }

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
  // 학생이 고른 몸 특징과 맞지 않는 자리
  for (const [sid, seatId] of Object.entries(seatOf)) {
    const body = bodyOf(sid);
    if (body.sight === 'poor' && !notes[sid]?.front && rowOf(seatId) >= FRONT_ROWS) { infos.push(`${nameOf(sid)}: 눈이 나쁜 편이라고 했는데 ${rowOf(seatId) + 1}번째 줄이에요.`); conflictSeats.add(seatId); }
    const feel = zoneFeel(seatId);
    if (feel === 'cool' && body.cold === 'yes') { infos.push(`${nameOf(sid)}: 추위를 잘 타는데 냉방 바람 자리예요.`); conflictSeats.add(seatId); }
    if (feel === 'warm' && body.heat === 'yes') { infos.push(`${nameOf(sid)}: 더위를 잘 타는데 난방 바람 자리예요.`); conflictSeats.add(seatId); }
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
  // 자리 환경: 냉난방기 바람 자리 표시 모드 + 지금 냉방/난방 중인지
  const zoneCount = Object.values(zones).filter((z) => z === 'ac').length;
  const climateSelect = el('select', { class: 'select', id: 'climate-select', title: '냉난방기 상태', 'aria-label': '냉난방기 상태' },
    Object.entries(CLIMATE_LABEL).map(([value, label]) => el('option', { value, text: `🌀 ${label}`, selected: climate === value ? true : null })));
  climateSelect.addEventListener('change', () => { climate = climateSelect.value; dirty = true; render(); });
  const zoneBtn = el('button', { type: 'button', class: `btn ${zoneMode ? 'primary' : ''}`, id: 'zone-mode', 'aria-pressed': zoneMode ? 'true' : 'false',
    text: zoneMode ? '✓ 바람 자리 표시 끝내기' : `🌀 바람 자리 표시${zoneCount ? ` (${zoneCount}개)` : ''}`,
    onClick: () => { zoneMode = !zoneMode; roleMode = false; selected = null; render(); if (zoneMode) toast('냉난방기 바람이 닿는 자리를 눌러 표시하거나 해제하세요. 끝나면 버튼을 다시 눌러요.', 4000); } });
  // 🎒 역할 자리 지정: 1인 1역 역할 목록이 있을 때만. 역할을 고르고 자리를 누르면 그 역할 담당 학생의 자리가 돼요
  const roles = roleList();
  if (roles.length && !roles.some((r) => r.id === roleModeRole)) roleModeRole = roles[0].id;
  const roleSeatCount = Object.keys(roleSeats).length;
  const roleRow = roles.length ? [
    el('button', { type: 'button', class: `btn ${roleMode ? 'primary' : ''}`, id: 'role-seat-mode', 'aria-pressed': roleMode ? 'true' : 'false',
      text: roleMode ? '✓ 역할 자리 지정 끝내기' : `🎒 역할 자리 지정${roleSeatCount ? ` (${roleSeatCount}개)` : ''}`,
      onClick: () => { roleMode = !roleMode; zoneMode = false; selected = null; render(); if (roleMode) toast('역할을 고른 뒤 자리를 누르면 그 역할 담당 학생이 앉는 자리가 돼요. 같은 역할 자리를 다시 누르면 해제돼요.', 4000); } }),
    (() => {
      const sel = el('select', { class: 'select', id: 'role-seat-role', title: '역할 자리로 지정할 역할', 'aria-label': '역할 자리로 지정할 역할' },
        roles.map((r) => el('option', { value: r.id, text: `${r.name} (담당: ${holderNames(r.id)})`, selected: roleModeRole === r.id ? true : null })));
      sel.addEventListener('change', () => { roleModeRole = sel.value; });
      return sel;
    })(),
  ] : [el('span', { class: 'muted', id: 'role-seat-hint', style: { alignSelf: 'center', fontSize: '14px' }, text: '🎒 1인 1역 역할 목록을 만들면 역할 자리를 지정할 수 있어요.' })];
  // 🤖 AI 자리 배정: 서버에 API 키가 있을 때만
  const aiEnabled = Boolean(data.ai?.enabled);
  const aiBtn = el('button', { type: 'button', class: 'btn', id: 'ai-seat-btn', disabled: aiEnabled && !aiBusy ? null : true,
    text: aiBusy ? 'AI가 배정 중…' : '🤖 AI 자리 배정',
    title: aiEnabled ? 'Claude 가 관계·메모·몸 특징·역할을 종합해 배정안을 만들어요 (30초~1분, API 비용)' : 'AI 자리 배정을 쓰려면 서버에 ANTHROPIC_API_KEY 를 설정해 주세요.',
    onClick: aiAssign });
  // 보는 방향: 저장 데이터와 무관한 표시 설정이라 dirty 로 만들지 않고 브라우저에만 기억해요
  const viewSelect = el('select', { class: 'select seat-view-select', title: '자리표 보는 방향', 'aria-label': '자리표 보는 방향' },
    Object.entries(SEAT_VIEWS).map(([value, v]) => el('option', { value, text: v.label, selected: seatView === value ? true : null })));
  viewSelect.addEventListener('change', () => { seatView = SEAT_VIEWS[viewSelect.value] ? viewSelect.value : 'student'; saveSeatView(seatView); render(); });

  const header = el('section', { class: 'card no-print' }, [
    el('div', { class: 'card-title' }, [
      el('div', {}, [el('h1', { text: `${data.room.name} 자리 배정` }), el('div', { class: 'muted', text: `${data.round.name} 응답 기준 (제출 ${data.analysis.submittedCount}/${data.students.length}명) · 자리 ${seatCount}개 · 교사 지정 규칙 ${rules.length}개` })]),
      el('div', { class: 'btn-row' }, [
        el('button', { type: 'button', class: 'btn primary', text: '자동 배정', onClick: () => autoAssign() }),
        el('button', { type: 'button', class: 'btn', text: '다른 배치', onClick: () => autoAssign() }),
        aiBtn,
        el('button', { type: 'button', class: 'btn', text: '모두 비우기', onClick: () => { if (!confirm('고정한 자리를 포함해 모두 비울까요?')) return; seats = {}; pinned = new Set(); dirty = true; render(); } }),
        el('button', { type: 'button', class: `btn ${dirty ? 'orange' : ''}`, text: dirty ? '저장하기 *' : '저장됨', onClick: save }),
        viewSelect,
        el('button', { type: 'button', class: 'btn', text: '인쇄', onClick: () => window.print() }),
      ]),
    ]),
    el('div', { class: 'btn-row', style: { marginTop: '6px' } }, [
      el('form', { class: 'inline-form', onSubmit: (e) => {
        e.preventDefault();
        try { layout = parseLayout(layoutInput.value); layoutText = layoutInput.value; } catch (err) { return toast(err.message, 4000); }
        const valid = new Set(seatList().map((s) => s.id));
        for (const id of Object.keys(seats)) if (!valid.has(id)) delete seats[id];
        for (const id of Object.keys(zones)) if (!valid.has(id)) delete zones[id];
        for (const id of Object.keys(roleSeats)) if (!valid.has(id)) delete roleSeats[id];
        pinned = new Set([...pinned].filter((id) => valid.has(id)));
        dirty = true; render();
      } }, [el('label', { text: '교실 배치', style: { fontWeight: 600, alignSelf: 'center' } }), layoutInput, el('button', { type: 'submit', class: 'btn', text: '적용' })]),
      friendsSelect,
    ]),
    el('div', { class: 'btn-row', style: { marginTop: '6px' } }, [zoneBtn, climateSelect]),
    el('div', { class: 'btn-row', style: { marginTop: '6px' } }, roleRow),
    el('p', { class: 'muted', style: { marginTop: '8px', marginBottom: 0 }, text: '배치는 "가로x세로" 블록을 쉼표로 나눠 적어요. 예: 2x4, 2x5, 2x4 는 2명씩 앉는 분단 세 개예요. 자리를 누른 뒤 다른 자리를 누르면 서로 바뀌고, 📍 을 누르면 자동 배정에서 그 자리를 고정해요. 👓 앞자리 필요(교사 지정 또는 눈이 나쁜 편), 📝 메모 있음, ❄️ 추위 잘 탐, 🔥 더위 잘 탐, 📏 키 큼, 🌱 키 작음.' }),
    el('p', { class: 'muted', style: { marginTop: '4px', marginBottom: 0 }, text: '🌀 바람 자리: 시스템 에어컨·히터 바람이 바로 닿는 자리를 표시해 두면, 냉방 중에는 추위를 잘 타는 학생을, 난방 중에는 더위를 잘 타는 학생을 자동 배정에서 그 자리에 앉히지 않아요. 학생이 "나는 이런 편이에요"에서 고른 몸 특징(눈·키·추위·더위)도 함께 참고해요.' }),
    el('p', { class: 'muted', style: { marginTop: '4px', marginBottom: 0 }, text: '🎒 역할 자리: 1인 1역에서 특정 역할(예: 칠판 지킴이)을 맡은 학생이 앉을 자리를 미리 정해 두면, 자동 배정과 AI 배정이 이번 회차 담당 학생을 그 자리에 앉혀요. 담당이 아직 없으면 보통 자리처럼 써요. 🤖 AI 자리 배정은 Claude 가 학생 관계·메모·몸 특징·성향 설문·1인 1역까지 종합해 배정안과 갈등 예측을 만들어 주는 기능으로, 실명 대신 가명을 보내고 30초~1분 정도 걸리며 API 비용이 들어요. 결과는 화면에서 확인한 뒤 저장해야 반영돼요.' }),
    el('p', { class: 'muted seat-view-hint', style: { marginTop: '4px', marginBottom: 0 }, text: '자리표는 "인쇄" 옆에서 보는 방향을 고를 수 있어요. 교사 시점은 교탁에서 학생들을 바라본 모습이라 위아래와 좌우가 모두 뒤집혀요. 방향은 화면과 인쇄에만 적용되고 배정 자체는 바뀌지 않아요.' }),
    staleNotice ? el('div', { class: 'alert warn', style: { marginTop: '12px', marginBottom: 0, display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } }, [
      el('span', { style: { flex: 1 }, text: '자리를 저장한 뒤에 학생 응답이 새로 들어왔어요. 아래 경고 목록은 최신 응답 기준이에요. 고정한 자리는 그대로 두고 다시 배정할 수 있어요.' }),
      el('button', { type: 'button', class: 'btn small primary', text: '최신 응답으로 다시 배정', onClick: () => autoAssign('최신 응답을 반영해 다시 배정했어요. 확인 후 저장해 주세요.') }),
      el('button', { type: 'button', class: 'btn small', text: '그대로 두기', onClick: () => { staleNotice = false; render(); } }),
    ]) : null,
  ]);

  // 좌석표 — 보는 방향에 따라 DOM 에 넣는 순서만 바꿔요 (CSS 로 뒤집으면 글자까지 거울상이 되니까)
  const view = SEAT_VIEWS[seatView] || SEAT_VIEWS.student;
  const order = (n, reversed) => { const idx = Array.from({ length: n }, (_, i) => i); return reversed ? idx.reverse() : idx; };
  const blocksEl = el('div', { class: 'seat-blocks' }, order(layout.blocks.length, view.flipCols).map((bi) => {
    const b = layout.blocks[bi];
    const grid = el('div', { class: 'seat-block', style: { gridTemplateColumns: `repeat(${b.cols}, 1fr)` } });
    for (const r of order(b.rows, view.flipRows)) for (const c of order(b.cols, view.flipCols)) grid.append(seatCard(`b${bi}-r${r}-c${c}`, ev));
    return grid;
  }));
  // 교탁: 학생 시점은 위, 줄을 뒤집은 시점(교사 시점·위아래만 뒤집기)은 아래
  const podium = el('div', { class: `podium${view.flipRows ? ' below' : ''}`, text: '교탁' });
  const chart = el('section', { class: `card seat-chart${zoneMode ? ' zone-mode' : ''}${roleMode ? ' role-mode' : ''}`, dataset: { view: seatView } }, [
    el('div', { class: 'print-only', style: { fontWeight: 700, fontSize: '18px', marginBottom: '8px' } }, [
      `${data.room.name} 자리표`,
      view.printLabel ? el('span', { class: 'print-view-label', text: ` · ${view.printLabel}` }) : null,
    ]),
    view.flipRows ? null : podium,
    blocksEl,
    view.flipRows ? podium : null,
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
          : w.p !== null || w.aiP !== null ? el('span', { class: `badge ${badgeLevel(Math.max(w.p || 0, w.aiP || 0))}`, title: w.aiReason || null,
            text: w.aiOnly ? `AI 예측 ${w.aiP}%` : [w.p !== null ? `갈등 ${w.p}%` : '', w.aiP !== null && w.aiP !== undefined ? `AI ${w.aiP}%` : ''].filter(Boolean).join(' · ') }) : null,
        !w.teacher && !w.aiOnly ? el('span', { class: 'muted', text: ` ${w.ab === 'bad' ? `${nameOf(w.a)} ${TYPE_ICON.bad}→ ${nameOf(w.b)}` : ''} ${w.ba === 'bad' ? `${nameOf(w.b)} ${TYPE_ICON.bad}→ ${nameOf(w.a)}` : ''}` }) : null,
        w.aiOnly ? el('span', { class: 'muted', text: ` 학생이 표시한 사이는 아니지만 AI 가 갈등 가능성을 봤어요${w.aiReason ? ` · ${w.aiReason}` : ''}` }) : null,
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
    aiSeatingPanel(),
  ]);

  setChildren(app, header, el('div', { class: 'grid-2 seat-layout' }, [chart, side]), notesSection());
}

const badgeLevel = (p) => (p >= 70 ? 'high' : p >= 40 ? 'medium' : 'low');

// ---------- 🤖 AI 자리 배정 ----------
/** 측면 카드의 "AI 자리 배정 메모": 만든 시각·회차·모델, 메모, 예측 갈등 상위 10쌍, 학생별 설명, 다시 적용 버튼 */
function aiSeatingPanel() {
  const a = aiSeating;
  if (!a) return null;
  const known = new Set(data.students.map((s) => s.id));
  const otherRound = a.roundId && a.roundId !== data.round.id;
  const pairs = (a.pairs || []).filter((p) => known.has(p.a) && known.has(p.b)).sort((p, q) => (q.probability || 0) - (p.probability || 0)).slice(0, 10);
  const explanations = Object.entries(a.explanations || {}).filter(([sid, text]) => known.has(sid) && text);
  const when = fmtDate(a.createdAt) || (a.createdAt ? new Date(a.createdAt).toLocaleString() : '');
  return el('div', { id: 'ai-seating-panel', style: { marginTop: '12px' } }, [
    el('h3', { text: '🤖 AI 자리 배정 메모' }),
    el('div', { class: 'muted', style: { fontSize: '13px' }, text: [when, otherRound ? `${a.roundName || '다른'} 회차 기준` : (a.roundName || data.round.name) + ' 회차', a.model ? `모델 ${a.model}` : ''].filter(Boolean).join(' · ') }),
    otherRound ? el('div', { class: 'alert warn', style: { marginTop: '6px', fontSize: '13px' }, text: `이 배정안은 ${a.roundName || '다른'} 회차 응답으로 만든 거예요. 지금 보는 ${data.round.name} 회차와 다를 수 있어요.` }) : null,
    a.truncated ? el('div', { class: 'muted', id: 'ai-seat-truncated', style: { marginTop: '4px', fontSize: '13px' }, text: '⚠️ 자료가 길어 AI에 보낸 내용 일부가 생략됐어요.' }) : null,
    (a.warnings || []).length ? el('ul', { class: 'muted', style: { paddingLeft: '18px', margin: '6px 0', fontSize: '13px' } }, a.warnings.map((w) => el('li', { text: `⚠️ ${w}` }))) : null,
    a.notes ? el('p', { id: 'ai-seat-notes', style: { margin: '6px 0', fontSize: '14px' }, text: a.notes }) : null,
    pairs.length ? el('div', { style: { marginTop: '6px' } }, [
      el('div', { style: { fontWeight: 600, fontSize: '14px' }, text: `AI 예측 갈등 가능성 (상위 ${pairs.length}쌍)` }),
      el('ul', { id: 'ai-seat-pairs', style: { paddingLeft: '18px', margin: '4px 0', fontSize: '13.5px' } }, pairs.map((p) => el('li', {}, [
        el('b', { text: `${nameOf(p.a)} ↔ ${nameOf(p.b)}` }), ' ',
        el('span', { class: `badge ${badgeLevel(p.probability || 0)}`, text: `${p.probability}%` }),
        p.reason ? el('span', { class: 'muted', text: ` · ${p.reason}` }) : null,
      ]))),
    ]) : null,
    explanations.length ? el('details', { style: { marginTop: '6px', fontSize: '13.5px' } }, [
      el('summary', { style: { cursor: 'pointer', fontWeight: 600 }, text: `학생별 자리 설명 (${explanations.length}명)` }),
      el('ul', { style: { paddingLeft: '18px', margin: '4px 0' } }, explanations.map(([sid, text]) => el('li', {}, [el('b', { text: nameOf(sid) }), el('span', { class: 'muted', text: ` · ${text}` })]))),
    ]) : null,
    el('div', { class: 'btn-row', style: { marginTop: '8px' } }, [
      el('button', { type: 'button', class: 'btn small', id: 'ai-seat-reapply', text: 'AI 배정안 다시 적용', onClick: () => toast(aiApplyMessage('AI 배정안을 다시 적용했어요.', applyAiSeating()), 6000) }),
    ]),
  ]);
}

/**
 * aiSeating.assignment 을 지금 배치에 맞게 좌석표에 넣어요 (없는 좌석·없는 학생·중복은 건너뜀).
 * 배정안에 자리가 없는 학생(배치가 달라졌거나 그 뒤에 들어온 학생)은 빈자리에 앞줄부터 앉혀요.
 * → { moved: 그렇게 앉힌 학생 수, short: 자리가 모자라 못 앉은 학생 수 }
 */
function applyAiSeating() {
  if (!aiSeating?.assignment) return { moved: 0, short: 0 };
  const list = seatList();
  const valid = new Set(list.map((s) => s.id));
  const known = new Set(data.students.map((s) => s.id));
  const used = new Set();
  seats = {};
  for (const [seatId, sid] of Object.entries(aiSeating.assignment)) {
    if (!valid.has(seatId) || !known.has(sid) || used.has(sid)) continue;
    seats[seatId] = sid;
    used.add(sid);
  }
  const empty = list.filter((s) => !seats[s.id]).sort((x, y) => x.r - y.r || x.b - y.b || x.c - y.c).map((s) => s.id);
  let moved = 0;
  let short = 0;
  for (const s of data.students) {
    if (used.has(s.id)) continue;
    const seatId = empty.shift();
    if (!seatId) { short++; continue; }
    seats[seatId] = s.id;
    used.add(s.id);
    moved++;
  }
  dirty = true;
  selected = null;
  staleNotice = false;
  render();
  return { moved, short };
}

/** AI 배정안을 적용한 뒤 보여 줄 안내: 배정안과 다르게 앉힌 학생이 있으면 알려 줘요 */
function aiApplyMessage(prefix, { moved = 0, short = 0 } = {}) {
  const bits = [prefix];
  if (moved) bits.push(`배치나 명단이 달라 ${moved}명은 배정안과 다른 자리(앞줄 빈자리부터)에 앉혔어요.`);
  if (short) bits.push(`${short}명은 자리가 모자라 앉히지 못했어요. 배치를 늘리거나 자동 배정을 눌러 주세요.`);
  bits.push('확인 후 저장해 주세요.');
  return bits.join(' ');
}

/**
 * 🤖 AI 자리 배정 요청: 화면의 교사 메모·규칙을 먼저 저장하고(서버가 저장본을 읽어요), 지금 화면의 배치·고정·바람 자리·역할 자리를 보내
 * 받은 배정안을 좌석표에 적용해요 (자리 저장은 선생님이)
 */
async function aiAssign() {
  if (aiBusy) return;
  if (!data.ai?.enabled) return toast('AI 자리 배정을 쓰려면 서버에 ANTHROPIC_API_KEY 를 설정해 주세요.', 4000);
  if (!data.students.length) return toast('학생이 없어요.');
  if (!confirm(AI_CONFIRM)) return;
  aiBusy = true;
  render();
  try {
    await saveNotes();   // 저장하지 않은 떨어뜨리기/가까이 앉히기 규칙·👓 앞자리·메모도 AI 가 보도록
    const body = { roundId: data.round.id, layout, seats, pinned: [...pinned], zones, climate, roleSeats, options };
    data = await api(`${base}/ai/seating`, { method: 'POST', body });
    buildRelations();
    aiBusy = false;
    if (!aiSeating?.assignment) throw new Error('AI 배정 결과를 받지 못했어요.');
    const applied = applyAiSeating();
    const summary = (aiSeating.notes || '').trim();
    toast(`${aiApplyMessage('AI 배정안을 적용했어요.', applied)}${summary ? ` ${summary.length > 80 ? `${summary.slice(0, 80)}…` : summary}` : ''}`, 6000);
  } catch (err) {
    aiBusy = false;
    render();
    toast(err.message, 5000);
  }
}

function seatCard(seatId, ev) {
  const sid = seats[seatId];
  const n = sid ? notes[sid] : null;
  const body = sid ? bodyOf(sid) : {};
  const zone = zones[seatId] || '';
  const roleId = roleSeats[seatId] || '';
  const cls = ['seat', sid ? '' : 'empty', selected === seatId ? 'selected' : '', ev.conflictSeats.has(seatId) ? 'conflict' : '', pinned.has(seatId) ? 'pinned' : '', zone ? `zone-${zone} climate-${climate}` : '', roleId ? 'role-seat' : ''].filter(Boolean).join(' ');
  const marks = `${n?.front || body.sight === 'poor' ? '👓' : ''}${body.cold === 'yes' ? '❄️' : ''}${body.heat === 'yes' ? '🔥' : ''}${body.height === 'tall' ? '📏' : ''}${body.height === 'short' ? '🌱' : ''}${n?.memo ? '📝' : ''}`;
  const title = [sid ? nameOf(sid) : '빈 자리', ...(sid ? bodyLabels(sid) : []), n?.front ? '앞자리 필요(교사 지정)' : '', n?.memo ? `메모: ${n.memo}` : '', zone === 'ac' ? `냉난방기 바람 자리 (${CLIMATE_LABEL[climate]})` : '', roleId ? `역할 자리: ${roleNameOf(roleId)} (담당: ${holderNames(roleId)})` : ''].filter(Boolean).join(' · ');
  return el('button', { type: 'button', class: cls, dataset: { seat: seatId }, title, onClick: () => onSeatClick(seatId) }, [
    el('span', { class: 'seat-name', text: sid ? nameOf(sid) : '빈 자리' }),
    marks ? el('span', { class: 'seat-marks', text: marks }) : null,
    zone ? el('span', { class: 'seat-zone', text: '🌀', 'aria-label': '냉난방기 바람 자리' }) : null,
    roleId ? el('span', { class: 'seat-role', text: `🎒 ${roleNameOf(roleId)}`, 'aria-label': `역할 자리: ${roleNameOf(roleId)}` }) : null,
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
    const labels = bodyLabels(s.id);
    return el('tr', {}, [
      el('td', { text: s.name, style: { fontWeight: 600, whiteSpace: 'nowrap' } }),
      el('td', { class: 'num' }, [el('label', { style: { cursor: 'pointer' } }, [front, ' 👓'])]),
      el('td', { class: 'body-cell' }, labels.length ? labels.map((t) => el('span', { class: 'badge gray body-badge', text: t })) : [el('span', { class: 'muted', text: '–' })]),
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
        el('h3', { text: '학생별 메모 · 앞자리 필요(👓) · 학생이 고른 특징' }),
        el('p', { class: 'muted', text: '👓 를 체크한 학생은 자동 배정에서 앞 두 줄에 앉혀요. "특징"은 학생이 설문에서 직접 고른 몸 특징(눈·키·추위·더위)으로, 자동 배정이 함께 참고해요. 메모는 좌석 위에 마우스를 올리면 보여요.' }),
        el('div', { class: 'table-wrap', style: { maxHeight: '420px', overflowY: 'auto' } }, [el('table', { class: 'table' }, [
          el('thead', {}, [el('tr', {}, [el('th', { text: '이름' }), el('th', { text: '앞자리' }), el('th', { text: '특징' }), el('th', { text: '메모' })])]),
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
  if (zoneMode) {
    if (zones[seatId]) delete zones[seatId]; else zones[seatId] = 'ac';
    dirty = true; render();
    return;
  }
  if (roleMode) {
    // 고른 역할의 자리로 지정, 이미 같은 역할 자리면 해제
    if (!roleModeRole || !roleOf(roleModeRole)) return toast('먼저 역할을 골라 주세요.');
    if (roleSeats[seatId] === roleModeRole) delete roleSeats[seatId]; else roleSeats[seatId] = roleModeRole;
    dirty = true; render();
    return;
  }
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

/** 교사 메모(👓 앞자리·메모)와 지정 규칙을 서버에 저장해요 (저장하기와 AI 자리 배정이 같이 씀) */
async function saveNotes() {
  const cleanNotes = {};
  for (const [sid, n] of Object.entries(notes)) if (n.front || (n.memo || '').trim()) cleanNotes[sid] = { memo: (n.memo || '').trim(), front: Boolean(n.front) };
  await api(`${base}/notes`, { method: 'PUT', body: { notes: cleanNotes, rules } });
}

async function save() {
  try {
    await saveNotes();
    await api(`${base}/seating`, { method: 'PUT', body: { layout, seats, pinned: [...pinned], options, zones, climate, roleSeats } });
    data = await api(dataUrl);
    buildRelations();
    dirty = false;
    staleNotice = false;
    render();
    toast('자리 배정과 메모를 저장했어요.');
  } catch (err) { toast(err.message, 4000); }
}

window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

function latestResponseAt() {
  let latest = null;
  for (const r of data.relations) if (r.updatedAt && (!latest || r.updatedAt > latest)) latest = r.updatedAt;
  for (const s of data.students) if (s.submittedAt && (!latest || s.submittedAt > latest)) latest = s.submittedAt;
  return latest;
}

(async () => {
  try {
    data = await api(dataUrl);
    buildRelations();
    if (data.seating) {
      layout = data.seating.layout;
      layoutText = layout.blocks.map((b) => `${b.cols}x${b.rows}`).join(', ');
      seats = { ...data.seating.seats };
      pinned = new Set(data.seating.pinned || []);
      options = { ...options, ...(data.seating.options || {}) };
      zones = { ...(data.seating.zones || {}) };
      climate = ['cool', 'warm', 'off'].includes(data.seating.climate) ? data.seating.climate : 'off';
      // 역할 자리: 그 사이 지워진 역할은 뺀다 (저장할 때 서버가 없는 역할을 거절해요)
      roleSeats = {};
      for (const [seatId, roleId] of Object.entries(data.seating.roleSeats || {})) if (roleOf(roleId)) roleSeats[seatId] = roleId;
    }
    notes = { ...(data.teacherNotes?.students || {}) };
    rules = [...(data.teacherNotes?.rules || [])];
    document.title = `${data.room.name} 자리 배정`;
    render();
    const hasSaved = Object.keys(seats).length > 0;
    if (!hasSaved && data.students.length) {
      // 저장된 자리가 없으면 지금 응답으로 바로 배정
      autoAssign(`${data.round.name} 응답을 바탕으로 바로 배정했어요. 확인 후 저장해 주세요.`);
    } else if (hasSaved && data.seating?.updatedAt) {
      const latest = latestResponseAt();
      if (latest && latest > data.seating.updatedAt) { staleNotice = true; render(); }
    }
  } catch (err) {
    setChildren(app, el('section', { class: 'card' }, [el('h1', { text: '교실을 열 수 없어요' }), el('p', { text: err.message })]));
  }
})();
