// 배정표 내보내기: 한글(HWPX) · 워드(DOCX) 문서를 외부 라이브러리 없이 만듭니다.
// 공통 문서 모델 → 형식별 XML. HWPX 구조는 한글이 저장한 실제 파일을 본떠 만들었습니다.
import { makeZip } from './zipwrite.js';
import { HEADER_XML, SETTINGS_XML, VERSION_XML } from './hwpx-template.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const paras = (cell) => (cell && typeof cell === 'object' && !Array.isArray(cell) ? String(cell.text ?? '') : String(cell ?? '')).split(/\r?\n/);
const cellOpts = (cell) => (cell && typeof cell === 'object' && !Array.isArray(cell) ? cell : {});

/**
 * 문서 모델을 블록 목록으로 통일합니다.
 * 블록: heading{text,level} · paragraph{text,style?} · list{items} · stats{items:[{label,value,sub?}]} · table{caption?,columns,rows,header}
 *       · seatmap{podium,blocks:[{cols,rows,cells}]} · pagebreak
 * (예전 모델 { title, meta, tables, notes } 도 받습니다)
 */
export function docBlocks(doc) {
  if (Array.isArray(doc.blocks)) return doc.blocks;
  return [
    ...(doc.tables || []).flatMap((t) => [{ type: 'table', ...t }]),
    ...(doc.notes || []).map((n) => ({ type: 'paragraph', text: n, style: 'note' })),
  ];
}

/** 자리표 블록 → 표 블록들 (한글·워드용: 분단마다 표 하나, 칠판이 위) */
function seatmapTables(block) {
  return (block.blocks || []).map((b, i) => ({
    type: 'table',
    caption: `${i + 1}분단 (위가 칠판 쪽)`,
    columns: Array.from({ length: b.cols }, () => ({ label: '', width: 1 / b.cols })),
    rows: (b.cells || []).map((row) => Array.from({ length: b.cols }, (_, ci) => ({ text: row?.[ci] || '(빈 자리)', align: 'center', bold: Boolean(row?.[ci]) }))),
    header: false,
  }));
}

// ---------- 공통: 배정표 문서 모델 ----------

const pad2 = (n) => String(n).padStart(2, '0');
function todayLabel(d = new Date()) {
  // 한국 시간 기준 날짜
  const kst = new Date(d.getTime() + 9 * 3600000);
  return `${kst.getUTCFullYear()}.${pad2(kst.getUTCMonth() + 1)}.${pad2(kst.getUTCDate())}`;
}

/**
 * 1인 1역 배정표의 문서 모델을 만듭니다.
 * @returns {{ title, meta: string[], tables: [{ caption?, columns: [{label, width}], rows: [[cell]], header: boolean }], notes: string[] }}
 */
