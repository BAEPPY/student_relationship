// 선생님 1인 1역 페이지: 역할 목록 · 지난달 현황 · 지원 현황 · 자동 배정/수정/확정 · 내보내기
import { api, el, toast, setChildren, fmtDate, copyText } from './common.js';

const adminToken = decodeURIComponent(location.pathname.split('/')[2] || '');
const base = `/api/teacher/${encodeURIComponent(adminToken)}`;
const roundParam = new URLSearchParams(location.search).get('round');
let roundQuery = roundParam ? `?round=${encodeURIComponent(roundParam)}` : '';   // 없는 회차면 현재 회차로 되돌립니다 (loadInitial)
let dataUrl = `${base}${roundQuery}`;
const app = document.getElementById('app');
document.getElementById('back-link').href = `/t/${encodeURIComponent(adminToken)}`;

const PICK_LABEL = ['1지망', '2지망', '3지망'];
const METHOD_LABEL = { rules: '규칙 배정', ai: 'AI 배정', manual: '직접 배정' };
const SOURCE_LABEL = { import: '가져온 기록', published: '확정·공개한 배정', manual: '직접 입력' };
const TRUNCATED_NOTICE = '자료가 길어 AI에 보낸 내용 일부가 생략됐어요.';
const MANUAL_EXPLANATION = '직접 옮김';

// ---------- 상태 ----------
let state = null;                 // 교사 API 응답 (teacherView)
let badPairs = new Set();         // 'a|b' (정렬) — 안 좋은 사이 표시가 있는 쌍
const ui = {
  open: { roles: true, history: true, apps: true, board: true, export: true },
  roles: { draft: [], dirty: false },
  history: { month: null, text: '', preview: null, expanded: new Set(), busy: false },
  apps: { expanded: new Set(), criteriaOpen: false },
  board: { assignments: {}, explanations: {}, dirty: false, selected: null, dragging: null, explain: new Set(), busy: null, seed: 1 },
  skipGuard: false,
};

const nameOf = (sid) => state.stats?.[sid]?.name || state.students.find((s) => s.id === sid)?.name || '?';
const roleById = (id) => state.roles.find((r) => r.id === id) || null;
const pairKey = (a, b) => [a, b].sort().join('|');
const isDirty = () => ui.roles.dirty || ui.board.dirty;
/** 그 역할을 맡고 있는 학생 (보드에서 수정 중인 배정 ∪ 서버에 저장된 배정) */
const roleMembers = (roleId) => [...new Set([...(ui.board.assignments[roleId] || []), ...(state.roleAssignment?.assignments?.[roleId] || [])])];

function monthIndex(name) {
  const m = /(\d{4})\s*년\s*(\d{1,2})\s*월/.exec(String(name || ''));
  return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : null;
}
function prevMonthName(name) {
  const m = /(\d{4})\s*년\s*(\d{1,2})\s*월/.exec(String(name || ''));
  if (!m) return '';
  let y = Number(m[1]);
  let mo = Number(m[2]) - 1;
  if (mo < 1) { mo = 12; y -= 1; }
  return `${y}년 ${mo}월`;
}

/** 값·입력 처리기를 붙인 input/textarea (textarea 는 value 속성이 안 먹어서 직접 넣습니다) */
function input(tag, attrs, value, onInput) {
  const node = el(tag, attrs);
  node.value = value ?? '';
  if (onInput) node.addEventListener('input', () => onInput(node.value, node));
  return node;
}

// ---------- 데이터 ----------
function afterState() {
  buildRelations();
  if (!ui.roles.dirty) ui.roles.draft = state.roles.map((r) => ({ ...r }));
  if (ui.history.month === null) ui.history.month = prevMonthName(state.round.name);
  if (ui.history.preview) {
    const ids = new Set(state.roles.map((r) => r.id));
    for (const k of Object.keys(ui.history.preview.assignments)) if (!ids.has(k)) delete ui.history.preview.assignments[k];
  }
  syncBoard();
  document.title = `${state.room.name} 1인 1역`;
}

function buildRelations() {
  badPairs = new Set();
  for (const r of state.relations || []) if (r.type === 'bad') badPairs.add(pairKey(r.from, r.to));
}

/** 서버 배정(또는 수정 중인 배정)을 현재 역할·학생 목록에 맞춰 정리합니다. */
function syncBoard() {
  const validStudents = new Set(state.students.map((s) => s.id));
  const source = ui.board.dirty ? ui.board.assignments : (state.roleAssignment?.assignments || {});
  const assignments = {};
  const seen = new Set();
  for (const r of state.roles) {
    assignments[r.id] = (source[r.id] || []).filter((sid) => validStudents.has(sid) && !seen.has(sid) && seen.add(sid));
  }
  ui.board.assignments = assignments;
  if (!ui.board.dirty) ui.board.explanations = { ...(state.roleAssignment?.explanations || {}) };
}

/** API 가 돌려준 teacherView 로 상태를 바꿉니다. 보고 있는 회차와 다르면 다시 불러옵니다. */
async function applyState(next) {
  if (!next || !next.room) return;
  state = (!state || next.round?.id === state.round?.id) ? next : await api(dataUrl);
  afterState();
  renderAll();
}

async function action(promise, okMessage, onSuccess) {
  try {
    const next = await promise;
    if (onSuccess) onSuccess(next);
    await applyState(next);
    if (okMessage) toast(okMessage);
    return true;
  } catch (err) {
    toast(err.message, 4000);
    return false;
  }
}

// ---------- 전체 렌더 ----------
function renderAll() {
  const y = window.scrollY;
  const sections = state.roles.length
    ? [renderHeader(), renderRoles(), renderHistory(), renderApplications(), renderBoard(), renderExport()]
    : [renderHeader(), renderOnboarding(), renderRoles()];
  setChildren(app, ...sections);
  window.scrollTo(0, y);
}

function sectionCard(key, title, subtitle, body, { id, cls = '', actions = [] } = {}) {
  const open = ui.open[key];
  return el('section', { class: `card ${cls}`, id }, [
    el('div', { class: 'card-title' }, [
      el('div', {}, [el('h2', { text: title }), subtitle ? el('div', { class: 'muted', text: subtitle }) : null]),
      el('div', { class: 'btn-row no-print' }, [...actions, el('button', { type: 'button', class: 'btn small', text: open ? '접기' : '펼치기', onClick: () => { ui.open[key] = !open; renderAll(); } })]),
    ]),
    open ? el('div', { class: 'section-body' }, body()) : null,
  ]);
}

