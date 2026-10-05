// 테스트용 문서 생성기: zip(HWPX·DOCX)과 OLE 복합 문서(HWP 5.0)를 최소 구조로 만듭니다.
import zlib from 'node:zlib';

// ---------- zip ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** { 'path/in/zip': string|Buffer } → zip Buffer. deflate=true 면 deflate 로 압축합니다. */
export function makeZip(entries, { deflate = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const method = deflate ? 8 : 0;
    const stored = deflate ? zlib.deflateRawSync(data) : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // utf-8 이름
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, stored);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + stored.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 문단·표를 HWPX 본문 XML 로. 표는 rows: string[][] 또는 셀마다 문단 배열. */
export function hwpxSection(blocks) {
  const para = (text) => `<hp:p id="1" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>${esc(text)}</hp:t></hp:run></hp:p>`;
  const cell = (c) => `<hp:tc><hp:cellAddr/><hp:subList>${(Array.isArray(c) ? c : [c]).map(para).join('')}</hp:subList></hp:tc>`;
  const table = (rows) => `<hp:p id="2"><hp:run><hp:tbl rowCnt="${rows.length}" colCnt="${Math.max(...rows.map((r) => r.length))}">${rows.map((r) => `<hp:tr>${r.map(cell).join('')}</hp:tr>`).join('')}</hp:tbl></hp:run></hp:p>`;
  const body = blocks.map((b) => (b.type === 'table' ? table(b.rows) : para(b.text))).join('\n');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">\n${body}\n</hs:sec>`;
}

export function makeHwpx(blocks, opts) {
  return makeZip({ mimetype: 'application/hwp+zip', 'Contents/content.hpf': '<opf:package/>', 'Contents/section0.xml': hwpxSection(blocks) }, opts);
}

export function docxDocument(blocks) {
  const para = (text) => `<w:p><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
  const cell = (c) => `<w:tc>${(Array.isArray(c) ? c : [c]).map(para).join('')}</w:tc>`;
  const table = (rows) => `<w:tbl>${rows.map((r) => `<w:tr>${r.map(cell).join('')}</w:tr>`).join('')}</w:tbl>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${blocks.map((b) => (b.type === 'table' ? table(b.rows) : para(b.text))).join('')}</w:body></w:document>`;
}

export function makeDocx(blocks, opts) {
  return makeZip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': docxDocument(blocks) }, opts);
}

// ---------- HWP 5.0 (OLE 복합 문서) ----------
const TAG = { PARA_HEADER: 66, PARA_TEXT: 67, CTRL_HEADER: 71, LIST_HEADER: 72, TABLE: 77 };

function record(tag, level, body) {
  const head = Buffer.alloc(4);
  head.writeUInt32LE((tag & 0x3ff) | ((level & 0x3ff) << 10) | ((body.length & 0xfff) << 20), 0);
  return Buffer.concat([head, body]);
}
const utf16 = (s) => Buffer.from(s, 'utf16le');
const u16 = (...vals) => { const b = Buffer.alloc(vals.length * 2); vals.forEach((v, i) => b.writeUInt16LE(v, i * 2)); return b; };

/** 문단·표 블록을 HWP 본문 섹션 레코드로 만듭니다. (실제 한글 파일의 레코드 단계 구조를 따릅니다) */
export function hwpSectionRecords(blocks) {
  const out = [];
  const paragraph = (level, text) => {
    out.push(record(TAG.PARA_HEADER, level, Buffer.alloc(24)));
    if (text) out.push(record(TAG.PARA_TEXT, level + 1, Buffer.concat([utf16(text), u16(13)])));
  };
  for (const b of blocks) {
    if (b.type !== 'table') { paragraph(0, b.text); continue; }
    // 표를 담는 문단: 확장 컨트롤(11) 8글자 + 문단 끝
    out.push(record(TAG.PARA_HEADER, 0, Buffer.alloc(24)));
    out.push(record(TAG.PARA_TEXT, 1, u16(11, 0x20, 0x6c, 0x62, 0x74, 0, 0, 11, 13)));
    out.push(record(TAG.CTRL_HEADER, 1, Buffer.from(' lbt', 'latin1')));
    const rows = b.rows;
    const cols = Math.max(...rows.map((r) => r.length));
    const tbl = Buffer.alloc(18 + rows.length * 2 + 2);
    tbl.writeUInt16LE(rows.length, 4);
    tbl.writeUInt16LE(cols, 6);
    rows.forEach((r, i) => tbl.writeUInt16LE(r.length, 18 + i * 2));
    out.push(record(TAG.TABLE, 2, tbl));
    rows.forEach((r, ri) => r.forEach((c, ci) => {
      const paras = Array.isArray(c) ? c : [c];
      const lh = Buffer.alloc(47);
      lh.writeInt16LE(paras.length, 0);
      lh.writeUInt16LE(ci, 6);
      lh.writeUInt16LE(ri, 8);
      lh.writeUInt16LE(1, 10);
      lh.writeUInt16LE(1, 12);
      out.push(record(TAG.LIST_HEADER, 2, lh));
      for (const p of paras) paragraph(2, p);
    }));
  }
  return Buffer.concat(out);
}

const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const FATSECT = 0xfffffffd;
const NOSTREAM = 0xffffffff;

function dirEntry({ name, type, left = NOSTREAM, right = NOSTREAM, child = NOSTREAM, start = 0, size = 0 }) {
  const e = Buffer.alloc(128, 0);
  const n = Buffer.from(name, 'utf16le');
  n.copy(e, 0);
  e.writeUInt16LE(n.length + 2, 64);
  e[66] = type;
  e[67] = 1;
  e.writeUInt32LE(left, 68);
  e.writeUInt32LE(right, 72);
  e.writeUInt32LE(child, 76);
  e.writeUInt32LE(start, 116);
  e.writeUInt32LE(size, 120);
  return e;
}

/**
 * HWP 5.0 파일을 만듭니다. FileHeader·DocInfo 는 미니 스트림에, 본문은 4096 바이트 이상이면 일반 섹터에 들어갑니다.
 * flags: 1 = 압축(기본), 2 = 암호, 4 = 배포용
 */
export function makeHwp(blocks, { flags = 1, pad = 0 } = {}) {
  const SEC = 512;
  const header = Buffer.alloc(256, 0);
  Buffer.from('HWP Document File', 'latin1').copy(header, 0);
  header.writeUInt32LE(0x05010000, 32);
  header.writeUInt32LE(flags, 36);
  const docInfo = Buffer.alloc(64, 0);
  const padded = pad ? [...blocks, ...Array.from({ length: pad }, (_, i) => ({ type: 'p', text: `채우기 문단 ${i}` }))] : blocks;
  let section = hwpSectionRecords(padded);
  if (flags & 1) section = zlib.deflateRawSync(section);

  // 미니 스트림: FileHeader, DocInfo, (작으면) Section0
  const mini = [];
  const miniFat = [];
  const miniPut = (data) => {
    const start = mini.length;
    const count = Math.max(1, Math.ceil(data.length / 64));
    for (let i = 0; i < count; i++) {
      const chunk = Buffer.alloc(64, 0);
      data.copy(chunk, 0, i * 64, Math.min(data.length, (i + 1) * 64));
      mini.push(chunk);
      miniFat.push(i === count - 1 ? ENDOFCHAIN : start + i + 1);
    }
    return start;
  };
  const headerStart = miniPut(header);
  const docInfoStart = miniPut(docInfo);
  const sectionInMini = section.length < 4096;
  const sectionMiniStart = sectionInMini ? miniPut(section) : 0;
  const miniStream = Buffer.concat(mini);

  // 일반 섹터 배치: 0 FAT, 1-2 디렉터리, 3 미니FAT, 4.. 미니 스트림, 그다음 Section0(큰 경우)
  const sectors = [];
  const fat = [];
  const put = (data) => {
    const start = sectors.length;
    const count = Math.max(1, Math.ceil(data.length / SEC));
    for (let i = 0; i < count; i++) {
      const chunk = Buffer.alloc(SEC, 0);
      data.copy(chunk, 0, i * SEC, Math.min(data.length, (i + 1) * SEC));
      sectors.push(chunk);
      fat.push(i === count - 1 ? ENDOFCHAIN : start + i + 1);
    }
    return start;
  };
  sectors.push(null); fat.push(FATSECT);               // 0: FAT (나중에 채움)
  const dirStart = put(Buffer.alloc(2 * SEC));           // 1-2: 디렉터리 자리
  const miniFatBuf = Buffer.alloc(SEC, 0xff);
  miniFat.forEach((v, i) => miniFatBuf.writeUInt32LE(v, i * 4));
  const miniFatStart = put(miniFatBuf);                  // 3
  const miniStart = put(miniStream);                     // 4..
  const sectionStart = sectionInMini ? sectionMiniStart : put(section);

  const dir = Buffer.concat([
    dirEntry({ name: 'Root Entry', type: 5, child: 1, start: miniStart, size: miniStream.length }),
    dirEntry({ name: 'FileHeader', type: 2, right: 2, start: headerStart, size: header.length }),
    dirEntry({ name: 'BodyText', type: 1, right: 3, child: 4 }),
    dirEntry({ name: 'DocInfo', type: 2, start: docInfoStart, size: docInfo.length }),
    dirEntry({ name: 'Section0', type: 2, start: sectionStart, size: section.length }),
  ]);
  dir.copy(sectors[dirStart], 0, 0, SEC);
  dir.copy(sectors[dirStart + 1], 0, SEC, dir.length);

  const fatBuf = Buffer.alloc(SEC, 0xff);
  fat.forEach((v, i) => fatBuf.writeUInt32LE(v, i * 4));
  sectors[0] = fatBuf;

  const head = Buffer.alloc(SEC, 0);
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(head, 0);
  head.writeUInt16LE(0x003e, 24);
  head.writeUInt16LE(3, 26);
  head.writeUInt16LE(0xfffe, 28);
  head.writeUInt16LE(9, 30);
  head.writeUInt16LE(6, 32);
  head.writeUInt32LE(1, 44);              // FAT 섹터 수
  head.writeUInt32LE(dirStart, 48);
  head.writeUInt32LE(4096, 56);
  head.writeUInt32LE(miniFatStart, 60);
  head.writeUInt32LE(1, 64);
  head.writeUInt32LE(ENDOFCHAIN, 68);
  head.writeUInt32LE(0, 72);
  head.fill(0xff, 76, 76 + 109 * 4);
  head.writeUInt32LE(0, 76);              // DIFAT[0] = FAT 섹터 0
  return Buffer.concat([head, ...sectors]);
}
