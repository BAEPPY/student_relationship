// 문서 파일 읽기(hwp · hwpx · docx · txt)와 역할 목록·지난달 현황 추출 테스트
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractDocument, documentToText, extractRoles, extractRoster, parseRoleNameCell, readZip, readCfb, decodeHwpText, parseXmlBlocks } from '../server/docfiles.js';
import { DEFAULT_ROLES, parseHistoryText } from '../server/roles.js';
import { makeZip, makeHwpx, makeDocx, makeHwp, hwpSectionRecords } from './helpers/docgen.js';

const STUDENTS = [['s1', '이준영'], ['s2', '임민호'], ['s3', '정서원'], ['s4', '이지민'], ['s5', '박한음'], ['s6', '고주성']].map(([id, name]) => ({ id, name }));
const HISTORY_BLOCKS = [
  { type: 'p', text: '2026년 9월 1인 1역 현황' },
  { type: 'table', rows: [
    ['역할명', '번호', '시간', '8~9월의 역할'],
    [['빗자루의 마법사', '해리포터, 헤르미온느'], '1', '', '8 이준영 24 임민호'],
    ['2'],
    [['칭찬 수집가'], '3', '', '9 정서원 23 이지민'],
    [['오늘의 아나운서'], '20', '', '20 박한음'],
    [['Door Master', '(도어 매스털)'], '16', '', '16 고주성'],
  ] },
];
const ROLE_BLOCKS = [
  { type: 'p', text: '우리 반 1인 1역' },
  { type: 'table', rows: [
    ['역할명', '해야할 일'],
    [['빗자루의 마법사', '해리포터, 헤르미온느', '(2명)'], '친구들이 쓴 빗자루와 쓰레받기를 예쁘게 정리해요.'],
    [['꼼꼼이', '(1인 1역 도우미)', '(2명)'], '친구들이 맡은 1인 1역을 잘했는지 확인해요.'],
    [['도서관 사서', '선생님', '(2명)'], '우리 반 책을 정리해요.'],
    [['체육 부장님 (2명)'], '체육 시간 준비를 도와요.'],
    [['친구를 도와주는', '무지개 마법 소녀 (1명)'], '빠진 1인 1역을 대신해요.'],
    [['Door Master', '(도어 매스털)(1명)'], '불을 끄고 문을 확인해요.'],
    [['종이와 크롬북의 마스터( 2명)'], '유인물을 나누어 줘요.'],
  ] },
];
const KNOWN = DEFAULT_ROLES.map((r) => r.name);

describe('zip · OLE 컨테이너', () => {
  test('zip 항목을 읽고(저장·deflate), 손상된 파일은 400 으로 거부', () => {
    for (const deflate of [false, true]) {
      const zip = readZip(makeZip({ 'a/b.txt': '안녕', 'c.bin': Buffer.from([1, 2, 3]) }, { deflate }));
      assert.deepEqual([...zip.keys()], ['a/b.txt', 'c.bin']);
      assert.equal(zip.get('a/b.txt')().toString('utf8'), '안녕');
      assert.deepEqual([...zip.get('c.bin')()], [1, 2, 3]);
    }
    assert.throws(() => readZip(Buffer.from('PK\u0003\u0004 not a zip at all, really not')), /zip/);
    assert.throws(() => readZip(Buffer.alloc(10)), { status: 400 });
  });

  test('OLE 복합 문서: 미니 스트림과 일반 섹터 스트림을 경로로 읽는다', () => {
    const small = readCfb(makeHwp([{ type: 'p', text: '짧은 문서' }]));
    assert.deepEqual([...small.keys()].sort(), ['BodyText/Section0', 'DocInfo', 'FileHeader']);
    assert.equal(small.get('FileHeader')().subarray(0, 17).toString('latin1'), 'HWP Document File');
    const big = makeHwp([{ type: 'p', text: '긴 문서' }], { pad: 200, flags: 0 });   // 압축 없음 → 본문이 4096 바이트를 넘어 일반 섹터에 들어감
    const streams = readCfb(big);
    const section = streams.get('BodyText/Section0')();
    assert.ok(section.length >= 4096, '본문이 일반 섹터에 들어갈 만큼 커야 함');
    const doc = extractDocument(big, 'big.hwp');
    assert.equal(doc.blocks[0].text, '긴 문서');
    assert.equal(doc.blocks.length, 201);
    assert.equal(doc.blocks[200].text, '채우기 문단 199');
    assert.throws(() => readCfb(Buffer.alloc(600)), /한글/);
  });

  test('PARA_TEXT 디코딩: 컨트롤 문자(16바이트)와 줄바꿈·탭 처리', () => {
    const text = decodeHwpText(Buffer.from(hwpSectionRecords([{ type: 'p', text: 'ab' }]).subarray(4 + 24 + 4)));
    assert.equal(text, 'ab');
    const b = Buffer.alloc(2 * 8 + 2 * 3);
    b.writeUInt16LE(11, 0); b.writeUInt16LE(11, 14); // 확장 컨트롤 8글자
    b.writeUInt16LE('가'.charCodeAt(0), 16); b.writeUInt16LE(9, 18); b.writeUInt16LE('나'.charCodeAt(0), 20);
    assert.equal(decodeHwpText(b.subarray(0, 16)), '');
    assert.equal(decodeHwpText(Buffer.concat([b.subarray(16, 18), Buffer.from([10, 0]), b.subarray(20, 22)])), '가\n나');
  });
});