// ---------- 1. 머리 카드 ----------
function renderHeader() {
  const total = state.students.length;
  const ids = new Set(state.students.map((s) => s.id));
  const appCount = Object.keys(state.applications || {}).filter((id) => ids.has(id)).length;
  const profCount = Object.keys(state.profiles || {}).filter((id) => ids.has(id)).length;
  const a = state.roleAssignment;
  const prev = state.previousRoles || { month: null, byStudent: {} };

  const sel = el('select', { class: 'select' }, state.rounds.map((r) => el('option', {
    value: r.id,
    text: `${r.name}${r.id === state.currentRoundId ? ' (현재 회차)' : ''}`,
    selected: r.id === state.round.id ? true : null,
  })));
  sel.addEventListener('change', () => {
    const id = sel.value;
    if (isDirty() && !confirm('저장하지 않은 내용이 있어요. 그래도 다른 회차로 이동할까요?')) { sel.value = state.round.id; return; }
    ui.skipGuard = true;
    location.href = `/t/${encodeURIComponent(adminToken)}/roles${id === state.currentRoundId ? '' : `?round=${encodeURIComponent(id)}`}`;
  });

  const assignBadge = !a
    ? el('span', { class: 'badge gray', text: '배정 전' })
    : a.published
      ? el('span', { class: 'badge blue', text: `확정·공개됨 ${fmtDate(a.publishedAt)}` })
      : el('span', { class: 'badge warn', text: `배정 초안 (${METHOD_LABEL[a.method] || a.method})` });

  const flow = ['학생 지원', '지난달 현황 가져오기', '자동 배정', '수정', '확정·공개'];
  return el('section', { class: 'card no-print' }, [
    el('div', { class: 'card-title' }, [
      el('div', {}, [
        el('h1', { text: `${state.room.name} 1인 1역` }),
        el('div', { class: 'muted', text: `${state.round.name} 기준 · 학생 ${total}명 · 역할 ${state.roles.length}개 (${state.roles.reduce((n, r) => n + r.slots, 0)}자리)` }),
      ]),
      el('div', { class: 'btn-row' }, [el('label', { class: 'muted', text: '회차' }), sel]),
    ]),
    el('div', { class: 'roles-flow' }, flow.flatMap((t, i) => [
      el('span', { class: 'step-pill', text: `${i + 1}. ${t}` }),
      i < flow.length - 1 ? el('span', { class: 'arrow', text: '→' }) : null,
    ])),
    el('p', { class: 'muted', style: { margin: '0 0 10px' }, text: '학생들은 자기 QR 링크에서 성향 설문과 1인 1역 지원서를 써요. 선생님은 지난달 현황을 가져온 뒤 자동 배정을 돌리고, 끌어다 놓기로 고친 다음 확정해서 학생에게 공개해요. 지난달에 맡았던 역할은 이번 달에 다시 맡지 않도록 자동으로 제외돼요.' }),
    el('div', { class: 'status-badges' }, [
      el('span', { class: `badge ${total && appCount === total ? 'green' : 'warn'}`, text: `지원서 ${appCount}/${total}` }),
      el('span', { class: `badge ${total && profCount === total ? 'green' : 'warn'}`, text: `성향 설문 ${profCount}/${total}` }),
      prev.month
        ? el('span', { class: 'badge green', text: `지난달 기록 있음 (${prev.month})` })
        : el('span', { class: 'badge gray', text: '지난달 기록 없음' }),
      assignBadge,
      state.room.locked ? el('span', { class: 'badge gray', text: '회차 마감됨' }) : null,
      state.ai?.enabled ? el('span', { class: 'badge blue', text: 'AI 배정 사용 가능' }) : el('span', { class: 'badge gray', text: 'AI 배정 꺼짐' }),
    ]),
  ]);
}

function renderOnboarding() {
  return el('section', { class: 'card' }, [
    el('h2', { text: '아직 역할이 없어요' }),
    el('p', { class: 'muted', text: '1인 1역을 시작하려면 먼저 역할 목록이 필요해요. 기본 역할 15개(26자리)를 불러온 뒤 우리 반에 맞게 고치거나, 아래 표에서 직접 만들 수 있어요. 역할이 있어야 학생 지원서 화면이 열려요.' }),
    el('div', { class: 'btn-row' }, [
      el('button', { type: 'button', class: 'btn primary', text: '기본 역할 15개 불러오기', onClick: loadDefaultRoles }),
      el('button', { type: 'button', class: 'btn', text: '직접 만들기', onClick: () => { if (!ui.roles.draft.length) ui.roles.draft.push(newRoleRow()); ui.roles.dirty = true; ui.open.roles = true; renderAll(); } }),
    ]),
  ]);
}

// ---------- 2. 역할 목록 ----------
const newRoleRow = () => ({ id: null, name: '', subtitle: '', slots: 1, description: '' });

function markRolesDirty() {
  if (ui.roles.dirty) return;
  ui.roles.dirty = true;
  const btn = document.getElementById('roles-save-btn');
  if (btn) { btn.textContent = '역할 저장하기 *'; btn.classList.add('orange'); }
}

function countPills(c) {
  return el('span', { class: 'count-pills', title: `1지망 ${c.first}명 · 2지망 ${c.second}명 · 3지망 ${c.third}명` }, [
    el('span', { class: 'first', text: String(c.first) }),
    el('span', { text: String(c.second) }),
    el('span', { text: String(c.third) }),
  ]);
}

async function loadDefaultRoles() {
  if (state.roles.length && !confirm('지금 역할 목록을 기본 역할 15개로 바꿀까요? 직접 만든 역할은 사라져요.')) return;
  await action(api(`${base}/roles/default`, { method: 'POST' }), '기본 역할 15개를 불러왔어요.', () => { ui.roles.dirty = false; });
}

async function saveRoles() {
  const roles = ui.roles.draft.map((r) => ({
    ...(r.id ? { id: r.id } : {}),
    name: r.name, subtitle: r.subtitle, slots: Number.parseInt(r.slots, 10), description: r.description,
  }));
  if (!roles.length && !confirm('역할을 모두 지우면 학생 지원서 화면이 닫혀요. 계속할까요?')) return;
  // 지워지는 역할을 맡고 있던 학생: 서버가 그 역할을 배정에서 빼고 경고를 남기므로, 저장 뒤 보드를 서버 상태로 다시 맞춥니다.
  const keep = new Set(roles.filter((r) => r.id).map((r) => r.id));
  const lost = new Set(state.roles.filter((r) => !keep.has(r.id)).flatMap((r) => roleMembers(r.id)));
  if (lost.size && ui.board.dirty && !confirm(`지운 역할을 맡은 학생이 ${lost.size}명 있어 저장하면 배정이 수정돼요. 아직 저장하지 않은 배정 수정 내용은 저장된 배정으로 되돌아가요. 계속할까요?`)) return;
  const okMessage = lost.size ? `역할 목록을 저장했어요. 역할이 없어진 학생 ${lost.size}명은 "아직 배정 안 됨"으로 옮겨졌어요.` : '역할 목록을 저장했어요.';
  await action(api(`${base}/roles${roundQuery}`, { method: 'PUT', body: { roles } }), okMessage, () => {
    ui.roles.dirty = false;
    if (!lost.size) return;
    ui.board.dirty = false;           // syncBoard 가 서버 배정(역할이 빠지고 경고가 더해진)을 그대로 가져옵니다
    ui.board.selected = null;
    ui.board.explain = new Set();
    ui.open.board = true;
  });
}

