// 배정표 내보내기: 한글(HWPX) · 워드(DOCX) 문서를 외부 라이브러리 없이 만듭니다.
// 공통 문서 모델 → 형식별 XML. HWPX 구조는 한글이 저장한 실제 파일을 본떠 만들었습니다.
import { makeZip } from './zipwrite.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const paras = (cell) => (cell && typeof cell === 'object' && !Array.isArray(cell) ? String(cell.text ?? '') : String(cell ?? '')).split(/\r?\n/);
const cellOpts = (cell) => (cell && typeof cell === 'object' && !Array.isArray(cell) ? cell : {});

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

const HWP_NS = 'xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>';

// 쪽: A4 세로. 단위는 HWPUNIT (1/7200 인치)
const PAGE = { width: 59528, height: 84186, left: 5669, right: 5669, top: 5669, bottom: 4252, header: 4252, footer: 4252 };
const TEXT_WIDTH = PAGE.width - PAGE.left - PAGE.right; // 48190
const CELL_MARGIN = { left: 510, right: 510, top: 141, bottom: 141 };
const LINE = 1800; // 10pt 글자 + 줄 간격

// 글자 모양: 0 보통, 1 굵게, 2 제목(16pt 굵게), 3 작은 회색
// 문단 모양: 0 양쪽 정렬, 1 가운데, 2 제목(가운데·아래 여백), 3 왼쪽
// 테두리: 1 없음(쪽), 2 없음(글자·문단 기본), 3 실선, 4 실선+회색 배경(머리글 칸)
function charPr(id, { height = 1000, bold = false, color = '#000000', font = 0 } = {}) {
  const ref = (v) => `hangul="${v}" latin="${v}" hanja="${v}" japanese="${v}" other="${v}" symbol="${v}" user="${v}"`;
  return `<hh:charPr id="${id}" height="${height}" textColor="${color}" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="2"><hh:fontRef ${ref(font)}/><hh:ratio ${ref(100)}/><hh:spacing ${ref(0)}/><hh:relSz ${ref(100)}/><hh:offset ${ref(0)}/>${bold ? '<hh:bold/>' : ''}<hh:underline type="NONE" shape="SOLID" color="#000000"/><hh:strikeout shape="NONE" color="#000000"/><hh:outline type="NONE"/><hh:shadow type="NONE" color="#B2B2B2" offsetX="10" offsetY="10"/></hh:charPr>`;
}
function paraPr(id, { align = 'JUSTIFY', next = 0, prev = 0, lineSpacing = 160 } = {}) {
  const margin = `<hh:margin><hc:intent value="0" unit="HWPUNIT"/><hc:left value="0" unit="HWPUNIT"/><hc:right value="0" unit="HWPUNIT"/><hc:prev value="${prev}" unit="HWPUNIT"/><hc:next value="${next}" unit="HWPUNIT"/></hh:margin><hh:lineSpacing type="PERCENT" value="${lineSpacing}" unit="HWPUNIT"/>`;
  return `<hh:paraPr id="${id}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0"><hh:align horizontal="${align}" vertical="BASELINE"/><hh:heading type="NONE" idRef="0" level="0"/><hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="BREAK_WORD" widowOrphan="0" keepWithNext="0" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/><hh:autoSpacing eAsianEng="0" eAsianNum="0"/><hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar">${margin}</hp:case><hp:default>${margin}</hp:default></hp:switch><hh:border borderFillIDRef="2" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/></hh:paraPr>`;
}
function borderFill(id, { line = false, fill = null } = {}) {
  const side = (name) => `<hh:${name} type="${line ? 'SOLID' : 'NONE'}" width="${line ? '0.12 mm' : '0.1 mm'}" color="#000000"/>`;
  const brush = fill ? `<hc:fillBrush><hc:winBrush faceColor="${fill}" hatchColor="#999999" alpha="0"/></hc:fillBrush>` : (id === 2 ? '<hc:fillBrush><hc:winBrush faceColor="none" hatchColor="#999999" alpha="0"/></hc:fillBrush>' : '');
  return `<hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0"><hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>${side('leftBorder')}${side('rightBorder')}${side('topBorder')}${side('bottomBorder')}<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/>${brush}</hh:borderFill>`;
}