describe('형식별 읽기', () => {
  for (const [label, make, format] of [['hwpx', makeHwpx, 'hwpx'], ['docx', makeDocx, 'docx'], ['hwp', makeHwp, 'hwp']]) {
    test(`${label}: 문단과 표(셀 안 문단 여러 개)를 순서대로 읽는다`, () => {
      const doc = extractDocument(make(HISTORY_BLOCKS), `현황.${label}`);
      assert.equal(doc.format, format);
      assert.equal(doc.blocks[0].type, 'p');
      assert.equal(doc.blocks[0].text, '2026년 9월 1인 1역 현황');
      const table = doc.blocks.find((b) => b.type === 'table');
      assert.ok(table, '표가 있어야 함');
      assert.equal(table.rows.length, 6);
      assert.deepEqual(table.rows[0].map((c) => c.join(' ')), ['역할명', '번호', '시간', '8~9월의 역할']);
      assert.deepEqual(table.rows[1][0], ['빗자루의 마법사', '해리포터, 헤르미온느']);
      assert.deepEqual(table.rows[1][3], ['8 이준영 24 임민호']);
      assert.deepEqual(table.rows[2], [['2']]);
      const text = documentToText(doc);
      assert.match(text, /^2026년 9월 1인 1역 현황\n역할명 \| 번호 \| 시간 \| 8~9월의 역할\n빗자루의 마법사 해리포터, 헤르미온느 \| 1 \|  \| 8 이준영 24 임민호\n2\n/);
    });
  }

  test('hwpx: 셀 안의 표(중첩)는 따로 읽고, 줄바꿈·엔티티를 처리한다', () => {
    const xml = `<hs:sec xmlns:hp="x"><hp:p><hp:run><hp:t>A &amp; B<hp:lineBreak/>C</hp:t></hp:run></hp:p>
      <hp:p><hp:run><hp:tbl><hp:tr><hp:tc><hp:subList><hp:p><hp:run><hp:t>바깥 셀</hp:t></hp:run></hp:p>
      <hp:p><hp:run><hp:tbl><hp:tr><hp:tc><hp:subList><hp:p><hp:run><hp:t>안쪽 셀</hp:t></hp:run></hp:p></hp:subList></hp:tc></hp:tr></hp:tbl></hp:run></hp:p>
      </hp:subList></hp:tc><hp:tc><hp:subList><hp:p/><hp:p><hp:run><hp:t/></hp:run></hp:p></hp:subList></hp:tc></hp:tr></hp:tbl></hp:run></hp:p></hs:sec>`;
    const blocks = parseXmlBlocks(xml, { tbl: 'hp:tbl', tr: 'hp:tr', tc: 'hp:tc', p: 'hp:p', t: 'hp:t', br: 'hp:lineBreak', tab: 'hp:tab' });
    assert.equal(blocks[0].text, 'A & B\nC');
    const tables = blocks.filter((b) => b.type === 'table');
    assert.equal(tables.length, 2);
    assert.deepEqual(tables[0].rows, [[['바깥 셀'], []]]);
    assert.deepEqual(tables[1].rows, [[['안쪽 셀']]]);
    assert.equal(tables[0].nested, 1);
  });

  test('hwp: 암호·배포용 문서와 옛 형식은 안내 문구로 거부', () => {
    assert.throws(() => extractDocument(makeHwp([{ type: 'p', text: 'x' }], { flags: 3 }), 'a.hwp'), /암호/);
    assert.throws(() => extractDocument(makeHwp([{ type: 'p', text: 'x' }], { flags: 5 }), 'a.hwp'), /배포용/);
    assert.throws(() => extractDocument(Buffer.from('HWP Document File V3.00'.padEnd(600, ' ')), 'old.hwp'), /hwp 5\.0/);
  });

  test('txt: utf-8 과 euc-kr, 형식 판별', () => {
    const doc = extractDocument(Buffer.from('﻿빗자루의 마법사: 8 이준영\n\n칭찬 수집가: 9 정서원\n', 'utf8'), '현황.txt');
    assert.equal(doc.format, 'txt');
    assert.deepEqual(doc.blocks.map((b) => b.text), ['빗자루의 마법사: 8 이준영', '칭찬 수집가: 9 정서원']);
    const euc = Buffer.from([0xb1, 0xe8, 0xc7, 0xcf, 0xb4, 0xc3]); // 김하늘 (EUC-KR)
    const doc2 = extractDocument(euc, 'names.txt');
    assert.equal(doc2.blocks[0].text, '김하늘');
    assert.throws(() => extractDocument(Buffer.alloc(0), 'a.txt'), /비어/);
    assert.throws(() => extractDocument(Buffer.from('%PDF-1.4 ...'), 'a.pdf'), /PDF/);
    assert.throws(() => extractDocument(makeZip({ 'xl/workbook.xml': '<x/>' }), 'a.xlsx'), /엑셀/);
    assert.throws(() => extractDocument(makeZip({ 'hello.txt': 'x' }), 'a.zip'), /zip 안에서/);
    assert.throws(() => extractDocument(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 3]), 'a.txt'), /읽을 수 있는 글/);
    assert.throws(() => extractDocument(Buffer.from('x'), 'a.exe'), /지원하지 않아요/);
  });
});