function renderRoles() {
  const counts = state.applicantCounts || {};
  const draft = ui.roles.draft;
  const rows = draft.map((r, i) => {
    const c = r.id ? counts[r.id] : null;
    return el('tr', {}, [
      el('td', { class: 'name-col' }, [input('input', { type: 'text', maxlength: 40, placeholder: '역할 이름' }, r.name, (v) => { r.name = v; markRolesDirty(); })]),
      el('td', { class: 'sub-col' }, [input('input', { type: 'text', maxlength: 40, placeholder: '부제 (선택)' }, r.subtitle, (v) => { r.subtitle = v; markRolesDirty(); })]),
      el('td', { class: 'slots-col' }, [input('input', { type: 'number', min: 1, max: 10 }, r.slots, (v) => { r.slots = v; markRolesDirty(); })]),
      el('td', {}, [input('textarea', { rows: 2, maxlength: 600, placeholder: '학생이 읽는 역할 설명' }, r.description, (v) => { r.description = v; markRolesDirty(); })]),
      el('td', { class: 'count-col' }, [c ? countPills(c) : el('span', { class: 'muted', text: '저장 후 표시' })]),
      el('td', {}, [el('button', { type: 'button', class: 'btn small danger', text: '삭제', onClick: () => {
        const name = r.name || '이 역할';
        const members = r.id ? roleMembers(r.id) : [];
        const lines = [];
        if (c?.total) lines.push(`"${name}"에 지원한 학생이 ${c.total}명 있어요.`);
        if (members.length) lines.push(`‘${name}’을(를) 맡은 학생 ${members.length}명이 역할을 잃어요. 저장하면 배정이 수정되어 다시 확정해야 해요.`);
        if (lines.length && !confirm(`${lines.join('\n')} 그래도 지울까요?`)) return;
        draft.splice(i, 1); ui.roles.dirty = true; renderAll();
      } })]),
    ]);
  });
  const totalSlots = draft.reduce((n, r) => n + (Number.parseInt(r.slots, 10) || 0), 0);
  const body = () => [
    el('p', { class: 'muted', text: '역할 이름과 설명은 학생 지원서에 그대로 보여요. 인원은 그 역할을 맡을 학생 수예요. "지원" 칸은 1지망·2지망·3지망으로 지원한 학생 수예요.' }),
    el('div', { class: 'table-wrap' }, [el('table', { class: 'table roles-table' }, [
      el('thead', {}, [el('tr', {}, [el('th', { text: '역할 이름' }), el('th', { text: '부제' }), el('th', { text: '인원' }), el('th', { text: '설명' }), el('th', { text: '지원 (1·2·3지망)' }), el('th', { text: '' })])]),
      el('tbody', {}, rows.length ? rows : [el('tr', {}, [el('td', { colspan: 6, class: 'muted', text: '역할이 없어요. "역할 추가"를 눌러 만들어 주세요.' })])]),
    ])]),
    el('div', { class: 'btn-row', style: { marginTop: '10px' } }, [
      el('button', { type: 'button', class: 'btn', text: '역할 추가', onClick: () => { draft.push(newRoleRow()); ui.roles.dirty = true; renderAll(); } }),
      el('button', { type: 'button', id: 'roles-save-btn', class: `btn ${ui.roles.dirty ? 'orange' : 'primary'}`, text: ui.roles.dirty ? '역할 저장하기 *' : '역할 저장하기', onClick: saveRoles }),
      el('button', { type: 'button', class: 'btn', text: '기본 역할 15개 불러오기', onClick: loadDefaultRoles }),
      el('span', { class: 'muted', text: `역할 ${draft.length}개 · ${totalSlots}자리 · 학생 ${state.students.length}명` }),
    ]),
    totalSlots && totalSlots < state.students.length ? el('div', { class: 'alert warn', style: { marginTop: '10px', marginBottom: 0 }, text: `자리(${totalSlots})가 학생 수(${state.students.length})보다 적어요. 인원을 늘리거나 역할을 더 만들어 주세요.` }) : null,
  ];
  return sectionCard('roles', '역할 목록', `${state.roles.length}개 역할 · 저장된 자리 ${state.roles.reduce((n, r) => n + r.slots, 0)}개`, body, { id: 'roles-card', cls: 'no-print' });
}

// ---------- 3. 지난달 현황 ----------
async function previewHistory() {
  if (!ui.history.text.trim()) return toast('먼저 지난달 현황을 붙여넣어 주세요.');
  ui.history.busy = true;
  try {
    const result = await api(`${base}/roles/history/parse`, { method: 'POST', body: { text: ui.history.text } });
    const assignments = {};
    for (const r of state.roles) assignments[r.id] = [...(result.assignments?.[r.id] || [])];
    ui.history.preview = { assignments, unmatched: result.unmatched || [] };
    const n = Object.values(assignments).flat().length;
    toast(n ? `${n}명을 찾았어요. 확인한 뒤 저장해 주세요.` : '학생 이름을 찾지 못했어요. 반 명단과 같은 이름으로 적어 주세요.', 3500);
  } catch (err) { toast(err.message, 4000); }
  ui.history.busy = false;
  renderAll();
}

async function saveHistory() {
  const month = (ui.history.month || '').trim();
  if (!month) return toast('달 이름을 적어 주세요. (예: 2026년 9월)');
  const assignments = {};
  for (const [roleId, sids] of Object.entries(ui.history.preview.assignments)) if (sids.length) assignments[roleId] = sids;
  if (!Object.keys(assignments).length) return toast('저장할 학생이 없어요.');
  const exists = (state.roleHistory || []).some((h) => h.month === month);
  if (exists && !confirm(`"${month}" 기록이 이미 있어요. 덮어쓸까요?`)) return;
  await action(api(`${base}/roles/history${roundQuery}`, { method: 'PUT', body: { month, assignments, source: 'import' } }), `${month} 기록을 저장했어요.`, () => {
    ui.history.preview = null; ui.history.text = '';
  });
}

async function deleteHistory(month) {
  if (!confirm(`"${month}" 기록을 지울까요? 그 달 역할은 더 이상 제외 규칙에 쓰이지 않아요.`)) return;
  await action(api(`${base}/roles/history/${encodeURIComponent(month)}`, { method: 'DELETE' }), `${month} 기록을 지웠어요.`);
}

