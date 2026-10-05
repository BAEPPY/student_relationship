// 배정표 내보내기(한글 HWPX · 워드 DOCX) 테스트: 만든 파일을 우리 파서로 다시 읽어 확인합니다.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rolesDocument, makeHwpxDocument, makeDocxDocument, hwpxHeaderXml, hwpxSectionXml, docxDocumentXml, docBlocks, buildRolesHwpx } from '../server/export-docs.js';
import { makeZip, crc32 } from '../server/zipwrite.js';
import { readZip, extractDocument, documentToText } from '../server/docfiles.js';
import { DEFAULT_ROLES, parseHistoryText } from '../server/roles.js';
import { createApp } from '../server/app.js';
import { FileStore } from '../server/store.js';

const students = ['김하늘', '이도윤', '박서연', '최지우', '정민준', '강서준'].map((n, i) => ({ id: `s${i + 1}`, name: n }));
const roles = DEFAULT_ROLES.slice(0, 4);
const assignment = {
  assignments: { broom: ['s1', 's2'], praise: ['s3'], recorder: [], checker: ['s4', 's5'] },
  explanations: { s1: '1지망 ✓ · 이유를 정성껏 적음(70자)', s4: '지원서가 없어 빈자리에 배정' },
  published: true,
  publishedAt: '2026-10-05T01:00:00Z',
};
const input = { room: { name: '3학년 2반' }, round: { name: '2026년 10월' }, roles, students, assignment, now: new Date('2026-10-05T03:00:00Z') };

describe('zip 만들기', () => {
  test('항목 순서·저장 방식을 지키고, 우리 파서로 다시 읽힌다', () => {
    const buf = makeZip([{ name: 'mimetype', data: 'application/hwp+zip', store: true }, { name: 'a/b.xml', data: '<x>안녕 &amp; 잘가</x>' }], { date: new Date('2026-10-05T03:00:00Z') });
    assert.equal(buf.readUInt32LE(0), 0x04034b50);
    assert.equal(buf.readUInt16LE(8), 0, '첫 항목(mimetype)은 압축하지 않음');
    assert.equal(buf.readUInt16LE(6), 0, '저장 항목 플래그 0');
    assert.equal(buf.subarray(30, 38).toString(), 'mimetype');
    const zip = readZip(buf);
    assert.deepEqual([...zip.keys()], ['mimetype', 'a/b.xml']);
    assert.equal(zip.get('a/b.xml')().toString(), '<x>안녕 &amp; 잘가</x>');
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  });
});

describe('배정표 문서 모델', () => {
  test('역할 · 인원 · 번호 이름, 빈자리, 미배정, 배정 이유 표', () => {
    const doc = rolesDocument({ ...input, reasons: true });
    assert.equal(doc.title, '2026년 10월 1인 1역 배정표');
    assert.match(doc.meta[0], /3학년 2반 · 학생 6명 · 역할 4개 \(8자리\) · 공개됨 \(2026-10-05\) · 만든 날짜 2026\.10\.05/);
    const [t1, t2] = doc.tables;
    assert.deepEqual(t1.columns.map((c) => c.label), ['역할명', '인원', '이번 달 담당 (번호 이름)']);
    assert.equal(t1.rows.length, 4);
    assert.equal(t1.rows[0][0].text, '빗자루의 마법사\n해리포터, 헤르미온느');
    assert.equal(t1.rows[0][1].text, '2명');
    assert.equal(t1.rows[0][2], '1 김하늘   2 이도윤');
    assert.equal(t1.rows[1][2], '3 박서연\n(빈자리 1)');
    assert.equal(t1.rows[2][2], '(빈자리 2)');
    assert.match(doc.notes[0], /^아직 배정되지 않은 학생 1명: 6 강서준$/);
    assert.equal(t2.rows.length, 6);
    assert.deepEqual(t2.rows[0].map((c) => (typeof c === 'string' ? c : c.text)), ['1', '김하늘', '빗자루의 마법사', '1지망 ✓ · 이유를 정성껏 적음(70자)']);
    assert.deepEqual(t2.rows[5].map((c) => (typeof c === 'string' ? c : c.text)), ['6', '강서준', '(미배정)', '']);
    const draft = rolesDocument({ ...input, assignment: { ...assignment, published: false } });
    assert.match(draft.meta[0], /초안/);
    assert.equal(draft.tables.length, 1);
  });
});

