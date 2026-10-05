import { api, el, toast, copyText, fmtDate, savedRooms, setChildren, TYPE_LABEL, TYPE_ICON } from './common.js';
import { RelationGraph } from './graph.js';

const adminToken = decodeURIComponent(location.pathname.split('/')[2] || '');
const base = `/api/teacher/${encodeURIComponent(adminToken)}`;
const app = document.getElementById('app');

let state = null;
let graph = null;
let ui = { filter: 'all', highlight: null, selectedEdge: null, showAllPairs: false, panelStudent: null, roundId: null, showAllHistory: false, aiRunning: false, aiOpen: new Set() };
let popoverEl = null;
let pollTimer = null;

const LEVEL_LABEL = { high: '높음', medium: '주의', low: '낮음' };
const RISK_ORDER = { high: 0, medium: 1, low: 2 };
const nameOf = (id) => state?.stats[id]?.name || '?';
const rolesPageUrl = () => `/t/${encodeURIComponent(adminToken)}/roles?round=${encodeURIComponent(state.round.id)}`;
// 역할 목록에서 지워진 역할은 roles.js 와 같은 표기로 보여줍니다
const roleNameOf = (roleId) => (state?.roles || []).find((r) => r.id === roleId)?.name || '(지워진 역할)';
const scrollToGraph = () => document.getElementById('graph-container')?.scrollIntoView({ behavior: 'smooth', block: 'center' });

// ---------- 데이터 ----------
async function load({ silent = false } = {}) {
  try {
    state = await api(ui.roundId ? `${base}?round=${encodeURIComponent(ui.roundId)}` : base);
    ui.roundId = state.round.id;
    savedRooms.add({ name: state.room.name, adminToken, createdAt: state.room.createdAt });
    document.getElementById('last-updated').textContent = `업데이트 ${fmtDate(new Date().toISOString())}`;
    renderAll();
  } catch (err) {
    if (!silent) {
      setChildren(app, el('section', { class: 'card' }, [el('h1', { text: '교실을 열 수 없어요' }), el('p', { text: err.message }), el('a', { class: 'btn', href: '/', text: '처음으로' })]));
    }
  }
}

function applyUpdate(next) {
  state = next;
  ui.roundId = state.round.id;
  renderAll();
}

async function action(promise, okMessage) {
  try {
    const next = await promise;
    if (next && next.room) applyUpdate(next);
    if (okMessage) toast(okMessage);
  } catch (err) {
    toast(err.message, 4000);
  }
}

// ---------- 전체 렌더 ----------
function renderAll() {
  if (!document.getElementById('graph-container')) buildSkeleton();
  renderHeader();
  graph.setData({ students: state.students, relations: state.relations, stats: state.stats });
  graph.setFilter(ui.filter);
  graph.setHighlight(ui.highlight);
  graph.setSelectedEdge(ui.selectedEdge);
  renderSidePanel();
  renderAnalysis();
  renderAiPanel();
  renderHistory();
  renderStudents();
  document.title = `${state.room.name} · ${state.round.name} · 선생님 페이지`;
}

function buildSkeleton() {
  setChildren(app,
    el('section', { class: 'card', id: 'header-card' }),
    el('section', { class: 'card' }, [
      el('div', { class: 'card-title' }, [
        el('h2', { text: '전체 관계도' }),
        el('div', { class: 'legend' }, [
          el('span', {}, [el('span', { class: 'line', style: { background: 'var(--red)' } }), '좋은 사이']),
          el('span', {}, [el('span', { class: 'line', style: { background: 'var(--black)' } }), '안 좋은 사이']),
          el('span', {}, [el('span', { class: 'sw', style: { background: 'var(--node-fill)', border: '2px solid var(--orange)' } }), '연결이 가장 많은 학생']),
          el('span', {}, [el('span', { class: 'sw', style: { background: '#f3f3f8', border: '1px dashed #c9c9d8' } }), '미제출']),
        ]),
      ]),
      el('div', { class: 'graph-toolbar', id: 'graph-toolbar' }),
      el('div', { class: 'grid-2', style: { gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)' } }, [
        el('div', { class: 'graph-wrap', id: 'graph-container' }),
        el('div', { class: 'side-panel', id: 'side-panel' }),
      ]),
      el('p', { class: 'muted', style: { marginTop: '8px' }, text: '화살표를 누르면 이유를 볼 수 있어요. 학생을 누르면 그 학생의 관계만 강조돼요. 빈 곳을 끌면 이동, 마우스 휠로 확대/축소, 학생 상자는 끌어서 옮길 수 있어요. 상자 오른쪽 위 숫자는 연결된 화살표 수예요.' }),
    ]),
    el('section', { class: 'card', id: 'analysis-card' }),
    el('section', { class: 'card ai-panel', id: 'ai-card' }),
    el('section', { class: 'card', id: 'history-card' }),
    el('section', { class: 'card', id: 'students-card' }),
    el('section', { class: 'card', id: 'danger-card' }),
  );
  const container = document.getElementById('graph-container');
  graph = new RelationGraph(container, {
    onEdgeClick: (edge, pt) => { ui.selectedEdge = `${edge.from}>${edge.to}`; graph.setSelectedEdge(ui.selectedEdge); showEdgePopover(edge, pt); },
    onNodeClick: (id) => { closePopover(); ui.selectedEdge = null; setHighlight(ui.highlight?.length === 1 && ui.highlight[0] === id ? null : [id], id); },
    onBackgroundClick: () => { closePopover(); ui.selectedEdge = null; graph.setSelectedEdge(null); },
  });
  renderToolbar();
  // 그래프 컨테이너가 화면에 보일 때 크기가 잡히므로 한 번 더 맞춤
  requestAnimationFrame(() => graph.fit());
  window.addEventListener('resize', () => graph.fit());
}

function setHighlight(ids, panelStudent = null) {
  ui.highlight = ids;
  ui.panelStudent = panelStudent || (ids && ids.length === 1 ? ids[0] : null);
  graph.setHighlight(ids);
  graph.setSelectedEdge(ui.selectedEdge);
  renderSidePanel();
}

function renderToolbar() {
  const bar = document.getElementById('graph-toolbar');
  setChildren(bar,
    ...[['all', '전체'], ['good', '좋은 사이만'], ['bad', '안 좋은 사이만']].map(([f, label]) => el('button', {
      type: 'button', class: `btn small ${ui.filter === f ? 'primary' : ''}`, text: label,
      onClick: () => { ui.filter = f; renderToolbar(); graph.setFilter(f); },
    })),
    el('span', { style: { flex: 1 } }),
    el('button', { type: 'button', class: 'btn small', text: '－', title: '축소', onClick: () => graph.zoom(1.25) }),
    el('button', { type: 'button', class: 'btn small', text: '＋', title: '확대', onClick: () => graph.zoom(0.8) }),
    el('button', { type: 'button', class: 'btn small', text: '화면에 맞추기', onClick: () => graph.fit() }),
    el('button', { type: 'button', class: 'btn small', text: '배치 다시 계산', onClick: () => graph.resetLayout() }),
    el('button', { type: 'button', class: 'btn small', text: '강조 해제', onClick: () => { closePopover(); ui.selectedEdge = null; setHighlight(null); } }),
  );
}