function renderHistory() {
  const prev = state.previousRoles || { month: null, byStudent: {} };
  const history = [...(state.roleHistory || [])].sort((a, b) => (monthIndex(b.month) ?? -1) - (monthIndex(a.month) ?? -1));
  const students = state.students;
  const sampleNames = students.slice(0, 2).map((s) => s.name);
  const r0 = state.roles[0]?.name || '빗자루의 마법사';
  const r1 = state.roles[1]?.name || '칭찬 수집가';
  const placeholder = `한 줄에 역할 하나. 예)\n${r0}: 8 ${sampleNames[0] || '이준영'} 24 ${sampleNames[1] || '임민호'}\n${r1}: 9 ${students[2]?.name || '정서원'}\n…\n(한글 문서의 표를 복사해 붙여넣어도 돼요. 번호는 있어도 없어도 괜찮아요.)`;

  const historyList = history.length ? el('ul', { class: 'history-list' }, history.map((h) => {
    const n = Object.values(h.assignments || {}).flat().length;
    const roleCount = Object.values(h.assignments || {}).filter((l) => l.length).length;
    const open = ui.history.expanded.has(h.month);
    return el('li', { class: 'history-item' }, [
      el('b', { text: h.month }),
      h.month === prev.month ? el('span', { class: 'badge green', text: '이번 회차의 지난달' }) : null,
      h.month === state.round.name ? el('span', { class: 'badge blue', text: '이번 달' }) : null,
      el('span', { class: 'muted', text: `학생 ${n}명 · 역할 ${roleCount}개 · ${SOURCE_LABEL[h.source] || h.source || ''}${h.updatedAt ? ` · ${fmtDate(h.updatedAt)}` : ''}` }),
      el('span', { class: 'grow' }),
      el('button', { type: 'button', class: 'btn small', text: open ? '닫기' : '보기', onClick: () => { open ? ui.history.expanded.delete(h.month) : ui.history.expanded.add(h.month); renderAll(); } }),
      el('button', { type: 'button', class: 'btn small danger', text: '삭제', onClick: () => deleteHistory(h.month) }),
      open ? el('div', { class: 'history-detail' }, Object.entries(h.assignments || {}).filter(([, l]) => l.length).map(([roleId, sids]) => el('div', {}, [
        el('b', { text: roleById(roleId)?.name || '(지워진 역할)' }), `: ${sids.map(nameOf).join(', ')}`,
      ]))) : null,
    ]);
  })) : el('p', { class: 'muted', text: '아직 저장된 달 기록이 없어요. 지난달 현황을 가져오면 같은 역할 연속 금지 규칙이 바로 적용돼요.' });

  const preview = ui.history.preview;
  const assignedInPreview = preview ? new Set(Object.values(preview.assignments).flat()) : new Set();
  const previewEl = preview ? el('div', { class: 'parse-preview' }, [
    el('div', { class: 'card-title' }, [
      el('h3', { text: `미리보기 · 학생 ${assignedInPreview.size}명` }),
      el('div', { class: 'btn-row' }, [
        el('button', { type: 'button', class: 'btn primary small', text: '이 달 기록으로 저장', onClick: saveHistory }),
        el('button', { type: 'button', class: 'btn small', text: '취소', onClick: () => { ui.history.preview = null; renderAll(); } }),
      ]),
    ]),
    el('p', { class: 'muted', text: '잘못 들어간 학생은 ✕ 로 빼고, 빠진 학생은 아래 선택 상자에서 더할 수 있어요. 한 학생은 한 역할에만 들어가요.' }),
    el('div', { class: 'preview-grid' }, state.roles.map((r) => {
      const sids = (preview.assignments[r.id] ||= []);   // 미리보기 뒤에 생긴 역할도 더한 학생이 사라지지 않게 붙여 둡니다
      const sel = el('select', {}, [
        el('option', { value: '', text: '+ 학생 더하기' }),
        ...students.filter((s) => !assignedInPreview.has(s.id)).map((s) => el('option', { value: s.id, text: s.name })),
      ]);
      sel.addEventListener('change', () => {
        if (!sel.value) return;
        for (const list of Object.values(preview.assignments)) { const i = list.indexOf(sel.value); if (i >= 0) list.splice(i, 1); }
        sids.push(sel.value); renderAll();
      });
      return el('div', { class: 'preview-role' }, [
        el('div', { class: 'preview-head' }, [el('b', { text: r.name }), el('span', { class: `badge ${sids.length ? 'blue' : 'gray'}`, text: `${sids.length}/${r.slots}` })]),
        el('div', { class: 'chips' }, sids.map((sid) => el('span', { class: 'chip removable' }, [
          nameOf(sid),
          el('button', { type: 'button', class: 'x', text: '✕', title: '빼기', onClick: () => { sids.splice(sids.indexOf(sid), 1); renderAll(); } }),
        ]))),
        el('div', { style: { marginTop: '6px' } }, [sel]),
      ]);
    })),
    preview.unmatched.length ? el('div', { style: { marginTop: '10px' } }, [
      el('div', { class: 'muted', style: { fontWeight: 600 }, text: `읽지 못한 줄 ${preview.unmatched.length}개 — 필요하면 위에서 직접 더해 주세요` }),
      el('ul', { class: 'unmatched-list' }, preview.unmatched.map((u) => el('li', {}, [`“${u.line}”`, el('span', { class: 'muted', text: ` · ${u.reason}` })]))),
    ]) : null,
  ]) : null;

  const body = () => [
    el('p', { class: 'muted', text: '지난달에 맡았던 역할은 이번 달 지원서와 자동 배정에서 자동으로 제외돼요. 이번 달 배정을 확정·공개하면 그 달 기록은 자동으로 저장되니, 처음 시작할 때만 지난달 현황을 가져오면 돼요.' }),
    historyList,
    el('div', { class: 'roles-import' }, [
      el('h3', { text: '지난달 현황 가져오기' }),
      el('div', { class: 'btn-row', style: { marginBottom: '8px' } }, [
        el('label', { style: { fontWeight: 600 }, text: '어느 달 기록인가요?' }),
        input('input', { type: 'text', maxlength: 40, placeholder: '예: 2026년 9월' }, ui.history.month, (v) => { ui.history.month = v; }),
        prev.month ? null : el('span', { class: 'muted', text: `(${state.round.name} 의 바로 전 달이면 제외 규칙에 쓰여요)` }),
      ]),
      input('textarea', { placeholder, rows: 8 }, ui.history.text, (v) => { ui.history.text = v; }),
      el('div', { class: 'btn-row', style: { marginTop: '8px' } }, [
        el('button', { type: 'button', class: 'btn primary', text: ui.history.busy ? '읽는 중…' : '미리보기', disabled: ui.history.busy ? true : null, onClick: previewHistory }),
        ui.history.text ? el('button', { type: 'button', class: 'btn', text: '지우기', onClick: () => { ui.history.text = ''; ui.history.preview = null; renderAll(); } }) : null,
        el('span', { class: 'muted', text: '역할은 이름이 들어 있는 줄로, 학생은 반 명단 이름으로 찾아요.' }),
      ]),
      previewEl,
    ]),
  ];
  return sectionCard('history', '지난달 현황', prev.month ? `이번 회차(${state.round.name})의 제외 기준: ${prev.month}` : '아직 제외 기준이 되는 지난달 기록이 없어요', body, { id: 'history-card', cls: 'no-print' });
}

// ---------- 4. 지원 현황 ----------
function sincerity(appl) {
  const choices = appl?.choices || [];
  if (!choices.length) return null;
  const reasonLen = choices.reduce((n, c) => n + (c.reason || '').trim().length, 0);
  const helpFilled = choices.reduce((n, c) => n + ((c.helpClass || '').trim() ? 1 : 0) + ((c.helpSelf || '').trim() ? 1 : 0), 0);
  const helpTotal = choices.length * 2;
  const avg = reasonLen / choices.length;
  const level = avg >= 60 && helpFilled === helpTotal ? 'green' : avg >= 25 ? 'warn' : 'high';
  const label = level === 'green' ? '꼼꼼해요' : level === 'warn' ? '보통' : '짧아요';
  return { reasonLen, helpFilled, helpTotal, level, label };
}

