// 종합 보고서 페이지 (/t/:adminToken/report). 서버가 만든 보고서 문서(report.json)를 읽기 좋은 문서로 그려요.
// 블록 종류: heading · paragraph · list · stats · table · seatmap · pagebreak (server/report.js 가 만들어요)
import { api, el, toast, setChildren, setupPageNav } from './common.js';

const adminToken = decodeURIComponent(location.pathname.split('/')[2] || '');
const base = `/api/teacher/${encodeURIComponent(adminToken)}`;
const app = document.getElementById('app');
document.body.classList.add('report');

let rounds = [];                                                   // [{ id, name, ... }]
let roundId = new URLSearchParams(location.search).get('round');   // 보고 있는 회차
let reasons = false;                                               // 학생별 배정 이유 표 넣기 (#opt-reasons)
let loading = 0;                                                   // 늦게 도착한 응답을 버리기 위한 번호표

setupPageNav(adminToken, roundId);

const roundName = () => rounds.find((r) => r.id === roundId)?.name || '';
const reportQuery = () => {
  const p = new URLSearchParams();
  if (roundId) p.set('round', roundId);
  if (reasons) p.set('reasons', '1');
  const q = p.toString();
  return q ? `?${q}` : '';
};

// ---------- 블록 그리기 ----------
/** 셀 글: 문자열이거나 { text, bold, align }. '\n' 은 줄을 나눠요. */
function cellContent(cell) {
  const spec = (cell && typeof cell === 'object') ? cell : { text: cell };
  const lines = String(spec.text ?? '').split('\n');
  const parts = lines.length > 1 ? lines.map((t) => el('span', { class: 'line', text: t })) : [lines[0]];
  return spec.bold ? [el('b', {}, parts)] : parts;
}

function renderTable(block) {
  const columns = Array.isArray(block.columns) ? block.columns : [];
  const total = columns.reduce((s, c) => s + (Number(c.width) || 0), 0) || 1;
  const cellClass = (cell) => {
    const align = (cell && typeof cell === 'object' && cell.align) || null;
    return align === 'center' ? 'center' : align === 'right' ? 'right' : null;
  };
  return el('div', { class: 'report-table-wrap' }, [el('table', { class: 'report-table' }, [
    block.caption ? el('caption', { text: block.caption }) : null,
    columns.length ? el('colgroup', {}, columns.map((c) => el('col', { style: { width: `${Math.round(((Number(c.width) || 0) / total) * 1000) / 10}%` } }))) : null,
    block.header !== false && columns.length ? el('thead', {}, [el('tr', {}, columns.map((c) => el('th', { scope: 'col', text: c.label ?? '' })))]) : null,
    el('tbody', {}, (block.rows || []).map((row) => el('tr', {}, (row || []).map((cell, i) => el('td', { class: cellClass(cell, i) }, cellContent(cell)))))),
  ])]);
}

/** 자리표: 교탁이 위, 0번째 줄이 맨 앞줄, 분단은 왼쪽부터 차례로. 빈 자리는 점선 상자예요. */
function renderSeatmap(block) {
  const blocks = Array.isArray(block.blocks) ? block.blocks : [];
  return el('div', { class: 'seatmap' }, [
    el('div', { class: 'podium-bar', text: '교탁 / 칠판' }),
    el('div', { class: 'seat-blocks' }, blocks.map((b) => {
      const cols = Math.max(1, Number(b.cols) || (b.cells?.[0]?.length ?? 1));
      const rows = Math.max(1, Number(b.rows) || (b.cells?.length ?? 1));
      const seats = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const name = String(b.cells?.[r]?.[c] ?? '').trim();
          seats.push(el('div', { class: `seat-box ${name ? '' : 'empty'}`, title: name || '빈 자리' }, [el('span', { text: name })]));
        }
      }
      return el('div', { class: 'seat-block', style: { gridTemplateColumns: `repeat(${cols}, auto)` } }, seats);
    })),
  ]);
}

function renderBlock(block) {
  if (!block || typeof block !== 'object') return null;
  switch (block.type) {
    case 'heading':
      return el(block.level === 3 ? 'h3' : 'h2', { text: block.text ?? '' });
    case 'paragraph':
      if (block.style === 'note') return el('div', { class: 'alert info', text: block.text ?? '' });
      return el('p', { class: block.style === 'muted' ? 'muted' : null, text: block.text ?? '' });
    case 'list':
      return el('ul', {}, (block.items || []).map((t) => el('li', { text: String(t) })));
    case 'stats':
      return el('div', { class: 'stat-tiles' }, (block.items || []).map((s) => el('div', { class: 'stat-tile' }, [
        el('div', { class: 'value', text: s.value ?? '' }),
        el('div', { class: 'label', text: s.label ?? '' }),
        s.sub ? el('div', { class: 'sub', text: s.sub }) : null,
      ])));
    case 'table':
      return renderTable(block);
    case 'seatmap':
      return renderSeatmap(block);
    case 'pagebreak':
      return el('div', { class: 'page-break', 'aria-hidden': 'true' });
    default:
      return null;
  }
}