export function rolesDocument({ room, round, roles, students, assignment, reasons = false, now = new Date() }) {
  const index = new Map(students.map((s, i) => [s.id, i + 1]));
  const nameOf = (sid) => students.find((s) => s.id === sid)?.name || '(삭제된 학생)';
  const label = (sid) => `${index.get(sid) ?? '?'} ${nameOf(sid)}`;
  const assignments = assignment?.assignments || {};
  const explanations = assignment?.explanations || {};
  const placed = new Set();
  const rows = [];
  for (const role of roles) {
    const sids = assignments[role.id] || [];
    sids.forEach((sid) => placed.add(sid));
    const empty = Math.max(0, role.slots - sids.length);
    const who = sids.map(label).join('   ');
    const roleCell = role.subtitle ? `${role.name}\n${role.subtitle}` : role.name;
    const whoCell = [who, empty ? `(빈자리 ${empty})` : ''].filter(Boolean).join('\n');
    rows.push([{ text: roleCell, bold: true }, { text: `${role.slots}명`, align: 'center' }, whoCell]);
  }
  const unassigned = students.filter((s) => !placed.has(s.id)).map((s) => label(s.id));
  const status = assignment?.published ? `공개됨 (${String(assignment.publishedAt || '').slice(0, 10) || '날짜 없음'})` : '초안 (아직 학생에게 공개하지 않음)';
  const doc = {
    title: `${round.name} 1인 1역 배정표`,
    meta: [`${room.name} · 학생 ${students.length}명 · 역할 ${roles.length}개 (${roles.reduce((n, r) => n + r.slots, 0)}자리) · ${status} · 만든 날짜 ${todayLabel(now)}`],
    tables: [{
      columns: [{ label: '역할명', width: 0.3 }, { label: '인원', width: 0.1 }, { label: '이번 달 담당 (번호 이름)', width: 0.6 }],
      rows,
      header: true,
    }],
    notes: [
      unassigned.length ? `아직 배정되지 않은 학생 ${unassigned.length}명: ${unassigned.join(', ')}` : '',
      '번호는 학급 명단 순서예요. 이 표를 다음 달 "지난달 현황 가져오기"에 그대로 올리면 같은 역할 연속 금지 규칙에 쓸 수 있어요.',
    ].filter(Boolean),
  };
  if (reasons) {
    const reasonRows = [];
    for (const s of students) {
      const roleId = Object.keys(assignments).find((rid) => (assignments[rid] || []).includes(s.id));
      const role = roles.find((r) => r.id === roleId);
      reasonRows.push([{ text: String(index.get(s.id)), align: 'center' }, s.name, role ? role.name : '(미배정)', explanations[s.id] || '']);
    }
    doc.tables.push({
      caption: '학생별 배정 이유 (선생님 참고용)',
      columns: [{ label: '번호', width: 0.08 }, { label: '이름', width: 0.16 }, { label: '역할', width: 0.26 }, { label: '배정 이유', width: 0.5 }],
      rows: reasonRows,
      header: true,
    });
  }
  return doc;
}

// ---------- HWPX ----------
// 한글이 저장한 실제 문서의 머리 부분(header.xml 등)을 그대로 쓰고, 본문(section0.xml)은 그 문서의 표 구조를 본떠 만듭니다.

const HWP_NS = 'xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>';

// 머리 부분(hwpx-template.js)에 정의된 id
const CH = { body: 0, small: 2, note: 4, head: 7, cell: 8, cellBold: 9, cellSub: 12, title: 14, caption: 19 };
const PA = { justify: 0, left: 11, center: 20 };
const BF = { none: 1, line: 3 };

// 쪽: A4 세로. 단위는 HWPUNIT (1/7200 인치). 여백은 한글 기본값(위 20mm, 아래 15mm, 좌우 20mm)에 가깝게.
const PAGE = { width: 59528, height: 84186, left: 5669, right: 5669, top: 5669, bottom: 4252, header: 4252, footer: 4252 };
const TEXT_WIDTH = PAGE.width - PAGE.left - PAGE.right; // 48190
const CELL_MARGIN = { left: 510, right: 510, top: 141, bottom: 141 };

export function hwpxHeaderXml() { return HEADER_XML; }

function secPr() {
  const pbf = (type) => `<hp:pageBorderFill type="${type}" borderFillIDRef="${BF.none}" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>`;
  return `<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0"><hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/><hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/><hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/><hp:pagePr landscape="WIDELY" width="${PAGE.width}" height="${PAGE.height}" gutterType="LEFT_ONLY"><hp:margin header="${PAGE.header}" footer="${PAGE.footer}" gutter="0" left="${PAGE.left}" right="${PAGE.right}" top="${PAGE.top}" bottom="${PAGE.bottom}"/></hp:pagePr><hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr><hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr>${pbf('BOTH')}${pbf('EVEN')}${pbf('ODD')}</hp:secPr><hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl>`;
}

/** 글자 수로 줄 수를 어림합니다 (한글은 글자 크기만큼, 영숫자는 그 절반 폭으로 봄) */
function estimateLines(text, innerWidth, size) {
  let width = 0;
  for (const ch of text) width += /[ᄀ-ᇿ㄰-㆏가-힯一-鿿＀-￯]/.test(ch) ? size : size * 0.55;
  return Math.max(1, Math.ceil(width / Math.max(1, innerWidth)));
}
const charHeight = (charPr) => ({ 0: 1000, 2: 900, 4: 900, 7: 1200, 8: 1300, 9: 1200, 12: 1200, 14: 1800, 19: 1500 }[charPr] || 1000);