function renderApplications() {
  const traitLabel = Object.fromEntries((state.traits || []).map((t) => [t.id, t.label]));
  const apps = state.applications || {};
  const profiles = state.profiles || {};
  const missing = state.students.filter((s) => !apps[s.id]);
  const aiStudents = Object.fromEntries((state.aiAnalysis?.students || []).map((s) => [s.id, s]));

  const detail = (s) => {
    const appl = apps[s.id];
    const prof = profiles[s.id];
    const ai = aiStudents[s.id];
    const answer = (v) => el('div', { class: `a ${v?.trim() ? '' : 'empty'}`, text: v?.trim() || '(안 적었어요)' });
    return el('div', { class: 'app-detail' }, [
      ...(appl?.choices || []).map((c, i) => el('div', { class: 'app-choice' }, [
        el('div', {}, [el('span', { class: `badge ${i === 0 ? 'blue' : 'gray'}`, text: PICK_LABEL[i] }), ' ', el('b', { text: roleById(c.roleId)?.name || '(지워진 역할)' })]),
        el('div', { class: 'q', text: '하고 싶은 이유' }), answer(c.reason),
        el('div', { class: 'q', text: '우리 반에 도움 되는 점' }), answer(c.helpClass),
        el('div', { class: 'q', text: '나에게 도움 되는 점' }), answer(c.helpSelf),
      ])),
      appl ? null : el('div', { class: 'app-choice muted', text: '아직 지원서를 내지 않았어요.' }),
      el('div', { class: 'profile-box' }, [
        el('div', { style: { fontWeight: 600, marginBottom: '4px' }, text: `성향 설문${prof?.updatedAt ? ` · ${fmtDate(prof.updatedAt)}` : ''}` }),
        prof ? el('div', {}, [
          el('div', { class: 'muted', text: '나는 이런 편이에요' }),
          el('div', { class: 'chips', style: { margin: '4px 0 8px' } }, (prof.traits || []).length ? prof.traits.map((t) => el('span', { class: 'chip', text: traitLabel[t] || t })) : [el('span', { class: 'muted', text: '고른 항목 없음' })]),
          el('div', { class: 'muted', text: '내 짝에게 바라는 점' }),
          el('div', { class: 'chips', style: { margin: '4px 0 6px' } }, (prof.partnerTraits || []).length ? prof.partnerTraits.map((t) => el('span', { class: 'chip', text: traitLabel[t] || t })) : [el('span', { class: 'muted', text: '고른 항목 없음' })]),
          prof.partnerText ? el('div', { style: { whiteSpace: 'pre-wrap' }, text: prof.partnerText }) : null,
        ]) : el('div', { class: 'muted', text: '아직 성향 설문을 하지 않았어요.' }),
      ]),
      ai ? el('div', { class: 'profile-box ai-box' }, [
        el('div', { style: { fontWeight: 600, marginBottom: '4px' }, text: 'AI 분석 참고' }),
        ai.summary ? el('div', { text: ai.summary }) : null,
        (ai.roleFit || []).length ? el('ul', { style: { margin: '4px 0 0', paddingLeft: '18px' } }, ai.roleFit.map((f) => el('li', {}, [el('b', { text: roleById(f.roleId)?.name || f.roleId }), f.reason ? ` · ${f.reason}` : '']))) : null,
        state.aiAnalysis?.truncated ? el('div', { class: 'truncated-note', text: TRUNCATED_NOTICE }) : null,
      ]) : null,
    ]);
  };

  const rows = state.students.flatMap((s) => {
    const appl = apps[s.id];
    const prof = profiles[s.id];
    const sc = sincerity(appl);
    const open = ui.apps.expanded.has(s.id);
    const choice = (i) => {
      const c = appl?.choices?.[i];
      if (!c) return el('span', { class: 'muted', text: '–' });
      return el('span', { text: roleById(c.roleId)?.name || '(지워진 역할)', title: `이유 ${(c.reason || '').trim().length}자${(c.helpClass || '').trim() ? ' · 반 도움 ✓' : ''}${(c.helpSelf || '').trim() ? ' · 나 도움 ✓' : ''}` });
    };
    const main = el('tr', { class: appl ? '' : 'missing' }, [
      el('td', {}, [el('b', { text: s.name })]),
      el('td', { class: 'center', title: prof ? '성향 설문 완료' : '성향 설문 전' }, [prof ? el('span', { class: 'badge green', text: '✓' }) : el('span', { class: 'muted', text: '–' })]),
      el('td', {}, [appl ? choice(0) : el('span', { class: 'badge warn', text: '아직 안 냈어요' })]),
      el('td', {}, [choice(1)]),
      el('td', {}, [choice(2)]),
      el('td', {}, [sc ? el('span', { class: 'sincerity' }, [el('span', { class: `badge ${sc.level}`, text: sc.label }), ` 이유 ${sc.reasonLen}자 · 도움 ${sc.helpFilled}/${sc.helpTotal}칸`]) : el('span', { class: 'muted', text: '–' })]),
      el('td', { class: 'center' }, [appl || prof || aiStudents[s.id] ? el('button', { type: 'button', class: 'btn small', text: open ? '닫기' : '자세히', onClick: () => { open ? ui.apps.expanded.delete(s.id) : ui.apps.expanded.add(s.id); renderAll(); } }) : null]),
    ]);
    return open ? [main, el('tr', { class: 'detail-row' }, [el('td', { colspan: 7 }, [detail(s)])])] : [main];
  });

  const allOpen = state.students.every((s) => ui.apps.expanded.has(s.id));
  const body = () => [
    el('div', { class: 'btn-row', style: { marginBottom: '10px' } }, [
      el('button', { type: 'button', class: 'btn small', text: ui.apps.criteriaOpen ? '선정 기준 닫기' : '선정 기준 보기', onClick: () => { ui.apps.criteriaOpen = !ui.apps.criteriaOpen; renderAll(); } }),
      el('button', { type: 'button', class: 'btn small', text: allOpen ? '모두 닫기' : '모두 펼치기', onClick: () => { ui.apps.expanded = allOpen ? new Set() : new Set(state.students.map((s) => s.id)); renderAll(); } }),
      el('span', { class: 'muted', text: '"성의"는 이유 글자 수와 도움 칸을 채웠는지로 간단히 짐작한 거예요. 꼭 내용을 읽고 판단해 주세요.' }),
    ]),
    ui.apps.criteriaOpen ? el('div', { class: 'criteria-box' }, [
      el('b', { text: '1인 1역 선정 기준' }),
      el('ol', {}, (state.selectionCriteria || []).map((c) => el('li', { text: c }))),
    ]) : null,
    missing.length ? el('div', { class: 'alert warn' }, [el('b', { text: `아직 지원서를 내지 않은 학생 ${missing.length}명: ` }), missing.map((s) => s.name).join(', ')]) : el('div', { class: 'alert success', text: '모든 학생이 지원서를 냈어요.' }),
    el('div', { class: 'table-wrap' }, [el('table', { class: 'table apps-table' }, [
      el('thead', {}, [el('tr', {}, [el('th', { text: '이름' }), el('th', { text: '성향' }), el('th', { text: '1지망' }), el('th', { text: '2지망' }), el('th', { text: '3지망' }), el('th', { text: '성의' }), el('th', { text: '' })])]),
      el('tbody', {}, rows.length ? rows : [el('tr', {}, [el('td', { colspan: 7, class: 'muted', text: '학생이 없어요.' })])]),
    ])]),
  ];
  return sectionCard('apps', '지원 현황', `지원서 ${state.students.length - missing.length}/${state.students.length}명`, body, { id: 'apps-card', cls: 'no-print' });
}