export function hwpxHeaderXml() {
  const fonts = ['함초롬돋움', '함초롬바탕'];
  const fontface = (lang) => `<hh:fontface lang="${lang}" fontCnt="${fonts.length}">${fonts.map((f, i) => `<hh:font id="${i}" face="${f}" type="TTF" isEmbedded="0"><hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="4" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/></hh:font>`).join('')}</hh:fontface>`;
  const langs = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER'];
  const numbering = '<hh:numberings itemCnt="1"><hh:numbering id="1" start="0">' + [1, 2, 3, 4, 5, 6, 7].map((lv) => `<hh:paraHead start="1" level="${lv}" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="DIGIT" charPrIDRef="4294967295" checkable="0">^${lv}.</hh:paraHead>`).join('') + '</hh:numbering></hh:numberings>';
  return `${XML_HEAD}<hh:head ${HWP_NS} version="1.4" secCnt="1"><hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/><hh:refList><hh:fontfaces itemCnt="${langs.length}">${langs.map(fontface).join('')}</hh:fontfaces><hh:borderFills itemCnt="4">${borderFill(1)}${borderFill(2)}${borderFill(3, { line: true })}${borderFill(4, { line: true, fill: '#EEEEEE' })}</hh:borderFills><hh:charProperties itemCnt="4">${charPr(0)}${charPr(1, { bold: true })}${charPr(2, { height: 1600, bold: true })}${charPr(3, { height: 900, color: '#555555' })}</hh:charProperties><hh:tabProperties itemCnt="3"><hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/><hh:tabPr id="1" autoTabLeft="1" autoTabRight="0"/><hh:tabPr id="2" autoTabLeft="0" autoTabRight="1"/></hh:tabProperties>${numbering}<hh:paraProperties itemCnt="4">${paraPr(0)}${paraPr(1, { align: 'CENTER' })}${paraPr(2, { align: 'CENTER', next: 600 })}${paraPr(3, { align: 'LEFT' })}</hh:paraProperties><hh:styles itemCnt="1"><hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/></hh:styles></hh:refList><hh:compatibleDocument targetProgram="HWP201X"><hh:layoutCompatibility/></hh:compatibleDocument><hh:docOption><hh:linkinfo path="" pageInherit="0" footnoteInherit="0"/></hh:docOption><hh:trackchageConfig flags="56"/></hh:head>`;
}

function secPr() {
  const pbf = (type) => `<hp:pageBorderFill type="${type}" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>`;
  return `<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0"><hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/><hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/><hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/><hp:pagePr landscape="WIDELY" width="${PAGE.width}" height="${PAGE.height}" gutterType="LEFT_ONLY"><hp:margin header="${PAGE.header}" footer="${PAGE.footer}" gutter="0" left="${PAGE.left}" right="${PAGE.right}" top="${PAGE.top}" bottom="${PAGE.bottom}"/></hp:pagePr><hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr><hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr>${pbf('BOTH')}${pbf('EVEN')}${pbf('ODD')}</hp:secPr><hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl>`;
}

/** 글자 수로 줄 수를 어림합니다 (한글 1000, 영숫자 500 단위 폭) */
function estimateLines(text, innerWidth, charHeight = 1000) {
  let width = 0;
  for (const ch of text) width += /[ᄀ-ᇿ㄰-㆏가-힯一-鿿＀-￯]/.test(ch) ? charHeight : charHeight * 0.55;
  return Math.max(1, Math.ceil(width / Math.max(1, innerWidth)));
}