export function hwpxSectionXml(doc) {
  let nextId = 3121190098;
  const topId = () => String(nextId++);
  const lineseg = (vertsize, width, vertpos = 0) => `<hp:linesegarray><hp:lineseg textpos="0" vertpos="${vertpos}" vertsize="${vertsize}" textheight="${vertsize}" baseline="${Math.round(vertsize * 0.85)}" spacing="${Math.round(vertsize * 0.6)}" horzpos="0" horzsize="${width}" flags="393216"/></hp:linesegarray>`;
  // 문단: 한글이 쓰는 속성 그대로. 셀 안 첫 문단은 id 2147483648, 그다음은 0 (한글 저장 파일과 같은 방식)
  const p = (text, { id, paraPr = PA.justify, charPr = CH.body, width = TEXT_WIDTH, lead = '', vertpos = 0, pageBreak = 0 } = {}) => {
    const size = charHeight(charPr);
    return `<hp:p id="${id}" paraPrIDRef="${paraPr}" styleIDRef="0" pageBreak="${pageBreak ? 1 : 0}" columnBreak="0" merged="0">${lead}<hp:run charPrIDRef="${charPr}">${text ? `<hp:t>${esc(text)}</hp:t>` : '<hp:t/>'}</hp:run>${lineseg(size, width, vertpos)}</hp:p>`;
  };
  const top = (text, opts = {}) => p(text, { id: topId(), ...opts });

  const table = (t) => {
    const cols = t.columns.map((c) => Math.round(TEXT_WIDTH * c.width));
    cols[cols.length - 1] += TEXT_WIDTH - cols.reduce((a, b) => a + b, 0);
    const allRows = [t.header ? t.columns.map((c) => ({ text: c.label, head: true })) : null, ...t.rows].filter(Boolean);
    const styleOf = (cell, ci) => {
      const o = cellOpts(cell);
      if (o.head) return { paraPr: PA.center, charPr: CH.head };
      if (o.bold) return { paraPr: PA.left, charPr: CH.cellBold, subCharPr: CH.cellSub };
      if (o.align === 'center') return { paraPr: PA.center, charPr: CH.cell };
      return { paraPr: ci === 0 ? PA.center : PA.left, charPr: CH.cell };
    };
    const rowHeights = allRows.map((row) => Math.max(...row.map((cell, ci) => {
      const st = styleOf(cell, ci);
      const inner = cols[ci] - CELL_MARGIN.left - CELL_MARGIN.right;
      const lines = paras(cell).reduce((n, line, li) => n + estimateLines(line, inner, charHeight(li && st.subCharPr ? st.subCharPr : st.charPr)), 0);
      return Math.round(lines * charHeight(st.charPr) * 1.6) + CELL_MARGIN.top + CELL_MARGIN.bottom + 300;
    })));
    const height = rowHeights.reduce((a, b) => a + b, 0);
    const trs = allRows.map((row, ri) => `<hp:tr>${row.map((cell, ci) => {
      const st = styleOf(cell, ci);
      const inner = cols[ci] - CELL_MARGIN.left - CELL_MARGIN.right;
      let vert = 0;
      const body = paras(cell).map((line, li) => {
        const charPr = li && st.subCharPr ? st.subCharPr : st.charPr;
        const xml = p(line, { id: li ? '0' : '2147483648', paraPr: st.paraPr, charPr, width: inner, vertpos: vert });
        vert += Math.round(charHeight(charPr) * 1.6);
        return xml;
      }).join('');
      return `<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="${BF.line}"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${body}</hp:subList><hp:cellAddr colAddr="${ci}" rowAddr="${ri}"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="${cols[ci]}" height="${rowHeights[ri]}"/><hp:cellMargin left="${CELL_MARGIN.left}" right="${CELL_MARGIN.right}" top="${CELL_MARGIN.top}" bottom="${CELL_MARGIN.bottom}"/></hp:tc>`;
    }).join('')}</hp:tr>`).join('');
    const tbl = `<hp:tbl id="${topId()}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="${allRows.length}" colCnt="${cols.length}" cellSpacing="0" borderFillIDRef="${BF.line}" noAdjust="0"><hp:sz width="${TEXT_WIDTH}" widthRelTo="ABSOLUTE" height="${height}" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="283" right="283" top="283" bottom="283"/><hp:inMargin left="${CELL_MARGIN.left}" right="${CELL_MARGIN.right}" top="${CELL_MARGIN.top}" bottom="${CELL_MARGIN.bottom}"/>${trs}</hp:tbl>`;
    const tablePara = `<hp:p id="${topId()}" paraPrIDRef="${PA.justify}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="${CH.body}">${tbl}<hp:t/></hp:run>${lineseg(height, TEXT_WIDTH)}</hp:p>`;
    return `${t.caption ? top(t.caption, { paraPr: PA.left, charPr: CH.caption }) : ''}${tablePara}`;
  };

  let pageBreakNext = false;
  const block = (b) => {
    const opts = pageBreakNext ? { pageBreak: 1 } : {};
    pageBreakNext = false;
    switch (b.type) {
      case 'heading': return top(b.text, { paraPr: PA.left, charPr: b.level >= 3 ? CH.cellBold : CH.caption, ...opts });
      case 'paragraph': return top(b.text, { paraPr: PA.left, charPr: b.style === 'muted' || b.style === 'note' ? CH.note : CH.body, ...opts });
      case 'list': return (b.items || []).map((it, i) => top(`• ${it}`, { paraPr: PA.left, charPr: CH.body, ...(i ? {} : opts) })).join('');
      case 'stats': return table({ columns: [{ label: '항목', width: 0.34 }, { label: '값', width: 0.26 }, { label: '설명', width: 0.4 }], rows: (b.items || []).map((it) => [{ text: it.label, bold: true }, { text: it.value, align: 'center' }, it.sub || '']), header: true });
      case 'table': return table(b);
      case 'seatmap': return [top('교탁 · 칠판 (위쪽)', { paraPr: PA.center, charPr: CH.cellBold }), ...seatmapTables(b).map((t) => table(t))].join('');
      case 'pagebreak': pageBreakNext = true; return '';
      default: return '';
    }
  };
  const body = [
    // 첫 문단: 구역·단 설정 + 제목 (한글 저장 파일처럼 첫 문단의 첫 run 에 secPr 이 들어갑니다)
    top(doc.title, { paraPr: PA.center, charPr: CH.title, lead: `<hp:run charPrIDRef="${CH.body}">${secPr()}</hp:run>` }),
    ...(doc.subtitle ? [top(doc.subtitle, { paraPr: PA.center, charPr: CH.cellSub })] : []),
    ...(doc.meta || []).map((m) => top(m, { paraPr: PA.center, charPr: CH.small })),
    top(''),
    ...docBlocks(doc).map((b, i, arr) => (b.type === 'pagebreak' ? block(b) : `${i && arr[i - 1].type !== 'heading' && b.type !== 'heading' ? top('') : ''}${block(b)}`)),
  ].join('');
  return `${XML_HEAD}<hs:sec ${HWP_NS}>${body}</hs:sec>`;
}