// ---------- 5. 자동 배정 · 수정 · 확정 ----------
function roleOfStudent(sid) {
  for (const [roleId, sids] of Object.entries(ui.board.assignments)) if (sids.includes(sid)) return roleId;
  return null;
}
function unassignedStudents() {
  const assigned = new Set(Object.values(ui.board.assignments).flat());
  return state.students.filter((s) => !assigned.has(s.id));
}
function pickIndex(sid, roleId) {
  const appl = state.applications?.[sid];
  if (!appl) return 'noapp';
  const i = (appl.choices || []).findIndex((c) => c.roleId === roleId);
  return i >= 0 ? i : 'other';
}
function boardStats() {
  const st = { first: 0, second: 0, third: 0, other: 0, noapp: 0, unassigned: unassignedStudents().length };
  for (const [roleId, sids] of Object.entries(ui.board.assignments)) {
    for (const sid of sids) {
      const p = pickIndex(sid, roleId);
      if (p === 0) st.first++; else if (p === 1) st.second++; else if (p === 2) st.third++; else if (p === 'other') st.other++; else st.noapp++;
    }
  }
  return st;
}
/** 한 학생이 그 역할에 있으면 안 되는 이유 (지난달 같은 역할 · 안 좋은 사이) */
function violationFor(sid, roleId) {
  const role = roleById(roleId);
  if (!role) return null;
  const prev = state.previousRoles || { month: null, byStudent: {} };
  if ((prev.byStudent?.[sid] || []).includes(roleId)) return `${nameOf(sid)}: ${role.name}은(는) 지난달(${prev.month || '지난달'})에도 맡았던 역할이에요.`;
  const bad = (ui.board.assignments[roleId] || []).filter((o) => o !== sid && badPairs.has(pairKey(sid, o)));
  if (bad.length) return `${nameOf(sid)} · ${bad.map(nameOf).join(', ')}: 안 좋은 사이 표시가 있는데 같은 역할이에요.`;
  return null;
}
function violationList() {
  const out = [];
  const prev = state.previousRoles || { month: null, byStudent: {} };
  for (const [roleId, sids] of Object.entries(ui.board.assignments)) {
    const role = roleById(roleId);
    if (!role) continue;
    for (const sid of sids) if ((prev.byStudent?.[sid] || []).includes(roleId)) out.push(`${nameOf(sid)}: ${role.name}은(는) 지난달(${prev.month})에도 맡았던 역할이에요.`);
    for (let i = 0; i < sids.length; i++) for (let j = i + 1; j < sids.length; j++) if (badPairs.has(pairKey(sids[i], sids[j]))) out.push(`${role.name}: ${nameOf(sids[i])} · ${nameOf(sids[j])} 사이에 안 좋은 사이 표시가 있어요.`);
    if (sids.length > role.slots) out.push(`${role.name}: 정원(${role.slots}명)보다 ${sids.length - role.slots}명 많아요.`);
  }
  return out;
}

/** 직접 옮긴 학생의 자동 배정 설명은 더 이상 맞지 않으므로 지우고, 역할에 들어갔으면 "직접 옮김"으로 둡니다. */
function setManualExplanation(sid, roleId) {
  delete ui.board.explanations[sid];
  ui.board.explain.delete(sid);
  if (roleId) ui.board.explanations[sid] = MANUAL_EXPLANATION;
}

function moveStudent(sid, roleId) {
  const cur = roleOfStudent(sid);
  if (cur === roleId) { ui.board.selected = null; renderAll(); return; }
  if (roleId) {
    const role = roleById(roleId);
    if (!role) return;
    if ((ui.board.assignments[roleId] || []).length >= role.slots) { toast(`${role.name}은(는) 정원(${role.slots}명)이 다 찼어요. 먼저 한 명을 빼 주세요.`, 3000); return; }
  }
  for (const list of Object.values(ui.board.assignments)) { const i = list.indexOf(sid); if (i >= 0) list.splice(i, 1); }
  if (roleId) ui.board.assignments[roleId].push(sid);
  setManualExplanation(sid, roleId);
  ui.board.dirty = true;
  ui.board.selected = null;
  renderAll();
  const v = roleId ? violationFor(sid, roleId) : null;
  if (v) toast(`주의: ${v}`, 3500);
}

/** 두 학생의 자리를 맞바꿉니다 (한쪽이 미배정이어도 됨). 정원은 그대로라 넘칠 일이 없어요. */
function swapStudents(a, b) {
  const ra = roleOfStudent(a);
  const rb = roleOfStudent(b);
  if (ra === rb) { ui.board.selected = null; renderAll(); return; }
  for (const list of Object.values(ui.board.assignments)) {
    const ia = list.indexOf(a);
    const ib = list.indexOf(b);
    if (ia >= 0) list[ia] = b;
    if (ib >= 0) list[ib] = a;
  }
  setManualExplanation(a, rb);
  setManualExplanation(b, ra);
  ui.board.dirty = true;
  ui.board.selected = null;
  renderAll();
  const notes = [rb ? violationFor(a, rb) : null, ra ? violationFor(b, ra) : null].filter(Boolean);
  toast(notes.length ? `주의: ${notes[0]}` : `${nameOf(a)} 과(와) ${nameOf(b)} 의 자리를 바꿨어요.`, notes.length ? 3500 : 2200);
}

function onChipClick(sid) {
  const sel = ui.board.selected;
  if (sel && sel !== sid) { swapStudents(sel, sid); return; }
  ui.board.selected = sel === sid ? null : sid;
  renderAll();
}