describe('HWPX', () => {
  test('패키지 구성과 XML 이 한글 저장 파일 구조를 따른다', () => {
    const buf = buildRolesHwpx({ ...input, reasons: true });
    const zip = readZip(buf);
    assert.deepEqual([...zip.keys()], ['mimetype', 'version.xml', 'Contents/header.xml', 'Contents/section0.xml', 'Preview/PrvText.txt', 'settings.xml', 'META-INF/container.rdf', 'Contents/content.hpf', 'META-INF/container.xml', 'META-INF/manifest.xml'], '한글 저장 파일과 같은 순서');
    assert.equal(buf.readUInt16LE(6), 0, 'mimetype 플래그 0');
    assert.equal(zip.get('mimetype')().toString(), 'application/hwp+zip');
    assert.equal(buf.readUInt16LE(8), 0, 'mimetype 은 압축 없이 첫 항목');
    const header = zip.get('Contents/header.xml')().toString();
    assert.match(header, /^<\?xml version="1\.0" encoding="UTF-8" standalone="yes" \?><hh:head /);
    // 머리 부분은 한글이 저장한 실제 문서의 것을 그대로 씀
    for (const tag of ['hh:fontfaces itemCnt="7"', 'hh:borderFills itemCnt="3"', 'hh:charProperties itemCnt="20"', 'hh:paraProperties itemCnt="21"', 'hh:styles itemCnt="22"', 'hh:compatibleDocument', 'hh:trackchageConfig']) assert.ok(header.includes(tag), tag);
    assert.ok(header.includes('<hh:bold/>'), '굵은 글자 모양');
    assert.ok(!/\b(user|lastsaveby)\b/.test(header.replace(/user="-?\d+"/g, '')), '머리 부분에 작성자 정보 없음');
    const section = zip.get('Contents/section0.xml')().toString();
    assert.ok(section.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hs:sec '));
    assert.ok(section.includes('<hp:secPr '), '첫 문단에 구역 설정');
    assert.ok(section.includes('<hp:colPr '), '단 설정');
    assert.ok(section.indexOf('<hp:secPr ') < section.indexOf('<hp:tbl '), '구역 설정이 표보다 앞');
    assert.equal((section.match(/<hp:tbl /g) || []).length, 2);
    assert.ok(section.includes('rowCnt="5" colCnt="3"'));
    assert.ok(section.includes('rowCnt="7" colCnt="4"'));
    // 셀마다 cellAddr · cellSpan · cellSz · cellMargin 이 subList 뒤에
    assert.match(section, /<\/hp:subList><hp:cellAddr colAddr="0" rowAddr="0"\/><hp:cellSpan colSpan="1" rowSpan="1"\/><hp:cellSz width="\d+" height="\d+"\/><hp:cellMargin /);
    // 모든 참조 id 가 header 에 있음
    const ids = (re) => new Set([...header.matchAll(re)].map((m) => m[1]));
    const charIds = ids(/<hh:charPr id="(\d+)"/g);
    const paraIds = ids(/<hh:paraPr id="(\d+)"/g);
    const borderIds = ids(/<hh:borderFill id="(\d+)"/g);
    for (const m of section.matchAll(/charPrIDRef="(\d+)"/g)) assert.ok(charIds.has(m[1]), `charPr ${m[1]}`);
    for (const m of section.matchAll(/paraPrIDRef="(\d+)"/g)) assert.ok(paraIds.has(m[1]), `paraPr ${m[1]}`);
    for (const m of section.matchAll(/borderFillIDRef="(\d+)"/g)) assert.ok(borderIds.has(m[1]), `borderFill ${m[1]}`);
    // 셀 문단 id 는 한글 저장 파일과 같은 방식 (첫 문단 2147483648, 다음 문단 0)
    assert.ok(section.includes('<hp:p id="2147483648" paraPrIDRef="20"'));
    assert.ok(section.includes('<hp:p id="0" paraPrIDRef="'));
    // 열 너비 합 = 본문 너비
    const widths = [...section.matchAll(/<hp:cellSz width="(\d+)"/g)].slice(0, 3).map((m) => Number(m[1]));
    assert.equal(widths.reduce((a, b) => a + b, 0), 48190);
    const hpf = zip.get('Contents/content.hpf')().toString();
    assert.ok(hpf.includes('<opf:title>2026년 10월 1인 1역 배정표</opf:title>'));
    assert.ok(zip.get('Preview/PrvText.txt')().toString().includes('1 김하늘'));
  });

  test('만든 HWPX 를 다시 읽으면 표 내용이 그대로이고, 지난달 현황으로 다시 가져올 수 있다', () => {
    const buf = buildRolesHwpx(input);
    const doc = extractDocument(buf, '배정표.hwpx');
    assert.equal(doc.format, 'hwpx');
    assert.equal(doc.blocks[0].text, '2026년 10월 1인 1역 배정표');
    const table = doc.blocks.find((b) => b.type === 'table');
    assert.deepEqual(table.rows[0].map((c) => c.join(' ')), ['역할명', '인원', '이번 달 담당 (번호 이름)']);
    assert.deepEqual(table.rows[1], [['빗자루의 마법사', '해리포터, 헤르미온느'], ['2명'], ['1 김하늘   2 이도윤']]);
    assert.deepEqual(table.rows[2], [['칭찬 수집가'], ['2명'], ['3 박서연', '(빈자리 1)']]);
    const { assignments } = parseHistoryText(documentToText(doc), students, roles);
    assert.deepEqual(assignments, { broom: ['s1', 's2'], praise: ['s3'], checker: ['s4', 's5'] });
  });

  test('특수 문자는 XML 로 안전하게 들어간다', () => {
    const xml = hwpxSectionXml({ title: 'A & B <C> "D"', meta: [], tables: [{ columns: [{ label: 'x', width: 1 }], rows: [['1 < 2 & 3']], header: true }], notes: [] });
    assert.ok(xml.includes('<hp:t>A &amp; B &lt;C&gt; &quot;D&quot;</hp:t>'));
    assert.ok(xml.includes('<hp:t>1 &lt; 2 &amp; 3</hp:t>'));
    assert.ok(hwpxHeaderXml().includes('함초롬돋움'));
    assert.ok(hwpxHeaderXml().includes('강원교육모두'));
  });
});

describe('DOCX', () => {
  test('워드 패키지 구성과 표 내용', () => {
    const buf = makeDocxDocument(rolesDocument({ ...input, reasons: true }));
    const zip = readZip(buf);
    assert.deepEqual([...zip.keys()], ['[Content_Types].xml', '_rels/.rels', 'word/_rels/document.xml.rels', 'word/styles.xml', 'word/document.xml']);
    const xml = zip.get('word/document.xml')().toString();
    assert.ok(xml.includes('<w:tblGrid>'));
    assert.ok(xml.includes('w:fill="EEEEEE"'), '머리글 칸 배경');
    assert.ok(xml.includes('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'));
    const doc = extractDocument(buf, '배정표.docx');
    assert.equal(doc.format, 'docx');
    assert.equal(doc.blocks[0].text, '2026년 10월 1인 1역 배정표');
    const tables = doc.blocks.filter((b) => b.type === 'table');
    assert.equal(tables.length, 2);
    assert.deepEqual(tables[0].rows[1], [['빗자루의 마법사', '해리포터, 헤르미온느'], ['2명'], ['1 김하늘   2 이도윤']]);
    assert.deepEqual(tables[1].rows[1].map((c) => c.join(' ')), ['1', '김하늘', '빗자루의 마법사', '1지망 ✓ · 이유를 정성껏 적음(70자)']);
  });
});

describe('내보내기 API', () => {
  let server;
  let url;
  before(async () => {
    const app = createApp({ store: new FileStore(null), baseUrl: 'https://example.test' });
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    url = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());
  const call = async (path, method = 'GET', body) => {
    const res = await fetch(url + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
  };
  test('배정이 있어야 내려받을 수 있고, 한글·워드 파일이 내려온다', async () => {
    const created = await call('/api/rooms', 'POST', { name: '파일반', students: '김하늘\n이도윤\n박서연', minGood: 0, minBad: 0 });
    const { adminToken: t } = JSON.parse(created.buf.toString());
    let r = await call(`/api/teacher/${t}/roles/export.hwpx`);
    assert.equal(r.status, 400);
    assert.match(JSON.parse(r.buf.toString()).error, /배정이 없어요/);
    await call(`/api/teacher/${t}/roles/default`, 'POST');
    const view = JSON.parse((await call(`/api/teacher/${t}/roles/assign`, 'POST', { method: 'rules' })).buf.toString());
    r = await call(`/api/teacher/${t}/roles/export.hwpx?round=${view.round.id}&reasons=1`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/hwp+zip');
    assert.match(r.headers.get('content-disposition'), /^attachment; filename="roles_2026-10\.hwpx"; filename\*=UTF-8''1%EC%9D%B81%EC%97%AD_2026%EB%85%84%2010%EC%9B%94\.hwpx$/);
    const doc = extractDocument(r.buf, 'a.hwpx');
    assert.equal(doc.format, 'hwpx');
    assert.match(doc.blocks[0].text, /1인 1역 배정표$/);
    assert.equal(doc.blocks.filter((b) => b.type === 'table').length, 2, '배정 이유 표 포함');
    r = await call(`/api/teacher/${t}/roles/export.docx`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.equal(extractDocument(r.buf, 'a.docx').blocks.filter((b) => b.type === 'table').length, 1);
    assert.equal((await call(`/api/teacher/${t}/roles/export.hwpx?round=nope`)).status, 404);
    assert.equal((await call('/api/teacher/nope/roles/export.hwpx')).status, 404);
  });
});

describe('문서 블록 렌더링 (보고서용)', () => {
  const doc = {
    title: '블록 문서',
    subtitle: '부제목 줄',
    meta: [],
    blocks: [
      { type: 'heading', text: '1. 큰 제목', level: 2 },
      { type: 'paragraph', text: '흐린 설명 문단', style: 'muted' },
      { type: 'list', items: ['첫째 항목', '둘째 항목'] },
      { type: 'stats', items: [{ label: '제출', value: '3 / 4명', sub: '75% 제출' }, { label: '고립 위험', value: '0명' }] },
      { type: 'pagebreak' },
      { type: 'heading', text: '작은 제목', level: 3 },
      { type: 'seatmap', podium: 'top', blocks: [{ cols: 2, rows: 1, cells: [['김하늘', '']] }] },
      { type: 'table', caption: '표 하나', columns: [{ label: '가', width: 0.5 }, { label: '나', width: 0.5 }], rows: [[{ text: '굵게', bold: true }, '보통\n둘째 줄']], header: true },
      { type: 'paragraph', text: '마지막 안내', style: 'note' },
    ],
  };
  test('한글: 제목 글자 모양, 목록 글머리, 통계 표, 쪽 나눔, 자리표', () => {
    const xml = hwpxSectionXml(doc);
    assert.ok(xml.includes('<hp:t>부제목 줄</hp:t>'));
    assert.match(xml, /charPrIDRef="19"><hp:t>1\. 큰 제목<\/hp:t>/, '큰 제목은 캡션 글자 모양');
    assert.match(xml, /charPrIDRef="9"><hp:t>작은 제목<\/hp:t>/, '작은 제목은 굵은 셀 글자 모양');
    assert.match(xml, /charPrIDRef="4"><hp:t>흐린 설명 문단<\/hp:t>/, '흐린 문단은 note 글자 모양');
    assert.ok(xml.includes('<hp:t>• 첫째 항목</hp:t>') && xml.includes('<hp:t>• 둘째 항목</hp:t>'));
    assert.ok(xml.includes('<hp:t>항목</hp:t>') && xml.includes('<hp:t>75% 제출</hp:t>'), '통계는 항목·값·설명 표로');
    assert.match(xml, /pageBreak="1"[^>]*>(?:(?!<hp:p ).)*<hp:t>작은 제목<\/hp:t>/, '쪽 나눔 다음 문단에 pageBreak');
    assert.equal((xml.match(/pageBreak="1"/g) || []).length, 1);
    assert.ok(xml.includes('<hp:t>교탁 · 칠판 (위쪽)</hp:t>') && xml.includes('<hp:t>1분단 (위가 칠판 쪽)</hp:t>') && xml.includes('<hp:t>(빈 자리)</hp:t>'));
    assert.equal((xml.match(/<hp:tbl /g) || []).length, 3, '통계 + 자리표 + 표');
    const back = extractDocument(makeHwpxDocument(doc, { now: new Date('2026-10-05T03:00:00Z') }), 'b.hwpx');
    const text = documentToText(back);
    for (const s of ['블록 문서', '부제목 줄', '1. 큰 제목', '• 첫째 항목', '작은 제목', '김하늘', '(빈 자리)', '표 하나', '둘째 줄', '마지막 안내']) assert.ok(text.includes(s), `"${s}" 없음`);
    assert.equal(back.blocks.filter((b) => b.type === 'table').length, 3);
  });
  test('워드: 같은 블록이 쪽 나눔·목록·표로 들어간다', () => {
    const xml = docxDocumentXml(doc);
    assert.equal((xml.match(/<w:br w:type="page"\/>/g) || []).length, 1);
    assert.ok(xml.includes('>• 첫째 항목</w:t>'), '목록 글머리');
    assert.equal((xml.match(/<w:tbl>/g) || []).length, 3);
    assert.ok(xml.includes('교탁 · 칠판 (위쪽)') && xml.includes('1분단 (위가 칠판 쪽)'));
    const back = extractDocument(makeDocxDocument(doc, { now: new Date('2026-10-05T03:00:00Z') }), 'b.docx');
    const text = documentToText(back);
    for (const s of ['블록 문서', '부제목 줄', '1. 큰 제목', '• 둘째 항목', '작은 제목', '75% 제출', '김하늘', '(빈 자리)', '표 하나', '마지막 안내']) assert.ok(text.includes(s), `"${s}" 없음`);
    assert.equal(back.blocks.filter((b) => b.type === 'table').length, 3);
  });
  test('예전 모델(tables · notes)도 블록으로 바뀐다', () => {
    const blocks = docBlocks({ title: 'x', tables: [{ columns: [{ label: 'a', width: 1 }], rows: [['1']], header: true }], notes: ['메모'] });
    assert.deepEqual(blocks.map((b) => b.type), ['table', 'paragraph']);
    assert.equal(blocks[1].style, 'note');
  });
});