function renderDocument(doc) {
  const meta = Array.isArray(doc.meta) ? doc.meta : (doc.meta ? [doc.meta] : []);
  return el('article', { class: 'report-doc', id: 'report-doc' }, [
    el('header', { class: 'report-head' }, [
      el('h1', { text: doc.title || '종합 보고서' }),
      doc.subtitle ? el('p', { class: 'report-subtitle', text: doc.subtitle }) : null,
      ...meta.map((m) => el('p', { class: 'muted report-meta', text: String(m) })),
    ]),
    ...(doc.blocks || []).map(renderBlock),
  ]);
}

// ---------- 조절 줄 (회차 · 이유 표) ----------
function renderControls() {
  const select = el('select', { class: 'select', id: 'round-select', 'aria-label': '보고서를 만들 회차' }, rounds.map((r) => el('option', {
    value: r.id, selected: r.id === roundId ? true : null, text: `${r.name}${r.open ? ' · 진행 중' : ''}`,
  })));
  select.addEventListener('change', () => {
    roundId = select.value;
    try { history.replaceState(null, '', `${location.pathname}?round=${encodeURIComponent(roundId)}`); } catch { /* 무시 */ }
    setupPageNav(adminToken, roundId);
    loadReport();
  });
  return el('div', { class: 'card report-controls no-print', id: 'report-controls' }, [
    el('label', { for: 'round-select' }, [el('b', { text: '회차' }), select]),
    el('label', {}, [
      el('input', { type: 'checkbox', id: 'opt-reasons', checked: reasons ? true : null, onChange: (e) => { reasons = e.target.checked; loadReport(); } }),
      '1인 1역 학생별 배정 이유 표도 넣기 (선생님 참고용)',
    ]),
    el('span', { class: 'muted', text: '인쇄하면 위쪽 메뉴와 이 줄은 빠지고 문서만 나와요. 인쇄 창에서 "PDF로 저장"을 고르면 PDF 파일이 돼요.' }),
  ]);
}

function showError(message) {
  setChildren(app, el('section', { class: 'card report-error' }, [
    el('div', { class: 'alert error', text: message }),
    el('div', { class: 'btn-row' }, [el('a', { class: 'btn', href: '/', text: '처음으로' })]),
  ]));
}

// ---------- 데이터 ----------
async function loadReport() {
  const seq = ++loading;
  const controls = document.getElementById('report-controls') || renderControls();
  setChildren(app, controls, el('div', { class: 'card', id: 'loading', text: '보고서를 만드는 중…' }));
  try {
    const doc = await api(`${base}/report.json${reportQuery()}`);
    if (seq !== loading) return;   // 그 사이 다른 회차를 골랐으면 버려요
    setChildren(app, controls, renderDocument(doc));
    document.title = `${doc.title || '종합 보고서'} · 학생 관계 마인드맵`;
  } catch (err) {
    if (seq !== loading) return;
    const message = err.status === 404 ? (err.message && !/^요청 실패/.test(err.message) ? err.message : '교실을 찾을 수 없어요') : (err.message || '보고서를 만들지 못했어요.');
    setChildren(app, controls, el('section', { class: 'card report-error' }, [el('div', { class: 'alert error', text: message })]));
  }
}

/** 한글(hwpx)·워드(docx) 파일로 받아요. 이름을 정해 저장해서 브라우저가 이름을 못 정하는 경우를 막아요. */
async function downloadFile(kind, btn) {
  const name = `종합보고서_${(roundName() || '보고서').replace(/[\\/:*?"<>|]+/g, ' ').trim()}.${kind}`;
  if (btn) btn.disabled = true;
  toast(`${kind === 'hwpx' ? '한글' : '워드'} 파일을 만드는 중…`, 1500);
  try {
    const res = await fetch(`${base}/report.${kind}${reportQuery()}`);
    if (!res.ok) {
      let msg = `파일을 만들지 못했어요 (${res.status})`;
      try { msg = (await res.json()).error || msg; } catch { /* 본문 없음 */ }
      throw new Error(msg);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name, style: { display: 'none' } });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
    toast(`${name} 파일을 내려받았어요. ${kind === 'hwpx' ? '한글 2014 이상에서 열어 주세요. 열리지 않으면 워드 파일을 써 주세요.' : '워드와 한글 모두에서 열려요.'}`, 5000);
  } catch (err) {
    toast(err.message, 4500);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function init() {
  document.getElementById('print-btn')?.addEventListener('click', () => window.print());
  document.getElementById('dl-hwpx')?.addEventListener('click', (e) => downloadFile('hwpx', e.currentTarget));
  document.getElementById('dl-docx')?.addEventListener('click', (e) => downloadFile('docx', e.currentTarget));
  let view;
  try {
    view = await api(base);
  } catch (err) {
    return showError(err.status === 404 ? '교실을 찾을 수 없어요' : (err.message || '교실을 열 수 없어요.'));
  }
  rounds = Array.isArray(view.rounds) ? view.rounds : [];
  // ?round= 가 없거나 지워진 회차면 현재 회차로 대신 열어요 (자리 배정 페이지와 같은 방식)
  if (!roundId || !rounds.some((r) => r.id === roundId)) {
    const missing = Boolean(roundId);
    roundId = view.round?.id || rounds[rounds.length - 1]?.id || null;
    try { history.replaceState(null, '', roundId ? `${location.pathname}?round=${encodeURIComponent(roundId)}` : location.pathname); } catch { /* 무시 */ }
    if (missing) toast('그 회차를 찾을 수 없어 현재 회차를 열었어요.', 4000);
  }
  setupPageNav(adminToken, roundId);
  await loadReport();
}

init();