function hwpxContentHpf(title, now) {
  const iso = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `${XML_HEAD}<opf:package ${HWP_NS} version="" unique-identifier="" id=""><opf:metadata><opf:title>${esc(title)}</opf:title><opf:language>ko</opf:language><opf:meta name="creator" content="text">학생 관계 마인드맵</opf:meta><opf:meta name="subject" content="text"/><opf:meta name="description" content="text"/><opf:meta name="lastsaveby" content="text">학생 관계 마인드맵</opf:meta><opf:meta name="CreatedDate" content="text">${iso}</opf:meta><opf:meta name="ModifiedDate" content="text">${iso}</opf:meta><opf:meta name="keyword" content="text"/></opf:metadata><opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/><opf:item id="settings" href="settings.xml" media-type="application/xml"/></opf:manifest><opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0"/></opf:spine></opf:package>`;
}

const HWPX_STATIC = {
  'META-INF/container.xml': `${XML_HEAD}<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"><ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/><ocf:rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/><ocf:rootfile full-path="META-INF/container.rdf" media-type="application/rdf+xml"/></ocf:rootfiles></ocf:container>`,
  'META-INF/manifest.xml': `${XML_HEAD}<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>`,
  'META-INF/container.rdf': `${XML_HEAD}<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="http://www.hancom.co.kr/hwpml/2016/meta/pkg#" rdf:resource="Contents/header.xml"/></rdf:Description><rdf:Description rdf:about="Contents/header.xml"><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#HeaderFile"/></rdf:Description><rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="http://www.hancom.co.kr/hwpml/2016/meta/pkg#" rdf:resource="Contents/section0.xml"/></rdf:Description><rdf:Description rdf:about="Contents/section0.xml"><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#SectionFile"/></rdf:Description><rdf:Description rdf:about=""><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#Document"/></rdf:Description></rdf:RDF>`,
};

