import { api, el, toast, copyText, fmtDate, savedRooms, setChildren, TYPE_LABEL, TYPE_ICON } from './common.js';
import { RelationGraph } from './graph.js';

const adminToken = decodeURIComponent(location.pathname.split('/')[2] || '');
const base = `/api/teacher/${encodeURIComponent(adminToken)}`;
const app = document.getElementById('app');

let state = null;
let graph = null;
let ui = { filter: 'all', highlight: null, selectedEdge: null, showAllPairs: false, panelStudent: null };
let popoverEl = null;
let pollTimer = null;

const LEVEL_LABEL = { high: '높음', medium: '주의', low: '낮음' };
const nameOf = (id) => state?.stats[id]?.name || '?';

// ---------- 데이터 ----------
async function load({ silent = false } = {}) {
  try {
    state = await api(base);
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
  renderStudents();
  document.title = `${state.room.name} · 선생님 페이지`;
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
          el('span', {}, [el('span', { class: 'sw', style: { background: 'var(--blue)', border: '2px solid #ffc107' } }), '연결이 가장 많은 학생']),
          el('span', {}, [el('span', { class: 'sw', style: { background: '#9fb3d9', border: '1px dashed #2f5597' } }), '미제출']),
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
function renderHeader() {
  const { room, analysis, students } = state;
  const card = document.getElementById('header-card');
  const pct = students.length ? Math.round((analysis.submittedCount / students.length) * 100) : 0;
  setChildren(card,
    el('div', { class: 'card-title' }, [
      el('div', {}, [
        el('h1', { text: room.name }),
        el('div', { class: 'muted', text: `만든 날짜 ${fmtDate(room.createdAt)} · 최소 표시 인원 ${room.minRelations}명` }),
      ]),
      el('div', { class: 'btn-row' }, [
        el('a', { class: 'btn primary', href: `/t/${encodeURIComponent(adminToken)}/print`, target: '_blank', text: '학생 QR 카드 인쇄' }),
        el('a', { class: 'btn', href: `${base}/export.csv`, text: 'CSV 내보내기' }),
        el('a', { class: 'btn', href: `${base}/export.json`, text: 'JSON 내보내기' }),
        el('button', { type: 'button', class: `btn ${room.locked ? '' : 'danger'}`, text: room.locked ? '마감 해제' : '제출 마감', onClick: () => {
          if (!room.locked && !confirm('제출을 마감하면 학생들이 더 이상 수정할 수 없어요. 마감할까요?')) return;
          action(api(base, { method: 'PATCH', body: { locked: !room.locked } }), room.locked ? '마감을 해제했어요.' : '제출을 마감했어요.');
        } }),
        el('button', { type: 'button', class: 'btn', text: '새로고침', onClick: () => load() }),
      ]),
    ]),
    el('div', { class: 'stat-row' }, [
      stat('제출', `${analysis.submittedCount} / ${students.length}명`, `${pct}%`),
      stat('좋은 사이 화살표', `${analysis.goodCount}개`, `서로 좋은 사이 ${analysis.mutualGood}쌍`),
      stat('안 좋은 사이 화살표', `${analysis.badCount}개`, `서로 안 좋은 사이 ${analysis.mutualBad}쌍`),
      stat('고립 위험', analysis.isolated.length ? analysis.isolated.join(', ') : '없음', '좋은 사이로 지목받지 못한 학생'),
    ]),
    room.locked ? el('div', { class: 'alert warn', style: { marginTop: '12px', marginBottom: 0 }, text: '제출이 마감된 상태예요. 학생 페이지는 읽기 전용이에요.' }) : null,
    state.notice ? el('div', { class: 'alert error', style: { marginTop: '12px', marginBottom: 0 }, text: `⚠️ ${state.notice}` }) : null,
  );
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
  function section(title, items) {
    return el('div', {}, [el('div', { class: 'muted', style: { fontWeight: 600 }, text: `${title} (${items.length})` }), items.length ? el('ul', {}, items) : el('p', { class: 'muted', style: { marginLeft: '4px' }, text: '없음' })]);
  }
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
              el('a', { href: '#', text: `${p.aName} ↔ ${p.bName}`, style: { textDecoration: 'none', color: 'inherit' }, onClick: (e) => { e.preventDefault(); setHighlight([p.a, p.b], p.a); document.getElementById('graph-container').scrollIntoView({ behavior: 'smooth', block: 'center' }); } }),
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

// ---------- 학생 관리 ----------
function renderStudents() {
  const card = document.getElementById('students-card');
  const { students, stats, room } = state;
  const rows = students.map((s) => {
    const st = stats[s.id];
    return el('tr', {}, [
      el('td', {}, [el('a', { href: '#', text: s.name, style: { fontWeight: 600 }, onClick: (e) => { e.preventDefault(); setHighlight([s.id], s.id); document.getElementById('graph-container').scrollIntoView({ behavior: 'smooth', block: 'center' }); } })]),
      el('td', {}, [el('span', { class: `badge ${s.submitted ? 'green' : 'gray'}`, text: s.submitted ? '제출' : '미제출' }), s.submitted ? el('div', { class: 'muted', style: { fontSize: '12px' }, text: fmtDate(s.submittedAt) }) : null]),
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
          if (!confirm(`${s.name} 학생이 표시한 관계를 모두 지울까요? 학생은 다시 표시할 수 있어요.`)) return;
          action(api(`${base}/students/${encodeURIComponent(s.id)}/reset`, { method: 'POST' }), '응답을 초기화했어요.');
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
  const minInput = el('input', { type: 'number', min: 1, max: 10, value: room.minRelations, style: { width: '80px' } });
  setChildren(card,
    el('div', { class: 'card-title' }, [el('h2', { text: '학생 관리' }), el('span', { class: 'muted', text: `${students.length}명` })]),
    el('div', { class: 'table-wrap' }, [el('table', { class: 'table' }, [
      el('thead', {}, [el('tr', {}, ['이름', '제출', '받은 ❤️', '받은 ⚡', '준 ❤️', '준 ⚡', ''].map((h) => el('th', { text: h })))]),
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
        el('h3', { text: '최소 표시 인원' }),
        el('form', { class: 'inline-form', onSubmit: (e) => {
          e.preventDefault();
          action(api(base, { method: 'PATCH', body: { minRelations: Number(minInput.value) } }), '저장했어요.');
        } }, [minInput, el('button', { type: 'submit', class: 'btn', text: '저장' }), el('span', { class: 'muted', text: '학생 한 명이 최소로 표시해야 하는 친구 수' })]),
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