describe('지난달 현황 · 역할 목록 추출', () => {
  test('현황 표 → 붙여넣기 글 → 역할별 학생 (Door Master 별칭 처리는 그대로)', () => {
    for (const make of [makeHwpx, makeHwp, makeDocx]) {
      const text = documentToText(extractDocument(make(HISTORY_BLOCKS), 'x'));
      const { assignments, unmatched } = parseHistoryText(text, STUDENTS, DEFAULT_ROLES);
      assert.deepEqual(assignments.broom, ['s1', 's2']);
      assert.deepEqual(assignments.praise, ['s3', 's4']);
      assert.deepEqual(assignments.announcer, ['s5']);
      assert.deepEqual(assignments.door, ['s6']);
      assert.deepEqual(unmatched.map((u) => u.line), ['2026년 9월 1인 1역 현황'], '제목 줄만 이름을 못 찾았다고 알려 줌');
    }
  });

  test('역할 이름 칸: 부제·인원·이어지는 이름을 구분', () => {
    const known = new Set(['도서관사서선생님']);
    assert.deepEqual(parseRoleNameCell(['빗자루의 마법사', '해리포터, 헤르미온느', '(2명)']), { name: '빗자루의 마법사', subtitle: '해리포터, 헤르미온느', slots: 2 });
    assert.deepEqual(parseRoleNameCell(['꼼꼼이', '(1인 1역 도우미)', '(2명)']), { name: '꼼꼼이', subtitle: '1인 1역 도우미', slots: 2 });
    assert.deepEqual(parseRoleNameCell(['도서관 사서', '선생님', '(2명)'], known), { name: '도서관 사서 선생님', subtitle: '', slots: 2 });
    assert.deepEqual(parseRoleNameCell(['도서관 사서', '선생님', '(2명)']), { name: '도서관 사서', subtitle: '선생님', slots: 2 });
    assert.deepEqual(parseRoleNameCell(['친구를 도와주는', '무지개 마법 소녀 (1명)']), { name: '친구를 도와주는 무지개 마법 소녀', subtitle: '', slots: 1 });
    assert.deepEqual(parseRoleNameCell(['Door Master', '(도어 매스털)(1명)']), { name: 'Door Master', subtitle: '도어 매스털', slots: 1 });
    assert.deepEqual(parseRoleNameCell(['종이와 크롬북의 마스터( 2명)']), { name: '종이와 크롬북의 마스터', subtitle: '', slots: 2 });
    assert.deepEqual(parseRoleNameCell(['우유배달 왔소', '(cow) (2명)']), { name: '우유배달 왔소', subtitle: 'cow', slots: 2 });
    assert.deepEqual(parseRoleNameCell(['체육 부장님']), { name: '체육 부장님', subtitle: '', slots: null });
  });

  test('역할 표(역할명 · 해야할 일)에서 역할 목록을 뽑는다', () => {
    for (const make of [makeHwpx, makeHwp, makeDocx]) {
      const result = extractRoles(extractDocument(make(ROLE_BLOCKS), 'x'), { knownNames: KNOWN });
      assert.equal(result.source, 'table');
      assert.deepEqual(result.roles.map((r) => [r.name, r.subtitle, r.slots]), [
        ['빗자루의 마법사', '해리포터, 헤르미온느', 2],
        ['꼼꼼이', '1인 1역 도우미', 2],
        ['도서관 사서 선생님', '', 2],
        ['체육 부장님', '', 2],
        ['친구를 도와주는 무지개 마법 소녀', '', 1],
        ['Door Master', '도어 매스털', 1],
        ['종이와 크롬북의 마스터', '', 2],
      ]);
      assert.equal(result.roles[0].description, '친구들이 쓴 빗자루와 쓰레받기를 예쁘게 정리해요.');
      assert.deepEqual(result.warnings, []);
    }
  });

  test('머리글 없는 표, 인원 열이 따로 있는 표, 번호 열', () => {
    const doc = extractDocument(makeHwpx([{ type: 'table', rows: [
      ['1', '칠판 지우기', '2', '수업이 끝나면 칠판을 깨끗이 지워요. 분필 가루도 털어요.'],
      ['2', '화분 돌보기', '1', '아침마다 화분에 물을 주고 잎을 닦아요. 시든 잎은 떼어요.'],
      ['3', '우유 당번', '2명', '우유를 가져오고 빈 상자를 정리해요. 남은 우유는 냉장고에 넣어요.'],
    ] }]), 'x.hwpx');
    const r = extractRoles(doc);
    assert.equal(r.source, 'table');
    assert.deepEqual(r.roles.map((x) => [x.name, x.slots]), [['칠판 지우기', 2], ['화분 돌보기', 1], ['우유 당번', 2]]);
    assert.match(r.roles[0].description, /^수업이 끝나면/);
  });

  test('표가 없으면 "(2명)" 제목 줄로 나누고, 역할이 하나뿐인 양식 표는 무시한다', () => {
    const doc = extractDocument(Buffer.from('우리 반 역할\n\n1. 칠판 지우기 (2명)\n수업이 끝나면 칠판을 지워요.\n분필 가루도 털어요.\n2. 화분 돌보기 (1명)\n아침마다 물을 줘요.\n', 'utf8'), 'roles.txt');
    const r = extractRoles(doc);
    assert.equal(r.source, 'paragraphs');
    assert.deepEqual(r.roles.map((x) => [x.name, x.slots, x.description]), [['칠판 지우기', 2, '수업이 끝나면 칠판을 지워요. 분필 가루도 털어요.'], ['화분 돌보기', 1, '아침마다 물을 줘요.']]);
    const form = extractDocument(makeHwpx([{ type: 'table', rows: [['1지망', '하고 싶은 역할', ''], ['하고 싶은 이유', ''], ['우리 반에 어떤 도움을 주고 싶나요?', '']] }, { type: 'p', text: '선생님의 1인 1역 선정 기준' }]), 'form.hwpx');
    const r2 = extractRoles(form);
    assert.deepEqual(r2.roles, []);
    assert.equal(r2.source, null);
    assert.ok(r2.warnings.length);
    // 인원이 없으면 1명으로 두고 알려 줌
    const r3 = extractRoles(extractDocument(makeHwpx([{ type: 'table', rows: [['역할', '설명'], ['칠판', '칠판을 지워요. 깨끗하게 매일 지워요 정말로'], ['화분', '물을 줘요. 아침마다 꼭 잊지 않고 줘요']] }]), 'x'));
    assert.deepEqual(r3.roles.map((x) => x.slots), [1, 1]);
    assert.match(r3.warnings[0], /인원을 찾지 못해/);
  });
});