// ---------- 헤더 ----------
function suggestRoundName() {
  const d = new Date();
  const base0 = `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
  if (!state.rounds.some((r) => r.name === base0)) return base0;
  const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  const base1 = `${next.getFullYear()}년 ${next.getMonth() + 1}월`;
  return state.rounds.some((r) => r.name === base1) ? `${base0} (2)` : base1;
}

function renderHeader() {
  const { room, analysis, students, round, rounds } = state;
  const card = document.getElementById('header-card');
  const pct = students.length ? Math.round((analysis.submittedCount / students.length) * 100) : 0;
  const isCurrent = round.id === state.currentRoundId;
  const soon = new Set((state.retention?.expiring || []).map((x) => x.id));
  const hasRoles = (state.roles || []).length > 0;
  const appCount = students.filter((s) => (state.applications?.[s.id]?.choices || []).length > 0).length;
  const assignment = state.roleAssignment;
  const roundSelect = el('select', { class: 'select' }, rounds.map((r) => el('option', {
    value: r.id, selected: r.id === round.id ? true : null,
    text: `${r.name} · ${r.open ? '진행 중' : '마감'} · 제출 ${r.submitted}/${r.total}${soon.has(r.id) ? ` · ⚠️ ${fmtDay(r.expiresAt)} 삭제 예정` : ''}`,
  })));
  roundSelect.addEventListener('change', () => { ui.roundId = roundSelect.value; closePopover(); ui.selectedEdge = null; ui.highlight = null; ui.panelStudent = null; load(); });
  setChildren(card,
    el('div', { class: 'card-title' }, [
      el('div', {}, [
        el('h1', { text: room.name }),
        el('div', { class: 'muted', text: `만든 날짜 ${fmtDate(room.createdAt)} · 꼭 표시: 좋은 사이 ${room.minGood}명, 안 좋은 사이 ${room.minBad}명 · 회차 ${rounds.length}개` }),
      ]),
      el('div', { class: 'btn-row' }, [
        el('a', { class: 'btn primary', href: `/t/${encodeURIComponent(adminToken)}/print`, target: '_blank', text: '학생 QR 카드 인쇄' }),
        el('a', { class: 'btn orange', href: `/t/${encodeURIComponent(adminToken)}/seats?round=${encodeURIComponent(round.id)}`, text: '자리 배정' }),
        el('span', { class: 'role-link-wrap' }, [
          el('a', { class: 'btn green', id: 'roles-link', href: rolesPageUrl(), text: '1인 1역' }),
          hasRoles ? el('span', {
            class: `badge ${students.length && appCount >= students.length ? 'green' : 'blue'}`, id: 'application-count',
            title: `${round.name} 1인 1역 지원서를 낸 학생 수`, text: `지원서 ${appCount}/${students.length}`,
          }) : null,
        ]),
        el('a', { class: 'btn', href: `${base}/export.csv`, text: 'CSV 내보내기' }),
        el('a', { class: 'btn', href: `${base}/export.json`, text: 'JSON 내보내기' }),
        el('button', { type: 'button', class: 'btn', text: '새로고침', onClick: () => load() }),
      ]),
    ]),
    el('div', { class: 'round-bar' }, [
      el('span', { style: { fontWeight: 700 }, text: '보고 있는 회차' }),
      roundSelect,
      isCurrent
        ? el('span', { class: `badge ${round.open ? 'green' : 'gray'}`, text: round.open ? '학생이 지금 답하는 회차' : '마감됨' })
        : el('span', { class: 'badge warn', text: '지난 회차 (읽기 전용)' }),
      assignment?.published
        ? el('span', { class: 'badge green', id: 'roles-published-badge', title: `${fmtDate(assignment.publishedAt)} 공개 · 학생 페이지에 자기 역할이 보여요`, text: '1인 1역 공개됨' })
        : (assignment ? el('span', { class: 'badge gray', id: 'roles-draft-badge', title: '배정 초안이 있지만 아직 학생에게 공개하지 않았어요', text: '1인 1역 초안' }) : null),
      el('span', { style: { flex: 1 } }),
      isCurrent ? el('button', { type: 'button', class: `btn small ${round.open ? 'danger' : ''}`, text: round.open ? '이 회차 마감' : '마감 해제', onClick: () => {
        if (round.open && !confirm(`${round.name} 조사를 마감하면 학생들이 더 이상 수정할 수 없어요. 마감할까요?`)) return;
        action(api(`${base}/rounds/${encodeURIComponent(round.id)}`, { method: 'PATCH', body: { closed: round.open } }), round.open ? '마감했어요.' : '마감을 해제했어요.');
      } }) : null,
      el('button', { type: 'button', class: 'btn small primary', text: '새 회차 시작', onClick: () => {
        const name = prompt('새 회차 이름을 입력하세요. 지금 회차는 자동으로 마감되고, 학생들은 빈 화면에서 새로 표시해요. 학생 QR은 그대로 쓸 수 있어요.', suggestRoundName());
        if (name === null || !name.trim()) return;
        action(api(`${base}/rounds`, { method: 'POST', body: { name: name.trim() } }), `${name.trim()} 조사를 시작했어요.`);
      } }),
      el('button', { type: 'button', class: 'btn small', text: '이름 바꾸기', onClick: () => {
        const name = prompt('회차 이름', round.name);
        if (name === null || !name.trim() || name.trim() === round.name) return;
        action(api(`${base}/rounds/${encodeURIComponent(round.id)}`, { method: 'PATCH', body: { name: name.trim() } }), '이름을 바꿨어요.');
      } }),
      rounds.length > 1 ? el('button', { type: 'button', class: 'btn small danger', text: '회차 삭제', onClick: () => {
        if (!confirm(`${round.name} 회차와 그 응답을 모두 지울까요? 되돌릴 수 없어요.`)) return;
        action(api(`${base}/rounds/${encodeURIComponent(round.id)}`, { method: 'DELETE' }), '회차를 지웠어요.');
      } }) : null,
    ]),
    el('div', { class: 'stat-row' }, [
      stat('제출', `${analysis.submittedCount} / ${students.length}명`, `${pct}%`),
      stat('좋은 사이 화살표', `${analysis.goodCount}개`, `서로 좋은 사이 ${analysis.mutualGood}쌍`),
      stat('안 좋은 사이 화살표', `${analysis.badCount}개`, `서로 안 좋은 사이 ${analysis.mutualBad}쌍`),
      stat('고립 위험', analysis.isolated.length ? analysis.isolated.join(', ') : '없음', '좋은 사이로 지목받지 못한 학생'),
    ]),
    isCurrent && !round.open ? el('div', { class: 'alert warn', style: { marginTop: '12px', marginBottom: 0 }, text: `${round.name} 조사가 마감된 상태예요. 학생 페이지는 읽기 전용이에요. 다음 조사를 하려면 "새 회차 시작"을 누르세요.` }) : null,
    retentionNotice(),
    state.notice ? el('div', { class: 'alert error', style: { marginTop: '12px', marginBottom: 0 }, text: `⚠️ ${state.notice}` }) : null,
  );
}

function fmtDay(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
}

// 보관 정책: 14개월이 지난 회차는 자동 삭제. 미리 알리고 내보내기를 권함
function retentionNotice() {
  const r = state.retention;
  if (!r) return null;
  const exportBtns = el('div', { class: 'btn-row', style: { marginTop: '8px' } }, [
    el('a', { class: 'btn small primary', href: `${base}/export.csv`, text: 'CSV 내보내기' }),
    el('a', { class: 'btn small', href: `${base}/export.json`, text: 'JSON 내보내기 (전체 회차·분석 포함)' }),
  ]);
  const parts = [];
  if (r.expiring.length) {
    parts.push(el('div', { class: 'alert error', style: { marginTop: '12px', marginBottom: 0 } }, [
      el('div', { style: { fontWeight: 700 }, text: `⚠️ 곧 삭제되는 회차가 있어요. 보관하려면 지금 내보내 두세요.` }),
      el('ul', { style: { margin: '6px 0 0', paddingLeft: '18px' } }, r.expiring.map((x) => el('li', { text: `${x.name} 회차 → ${fmtDay(x.expiresAt)}에 자동 삭제` }))),
      exportBtns,
    ]));
  }
  const recent = (r.log || []).slice(-3).reverse();
  parts.push(el('div', { class: 'muted', style: { marginTop: '10px', fontSize: '13px' } }, [
    `🗓️ 보관 정책: 조사 응답은 마감 뒤 ${r.months}개월이 지나면 자동으로 삭제돼요. 교실 전체가 ${r.months}개월 동안 사용되지 않으면 교실도 삭제돼요. 오래 보관하려면 CSV/JSON으로 내보내 두세요.`,
    recent.length ? el('div', { style: { marginTop: '4px' }, text: `최근 자동 삭제: ${recent.map((x) => `${x.name} (${fmtDay(x.deletedAt)}, 응답 ${x.submitted}명)`).join(' · ')}` }) : null,
  ]));
  return el('div', {}, parts);
}

function stat(label, value, sub) {
  return el('div', { class: 'stat' }, [el('div', { class: 'label', text: label }), el('div', { class: 'value', text: value }), sub ? el('div', { class: 'muted', style: { fontSize: '12px' }, text: sub }) : null]);
}

// ---------- 화살표 팝오버 ----------
function showEdgePopover(edge, pt) {
  closePopover();
  const container = document.getElementById('graph-container');
  const reverse = state.relations.find((r) => r.from === edge.to && r.to === edge.from);
  const box = el('div', { class: 'popover' }, [
    el('button', { type: 'button', class: 'close', text: '×', 'aria-label': '닫기', onClick: () => { closePopover(); ui.selectedEdge = null; graph.setSelectedEdge(null); } }),
    el('div', { class: 'row' }, [el('b', { text: `${nameOf(edge.from)} → ${nameOf(edge.to)}` }), ' ', el('span', { class: `badge ${edge.type}`, text: `${TYPE_ICON[edge.type]} ${TYPE_LABEL[edge.type]}` })]),
    edge.tagLabels.length ? el('div', { class: 'chips row' }, edge.tagLabels.map((t) => el('span', { class: `chip selected ${edge.type === 'bad' ? 'bad-theme' : 'good-theme'}`, text: t, style: { padding: '4px 10px', fontSize: '13px' } }))) : null,
    edge.reason ? el('div', { class: 'reason-text', text: edge.reason }) : (!edge.tagLabels.length ? el('div', { class: 'muted', text: '적은 이유가 없어요.' }) : null),
    el('div', { class: 'muted', style: { marginTop: '6px', fontSize: '12px' }, text: `수정 ${fmtDate(edge.updatedAt)}` }),
    reverse
      ? el('div', { class: 'row', style: { marginTop: '8px', borderTop: '1px solid var(--gray-200)', paddingTop: '8px' } }, [
        el('span', { class: 'muted', text: '반대 방향: ' }),
        el('b', { text: `${nameOf(reverse.from)} → ${nameOf(reverse.to)}` }), ' ',
        el('span', { class: `badge ${reverse.type}`, text: `${TYPE_ICON[reverse.type]} ${TYPE_LABEL[reverse.type]}` }),
        el('button', { type: 'button', class: 'btn small', style: { marginLeft: '6px' }, text: '보기', onClick: () => { ui.selectedEdge = `${reverse.from}>${reverse.to}`; graph.setSelectedEdge(ui.selectedEdge); showEdgePopover(reverse, pt); } }),
      ])
      : el('div', { class: 'muted', style: { marginTop: '8px', fontSize: '12px' }, text: `${nameOf(edge.to)}은(는) ${nameOf(edge.from)}을(를) 표시하지 않았어요.` }),
  ]);
  container.append(box);
  popoverEl = box;
  const cw = container.clientWidth;
  const ch = container.clientHeight;
  const bw = box.offsetWidth;
  const bh = box.offsetHeight;
  box.style.left = `${Math.max(6, Math.min(cw - bw - 6, pt.x + 10))}px`;
  box.style.top = `${Math.max(6, Math.min(ch - bh - 6, pt.y + 10))}px`;
}

function closePopover() {
  popoverEl?.remove();
  popoverEl = null;
}

// ---------- 학생 상세 패널 ----------
function renderSidePanel() {
  const panel = document.getElementById('side-panel');
  const id = ui.panelStudent;
  if (!id || !state.stats[id]) {
    const top = [...state.students].sort((a, b) => state.stats[b.id].degree - state.stats[a.id].degree).slice(0, 5);
    setChildren(panel,
      el('h3', { text: '학생을 선택하세요' }),
      el('p', { class: 'muted', text: '관계도에서 학생 상자를 누르거나 아래 이름을 누르면 그 학생의 관계와 이유를 자세히 볼 수 있어요.' }),
      el('div', { class: 'muted', style: { fontWeight: 600, marginBottom: '4px' }, text: '연결이 많은 학생' }),
      el('ul', {}, top.map((s) => el('li', {}, [el('a', { href: '#', text: `${s.name} (${state.stats[s.id].degree})`, onClick: (e) => { e.preventDefault(); setHighlight([s.id], s.id); } })]))),
    );
    return;
  }
  const st = state.stats[id];
  const risk = state.analysis.studentRisk[id];
  const myPairs = state.analysis.pairs.filter((p) => (p.a === id || p.b === id) && (p.ab === 'bad' || p.ba === 'bad'));
  const relOf = (from, to) => state.relations.find((r) => r.from === from && r.to === to);
  const line = (from, to) => {
    const r = relOf(from, to);
    const detail = [...r.tagLabels, r.reason].filter(Boolean).join(', ');
    return el('li', {}, [el('a', { href: '#', text: nameOf(from === id ? to : from), onClick: (e) => { e.preventDefault(); setHighlight([from === id ? to : from]); } }), detail ? el('span', { class: 'muted', text: ` · ${detail}` }) : null]);
  };
  setChildren(panel,
    el('h3', {}, [el('span', { text: st.name }), el('button', { type: 'button', class: 'btn small', text: '닫기', onClick: () => setHighlight(null) })]),
    el('div', { style: { marginBottom: '8px' } }, [
      el('span', { class: `badge ${st.submitted ? 'green' : 'warn'}`, text: st.submitted ? `제출 ${fmtDate(st.submittedAt)}` : '미제출' }), ' ',
      risk.flags.includes('isolated') ? el('span', { class: 'badge high', text: '고립 위험' }) : null, ' ',
      risk.flags.includes('targeted') ? el('span', { class: 'badge high', text: '여러 명이 안 좋게 지목' }) : null, ' ',
      risk.flags.includes('many-conflicts') ? el('span', { class: 'badge warn', text: '안 좋은 사이 다수 표시' }) : null,
    ]),
    el('div', { class: 'stat-row', style: { marginBottom: '10px' } }, [
      stat('받은 ❤️', st.inGood.length), stat('받은 ⚡', st.inBad.length), stat('준 ❤️', st.outGood.length), stat('준 ⚡', st.outBad.length),
    ]),
    teacherNoteBox(id),
    rolesInfoBox(id),
    state.history.trend.length > 1 ? el('div', { class: 'muted', style: { fontSize: '13px', marginBottom: '10px' }, text: `회차별 받은 ❤️/⚡: ${state.history.students.find((s) => s.id === id).rounds.map((r, i) => `${state.history.trend[i].name.replace(/^\d{4}년 /, '')} ${r.inGood}/${r.inBad}`).join(' · ')}` }) : null,
    section('나를 좋은 사이로 표시한 친구', st.inGood.map((f) => line(f, id))),
    section('나를 안 좋은 사이로 표시한 친구', st.inBad.map((f) => line(f, id))),
    section('내가 좋은 사이로 표시한 친구', st.outGood.map((t) => line(id, t))),
    section('내가 안 좋은 사이로 표시한 친구', st.outBad.map((t) => line(id, t))),
    myPairs.length ? el('div', {}, [
      el('div', { class: 'muted', style: { fontWeight: 600 }, text: '갈등 가능성' }),
      el('ul', {}, myPairs.map((p) => el('li', {}, [
        el('a', { href: '#', text: `${nameOf(p.a === id ? p.b : p.a)}`, onClick: (e) => { e.preventDefault(); setHighlight([p.a, p.b], id); } }),
        ' ', el('span', { class: `badge ${p.level}`, text: `${p.probability}% · ${LEVEL_LABEL[p.level]}` }),
      ]))),
    ]) : null,
  );
  function teacherNoteBox(sid) {
    const n = state.teacherNotes?.students?.[sid];
    const myRules = (state.teacherNotes?.rules || []).filter((r) => r.a === sid || r.b === sid);
    if (!n && !myRules.length) return null;
    return el('div', { class: 'alert info', style: { marginBottom: '10px' } }, [
      el('div', { style: { fontWeight: 600 }, text: '교사 메모' }),
      n?.front ? el('div', { text: '👓 앞자리 필요' }) : null,
      n?.memo ? el('div', { text: `📝 ${n.memo}` }) : null,
      ...myRules.map((r) => el('div', { text: `${r.type === 'apart' ? '↔ 떨어뜨리기' : '⇢ 가까이 앉히기'}: ${nameOf(r.a === sid ? r.b : r.a)}${r.note ? ` · ${r.note}` : ''}` })),
      el('a', { href: `/t/${encodeURIComponent(adminToken)}/seats`, class: 'muted', style: { fontSize: '12px' }, text: '자리 배정 페이지에서 수정' }),
    ]);
  }
  function section(title, items) {
    return el('div', {}, [el('div', { class: 'muted', style: { fontWeight: 600 }, text: `${title} (${items.length})` }), items.length ? el('ul', {}, items) : el('p', { class: 'muted', style: { marginLeft: '4px' }, text: '없음' })]);
  }
}

// 학생 패널: 성향 설문 · 1인 1역 지원서 · 배정 · AI 요약
function rolesInfoBox(sid) {
  const traitLabel = new Map((state.traits || []).map((t) => [t.id, t.label]));
  const hasRoles = (state.roles || []).length > 0;
  const profile = state.profiles?.[sid] || null;
  const application = state.applications?.[sid] || null;
  const choices = application?.choices || [];
  const assignment = state.roleAssignment || null;
  let assignedRoleId = null;
  for (const [roleId, sids] of Object.entries(assignment?.assignments || {})) if ((sids || []).includes(sid)) assignedRoleId = roleId;
  const prevMonth = state.previousRoles?.month || null;
  const prevRoleIds = state.previousRoles?.byStudent?.[sid] || [];
  const aiStudent = (state.aiAnalysis?.students || []).find((s) => s.id === sid) || null;
  // 학생 페이지의 .trait-chip(버튼)과 이름이 겹치지 않도록 선생님 화면 전용 클래스를 씁니다
  const chips = (ids, cls) => el('div', { class: 'chips profile-chips' }, ids.map((t) => el('span', { class: `profile-chip ${cls}`, text: traitLabel.get(t) || t })));
  const label = (text) => el('div', { class: 'label', text });

  const profileBlock = profile
    ? [
      label(`나의 성향 (${(profile.traits || []).length}) · ${fmtDate(profile.updatedAt)}`),
      (profile.traits || []).length ? chips(profile.traits, '') : el('div', { class: 'muted', text: '고른 항목이 없어요.' }),
      ...((profile.partnerTraits || []).length ? [label('짝에게 바라는 점'), chips(profile.partnerTraits, 'partner')] : []),
      profile.partnerText ? el('div', { class: 'quote', text: `“${profile.partnerText}”` }) : null,
    ]
    : [el('div', { class: 'muted', text: '성향 설문을 아직 내지 않았어요.' })];

  const applicationBlock = choices.length
    ? [
      label(`1인 1역 지원서 · ${fmtDate(application.updatedAt)}`),
      el('ol', { class: 'app-choices' }, choices.map((c, i) => el('li', {}, [
        el('span', { class: `rank r${i + 1}`, text: `${i + 1}지망` }),
        el('b', { text: roleNameOf(c.roleId) }),
        c.reason ? el('div', { class: 'app-reason', text: c.reason }) : null,
        c.helpClass ? el('div', { class: 'muted app-help', text: `우리 반에: ${c.helpClass}` }) : null,
        c.helpSelf ? el('div', { class: 'muted app-help', text: `나에게: ${c.helpSelf}` }) : null,
      ]))),
    ]
    : [label('1인 1역 지원서'), el('div', { class: 'muted', text: hasRoles ? '지원서 없음' : '아직 역할 목록이 없어요. 1인 1역 페이지에서 역할을 만들면 학생이 지원할 수 있어요.' })];

  const assignedBlock = assignedRoleId
    ? el('div', { class: 'assigned-role' }, [
      label('이번 달 배정'),
      el('span', { class: 'role-chip', text: roleNameOf(assignedRoleId) }), ' ',
      el('span', { class: `badge ${assignment.published ? 'green' : 'warn'}`, text: assignment.published ? '공개됨' : '초안 · 학생에게는 아직 안 보여요' }),
      assignment.explanations?.[sid] ? el('div', { class: 'muted', style: { fontSize: '13px', marginTop: '4px' }, text: assignment.explanations[sid] }) : null,
    ])
    : (assignment ? el('div', { class: 'muted', style: { marginTop: '6px' }, text: '이번 달 배정 초안에 아직 들어 있지 않아요.' }) : null);

  return el('div', { class: 'roles-info', id: 'roles-info' }, [
    el('div', { class: 'roles-info-title', text: '📝 성향 · 1인 1역' }),
    ...profileBlock,
    ...applicationBlock,
    prevRoleIds.length ? el('div', { class: 'muted', style: { fontSize: '13px', marginTop: '6px' }, text: `지난달${prevMonth ? `(${prevMonth})` : ''} 역할: ${prevRoleIds.map(roleNameOf).join(', ')} → 이번 달은 다른 역할을 맡아요.` }) : null,
    assignedBlock,
    aiStudent ? el('div', { class: 'ai-mini' }, [
      el('div', { style: { fontWeight: 700, marginBottom: '2px' }, text: '🤖 AI 요약' }),
      aiStudent.summary ? el('div', { text: aiStudent.summary }) : null,
      aiStudent.watch ? el('div', { class: 'muted', style: { fontSize: '13px', marginTop: '2px' }, text: `👀 ${aiStudent.watch}` }) : null,
      (aiStudent.roleFit || []).length ? el('div', { class: 'muted', style: { fontSize: '13px', marginTop: '2px' }, text: `추천 역할: ${aiStudent.roleFit.map((f) => roleNameOf(f.roleId)).join(', ')}` }) : null,
    ]) : null,
    el('div', { style: { marginTop: '8px' } }, [el('a', { class: 'btn small', href: rolesPageUrl(), text: '1인 1역 페이지에서 배정하기' })]),
  ]);
}

// ---------- 갈등 분석 ----------
function renderAnalysis() {
  const card = document.getElementById('analysis-card');
  const a = state.analysis;
  const pairs = a.pairs.filter((p) => p.ab === 'bad' || p.ba === 'bad');
  const shown = ui.showAllPairs ? pairs : pairs.slice(0, 8);
  const arrowText = (p) => {
    const parts = [];
    if (p.ab !== 'none') parts.push(`${p.aName} ${TYPE_ICON[p.ab]}→ ${p.bName}`);
    if (p.ba !== 'none') parts.push(`${p.bName} ${TYPE_ICON[p.ba]}→ ${p.aName}`);
    return parts.join(' · ');
  };
  setChildren(card,
    el('div', { class: 'card-title' }, [el('h2', { text: '갈등 가능성 분석' }), el('span', { class: 'muted', text: `${a.submittedCount}명 응답 기준` })]),
    el('div', { class: 'alert info', text: '학생들의 응답(관계 방향, 이유의 심각도, 공통 친구, 지목 횟수, 고립 여부)을 바탕으로 앞으로 갈등이 생길 가능성을 추정한 참고용 수치예요. 학생을 판단하는 근거가 아니라, 먼저 관심을 기울일 관계를 찾는 도구로 활용해 주세요.' }),
    el('div', { class: 'grid-2' }, [
      el('div', {}, [
        el('h3', { text: '주의가 필요한 관계' }),
        pairs.length === 0 ? el('p', { class: 'muted', text: '안 좋은 사이로 표시된 관계가 아직 없어요.' }) : null,
        ...shown.map((p) => el('div', { class: `pair ${p.level}` }, [
          el('div', { class: 'pair-head' }, [
            el('div', { class: 'names' }, [
              el('a', { href: '#', text: `${p.aName} ↔ ${p.bName}`, style: { textDecoration: 'none', color: 'inherit' }, onClick: (e) => { e.preventDefault(); setHighlight([p.a, p.b], p.a); scrollToGraph(); } }),
              el('div', { class: 'arrow-mini', text: arrowText(p) }),
            ]),
            el('span', { class: `badge ${p.level}`, text: LEVEL_LABEL[p.level] }),
            el('div', { class: 'pct', text: `${p.probability}%` }),
          ]),
          el('div', { class: 'pair-bar' }, [el('div', { style: { width: `${p.probability}%` } })]),
          el('ul', {}, p.factors.map((f) => el('li', { text: f.delta ? `${f.label} (+${f.delta})` : f.label }))),
        ])),
        pairs.length > 8 ? el('button', { type: 'button', class: 'btn small', text: ui.showAllPairs ? '접기' : `${pairs.length - 8}개 더 보기`, onClick: () => { ui.showAllPairs = !ui.showAllPairs; renderAnalysis(); } }) : null,
      ]),
      el('div', {}, [
        el('h3', { text: '한눈에 보기' }),
        el('div', { class: 'side-panel' }, [
          el('div', { class: 'muted', style: { fontWeight: 600 }, text: '좋은 사이로 많이 지목된 학생' }),
          a.mostLiked.length ? el('ul', {}, a.mostLiked.map((s) => el('li', { text: `${s.name} · ${s.count}명` }))) : el('p', { class: 'muted', text: '아직 없어요.' }),
          el('div', { class: 'muted', style: { fontWeight: 600 }, text: '안 좋은 사이로 많이 지목된 학생' }),
          a.mostDisliked.length ? el('ul', {}, a.mostDisliked.map((s) => el('li', { text: `${s.name} · ${s.count}명` }))) : el('p', { class: 'muted', text: '아직 없어요.' }),
          el('div', { class: 'muted', style: { fontWeight: 600 }, text: '고립 위험 (좋은 사이로 지목받지 못함)' }),
          a.isolated.length ? el('ul', {}, a.isolated.map((n) => el('li', { text: n }))) : el('p', { class: 'muted', text: a.submittedCount >= 3 ? '없어요.' : '응답이 3명 이상 모이면 계산해요.' }),
          el('div', { class: 'muted', style: { fontWeight: 600 }, text: '계산 방식' }),
          el('ul', { class: 'muted', style: { fontSize: '13px' } }, [
            el('li', { text: '서로 안 좋은 사이 78% · 한쪽만 안 좋은 사이 48% · 한쪽은 좋고 한쪽은 안 좋음 40% 에서 시작' }),
            el('li', { text: '이유의 심각도(때리거나 괴롭힘, 따돌림, 험담, 싸움 등)에 따라 최대 +25' }),
            el('li', { text: '공통 친구가 많으면 +4/명 (최대 +12), 3명 이상에게 안 좋게 지목된 학생 +6, 고립 위험 학생 +5' }),
            el('li', { text: '70% 이상 높음 · 40% 이상 주의 · 그 미만 낮음' }),
          ]),
        ]),
      ]),
    ]),
  );
}

// ---------- AI 관계·역할 분석 ----------
async function runAiAnalysis() {
  if (ui.aiRunning) return;
  ui.aiRunning = true;
  renderAiPanel();
  try {
    const next = await api(`${base}/ai/analyze`, { method: 'POST', body: { roundId: state.round.id } });
    ui.aiRunning = false;
    if (next && next.room && ui.roundId !== next.round.id) {
      // 기다리는 동안 다른 회차로 옮겨 갔으면 보고 있는 회차를 그대로 두고 조용히 새로 받습니다
      toast(`${next.round.name} 분석을 마쳤어요.`);
      renderAiPanel();
      load({ silent: true });
      return;
    }
    if (next && next.room) applyUpdate(next);
    toast('AI 분석을 마쳤어요.');
  } catch (err) {
    ui.aiRunning = false;
    toast(err.message, 5000);
    renderAiPanel();
  }
}

function renderAiPanel() {
  const card = document.getElementById('ai-card');
  const enabled = Boolean(state.ai?.enabled);
  const a = state.aiAnalysis || null;
  const levelOf = (lv) => (LEVEL_LABEL[lv] ? lv : 'low');
  // 분석 뒤에 삭제된 학생이 섞여 있을 수 있으므로 지금 있는 학생만 남깁니다
  const exists = (id) => Boolean(state.stats[id]);
  const pairs = (a?.pairs || []).filter((p) => exists(p.a) && exists(p.b)).sort((x, y) => (RISK_ORDER[x.riskLevel] ?? 2) - (RISK_ORDER[y.riskLevel] ?? 2));
  const byId = new Map((a?.students || []).filter((s) => exists(s.id)).map((s) => [s.id, s]));
  const aiStudents = state.students.map((s) => ({ s, info: byId.get(s.id) })).filter((x) => x.info);
  for (const id of [...ui.aiOpen]) if (!exists(id)) ui.aiOpen.delete(id);
  const allOpen = aiStudents.length > 0 && aiStudents.every((x) => ui.aiOpen.has(x.s.id));

  const controls = enabled
    ? el('div', { class: 'ai-controls' }, [
      el('button', { type: 'button', class: 'btn primary', id: 'ai-run-btn', disabled: ui.aiRunning ? true : null, text: a ? '다시 분석' : 'AI 분석 실행', onClick: runAiAnalysis }),
      ui.aiRunning ? el('span', { class: 'ai-running', role: 'status', id: 'ai-running' }, [el('span', { class: 'spin', 'aria-hidden': 'true' }), 'AI가 읽는 중이에요… 30초~1분 정도 걸려요']) : null,
      el('span', { class: 'muted ai-privacy', text: '🔒 학생 이름은 S1, S2 같은 가명으로 바꿔서 보내고, 결과만 저장해요.' }),
    ])
    : el('div', { class: 'alert info', id: 'ai-disabled', style: { marginBottom: a ? '12px' : 0 } }, [
      el('div', { style: { fontWeight: 700 }, text: 'AI 분석은 아직 꺼져 있어요.' }),
      el('div', { text: '서버 환경 변수 ANTHROPIC_API_KEY 를 설정하면 학생들의 관계·성향·지원서를 함께 읽고, 갈등 가능성과 어울리는 역할을 풀어서 설명해 줘요. 그 전까지는 위의 규칙 기반 갈등 분석을 사용해요.' }),
      el('div', { style: { marginTop: '4px', fontSize: '13px' }, text: '설정 방법은 README 참고' }),
    ]);

  const pairEl = (p) => {
    const lv = levelOf(p.riskLevel);
    return el('div', { class: `ai-pair ${lv}` }, [
      el('div', { class: 'ai-pair-head' }, [
        el('a', { href: '#', class: 'names', text: `${nameOf(p.a)} ↔ ${nameOf(p.b)}`, onClick: (e) => { e.preventDefault(); setHighlight([p.a, p.b], p.a); scrollToGraph(); } }),
        el('span', { class: `badge ${lv}`, text: LEVEL_LABEL[lv] }),
        p.conflictType ? el('span', { class: 'conflict-type', text: p.conflictType }) : null,
      ]),
      p.analysis ? el('p', { class: 'ai-text', text: p.analysis }) : el('p', { class: 'ai-text muted', text: '설명이 비어 있어요.' }),
      p.advice ? el('div', { class: 'ai-advice' }, [el('div', { class: 'ai-advice-label', text: '💡 이렇게 해 보세요' }), el('div', { text: p.advice })]) : null,
    ]);
  };

  const studentEl = ({ s, info }) => {
    const fit = info.roleFit || [];
    const empty = !info.summary && !info.strengths && !info.watch && !fit.length;
    return el('details', {
      class: 'ai-student', open: ui.aiOpen.has(s.id) ? true : null,
      onToggle: (e) => { if (e.target.open) ui.aiOpen.add(s.id); else ui.aiOpen.delete(s.id); },
    }, [
      el('summary', {}, [
        el('b', { text: s.name }),
        fit.length ? el('span', { class: 'muted', text: `추천 역할: ${fit.slice(0, 2).map((f) => roleNameOf(f.roleId)).join(', ')}` }) : null,
      ]),
      el('div', { class: 'ai-student-body' }, [
        info.summary ? el('p', { text: info.summary }) : null,
        info.strengths ? el('div', { class: 'ai-line' }, [el('b', { text: '💪 강점: ' }), info.strengths]) : null,
        info.watch ? el('div', { class: 'ai-line' }, [el('b', { text: '👀 살펴볼 점: ' }), info.watch]) : null,
        fit.length ? el('div', { class: 'chips role-chips' }, fit.map((f) => el('span', { class: 'role-chip', title: f.reason || '' }, [
          el('b', { text: roleNameOf(f.roleId) }),
          f.reason ? el('span', { class: 'reason', text: ` — ${f.reason}` }) : null,
        ]))) : null,
        empty ? el('p', { class: 'muted', text: '이 학생에 대한 내용이 비어 있어요.' }) : null,
        el('a', { href: '#', class: 'muted', style: { fontSize: '12px' }, text: '관계도에서 보기', onClick: (e) => { e.preventDefault(); setHighlight([s.id], s.id); scrollToGraph(); } }),
      ]),
    ]);
  };

  const results = a ? [
    el('div', { class: 'ai-meta muted', id: 'ai-meta' }, [
      `분석 ${fmtDate(a.createdAt)}${a.model ? ` · 모델 ${a.model}` : ''} · ${state.round.name} 회차`,
      a.truncated ? el('span', { class: 'ai-truncated', id: 'ai-truncated', text: ' · ⚠️ 자료가 길어 AI에 보낸 내용 일부가 생략됐어요.' }) : null,
    ]),
    el('div', { class: 'ai-summary' }, [
      el('div', { class: 'ai-summary-label', text: '학급 전체 요약' }),
      el('p', { text: a.summary || '요약이 비어 있어요.' }),
    ]),
    el('div', { class: 'grid-2' }, [
      el('div', {}, [
        el('h3', { text: `주의가 필요한 관계 (${pairs.length})` }),
        pairs.length ? el('div', { id: 'ai-pairs' }, pairs.map(pairEl)) : el('p', { class: 'muted', text: 'AI가 특별히 주의할 관계를 찾지 못했어요.' }),
      ]),
      el('div', {}, [
        el('div', { class: 'card-title', style: { marginBottom: '4px' } }, [
          el('h3', { style: { margin: 0 }, text: `학생별 분석 (${aiStudents.length})` }),
          aiStudents.length ? el('button', {
            type: 'button', class: 'btn small', id: 'ai-toggle-all', text: allOpen ? '모두 접기' : '모두 펼치기',
            onClick: () => { ui.aiOpen = allOpen ? new Set() : new Set(aiStudents.map((x) => x.s.id)); renderAiPanel(); },
          }) : null,
        ]),
        aiStudents.length ? el('div', { id: 'ai-students' }, aiStudents.map(studentEl)) : el('p', { class: 'muted', text: '학생별 내용이 없어요.' }),
      ]),
    ]),
    el('p', { class: 'muted', style: { marginTop: '10px', marginBottom: 0 }, text: 'AI 분석은 참고용이에요. 학생을 판단하는 근거가 아니라 먼저 살펴볼 관계와 어울리는 역할을 찾는 도구로 써 주세요. 학생이 답을 고치면 "다시 분석"으로 새로 받을 수 있어요.' }),
  ] : [
    enabled ? el('p', { class: 'muted', style: { marginBottom: 0 }, text: '아직 분석 결과가 없어요. "AI 분석 실행"을 누르면 이번 회차의 관계도, 성향 설문, 1인 1역 지원서, 교사 메모를 함께 읽고 학급 요약·주의할 관계·학생별 역할 추천을 만들어요.' }) : null,
  ];

  setChildren(card,
    el('div', { class: 'card-title' }, [
      el('h2', { text: '🤖 AI 관계·역할 분석' }),
      el('span', { class: 'muted', text: enabled ? (a ? `마지막 분석 ${fmtDate(a.createdAt)}` : '아직 분석 전') : '꺼져 있음' }),
    ]),
    controls,
    ...results,
  );
}

// ---------- 회차별 변화 분석 ----------
function renderHistory() {
  const card = document.getElementById('history-card');
  const h = state.history;
  const short = (name) => name.replace(/^\d{4}년 /, '');
  if (!h || h.trend.length < 2) {
    setChildren(card,
      el('div', { class: 'card-title' }, [el('h2', { text: '회차별 변화 분석' })]),
      el('p', { class: 'muted', text: '회차가 2개 이상 되면 달마다 관계가 어떻게 변했는지 여기에서 비교할 수 있어요. 다음 달 조사는 위의 "새 회차 시작"으로 시작하세요.' }),
    );
    return;
  }
  const c = h.changes;
  const arrow = (d) => (d > 0 ? `▲${d}` : d < 0 ? `▼${-d}` : '－');
  const trendTable = el('div', { class: 'table-wrap' }, [el('table', { class: 'table' }, [
    el('thead', {}, [el('tr', {}, ['회차', '제출', '좋은 사이', '안 좋은 사이', '서로 안 좋은 쌍', '갈등 높음 쌍', '고립 위험'].map((t) => el('th', { text: t })))]),
    el('tbody', {}, h.trend.map((t, i) => {
      const prev = h.trend[i - 1];
      const cell = (v, key) => el('td', { class: 'num' }, [String(v), prev ? el('span', { class: 'muted', style: { fontSize: '12px', marginLeft: '4px' }, text: arrow(v - prev[key]) }) : null]);
      return el('tr', { style: t.id === state.round.id ? { background: 'var(--blue-light)' } : null }, [
        el('td', {}, [el('a', { href: '#', text: t.name, style: { fontWeight: 600 }, onClick: (e) => { e.preventDefault(); ui.roundId = t.id; load(); } }), t.open ? el('span', { class: 'badge green', style: { marginLeft: '6px' }, text: '진행 중' }) : null]),
        el('td', { class: 'num', text: `${t.submitted}/${t.total}` }),
        cell(t.good, 'good'), cell(t.bad, 'bad'), cell(t.mutualBad, 'mutualBad'), cell(t.highRisk, 'highRisk'), cell(t.isolated, 'isolated'),
      ]);
    })),
  ])]);

  const pairList = (items, empty) => items.length
    ? el('ul', { style: { paddingLeft: '18px', margin: '4px 0 10px' } }, items.map((p) => el('li', {}, [
      el('a', { href: '#', text: `${p.aName} ↔ ${p.bName}`, onClick: (e) => { e.preventDefault(); setHighlight([p.a, p.b], p.a); scrollToGraph(); } }),
      p.probability !== null ? el('span', { class: `badge ${p.probability >= 70 ? 'high' : p.probability >= 40 ? 'medium' : 'low'}`, style: { marginLeft: '6px' }, text: `${p.probability}%` }) : null,
    ])))
    : el('p', { class: 'muted', style: { margin: '4px 0 10px' }, text: empty });

  const studentRows = h.students.map((s) => el('tr', {}, [
    el('td', {}, [el('a', { href: '#', text: s.name, style: { fontWeight: 600 }, onClick: (e) => { e.preventDefault(); setHighlight([s.id], s.id); } })]),
    ...s.rounds.map((r) => el('td', { class: 'num' }, [
      r.submitted ? `${r.inGood} / ${r.inBad}` : el('span', { class: 'muted', text: `${r.inGood} / ${r.inBad} (미제출)` }),
      r.flags.includes('isolated') ? el('span', { class: 'badge high', style: { marginLeft: '4px' }, text: '고립' }) : null,
    ])),
  ]));
  const shownRows = ui.showAllHistory ? studentRows : studentRows.slice(0, 12);

  setChildren(card,
    el('div', { class: 'card-title' }, [el('h2', { text: '회차별 변화 분석' }), el('span', { class: 'muted', text: `${c.prevName} → ${c.lastName} 비교` })]),
    el('h3', { text: '학급 추세' }),
    trendTable,
    el('div', { class: 'grid-2', style: { marginTop: '14px' } }, [
      el('div', {}, [
        el('h3', { text: `새로 생긴 갈등 (${c.newConflicts.length})` }),
        pairList(c.newConflicts, '없어요.'),
        el('h3', { text: `계속되는 갈등 (${c.persistent.length})` }),
        pairList(c.persistent, '없어요.'),
        el('h3', { text: `해소된 갈등 (${c.resolved.length})` }),
        pairList(c.resolved, '없어요.'),
      ]),
      el('div', {}, [
        el('h3', { text: '관심이 필요한 학생' }),
        c.worsened.length ? el('ul', { style: { paddingLeft: '18px', margin: '4px 0 10px' } }, c.worsened.slice(0, 8).map((s) => el('li', {}, [
          el('a', { href: '#', text: s.name, onClick: (e) => { e.preventDefault(); setHighlight([s.id], s.id); } }),
          el('span', { class: 'muted', text: ` · 받은 ⚡ ${arrow(s.inBadDelta)} · 받은 ❤️ ${arrow(s.inGoodDelta)}${s.newlyIsolated ? ' · 새로 고립 위험' : ''}` }),
        ]))) : el('p', { class: 'muted', text: '나빠진 학생이 없어요.' }),
        el('h3', { text: '좋아진 학생' }),
        c.improved.length ? el('ul', { style: { paddingLeft: '18px', margin: '4px 0 10px' } }, c.improved.slice(0, 8).map((s) => el('li', {}, [
          el('a', { href: '#', text: s.name, onClick: (e) => { e.preventDefault(); setHighlight([s.id], s.id); } }),
          el('span', { class: 'muted', text: ` · 받은 ❤️ ${arrow(s.inGoodDelta)} · 받은 ⚡ ${arrow(s.inBadDelta)}${s.recovered ? ' · 고립 위험 벗어남' : ''}` }),
        ]))) : el('p', { class: 'muted', text: '아직 없어요.' }),
      ]),
    ]),
    el('h3', { style: { marginTop: '10px' }, text: '학생별 받은 ❤️ / ⚡' }),
    el('div', { class: 'table-wrap' }, [el('table', { class: 'table' }, [
      el('thead', {}, [el('tr', {}, [el('th', { text: '이름' }), ...h.trend.map((t) => el('th', { text: short(t.name) }))])]),
      el('tbody', {}, shownRows),
    ])]),
    studentRows.length > 12 ? el('button', { type: 'button', class: 'btn small', style: { marginTop: '8px' }, text: ui.showAllHistory ? '접기' : `${studentRows.length - 12}명 더 보기`, onClick: () => { ui.showAllHistory = !ui.showAllHistory; renderHistory(); } }) : null,
    el('p', { class: 'muted', style: { marginTop: '10px', marginBottom: 0 }, text: '"새로 생긴 갈등"은 지난 회차에 없던 안 좋은 사이가 이번 회차에 생긴 쌍, "해소된 갈등"은 지난 회차에 있던 안 좋은 사이가 이번 회차에 사라진 쌍이에요. 응답이 없는 학생의 관계는 변화로 세지 않아요.' }),
  );
}

// ---------- 학생 관리 ----------
// 학생별 성향 설문 · 지원서 제출 표시 (지원서는 역할 목록이 있을 때만)
function statusIcons(sid) {
  const profile = state.profiles?.[sid] || null;
  const application = state.applications?.[sid] || null;
  const firstChoice = application?.choices?.[0]?.roleId;
  const icons = [
    el('span', {
      class: `status-icon ${profile ? 'done' : 'todo'}`, 'data-kind': 'profile',
      title: profile ? `성향 설문 제출 · ${fmtDate(profile.updatedAt)}` : '성향 설문을 아직 내지 않았어요',
      text: profile ? '성향 ✓' : '성향 –',
    }),
  ];
  if ((state.roles || []).length) {
    icons.push(el('span', {
      class: `status-icon ${application ? 'done' : 'todo'}`, 'data-kind': 'application',
      title: application ? `1인 1역 지원서 제출 · ${fmtDate(application.updatedAt)}${firstChoice ? ` · 1지망 ${roleNameOf(firstChoice)}` : ''}` : '1인 1역 지원서를 아직 내지 않았어요',
      text: application ? '지원서 ✓' : '지원서 –',
    }));
  }
  return el('div', { class: 'status-icons' }, icons);
}

function renderStudents() {
  const card = document.getElementById('students-card');
  const { students, stats, room } = state;
  const rows = students.map((s) => {
    const st = stats[s.id];
    return el('tr', {}, [
      el('td', {}, [el('a', { href: '#', text: s.name, style: { fontWeight: 600 }, onClick: (e) => { e.preventDefault(); setHighlight([s.id], s.id); scrollToGraph(); } })]),
      el('td', {}, [el('span', { class: `badge ${s.submitted ? 'green' : 'gray'}`, text: s.submitted ? '제출' : '미제출' }), s.submitted ? el('div', { class: 'muted', style: { fontSize: '12px' }, text: fmtDate(s.submittedAt) }) : null]),
      el('td', {}, [statusIcons(s.id)]),
      el('td', { class: 'num', text: st.inGood.length }),
      el('td', { class: 'num', text: st.inBad.length }),
      el('td', { class: 'num', text: st.outGood.length }),
      el('td', { class: 'num', text: st.outBad.length }),
      el('td', {}, [el('div', { class: 'btn-row' }, [
        el('button', { type: 'button', class: 'btn small', text: '링크 복사', onClick: () => copyText(s.url) }),
        el('button', { type: 'button', class: 'btn small', text: '이름 바꾸기', onClick: () => {
          const name = prompt('새 이름을 입력하세요.', s.name);
          if (name === null || !name.trim() || name.trim() === s.name) return;
          action(api(`${base}/students/${encodeURIComponent(s.id)}`, { method: 'PATCH', body: { name } }), '이름을 바꿨어요.');
        } }),
        el('button', { type: 'button', class: 'btn small', text: '응답 초기화', onClick: () => {
          if (!confirm(`${state.round.name} 회차에서 ${s.name} 학생이 표시한 관계를 모두 지울까요?`)) return;
          action(api(`${base}/students/${encodeURIComponent(s.id)}/reset`, { method: 'POST', body: { roundId: state.round.id } }), '응답을 초기화했어요.');
        } }),
        el('button', { type: 'button', class: 'btn small', text: '링크 재발급', onClick: () => {
          if (!confirm(`${s.name} 학생의 링크(QR)를 새로 만들까요? 기존 QR은 더 이상 열리지 않아요.`)) return;
          action(api(`${base}/students/${encodeURIComponent(s.id)}/rotate`, { method: 'POST' }), '새 링크를 만들었어요. QR 카드를 다시 인쇄해 주세요.');
        } }),
        el('button', { type: 'button', class: 'btn small danger', text: '삭제', onClick: () => {
          if (!confirm(`${s.name} 학생을 교실에서 삭제할까요? 이 학생과 관련된 관계도 함께 지워져요.`)) return;
          action(api(`${base}/students/${encodeURIComponent(s.id)}`, { method: 'DELETE' }), '학생을 삭제했어요.');
        } }),
      ])]),
    ]);
  });
  const addInput = el('input', { type: 'text', placeholder: '추가할 학생 이름 (쉼표로 여러 명)', maxlength: 200 });
  const minGoodInput = el('input', { type: 'number', min: 0, max: 10, value: room.minGood, style: { width: '70px' } });
  const minBadInput = el('input', { type: 'number', min: 0, max: 10, value: room.minBad, style: { width: '70px' } });
  setChildren(card,
    el('div', { class: 'card-title' }, [el('h2', { text: '학생 관리' }), el('span', { class: 'muted', text: `${students.length}명` })]),
    el('div', { class: 'table-wrap' }, [el('table', { class: 'table' }, [
      el('thead', {}, [el('tr', {}, ['이름', '제출', '성향 · 지원서', '받은 ❤️', '받은 ⚡', '준 ❤️', '준 ⚡', ''].map((h) => el('th', { text: h })))]),
      el('tbody', {}, rows),
    ])]),
    el('div', { class: 'grid-2', style: { marginTop: '14px' } }, [
      el('div', {}, [
        el('h3', { text: '학생 추가' }),
        el('form', { class: 'inline-form', onSubmit: (e) => {
          e.preventDefault();
          if (!addInput.value.trim()) return;
          action(api(`${base}/students`, { method: 'POST', body: { name: addInput.value } }), '학생을 추가했어요. QR 카드를 인쇄해 주세요.');
        } }, [addInput, el('button', { type: 'submit', class: 'btn primary', text: '추가' })]),
      ]),
      el('div', {}, [
        el('h3', { text: '꼭 표시해야 하는 인원' }),
        el('form', { class: 'min-form', onSubmit: (e) => {
          e.preventDefault();
          action(api(base, { method: 'PATCH', body: { minGood: Number(minGoodInput.value), minBad: Number(minBadInput.value) } }), '저장했어요.');
        } }, [
          el('label', { class: 'min-row' }, [el('span', { class: 'min-label', text: '❤️ 좋은 사이' }), minGoodInput, el('span', { text: '명 이상' })]),
          el('label', { class: 'min-row' }, [el('span', { class: 'min-label', text: '⚡ 안 좋은 사이' }), minBadInput, el('span', { text: '명 이상' })]),
          el('div', {}, [el('button', { type: 'submit', class: 'btn', text: '저장' })]),
        ]),
        el('p', { class: 'muted', style: { marginTop: '6px' }, text: '학생은 둘 다 채워야 제출할 수 있어요. 반 인원이 적으면 자동으로 줄어들어요.' }),
      ]),
    ]),
  );

  const danger = document.getElementById('danger-card');
  setChildren(danger,
    el('h3', { text: '교실 삭제' }),
    el('p', { class: 'muted', text: '교실과 모든 학생 응답이 완전히 삭제돼요. 필요하면 먼저 CSV/JSON으로 내보내 두세요.' }),
    el('button', { type: 'button', class: 'btn danger', text: '이 교실 삭제', onClick: async () => {
      if (!confirm('정말 이 교실을 삭제할까요? 되돌릴 수 없어요.')) return;
      if (prompt(`확인을 위해 교실 이름(${room.name})을 입력하세요.`) !== room.name) return toast('이름이 일치하지 않아요.');
      try {
        await api(base, { method: 'DELETE' });
        savedRooms.remove(adminToken);
        clearInterval(pollTimer);
        location.href = '/';
      } catch (err) { toast(err.message, 4000); }
    } }),
  );
}

// ---------- 시작 ----------
load();
pollTimer = setInterval(() => {
  const typing = document.activeElement?.matches?.('input, textarea');
  if (document.visibilityState === 'visible' && !popoverEl && !typing) load({ silent: true });
}, 20000);