export function hwpxSectionXml(doc) {
  let nextId = 1;
  const pid = () => String(nextId++);
  const lineseg = (vertsize, width) => `<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="${vertsize}" textheight="${vertsize}" baseline="${Math.round(vertsize * 0.85)}" spacing="${Math.round(vertsize * 0.6)}" horzpos="0" horzsize="${width}" flags="393216"/></hp:linesegarray>`;
  const p = (text, { paraPr = 0, charPr = 0, width = TEXT_WIDTH, size = 1000, lead = '' } = {}) =>
    `<hp:p id="${pid()}" paraPrIDRef="${paraPr}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${lead}<hp:run charPrIDRef="${charPr}">${text ? `<hp:t>${esc(text)}</hp:t>` : '<hp:t/>'}</hp:run>${lineseg(size, width)}</hp:p>`;

  const table = (t) => {
    const cols = t.columns.map((c) => Math.round(TEXT_WIDTH * c.width));
    cols[cols.length - 1] += TEXT_WIDTH - cols.reduce((a, b) => a + b, 0);
    const allRows = [t.header ? t.columns.map((c) => ({ text: c.label, bold: true, align: 'center', head: true })) : null, ...t.rows].filter(Boolean);
    const rowHeights = allRows.map((row) => Math.max(...row.map((cell, ci) => {
      const lines = paras(cell).reduce((n, line) => n + estimateLines(line, cols[ci] - CELL_MARGIN.left - CELL_MARGIN.right), 0);
      return lines * LINE + CELL_MARGIN.top + CELL_MARGIN.bottom + 300;
    })));
    const height = rowHeights.reduce((a, b) => a + b, 0);
    const trs = allRows.map((row, ri) => `<hp:tr>${row.map((cell, ci) => {
      const o = cellOpts(cell);
      const inner = cols[ci] - CELL_MARGIN.left - CELL_MARGIN.right;
      const body = paras(cell).map((line) => p(line, { paraPr: o.align === 'center' || o.head ? 1 : 3, charPr: o.head || o.bold ? 1 : 0, width: inner })).join('');
      return `<hp:tc name="" header="${o.head ? 1 : 0}" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="${o.head ? 4 : 3}"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${body}</hp:subList><hp:cellAddr colAddr="${ci}" rowAddr="${ri}"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="${cols[ci]}" height="${rowHeights[ri]}"/><hp:cellMargin left="${CELL_MARGIN.left}" right="${CELL_MARGIN.right}" top="${CELL_MARGIN.top}" bottom="${CELL_MARGIN.bottom}"/></hp:tc>`;
    }).join('')}</hp:tr>`).join('');
    const tbl = `<hp:tbl id="${pid()}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="${allRows.length}" colCnt="${cols.length}" cellSpacing="0" borderFillIDRef="3" noAdjust="0"><hp:sz width="${TEXT_WIDTH}" widthRelTo="ABSOLUTE" height="${height}" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="283" right="283" top="283" bottom="283"/><hp:inMargin left="${CELL_MARGIN.left}" right="${CELL_MARGIN.right}" top="${CELL_MARGIN.top}" bottom="${CELL_MARGIN.bottom}"/>${trs}</hp:tbl>`;
    return `${t.caption ? p(t.caption, { paraPr: 3, charPr: 1 }) : ''}<hp:p id="${pid()}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0">${tbl}<hp:t/></hp:run>${lineseg(height, TEXT_WIDTH)}</hp:p>`;
  };

  const body = [
    p(doc.title, { paraPr: 2, charPr: 2, size: 1600, lead: `<hp:run charPrIDRef="0">${secPr()}</hp:run>` }),
    ...doc.meta.map((m) => p(m, { paraPr: 1, charPr: 3, size: 900 })),
    p(''),
    ...doc.tables.flatMap((t, i) => [i ? p('') : '', table(t)]),
    p(''),
    ...doc.notes.map((n) => p(n, { paraPr: 3, charPr: 3, size: 900 })),
  ].join('');
  return `${XML_HEAD}<hs:sec ${HWP_NS}>${body}</hs:sec>`;
}