/** 문서 모델 → HWPX(zip). 항목 순서와 압축 방식은 한글 저장 파일과 같게 (mimetype 을 맨 앞에 압축 없이) */
export function makeHwpxDocument(doc, { now = new Date() } = {}) {
  const preview = [doc.title, doc.subtitle || '', ...(doc.meta || []), ...docBlocks(doc).flatMap((b) => {
    if (b.type === 'table') return [b.caption || '', ...(b.header ? [b.columns.map((c) => c.label).join('\t')] : []), ...b.rows.map((r) => r.map((c) => paras(c).join(' ')).join('\t'))];
    if (b.type === 'list') return b.items || [];
    if (b.type === 'stats') return (b.items || []).map((it) => `${it.label}: ${it.value}`);
    return [b.text || ''];
  })].filter(Boolean).join('\n').slice(0, 4000);
  // 항목 순서와 압축 방식은 한글이 저장한 파일과 같게 (mimetype·version.xml 은 압축 없이)
  return makeZip([
    { name: 'mimetype', data: 'application/hwp+zip', store: true },
    { name: 'version.xml', data: VERSION_XML, store: true },
    { name: 'Contents/header.xml', data: HEADER_XML },
    { name: 'Contents/section0.xml', data: hwpxSectionXml(doc) },
    { name: 'Preview/PrvText.txt', data: preview },
    { name: 'settings.xml', data: SETTINGS_XML },
    { name: 'META-INF/container.rdf', data: HWPX_STATIC['META-INF/container.rdf'] },
    { name: 'Contents/content.hpf', data: hwpxContentHpf(doc.title, now) },
    { name: 'META-INF/container.xml', data: HWPX_STATIC['META-INF/container.xml'] },
    { name: 'META-INF/manifest.xml', data: HWPX_STATIC['META-INF/manifest.xml'] },
  ], { date: now });
}

// ---------- DOCX ----------

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const PAGE_TW = { width: 11906, height: 16838, margin: 1134 }; // A4, 여백 2cm (twip)
const TEXT_TW = PAGE_TW.width - PAGE_TW.margin * 2; // 9638

