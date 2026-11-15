// 보고서 문서 모델(server/report.js · server/student-report.js)을 화면에 그려요. 학급 보고서와 학생별 보고서가 함께 씁니다.
// 블록 종류: heading · paragraph · list · stats · table · seatmap · chart · pagebreak
import { el, svgEl } from './common.js';

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

/** 자리표: 교탁이 위, 0번째 줄이 맨 앞줄, 분단은 왼쪽부터 차례로. 빈 자리는 점선 상자예요.
 *  🌀 바람 자리(zones)는 왼쪽 위 표시, 🎒 역할 자리(roles: 역할 이름)는 오른쪽 아래 작은 배지로 보여 줘요. */
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
          const zone = b.zones?.[r]?.[c] || '';
          const zoneLabel = zone === 'ac' ? `냉난방기 바람 자리${block.climate === 'cool' ? ' (냉방 중)' : block.climate === 'warm' ? ' (난방 중)' : ''}` : '';
          const role = String(b.roles?.[r]?.[c] ?? '').trim();
          const roleLabel = role ? `역할 자리: ${role}` : '';
          seats.push(el('div', { class: `seat-box ${name ? '' : 'empty'} ${zone ? `zone-${zone} climate-${block.climate || 'off'}` : ''} ${role ? 'role-seat' : ''}`, title: [name || '빈 자리', zoneLabel, roleLabel].filter(Boolean).join(' · ') }, [
            el('span', { text: name }),
            zone ? el('span', { class: 'seat-zone', text: '🌀', 'aria-label': zoneLabel }) : null,
            role ? el('span', { class: 'seat-role', text: role, title: roleLabel }) : null,
          ]));
        }
      }
      return el('div', { class: 'seat-block', style: { gridTemplateColumns: `repeat(${cols}, auto)` } }, seats);
    })),
  ]);
}

export function renderBlock(block) {
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
    case 'chart':
      return renderChart(block);
    case 'pagebreak':
      return el('div', { class: 'page-break', 'aria-hidden': 'true' });
    default:
      return null;
  }
}

/** 회차별 묶음 막대 그래프 (인쇄에도 나와요). { labels: [...], series: [{ label, kind: 'good'|'bad', values: [...] }] } */
const CHART_COLORS = { good: '#ef5b6b', bad: '#4a4c5c' };
function renderChart(block) {
  const labels = Array.isArray(block.labels) ? block.labels : [];
  const series = (Array.isArray(block.series) ? block.series : []).filter((s) => Array.isArray(s.values));
  if (!labels.length || !series.length) return null;
  const max = Math.max(1, ...series.flatMap((s) => s.values.map((v) => Number(v) || 0)));
  const W = 640; const H = 190; const padL = 30; const padB = 30; const padT = 16;
  const groupW = (W - padL - 8) / labels.length;
  const barW = Math.min(26, (groupW - 12) / series.length);
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${block.caption || '그래프'}: ${series.map((s) => `${s.label} ${s.values.join(', ')}`).join(' / ')}` });
  svg.append(svgEl('line', { x1: padL, y1: H - padB, x2: W - 4, y2: H - padB, stroke: '#c9cad6', 'stroke-width': 1 }));
  for (const tick of [0, max]) {
    svg.append(svgEl('text', { x: padL - 6, y: y(tick) + 4, 'text-anchor': 'end', text: String(tick), style: 'font-size:11px;fill:#7d7f92' }));
  }
  labels.forEach((label, i) => {
    const gx = padL + groupW * i + (groupW - barW * series.length) / 2;
    series.forEach((s, k) => {
      const v = Number(s.values[i]) || 0;
      const color = CHART_COLORS[s.kind] || '#6c5ce7';
      const top = y(v);
      svg.append(svgEl('rect', { x: gx + barW * k, y: top, width: Math.max(2, barW - 3), height: Math.max(0, H - padB - top), rx: 3, fill: color }));
      svg.append(svgEl('text', { x: gx + barW * k + (barW - 3) / 2, y: top - 3, 'text-anchor': 'middle', text: String(v), style: `font-size:11px;font-weight:700;fill:${color}` }));
    });
    svg.append(svgEl('text', { x: padL + groupW * i + groupW / 2, y: H - padB + 16, 'text-anchor': 'middle', text: String(label), style: 'font-size:12px;fill:#4a4c5c' }));
  });
  return el('figure', { class: 'report-chart' }, [
    block.caption ? el('figcaption', { text: block.caption }) : null,
    svg,
    el('div', { class: 'chart-legend' }, series.map((s) => el('span', {}, [el('i', { style: { background: CHART_COLORS[s.kind] || '#6c5ce7' } }), s.label]))),
  ]);
}

export function renderDocument(doc) {
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