describe('학생 명단 추출', () => {
  const ROSTER_TABLE = [
    { type: 'p', text: '3학년 2반 명단' },
    { type: 'table', rows: [
      ['번호', '이름', '성별', '비고'],
      ['1', '김하늘', '남', ''],
      ['2', '이도윤', '남', '전학'],
      ['3', '박서연', '여', ''],
      ['4', '남궁민수', '남', ''],
      ['5', '김민준A', '남', ''],
      ['합계', '5명', '', ''],
    ] },
  ];
  const roster = (buf, name = 'x') => extractRoster(extractDocument(buf, name));
  const text = (s) => roster(Buffer.from(s, 'utf8'), 'names.txt');

  test('번호·이름 열이 있는 표 (hwpx · hwp · docx): 머리글과 합계 줄은 건너뛰고 번호순으로', () => {
    for (const [make, name] of [[makeHwpx, 'a.hwpx'], [makeHwp, 'a.hwp'], [makeDocx, 'a.docx']]) {
      const r = roster(make(ROSTER_TABLE), name);
      assert.equal(r.source, 'table', name);
      assert.deepEqual(r.names, ['김하늘', '이도윤', '박서연', '남궁민수', '김민준A'], name);
      assert.deepEqual(r.warnings, [], name);
    }
  });

  test('두 블록(1~3 | 4~6)으로 나뉜 표는 번호순으로, 번호가 없으면 열 단위로 읽는다', () => {
    const numbered = roster(makeHwpx([{ type: 'table', rows: [['번호', '이름', '번호', '이름'], ['1', '김하늘', '4', '최지우'], ['2', '이도윤', '5', '한지민'], ['3', '박서연', '6', '오세훈']] }]));
    assert.deepEqual(numbered.names, ['김하늘', '이도윤', '박서연', '최지우', '한지민', '오세훈']);
    const noHeader = roster(makeDocx([{ type: 'table', rows: [['1', '김하늘', '4', '최지우'], ['2', '이도윤', '5', '한지민'], ['3', '박서연', '6', '오세훈']] }]));
    assert.deepEqual(noHeader.names, ['김하늘', '이도윤', '박서연', '최지우', '한지민', '오세훈']);
    const plain = roster(makeHwpx([{ type: 'table', rows: [['이름', '이름'], ['김하늘', '최지우'], ['이도윤', '한지민'], ['박서연', '오세훈']] }]));
    assert.deepEqual(plain.names, ['김하늘', '이도윤', '박서연', '최지우', '한지민', '오세훈']);
    // 남/여 블록처럼 번호가 겹치면 번호로 섞지 않고 적힌 순서 그대로
    const boysGirls = roster(makeHwpx([{ type: 'table', rows: [['번호', '남학생', '번호', '여학생'], ['1', '김하늘', '1', '박서연'], ['2', '이도윤', '2', '최지우']] }]));
    assert.deepEqual(boysGirls.names, ['김하늘', '이도윤', '박서연', '최지우']);
  });

  test('칸 안에 번호가 함께 있는 표("3 김하늘", "김하늘(3)")와 한 칸에 적힌 목록, 띄어 쓴 이름', () => {
    assert.deepEqual(roster(makeHwpx([{ type: 'table', rows: [['3 김하늘', '1 이도윤'], ['2 박서연', '4 최지우']] }])).names, ['이도윤', '박서연', '김하늘', '최지우']);
    assert.deepEqual(roster(makeHwp([{ type: 'table', rows: [['김하늘(3)', '이도윤(1)'], ['박서연(2)', '최지우(4)']] }]), 'a.hwp').names, ['이도윤', '박서연', '김하늘', '최지우']);
    assert.deepEqual(roster(makeHwpx([{ type: 'table', rows: [[['1. 김하늘', '2. 이도윤', '3. 박서연']]] }])).names, ['김하늘', '이도윤', '박서연']);
    assert.deepEqual(roster(makeHwpx([{ type: 'table', rows: [['번호', '이 름'], ['1', '김 하 늘'], ['2', '이 도윤'], ['3', '남궁 민수']] }])).names, ['김하늘', '이도윤', '남궁민수']);
    // 제목 줄 + 머리글 줄, 비고 열의 낱말은 이름이 아님
    const titled = roster(makeDocx([{ type: 'table', rows: [['3학년 2반 명단'], ['번호', '이름', '비고'], ['1', '김하늘', '전학'], ['2', '이도윤', ''], ['3', '박서연', '전학']] }]));
    assert.equal(titled.source, 'table');
    assert.deepEqual(titled.names, ['김하늘', '이도윤', '박서연']);
  });

  test('표가 없으면 줄 단위: 번호 목록, 쉼표 목록, 한 줄에 여러 명, 문장 줄과 머리말은 무시', () => {
    const r = text('우리 반 명단\n1. 김하늘\n2. 이도윤\n3) 박서연\n4 최지우\n');
    assert.equal(r.source, 'lines');
    assert.deepEqual(r.names, ['김하늘', '이도윤', '박서연', '최지우']);
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(text('김하늘, 이도윤, 박서연 / 최지우 · 한지민').names, ['김하늘', '이도윤', '박서연', '최지우', '한지민']);
    assert.deepEqual(text('김하늘 이도윤 박서연 최지우').names, ['김하늘', '이도윤', '박서연', '최지우']);
    assert.deepEqual(text('1 김하늘    3 박서연\n2 이도윤    4 최지우').names, ['김하늘', '이도윤', '박서연', '최지우'], '두 단으로 적은 글은 번호순');
    assert.deepEqual(text('① 김하늘\n② 이도윤\n③ 박서연').names, ['김하늘', '이도윤', '박서연']);
    assert.deepEqual(text('1,김하늘,남\n2,이도윤,여').names, ['김하늘', '이도윤']);
    const sentence = '우리 반 학생들은 서로 사이좋게 지내며 친구를 도와주는 마음이 깊고 늘 밝게 인사하는 어린이들이에요. 선생님도 그런 학생들이 자랑스러워요.';
    assert.ok(sentence.length > 60);
    assert.deepEqual(text(`${sentence}\n김하늘\n이도윤`).names, ['김하늘', '이도윤']);
    assert.deepEqual(text('이름\n번호\n성별\n담임 홍길동\n김하늘\n이도윤 선생님\n박서연\n합계').names, ['김하늘', '박서연'], '머리말과 선생님 이름은 빼요');
    assert.deepEqual(text('하늘은 맑고\n학생들이 뛰어요').names, [], '성씨로 시작해도 문장 속 낱말은 넣지 않아요');
  });

  test('같은 이름은 한 번만 넣고 알려 주며, 번호까지 같으면 조용히 합친다', () => {
    const dup = text('김하늘\n이도윤\n김하늘');
    assert.deepEqual(dup.names, ['김하늘', '이도윤']);
    assert.match(dup.warnings[0], /같은 이름이 여러 번 있어 한 번만 넣었어요: 김하늘/);
    assert.deepEqual(text('1. 김하늘\n2. 이도윤\n1. 김하늘').warnings, []);
    assert.match(text('1. 김하늘\n2. 이도윤\n3. 김하늘').warnings[0], /같은 이름/);
    const twice = roster(makeHwpx([ROSTER_TABLE[1], ROSTER_TABLE[1]]));
    assert.deepEqual(twice.names, ['김하늘', '이도윤', '박서연', '남궁민수', '김민준A'], '같은 표가 두 번 있어도 한 번만');
    assert.deepEqual(twice.warnings, []);
  });

  test('이름이 하나도 없으면 안내, 성씨가 아닌 낱말이 많으면 확인 안내, 80명을 넘으면 앞의 80명만', () => {
    const none = text('안녕하세요\n반갑습니다');
    assert.deepEqual(none, { names: [], source: null, warnings: ['명단을 찾지 못했어요. 번호와 이름이 있는 표나, 한 줄에 한 명씩 적힌 파일을 올려 주세요.'] });
    assert.equal(roster(makeHwpx([{ type: 'table', rows: [['', ''], ['', '']] }])).source, null);
    const odd = text('1. 바나나\n2. 포도알\n3. 딸기');
    assert.deepEqual(odd.names, ['바나나', '포도알', '딸기']);
    assert.deepEqual(odd.warnings, ['이름이 아닌 낱말이 섞였을 수 있어요. 목록을 확인해 주세요.']);
    const many = roster(makeHwpx([{ type: 'table', rows: [['번호', '이름'], ...Array.from({ length: 85 }, (_, i) => [String(i + 1), `김하${String.fromCharCode(0xac00 + i)}`])] }]));
    assert.equal(many.names.length, 80);
    assert.equal(many.names[0], '김하가');
    assert.match(many.warnings[0], /80명만 넣었어요.*85명/);
  });
});