function docxRun(text, { bold = false, size = 20, color = null } = {}) {
  const rPr = `<w:rPr>${bold ? '<w:b/>' : ''}${color ? `<w:color w:val="${color}"/>` : ''}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>`;
  return `<w:r>${rPr}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}
function docxP(text, { align = 'left', bold = false, size = 20, color = null, after = 120 } = {}) {
  return `<w:p><w:pPr><w:jc w:val="${align}"/><w:spacing w:after="${after}" w:line="300" w:lineRule="auto"/></w:pPr>${text ? docxRun(text, { bold, size, color }) : ''}</w:p>`;
}

export function docxDocumentXml(doc) {
  const table = (t) => {
    const cols = t.columns.map((c) => Math.round(TEXT_TW * c.width));
    cols[cols.length - 1] += TEXT_TW - cols.reduce((a, b) => a + b, 0);
    const border = (n) => `<w:${n} w:val="single" w:sz="6" w:space="0" w:color="000000"/>`;
    const allRows = [t.header ? t.columns.map((c) => ({ text: c.label, bold: true, align: 'center', head: true })) : null, ...t.rows].filter(Boolean);
    const trs = allRows.map((row) => `<w:tr>${row.map((cell, ci) => {
      const o = cellOpts(cell);
      const tcPr = `<w:tcPr><w:tcW w:w="${cols[ci]}" w:type="dxa"/>${o.head ? '<w:shd w:val="clear" w:color="auto" w:fill="EEEEEE"/>' : ''}<w:vAlign w:val="center"/></w:tcPr>`;
      const body = paras(cell).map((line) => docxP(line, { align: o.align === 'center' || o.head ? 'center' : 'left', bold: Boolean(o.bold || o.head), after: 40 })).join('');
      return `<w:tc>${tcPr}${body}</w:tc>`;
    }).join('')}</w:tr>`).join('');
    return `${t.caption ? docxP(t.caption, { bold: true, after: 80 }) : ''}<w:tbl><w:tblPr><w:tblW w:w="${TEXT_TW}" w:type="dxa"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${cols.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${trs}</w:tbl>`;
  };
  const block = (b) => {
    switch (b.type) {
      case 'heading': return docxP(b.text, { bold: true, size: b.level >= 3 ? 24 : 28, after: 100 });
      case 'paragraph': return docxP(b.text, b.style === 'muted' || b.style === 'note' ? { size: 18, color: '555555' } : {});
      case 'list': return (b.items || []).map((it) => docxP(`• ${it}`, { after: 40 })).join('');
      case 'stats': return table({ columns: [{ label: '항목', width: 0.34 }, { label: '값', width: 0.26 }, { label: '설명', width: 0.4 }], rows: (b.items || []).map((it) => [{ text: it.label, bold: true }, { text: it.value, align: 'center' }, it.sub || '']), header: true });
      case 'table': return table(b);
      case 'seatmap': return [docxP('교탁 · 칠판 (위쪽)', { align: 'center', bold: true }), ...seatmapTables(b).map((t) => `${table(t)}${docxP('', { after: 120 })}`)].join('');
      case 'pagebreak': return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
      default: return '';
    }
  };
  const body = [
    docxP(doc.title, { align: 'center', bold: true, size: 32, after: 160 }),
    ...(doc.subtitle ? [docxP(doc.subtitle, { align: 'center', size: 22, after: 120 })] : []),
    ...(doc.meta || []).map((m) => docxP(m, { align: 'center', size: 18, color: '555555', after: 240 })),
    ...docBlocks(doc).map((b, i, arr) => `${i && b.type === 'table' && arr[i - 1].type === 'table' ? docxP('', { after: 120 }) : ''}${block(b)}`),
    `<w:sectPr><w:pgSz w:w="${PAGE_TW.width}" w:h="${PAGE_TW.height}"/><w:pgMar w:top="${PAGE_TW.margin}" w:right="${PAGE_TW.margin}" w:bottom="${PAGE_TW.margin}" w:left="${PAGE_TW.margin}" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`,
  ].join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W_NS}><w:body>${body}</w:body></w:document>`;
}

const DOCX_STATIC = {
  '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
  '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/_rels/document.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
  'word/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W_NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="맑은 고딕" w:hAnsi="맑은 고딕" w:eastAsia="맑은 고딕" w:cs="맑은 고딕"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="ko-KR" w:eastAsia="ko-KR"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>`,
};

/** 문서 모델 → DOCX(zip) */
export function makeDocxDocument(doc, { now = new Date() } = {}) {
  return makeZip([
    { name: '[Content_Types].xml', data: DOCX_STATIC['[Content_Types].xml'] },
    { name: '_rels/.rels', data: DOCX_STATIC['_rels/.rels'] },
    { name: 'word/_rels/document.xml.rels', data: DOCX_STATIC['word/_rels/document.xml.rels'] },
    { name: 'word/styles.xml', data: DOCX_STATIC['word/styles.xml'] },
    { name: 'word/document.xml', data: docxDocumentXml(doc) },
  ], { date: now });
}

// ---------- 진입점 ----------
export function buildRolesHwpx(input) { return makeHwpxDocument(rolesDocument(input), { now: input.now }); }
export function buildRolesDocx(input) { return makeDocxDocument(rolesDocument(input), { now: input.now }); }