function dropTarget(node, roleId) {
  node.addEventListener('dragover', (e) => {
    if (!ui.board.dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    node.classList.add('drop-over');
  });
  node.addEventListener('dragleave', (e) => { if (!e.relatedTarget || !node.contains(e.relatedTarget)) node.classList.remove('drop-over'); });
  node.addEventListener('drop', (e) => {
    e.preventDefault();
    const sid = ui.board.dragging || e.dataTransfer.getData('text/plain');
    ui.board.dragging = null;
    node.classList.remove('drop-over');
    if (sid) moveStudent(sid, roleId);
  });
  node.addEventListener('click', () => { if (ui.board.selected) moveStudent(ui.board.selected, roleId); });
}

function slotChip(sid, roleId) {
  const vio = roleId ? violationFor(sid, roleId) : null;
  const expl = ui.board.explanations[sid];
  const p = roleId ? pickIndex(sid, roleId) : null;
  const pickEl = roleId ? el('span', {
    class: `pick ${p === 0 ? 'p1' : p === 'noapp' || p === 'other' ? 'none' : ''}`,
    title: p === 'noapp' ? '지원서 없음' : p === 'other' ? '지망하지 않은 역할' : PICK_LABEL[p],
    text: p === 'noapp' ? '없음' : p === 'other' ? '지망 외' : `${p + 1}지망`,
  }) : null;
  const chip = el('button', {
    type: 'button',
    class: `slot-chip ${ui.board.selected === sid ? 'selected' : ''} ${vio ? 'violation' : ''}`,
    draggable: 'true',
    dataset: { sid },
    title: vio || (ui.board.selected === sid ? '옮길 역할 카드를 누르세요' : '끌어서 옮기거나, 누른 뒤 옮길 카드를 누르세요'),
    onClick: (e) => { e.stopPropagation(); onChipClick(sid); },
  }, [
    el('span', { class: 'slot-name', text: nameOf(sid) }),
    vio ? el('span', { class: 'vio-mark', text: '⚠' }) : null,
    pickEl,
    expl ? el('span', { class: 'why', role: 'button', title: '배정 이유 보기', text: '?', onClick: (e) => { e.stopPropagation(); ui.board.explain.has(sid) ? ui.board.explain.delete(sid) : ui.board.explain.add(sid); renderAll(); } }) : null,
  ]);
  chip.addEventListener('dragstart', (e) => {
    ui.board.dragging = sid;
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', sid); } catch { /* 일부 브라우저 */ }
    chip.classList.add('dragging');
  });
  chip.addEventListener('dragend', () => {
    ui.board.dragging = null;
    chip.classList.remove('dragging');
    document.querySelectorAll('.drop-over').forEach((n) => n.classList.remove('drop-over'));
  });
  const wrap = el('div', { class: 'slot-wrap' }, [chip, expl && ui.board.explain.has(sid) ? el('div', { class: 'explain', text: expl }) : null]);
  return wrap;
}

async function runAssign(method, seed) {
  if (ui.board.busy) return;
  if (method === 'ai' && !state.ai?.enabled) return toast('서버에 ANTHROPIC_API_KEY 를 설정하면 쓸 수 있어요.', 4000);
  if (state.roleAssignment?.published && !confirm('이미 확정·공개된 배정이 있어요. 새로 배정하면 공개가 취소되고 초안으로 바뀌어요. 계속할까요?')) return;
  if (!state.roleAssignment?.published && ui.board.dirty && !confirm('수정 중인 배정이 있어요. 자동 배정 결과로 바꿀까요?')) return;
  ui.board.busy = method;
  renderAll();
  try {
    const next = await api(`${base}/roles/assign`, { method: 'POST', body: { method, roundId: state.round.id, seed } });
    ui.board.seed = seed;
    ui.board.dirty = false;
    ui.board.selected = null;
    ui.board.explain = new Set();
    ui.board.busy = null;
    await applyState(next);
    toast(method === 'ai' ? 'AI 배정 초안을 만들었어요. 확인하고 고친 뒤 확정해 주세요.' : '규칙 배정 초안을 만들었어요. 마음에 안 들면 "다시 섞기"를 눌러 보세요.', 3500);
  } catch (err) {
    ui.board.busy = null;
    renderAll();
    toast(err.message, 5000);
  }
}

async function saveAssignment(published) {
  const un = unassignedStudents();
  const vio = violationList();
  let okMessage = '배정 초안을 저장했어요.';
  if (published) {
    const parts = [`확정하면 학생들이 자기 QR 링크에서 맡은 역할을 볼 수 있어요. 또 "${state.round.name}" 배정 기록으로 저장되어 다음 달에는 같은 역할을 맡지 않도록 제외돼요.`];
    if (un.length) parts.push(`아직 배정되지 않은 학생이 ${un.length}명 있어요.`);
    if (vio.length) parts.push(`주의 표시가 있는 배정이 ${vio.length}개 있어요.`);
    parts.push('계속할까요?');
    if (!confirm(parts.join('\n'))) return;
    okMessage = '확정했어요. 학생들이 자기 역할을 볼 수 있어요.';
  } else if (state.roleAssignment?.published) {
    if (!confirm('공개를 취소하면 학생 화면에서 역할이 사라져요. 이 달의 기록은 그대로 남아 있어요. 계속할까요?')) return;
    okMessage = '공개를 취소했어요. 다시 초안 상태예요.';
  }
  const body = { assignments: ui.board.assignments, explanations: ui.board.explanations, published, roundId: state.round.id };
  await action(api(`${base}/roles/assignment`, { method: 'PUT', body }), okMessage, () => { ui.board.dirty = false; ui.board.selected = null; });
}

function renderBoard() {
  const a = state.roleAssignment;
  const busy = ui.board.busy;
  const unassigned = unassignedStudents();
  const vio = violationList();
  const st = boardStats();
  const counts = state.applicantCounts || {};
  const hasAny = Object.values(ui.board.assignments).some((l) => l.length);
  const prev = state.previousRoles || { month: null };
  const selecting = Boolean(ui.board.selected);

  const bin = el('div', { class: `unassigned-bin ${selecting ? 'targetable' : ''}` }, [
    el('div', { class: 'card-title bin-head' }, [
      el('b', { text: `아직 배정 안 됨 ${unassigned.length}명` }),
      el('span', { class: 'muted no-print', text: '여기로 끌어다 놓으면 역할에서 빠져요.' }),
    ]),
    unassigned.length ? el('div', { class: 'chips' }, unassigned.map((s) => slotChip(s.id, null))) : el('div', { class: 'muted', text: '모든 학생이 역할을 맡았어요.' }),
  ]);
  dropTarget(bin, null);

  const grid = el('div', { class: 'role-board' }, state.roles.map((r) => {
    const sids = ui.board.assignments[r.id] || [];
    const full = sids.length >= r.slots;
    const c = counts[r.id];
    const card = el('div', { class: `role-card ${full ? 'full' : ''} ${selecting ? 'targetable' : ''}`, dataset: { roleId: r.id }, title: selecting ? (full ? '정원이 다 찼어요' : '여기로 옮기기') : null }, [
      el('div', { class: 'role-head' }, [
        el('div', {}, [el('b', { text: r.name }), r.subtitle ? el('span', { class: 'sub', text: r.subtitle }) : null]),
        el('span', { class: `badge ${full ? 'green' : 'gray'}`, text: `${sids.length}/${r.slots}` }),
      ]),
      el('div', { class: 'slots' }, [
        ...sids.map((sid) => slotChip(sid, r.id)),
        ...Array.from({ length: Math.max(0, r.slots - sids.length) }, () => el('div', { class: 'slot empty no-print', text: '빈 자리' })),
      ]),
      c ? el('div', { class: 'muted role-foot no-print', text: `지원 1지망 ${c.first} · 2지망 ${c.second} · 3지망 ${c.third}` }) : null,
    ]);
    dropTarget(card, r.id);
    return card;
  }));

  const statTile = (label, value, color) => el('div', { class: 'stat' }, [el('div', { class: 'label', text: label }), el('div', { class: 'value', text: `${value}명`, style: color ? { color } : null })]);

  const body = () => [
    el('div', { class: 'board-toolbar no-print' }, [
      el('button', { type: 'button', class: 'btn primary', text: '규칙 배정', disabled: busy ? true : null, onClick: () => runAssign('rules', 1) }),
      el('button', { type: 'button', class: 'btn', text: '다시 섞기', disabled: busy ? true : null, title: '다른 순서로 규칙 배정을 다시 해요', onClick: () => runAssign('rules', (ui.board.seed || 1) + 1) }),
      el('button', { type: 'button', class: 'btn', text: busy === 'ai' ? 'AI가 배정하는 중…' : 'AI 배정', disabled: busy || !state.ai?.enabled ? true : null, title: state.ai?.enabled ? '지원서·성향·관계를 읽고 AI가 배정해요 (30~60초)' : '서버에 ANTHROPIC_API_KEY 를 설정하면 쓸 수 있어요', onClick: () => runAssign('ai') }),
      el('span', { style: { flex: 1 } }),
      el('button', { type: 'button', class: 'btn', text: '모두 비우기', disabled: busy ? true : null, onClick: () => { if (!hasAny || !confirm('배정을 모두 비울까요? 저장하기 전까지는 서버에 반영되지 않아요.')) return; for (const k of Object.keys(ui.board.assignments)) ui.board.assignments[k] = []; ui.board.explanations = {}; ui.board.explain = new Set(); ui.board.dirty = true; ui.board.selected = null; renderAll(); } }),
      el('button', { type: 'button', class: `btn ${ui.board.dirty ? 'orange' : ''}`, text: ui.board.dirty ? '초안 저장 *' : '초안 저장', disabled: busy ? true : null, onClick: () => saveAssignment(false) }),
      a?.published
        ? el('button', { type: 'button', class: 'btn danger', text: '공개 취소', disabled: busy ? true : null, onClick: () => saveAssignment(false) })
        : null,
      el('button', { type: 'button', class: 'btn primary', text: a?.published ? '수정한 내용으로 다시 공개' : '확정하고 학생에게 공개', disabled: busy || !hasAny ? true : null, onClick: () => saveAssignment(true) }),
    ]),
    !state.ai?.enabled ? el('p', { class: 'muted no-print', style: { marginTop: '-4px' }, text: 'AI 배정은 서버에 ANTHROPIC_API_KEY 를 설정하면 쓸 수 있어요. 규칙 배정은 지망 순서·지난달 제외·안 좋은 사이를 고려해 서버에서 바로 계산해요.' }) : null,
    busy ? el('div', { class: 'alert info no-print' }, [el('span', { class: 'spinner' }), busy === 'ai' ? 'AI가 지원서와 성향, 친구 관계를 읽고 배정하는 중이에요. 30~60초 정도 걸려요. 이 페이지를 닫지 말고 기다려 주세요.' : '규칙에 따라 배정하는 중이에요…']) : null,
    a?.published
      ? el('div', { class: `alert ${ui.board.dirty ? 'warn' : 'success'} no-print` }, [
        el('b', { text: `${fmtDate(a.publishedAt)} 에 확정·공개했어요. ` }),
        ui.board.dirty ? '수정한 내용은 아직 저장되지 않았어요. "수정한 내용으로 다시 공개"를 눌러야 학생 화면에 반영돼요.' : `학생들은 자기 역할을 볼 수 있고, "${state.round.name}" 기록으로 저장되어 다음 달 제외 규칙에 쓰여요.`,
      ])
      : a
        ? el('div', { class: 'alert info no-print', text: `${METHOD_LABEL[a.method] || a.method} 초안 · ${fmtDate(a.updatedAt || a.createdAt)}${ui.board.dirty ? ' · 수정 중 (저장 전)' : ''}. 아직 학생에게는 보이지 않아요.` })
        : el('div', { class: 'alert info no-print', text: '아직 배정이 없어요. "규칙 배정"을 누르거나, 아래 "아직 배정 안 됨" 칸의 이름표를 역할 카드로 끌어다 놓아 직접 배정할 수 있어요.' }),
    el('p', { class: 'muted no-print', text: `이름표를 끌어서 다른 역할 카드나 "아직 배정 안 됨" 칸에 놓으면 옮겨져요. 이름표를 한 번 누른 뒤 옮길 카드를 눌러도 되고, 다른 이름표를 누르면 두 학생의 자리가 서로 바뀌어요. 정원이 찬 카드에는 넣을 수 없어요. 빨간 테두리는 지난달(${prev.month || '기록 없음'})과 같은 역할이거나 안 좋은 사이끼리 같은 역할인 경우예요. "?"를 누르면 배정 이유를 볼 수 있어요.` }),
    selecting ? el('div', { class: 'alert warn no-print', text: `${nameOf(ui.board.selected)} 을(를) 골랐어요. 옮길 역할 카드나 "아직 배정 안 됨" 칸을 누르세요. 이름표를 다시 누르면 취소돼요.` }) : null,
    el('div', { class: 'stat-row board-stats no-print' }, [
      statTile('1지망', st.first, '#1e6b32'), statTile('2지망', st.second), statTile('3지망', st.third),
      statTile('지망 외', st.other, st.other ? '#b26a00' : null), statTile('지원서 없음', st.noapp, st.noapp ? '#b26a00' : null), statTile('미배정', st.unassigned, st.unassigned ? '#d63d4f' : null),
    ]),
    vio.length ? el('div', { class: 'no-print' }, [el('b', { style: { color: '#a61b1b' }, text: `주의 ${vio.length}개` }), el('ul', { class: 'violations' }, vio.map((t) => el('li', { text: t })))]) : null,
    (a?.warnings?.length || a?.notes || a?.truncated) ? el('div', { class: 'no-print' }, [
      el('b', { style: { color: '#7a4f00' }, text: '배정할 때 참고한 점' }),
      (a.warnings?.length || a.notes) ? el('ul', { class: 'warnings' }, [...(a.warnings || []).map((t) => el('li', { text: t })), a.notes ? el('li', { text: a.notes }) : null]) : null,
      a.truncated ? el('div', { class: 'truncated-note', text: TRUNCATED_NOTICE }) : null,
    ]) : null,
    el('div', { class: 'print-only print-head' }, [
      el('div', { style: { fontSize: '20px', fontWeight: 800 }, text: `${state.room.name} · ${state.round.name} 1인 1역` }),
      el('div', { class: 'muted', text: a?.published ? `확정 ${fmtDate(a.publishedAt)}` : '초안' }),
    ]),
    bin,
    grid,
  ];
  return sectionCard('board', '자동 배정 · 수정 · 확정', a ? `${METHOD_LABEL[a.method] || a.method} · ${a.published ? '확정·공개됨' : '초안'}` : '아직 배정 전이에요', body, { id: 'board-card', cls: 'roles-board-card' });
}

// ---------- 6. 결과 내보내기 ----------
function exportText() {
  const lines = [`${state.room.name} · ${state.round.name} 1인 1역`, '역할 · 학생', ''];
  for (const r of state.roles) {
    const sids = ui.board.assignments[r.id] || [];
    lines.push(`${r.name}${r.subtitle ? ` (${r.subtitle})` : ''}: ${sids.length ? sids.map(nameOf).join(', ') : '(없음)'}`);
  }
  const un = unassignedStudents();
  if (un.length) lines.push('', `아직 배정 안 됨: ${un.map((s) => s.name).join(', ')}`);
  return lines.join('\n');
}

function renderExport() {
  const text = exportText();
  const body = () => [
    el('p', { class: 'muted', text: '아래 표를 복사해 학급 게시판이나 알림장에 붙여 넣을 수 있어요. "인쇄"를 누르면 배정표만 깔끔하게 인쇄돼요.' }),
    el('div', { class: 'table-wrap' }, [el('table', { class: 'table export-table' }, [
      el('thead', {}, [el('tr', {}, [el('th', { text: '역할' }), el('th', { text: '학생' })])]),
      el('tbody', {}, [
        ...state.roles.map((r) => el('tr', {}, [el('td', { style: { fontWeight: 600, whiteSpace: 'nowrap' }, text: r.name }), el('td', { text: (ui.board.assignments[r.id] || []).map(nameOf).join(', ') || '–' })])),
        unassignedStudents().length ? el('tr', {}, [el('td', { class: 'muted', text: '아직 배정 안 됨' }), el('td', { class: 'muted', text: unassignedStudents().map((s) => s.name).join(', ') })]) : null,
      ]),
    ])]),
    el('div', { class: 'btn-row', style: { marginTop: '10px' } }, [
      el('button', { type: 'button', class: 'btn primary', text: '표 복사', onClick: () => copyText(text) }),
      el('button', { type: 'button', class: 'btn', text: '인쇄', onClick: () => { ui.open.board = true; renderAll(); window.print(); } }),
      ui.board.dirty ? el('span', { class: 'muted', text: '저장하지 않은 수정 내용도 포함돼요.' }) : null,
    ]),
  ];
  return sectionCard('export', '결과 내보내기', '복사하거나 인쇄해요', body, { id: 'export-card', cls: 'no-print' });
}

// ---------- 시작 ----------
window.addEventListener('beforeunload', (e) => { if (isDirty() && !ui.skipGuard) { e.preventDefault(); e.returnValue = ''; } });

/** 첫 데이터. ?round= 가 없는(지워진) 회차면 현재 회차로 대신 엽니다. */
async function loadInitial() {
  try {
    return await api(dataUrl);
  } catch (err) {
    if (!roundParam || err.status !== 404) throw err;
    const next = await api(base);            // 교실 자체가 없으면 여기서 다시 404 → 바깥에서 안내
    roundQuery = '';
    dataUrl = base;
    try { history.replaceState(null, '', location.pathname); } catch { /* 무시 */ }
    toast('그 회차를 찾을 수 없어 현재 회차를 열었어요.', 4000);
    return next;
  }
}

(async () => {
  try {
    state = await loadInitial();
    afterState();
    renderAll();
  } catch (err) {
    setChildren(app, el('section', { class: 'card' }, [
      el('h2', { text: err.status === 404 ? '교실을 찾을 수 없어요' : '불러오지 못했어요' }),
      el('p', { class: 'muted', text: err.message }),
      el('a', { class: 'btn', href: '/', text: '처음으로' }),
    ]));
  }
})();