function hwpxContentHpf(title, now) {
  const iso = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `${XML_HEAD}<opf:package ${HWP_NS} version="" unique-identifier="" id=""><opf:metadata><opf:title>${esc(title)}</opf:title><opf:language>ko</opf:language><opf:meta name="creator" content="text">학생 관계 마인드맵</opf:meta><opf:meta name="subject" content="text"/><opf:meta name="description" content="text"/><opf:meta name="lastsaveby" content="text">학생 관계 마인드맵</opf:meta><opf:meta name="CreatedDate" content="text">${iso}</opf:meta><opf:meta name="ModifiedDate" content="text">${iso}</opf:meta><opf:meta name="keyword" content="text"/></opf:metadata><opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/><opf:item id="settings" href="settings.xml" media-type="application/xml"/></opf:manifest><opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0"/></opf:spine></opf:package>`;
}

const HWPX_STATIC = {
  'version.xml': `${XML_HEAD}<hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="0" buildNumber="1" os="1" xmlVersion="1.4" application="Hancom Office Hangul" appVersion="11, 0, 0, 1 WIN32LEWindows_10"/>`,
  'META-INF/container.xml': `${XML_HEAD}<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"><ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/><ocf:rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/><ocf:rootfile full-path="META-INF/container.rdf" media-type="application/rdf+xml"/></ocf:rootfiles></ocf:container>`,
  'META-INF/manifest.xml': `${XML_HEAD}<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>`,
  'META-INF/container.rdf': `${XML_HEAD}<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="http://www.hancom.co.kr/hwpml/2016/meta/pkg#" rdf:resource="Contents/header.xml"/></rdf:Description><rdf:Description rdf:about="Contents/header.xml"><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#HeaderFile"/></rdf:Description><rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="http://www.hancom.co.kr/hwpml/2016/meta/pkg#" rdf:resource="Contents/section0.xml"/></rdf:Description><rdf:Description rdf:about="Contents/section0.xml"><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#SectionFile"/></rdf:Description><rdf:Description rdf:about=""><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#Document"/></rdf:Description></rdf:RDF>`,
  'settings.xml': `${XML_HEAD}<ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"><ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>`,
};

/** 문서 모델 → HWPX(zip) */
export function makeHwpxDocument(doc, { now = new Date() } = {}) {
  const preview = [doc.title, ...doc.meta, ...doc.tables.flatMap((t) => [t.caption || '', ...(t.header ? [t.columns.map((c) => c.label).join('\t')] : []), ...t.rows.map((r) => r.map((c) => paras(c).join(' ')).join('\t'))]), ...doc.notes].filter(Boolean).join('\n');
  return makeZip([
    { name: 'mimetype', data: 'application/hwp+zip', store: true },
    { name: 'version.xml', data: HWPX_STATIC['version.xml'] },
    { name: 'META-INF/container.xml', data: HWPX_STATIC['META-INF/container.xml'] },
    { name: 'META-INF/manifest.xml', data: HWPX_STATIC['META-INF/manifest.xml'] },
    { name: 'META-INF/container.rdf', data: HWPX_STATIC['META-INF/container.rdf'] },
    { name: 'Contents/content.hpf', data: hwpxContentHpf(doc.title, now) },
    { name: 'Contents/header.xml', data: hwpxHeaderXml() },
    { name: 'Contents/section0.xml', data: hwpxSectionXml(doc) },
    { name: 'settings.xml', data: HWPX_STATIC['settings.xml'] },
    { name: 'Preview/PrvText.txt', data: preview },
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
  const body = [
    docxP(doc.title, { align: 'center', bold: true, size: 32, after: 160 }),
    ...doc.meta.map((m) => docxP(m, { align: 'center', size: 18, color: '555555', after: 240 })),
    ...doc.tables.flatMap((t, i) => [i ? docxP('', { after: 200 }) : '', table(t)]),
    docxP('', { after: 120 }),
    ...doc.notes.map((n) => docxP(n, { size: 18, color: '555555' })),
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
