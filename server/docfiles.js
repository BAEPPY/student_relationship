// 문서 파일(.hwp, .hwpx, .docx, .txt)에서 문단과 표를 읽어 냅니다.
// 외부 라이브러리 없이 동작합니다: zip(HWPX/DOCX)과 OLE 복합 문서(HWP 5.0)를 직접 읽습니다.
// 읽은 내용은 메모리에서만 쓰고 저장하지 않습니다.
import zlib from 'node:zlib';

const LIMITS = {
  file: 6 * 1024 * 1024,        // 업로드 파일 최대 크기
  inflated: 40 * 1024 * 1024,   // 압축을 푼 뒤 전체 최대 크기 (zip 폭탄 방지)
  entries: 4000,                // zip 항목 수 최대
  records: 400000,              // HWP 레코드 수 최대
  tableCells: 20000,            // 표 하나의 셀 수 최대
};

class DocError extends Error {
  constructor(message) { super(message); this.status = 400; this.expose = true; }
}
const fail = (m) => new DocError(m);

// ---------- zip ----------

/** zip 파일의 항목 목록을 읽습니다. 값은 필요할 때 압축을 푸는 함수입니다. */
export function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw fail('zip 파일이 아니에요.');
  // End of central directory 찾기 (뒤에서부터)
  const minPos = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw fail('zip 파일의 끝을 찾지 못했어요.');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count > LIMITS.entries) throw fail('zip 항목이 너무 많아요.');
  if (cdOffset >= buf.length) throw fail('zip 파일이 손상됐어요.');
  const entries = new Map();
  let p = cdOffset;
  let totalInflated = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw fail('zip 파일이 손상됐어요.');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (size === 0xffffffff || compSize === 0xffffffff) throw fail('너무 큰 zip(zip64)은 읽을 수 없어요.');
    totalInflated += size;
    if (totalInflated > LIMITS.inflated) throw fail('압축을 풀면 너무 커지는 파일이에요.');
    entries.set(name, () => {
      if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) throw fail('zip 파일이 손상됐어요.');
      const lnameLen = buf.readUInt16LE(localOffset + 26);
      const lextraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lnameLen + lextraLen;
      const data = buf.subarray(start, start + compSize);
      if (data.length !== compSize) throw fail('zip 파일이 손상됐어요.');
      if (method === 0) return Buffer.from(data);
      if (method === 8) {
        try {
          return zlib.inflateRawSync(data, { maxOutputLength: Math.min(size || LIMITS.inflated, LIMITS.inflated) });
        } catch { throw fail('zip 항목의 압축을 풀지 못했어요.'); }
      }
      throw fail('지원하지 않는 zip 압축 방식이에요.');
    });
  }
  return entries;
}

// ---------- OLE 복합 문서 (HWP 5.0 컨테이너) ----------

const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

/** OLE 복합 문서를 읽어 { "BodyText/Section0": Buffer } 꼴로 돌려줍니다. */
export function readCfb(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 512) throw fail('한글 파일이 아니에요.');
  const sig = buf.subarray(0, 8).toString('hex');
  if (sig !== 'd0cf11e0a1b11ae1') throw fail('한글(hwp) 파일 형식이 아니에요.');
  const sectorShift = buf.readUInt16LE(30);
  const miniShift = buf.readUInt16LE(32);
  if (![9, 12].includes(sectorShift) || miniShift !== 6) throw fail('지원하지 않는 한글 파일 형식이에요.');
  const sectorSize = 1 << sectorShift;
  const numFat = buf.readUInt32LE(44);
  const firstDir = buf.readUInt32LE(48);
  const miniCutoff = buf.readUInt32LE(56) || 4096;
  const firstMiniFat = buf.readUInt32LE(60);
  const numMiniFat = buf.readUInt32LE(64);
  const firstDifat = buf.readUInt32LE(68);
  const numDifat = buf.readUInt32LE(72);
  const maxSectors = Math.floor(buf.length / sectorSize);
  const sectorAt = (n) => {
    const off = (n + 1) * sectorSize;
    if (n >= maxSectors || off + sectorSize > buf.length) throw fail('한글 파일이 손상됐어요.');
    return buf.subarray(off, off + sectorSize);
  };
  const u32s = (b) => { const out = new Array(b.length >> 2); for (let i = 0; i < out.length; i++) out[i] = b.readUInt32LE(i * 4); return out; };

  // DIFAT → FAT 섹터 목록
  const fatSectors = [];
  for (let i = 0; i < 109 && fatSectors.length < numFat; i++) {
    const s = buf.readUInt32LE(76 + i * 4);
    if (s === FREESECT || s === ENDOFCHAIN) break;
    fatSectors.push(s);
  }
  let difat = firstDifat;
  for (let n = 0; n < numDifat && difat !== ENDOFCHAIN && difat !== FREESECT; n++) {
    const arr = u32s(sectorAt(difat));
    for (let i = 0; i < arr.length - 1 && fatSectors.length < numFat; i++) {
      if (arr[i] === FREESECT) break;
      fatSectors.push(arr[i]);
    }
    difat = arr[arr.length - 1];
  }
  const fat = [];
  for (const s of fatSectors) fat.push(...u32s(sectorAt(s)));

  const chain = (start, table, limit) => {
    const out = [];
    const seen = new Set();
    let s = start;
    while (s !== ENDOFCHAIN && s !== FREESECT && s !== undefined) {
      if (seen.has(s) || out.length > limit) throw fail('한글 파일이 손상됐어요.');
      seen.add(s);
      out.push(s);
      s = table[s];
    }
    return out;
  };
  const readChain = (start, size) => {
    const parts = chain(start, fat, maxSectors + 1).map(sectorAt);
    const all = Buffer.concat(parts);
    return size === undefined ? all : all.subarray(0, Math.min(size, all.length));
  };

  // 디렉터리 (128바이트 항목; 빈 항목은 자리만 차지)
  const dir = readChain(firstDir);
  const slots = [];
  for (let off = 0, i = 0; off + 128 <= dir.length; off += 128, i++) {
    const type = dir[off + 66];
    if (!type) { slots[i] = null; continue; }
    const nameLen = dir.readUInt16LE(off + 64);
    slots[i] = {
      name: nameLen >= 2 ? dir.subarray(off, off + Math.min(nameLen - 2, 64)).toString('utf16le') : '',
      type,
      left: dir.readUInt32LE(off + 68),
      right: dir.readUInt32LE(off + 72),
      child: dir.readUInt32LE(off + 76),
      start: dir.readUInt32LE(off + 116),
      size: dir.readUInt32LE(off + 120),
    };
  }
  const root = slots[0];
  if (!root || root.type !== 5) throw fail('한글 파일이 손상됐어요.');

  // 미니 스트림
  const miniStream = root.size ? readChain(root.start, root.size) : Buffer.alloc(0);
  const miniFat = [];
  if (numMiniFat && firstMiniFat !== ENDOFCHAIN && firstMiniFat !== FREESECT) {
    for (const s of chain(firstMiniFat, fat, maxSectors + 1)) miniFat.push(...u32s(sectorAt(s)));
  }
  const readMini = (start, size) => {
    const parts = chain(start, miniFat, (miniStream.length >> 6) + 1).map((s) => {
      const off = s * 64;
      if (off + 64 > miniStream.length) throw fail('한글 파일이 손상됐어요.');
      return miniStream.subarray(off, off + 64);
    });
    return Buffer.concat(parts).subarray(0, size);
  };
  const readStream = (e) => (e.size < miniCutoff ? readMini(e.start, e.size) : readChain(e.start, e.size));

  // 트리를 돌며 경로 만들기
  const streams = new Map();
  const visited = new Set();
  const walk = (idx, prefix) => {
    if (idx === FREESECT || idx >= slots.length || visited.has(idx)) return;
    visited.add(idx);
    const e = slots[idx];
    if (!e) return;
    walk(e.left, prefix);
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.type === 2) streams.set(path, () => readStream(e));
    else if (e.type === 1) walk(e.child, path);
    walk(e.right, prefix);
  };
  walk(root.child, '');
  return streams;
}

// ---------- HWP 5.0 본문 레코드 ----------

const TAG = { PARA_HEADER: 66, PARA_TEXT: 67, LIST_HEADER: 72, TABLE: 77 };
const INLINE_CTRL = new Set([4, 5, 6, 7, 8, 9, 19, 20]);
const EXTENDED_CTRL = new Set([1, 2, 3, 11, 12, 14, 15, 16, 17, 18, 21, 22, 23]);

function* hwpRecords(buf) {
  let i = 0;
  let n = 0;
  while (i + 4 <= buf.length) {
    if (++n > LIMITS.records) throw fail('한글 파일이 너무 복잡해요.');
    const h = buf.readUInt32LE(i);
    const tag = h & 0x3ff;
    const level = (h >> 10) & 0x3ff;
    let size = (h >> 20) & 0xfff;
    i += 4;
    if (size === 0xfff) {
      if (i + 4 > buf.length) break;
      size = buf.readUInt32LE(i);
      i += 4;
    }
    if (i + size > buf.length) break;
    yield { tag, level, body: buf.subarray(i, i + size) };
    i += size;
  }
}

/** PARA_TEXT 레코드(UTF-16LE + 컨트롤 문자)를 글로 바꿉니다. */
export function decodeHwpText(body) {
  let out = '';
  let i = 0;
  while (i + 2 <= body.length) {
    const ch = body.readUInt16LE(i);
    if (INLINE_CTRL.has(ch) || EXTENDED_CTRL.has(ch)) {
      if (ch === 9) out += ' ';
      i += 16; // 인라인·확장 컨트롤은 8글자(16바이트)를 차지
      continue;
    }
    i += 2;
    if (ch === 10) out += '\n';
    else if (ch === 13 || ch === 0) continue;
    else if (ch === 24) out += '-';
    else if (ch === 30 || ch === 31) out += ' ';
    else if (ch < 32) continue;
    else out += String.fromCharCode(ch);
  }
  return out;
}

/** 본문 섹션 레코드를 문단·표 블록으로 바꿉니다. */
function parseHwpSection(buf) {
  const blocks = [];
  const tableStack = [];
  const finishTable = () => {
    const t = tableStack.pop();
    const rowsMap = new Map();
    for (const c of t.cells) {
      if (!rowsMap.has(c.row)) rowsMap.set(c.row, []);
      rowsMap.get(c.row).push(c);
    }
    const rows = [...rowsMap.entries()].sort((a, b) => a[0] - b[0]).map(([, cells]) => cells.sort((a, b) => a.col - b.col).map((c) => c.paragraphs));
    t.block.rows = rows;
  };
  for (const rec of hwpRecords(buf)) {
    const { tag, level, body } = rec;
    // 표 밖으로 나오면 표를 마무리
    while (tableStack.length && level <= tableStack[tableStack.length - 1].level - 1 && tag !== TAG.LIST_HEADER) finishTable();
    while (tableStack.length && tag === TAG.LIST_HEADER && level < tableStack[tableStack.length - 1].level) finishTable();
    if (tag === TAG.TABLE) {
      if (body.length < 8) continue;
      const rows = body.readUInt16LE(4);
      const cols = body.readUInt16LE(6);
      let total = 0;
      for (let r = 0; r < rows && 18 + r * 2 + 2 <= body.length; r++) total += body.readUInt16LE(18 + r * 2);
      if (!total) total = rows * cols;
      if (total > LIMITS.tableCells) throw fail('표가 너무 커요.');
      const block = { type: 'table', rows: [] };
      // 셀 안의 표는 그 셀 문단에 붙지 않고 별도 블록으로 뒤에 둡니다.
      const parentTable = tableStack[tableStack.length - 1];
      if (parentTable) parentTable.block.nested = (parentTable.block.nested || 0) + 1;
      blocks.push(block);
      tableStack.push({ level, total, cells: [], current: null, block });
      continue;
    }
    if (tag === TAG.LIST_HEADER) {
      const top = tableStack[tableStack.length - 1];
      if (top && level === top.level && top.cells.length < top.total && body.length >= 14) {
        const cell = { col: body.readUInt16LE(6), row: body.readUInt16LE(8), paragraphs: [] };
        top.cells.push(cell);
        top.current = cell;
      }
      continue;
    }
    if (tag === TAG.PARA_TEXT) {
      const text = decodeHwpText(body).trim();
      if (!text) continue;
      let target = null;
      for (let k = tableStack.length - 1; k >= 0; k--) {
        if (tableStack[k].level < level && tableStack[k].current) { target = tableStack[k].current; break; }
      }
      if (target) target.paragraphs.push(text);
      else blocks.push({ type: 'p', text });
    }
  }
  while (tableStack.length) finishTable();
  return blocks;
}

export function parseHwp(buf) {
  const streams = readCfb(buf);
  const header = streams.get('FileHeader')?.();
  if (!header || header.subarray(0, 17).toString('latin1') !== 'HWP Document File') throw fail('한글(hwp 5.0) 파일이 아니에요. 한글 97 등 옛 형식은 "다른 이름으로 저장"에서 hwpx 로 저장해 주세요.');
  const flags = header.length >= 40 ? header.readUInt32LE(36) : 0;
  if (flags & 0b10) throw fail('암호가 걸린 한글 파일은 읽을 수 없어요. 암호를 푼 뒤 올려 주세요.');
  if (flags & 0b100) throw fail('배포용(읽기 전용) 한글 문서는 읽을 수 없어요. 일반 문서로 저장한 뒤 올려 주세요.');
  const compressed = Boolean(flags & 0b1);
  const names = [...streams.keys()].filter((n) => /^BodyText\/Section\d+$/.test(n)).sort((a, b) => Number(a.match(/\d+$/)[0]) - Number(b.match(/\d+$/)[0]));
  if (!names.length) throw fail('한글 파일에서 본문을 찾지 못했어요.');
  const blocks = [];
  for (const name of names) {
    let data = streams.get(name)();
    if (compressed) {
      try { data = zlib.inflateRawSync(data, { maxOutputLength: LIMITS.inflated }); } catch { throw fail('한글 파일의 본문을 풀지 못했어요.'); }
    }
    blocks.push(...parseHwpSection(data));
  }
  return { format: 'hwp', blocks };
}

// ---------- XML 기반 (HWPX · DOCX) ----------

function decodeEntities(s) {
  return s.replace(/&(lt|gt|amp|quot|apos|#x[0-9a-fA-F]+|#\d+);/g, (m, e) => {
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'amp') return '&';
    if (e === 'quot') return '"';
    if (e === 'apos') return '\'';
    const code = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

/**
 * 표·문단 태그 이름을 받아 XML 에서 문단과 표를 뽑습니다.
 * 중첩된 표(셀 안의 표)도 별도의 표로 읽습니다.
 */
export function parseXmlBlocks(xml, names) {
  const blocks = [];
  const tableStack = [];   // { block, rows }
  const rowStack = [];     // cells[]
  const cellStack = [];    // paragraphs[]
  const paraStack = [];    // { text }
  let inText = null;       // { start }
  const tagRe = /<(\/?)([A-Za-z0-9_:.-]+)((?:\s[^>]*?)?)(\/?)>/g;
  const brRe = new RegExp(`<${names.br}\\b[^>]*/?>`, 'g');
  const tabRe = new RegExp(`<${names.tab}\\b[^>]*/?>`, 'g');
  const addText = (raw) => {
    const text = decodeEntities(raw.replace(brRe, '\n').replace(tabRe, ' ').replace(/<[^>]*>/g, ''));
    if (!text) return;
    const para = paraStack[paraStack.length - 1];
    if (para) para.text += text;
    else blocks.push({ type: 'p', text });
  };
  let m;
  while ((m = tagRe.exec(xml))) {
    const [, closing, name, , selfClose] = m;
    if (inText) {
      if (closing && name === names.t) {
        addText(xml.slice(inText.start, m.index));
        inText = null;
      }
      continue; // 글 안의 lineBreak 등은 addText 에서 처리
    }
    if (name === names.t) {
      if (!closing && !selfClose) inText = { start: m.index + m[0].length };
      continue;
    }
    if (name === names.p) {
      if (selfClose) continue;
      if (!closing) { paraStack.push({ text: '' }); continue; }
      const para = paraStack.pop();
      if (!para) continue;
      const text = para.text.trim();
      const cell = cellStack[cellStack.length - 1];
      if (cell) { if (text) cell.push(text); } else if (text) blocks.push({ type: 'p', text });
      continue;
    }
    if (name === names.tbl) {
      if (selfClose) continue;
      if (!closing) {
        const block = { type: 'table', rows: [] };
        const parent = tableStack[tableStack.length - 1];
        if (parent) parent.block.nested = (parent.block.nested || 0) + 1;
        blocks.push(block);
        tableStack.push({ block });
      } else tableStack.pop();
      continue;
    }
    if (name === names.tr) {
      if (selfClose) continue;
      if (!closing) rowStack.push([]);
      else {
        const row = rowStack.pop();
        const t = tableStack[tableStack.length - 1];
        if (row && t) {
          t.block.rows.push(row);
          if (t.block.rows.length * Math.max(1, row.length) > LIMITS.tableCells) throw fail('표가 너무 커요.');
        }
      }
      continue;
    }
    if (name === names.tc) {
      if (selfClose) { rowStack[rowStack.length - 1]?.push([]); continue; }
      if (!closing) cellStack.push([]);
      else {
        const cell = cellStack.pop();
        rowStack[rowStack.length - 1]?.push(cell || []);
      }
    }
  }
  return blocks;
}

const HWPX_NAMES = { tbl: 'hp:tbl', tr: 'hp:tr', tc: 'hp:tc', p: 'hp:p', t: 'hp:t', br: 'hp:lineBreak', tab: 'hp:tab' };
const DOCX_NAMES = { tbl: 'w:tbl', tr: 'w:tr', tc: 'w:tc', p: 'w:p', t: 'w:t', br: 'w:br', tab: 'w:tab' };

export function parseHwpx(buf) {
  const zip = readZip(buf);
  const sections = [...zip.keys()].filter((n) => /^Contents\/section\d+\.xml$/i.test(n)).sort((a, b) => Number(a.match(/(\d+)\.xml$/i)[1]) - Number(b.match(/(\d+)\.xml$/i)[1]));
  if (!sections.length) throw fail('hwpx 파일에서 본문을 찾지 못했어요.');
  const blocks = [];
  for (const name of sections) blocks.push(...parseXmlBlocks(zip.get(name)().toString('utf8'), HWPX_NAMES));
  return { format: 'hwpx', blocks };
}

export function parseDocx(buf) {
  const zip = readZip(buf);
  const doc = zip.get('word/document.xml');
  if (!doc) throw fail('워드(docx) 파일에서 본문을 찾지 못했어요.');
  return { format: 'docx', blocks: parseXmlBlocks(doc().toString('utf8'), DOCX_NAMES) };
}

export function parseText(buf) {
  let text = buf.toString('utf8');
  if (text.includes('�')) {
    try { text = new TextDecoder('euc-kr').decode(buf); } catch { /* ICU 없음 → utf8 그대로 */ }
  }
  text = text.replace(/^﻿/, '');
  const blocks = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => ({ type: 'p', text: l }));
  return { format: 'txt', blocks };
}

// ---------- 형식 판별 ----------

/** 파일 내용과 이름으로 형식을 알아내어 문단·표 블록을 돌려줍니다. */
export function extractDocument(buf, fileName = '') {
  if (!Buffer.isBuffer(buf) || !buf.length) throw fail('파일이 비어 있어요.');
  if (buf.length > LIMITS.file) throw fail('파일이 너무 커요. (최대 6MB)');
  const ext = String(fileName || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
  const head = buf.subarray(0, 8).toString('hex');
  if (head === 'd0cf11e0a1b11ae1') return parseHwp(buf);
  if (buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50) {
    const zip = readZip(buf);
    if ([...zip.keys()].some((n) => /^Contents\/section\d+\.xml$/i.test(n))) return parseHwpx(buf);
    if (zip.has('word/document.xml')) return parseDocx(buf);
    if (zip.has('xl/workbook.xml')) throw fail('엑셀 파일은 아직 읽을 수 없어요. 표를 복사해 붙여넣거나 한글·워드로 저장해 주세요.');
    throw fail('zip 안에서 한글(hwpx)이나 워드(docx) 본문을 찾지 못했어요.');
  }
  if (ext === 'hwp') throw fail('한글(hwp 5.0) 파일 형식이 아니에요. 한글에서 "다른 이름으로 저장"으로 hwp 나 hwpx 로 저장해 주세요.');
  if (ext === 'hwpx' || ext === 'docx') throw fail(`${ext} 파일이 손상됐거나 형식이 달라요.`);
  if (ext === 'pdf' || head.startsWith('255044462d')) throw fail('PDF 는 읽을 수 없어요. 한글·워드 파일이나 텍스트를 올려 주세요.');
  if (ext && !['txt', 'csv', 'md'].includes(ext)) throw fail(`.${ext} 파일은 지원하지 않아요. (.hwp, .hwpx, .docx, .txt)`);
  // 텍스트로 간주: 제어 문자가 많으면 바이너리
  const sample = buf.subarray(0, 2048);
  let weird = 0;
  for (const b of sample) if (b < 9 || (b > 13 && b < 32)) weird++;
  if (weird > sample.length / 20) throw fail('읽을 수 있는 글이 아니에요. (.hwp, .hwpx, .docx, .txt 파일을 올려 주세요)');
  return parseText(buf);
}

// ---------- 활용: 붙여넣기용 글, 역할 목록 ----------

const cellText = (cell) => (Array.isArray(cell) ? cell : [String(cell ?? '')]).map((p) => String(p).replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ');

/** 문서를 "지난달 현황" 붙여넣기 칸에 넣을 글로 바꿉니다. 표는 한 줄에 한 행, 칸은 " | " 로 나눕니다. */
export function documentToText(doc) {
  const lines = [];
  for (const b of doc.blocks) {
    if (b.type === 'p') lines.push(b.text.replace(/\s+/g, ' ').trim());
    else for (const row of b.rows) lines.push(row.map(cellText).join(' | '));
  }
  return lines.filter(Boolean).join('\n');
}

const compact = (s) => String(s || '').replace(/[\s()（）\[\]·,.:：\-_'"‘’“”]/g, '').toLowerCase();
const SLOT_RE = /\(?\s*(\d{1,2})\s*명\s*\)?/;
const NAME_HEADER = /역할|이름|명칭|직책|담당/;
const DESC_HEADER = /해야|하는\s*일|할\s*일|설명|내용|활동|임무|업무|역할\s*소개/;
const SLOT_HEADER = /인원|정원|명수|몇\s*명|사람\s*수/;
const UNFINISHED = /(는|은|의|과|와|을|를|하는|주는|있는|없는|위한|에게|에서|부터|까지)$/;

/** 역할 이름 칸(문단 여러 개)에서 이름·부제·인원을 뽑습니다. */
export function parseRoleNameCell(paragraphs, knownCompact = new Set()) {
  let slots = null;
  const subtitle = [];
  const nameParts = [];
  for (const raw of (Array.isArray(paragraphs) ? paragraphs : [paragraphs]).map((p) => String(p ?? '').trim()).filter(Boolean)) {
    let text = raw;
    const sm = SLOT_RE.exec(text);
    if (sm && slots === null) { slots = Number(sm[1]); text = text.replace(sm[0], ' '); }
    // 괄호 안은 부제
    text = text.replace(/[(（]([^)）]*)[)）]/g, (m, inner) => { const t = inner.trim(); if (t) subtitle.push(t); return ' '; });
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (!nameParts.length) { nameParts.push(text); continue; }
    const joined = `${nameParts.join(' ')} ${text}`;
    const prev = nameParts[nameParts.length - 1];
    if (knownCompact.has(compact(joined)) || UNFINISHED.test(prev)) nameParts.push(text);
    else subtitle.push(text);
  }
  return { name: nameParts.join(' ').trim(), subtitle: subtitle.join(', ').trim(), slots };
}

function looksNumeric(text) { return /^\s*\d{1,3}\s*$/.test(text); }

/**
 * 문서에서 역할 목록을 뽑습니다. 역할 이름 열과 설명 열이 있는 표를 우선 찾고, 없으면 "(2명)" 같은 제목 줄을 기준으로 문단을 묶습니다.
 * @returns {{ roles: {name, subtitle, slots, description}[], source: 'table'|'paragraphs'|null, warnings: string[] }}
 */
export function extractRoles(doc, { knownNames = [] } = {}) {
  const knownCompact = new Set(knownNames.map(compact));
  const warnings = [];
  const finish = (roles, source) => {
    const seen = new Set();
    const out = [];
    const noSlots = [];
    for (const r of roles) {
      const key = compact(r.name);
      if (!r.name || seen.has(key)) continue;
      seen.add(key);
      if (!r.slots) noSlots.push(r.name);
      out.push({ name: r.name.slice(0, 40), subtitle: (r.subtitle || '').slice(0, 40), slots: Math.min(10, Math.max(1, r.slots || 1)), description: (r.description || '').slice(0, 600) });
    }
    if (noSlots.length) warnings.push(`인원을 찾지 못해 1명으로 두었어요: ${noSlots.join(', ')}`);
    return { roles: out, source: out.length ? source : null, warnings };
  };

  // 1) 표
  const tables = doc.blocks.filter((b) => b.type === 'table' && b.rows.length >= 2 && Math.max(...b.rows.map((r) => r.length)) >= 2);
  let best = null;
  for (const t of tables) {
    const cols = Math.max(...t.rows.map((r) => r.length));
    const header = t.rows[0].map(cellText);
    let nameCol = header.findIndex((h) => NAME_HEADER.test(h) && !DESC_HEADER.test(h));
    let descCol = header.findIndex((h) => DESC_HEADER.test(h));
    let slotCol = header.findIndex((h) => SLOT_HEADER.test(h));
    const hasHeader = nameCol >= 0 || descCol >= 0;
    const dataRows = (hasHeader ? t.rows.slice(1) : t.rows).filter((r) => r.some((c) => cellText(c)));
    if (!dataRows.length) continue;
    const avgLen = (ci) => dataRows.reduce((n, r) => n + cellText(r[ci] || []).length, 0) / dataRows.length;
    const nums = (ci) => dataRows.map((r) => /^\s*(\d{1,3})\s*명?\s*$/.exec(cellText(r[ci] || []))).map((m) => (m ? Number(m[1]) : null));
    // 번호 열: 대부분 숫자이고 아래로 갈수록 커짐. 인원 열: 10 이하의 작은 숫자(또는 "2명")가 대부분
    const isIndexCol = (ci) => { const v = nums(ci).filter((x) => x !== null); return v.length >= dataRows.length * 0.6 && v.length >= 2 && v.every((x, i) => i === 0 || x > v[i - 1]); };
    const slotLike = (ci) => { const v = nums(ci); const ok = v.filter((x) => x !== null && x >= 1 && x <= 10); return ok.length >= dataRows.length * 0.6 && !isIndexCol(ci); };
    const numericCol = (ci) => isIndexCol(ci) || slotLike(ci);
    const candidates = [...Array(cols).keys()].filter((ci) => !numericCol(ci));
    if (descCol < 0) {
      const sorted = [...candidates].sort((a, b) => avgLen(b) - avgLen(a));
      descCol = sorted.find((ci) => ci !== nameCol && avgLen(ci) >= 20) ?? -1;
    }
    if (nameCol < 0) {
      const sorted = candidates.filter((ci) => ci !== descCol && !slotLike(ci)).sort((a, b) => avgLen(a) - avgLen(b));
      nameCol = sorted.find((ci) => avgLen(ci) > 0 && avgLen(ci) <= 30) ?? -1;
    }
    if (slotCol < 0) slotCol = [...Array(cols).keys()].find((ci) => ci !== nameCol && ci !== descCol && slotLike(ci)) ?? -1;
    if (nameCol < 0) continue;
    const score = dataRows.length + (descCol >= 0 ? 100 : 0) + (hasHeader ? 50 : 0);
    if (!best || score > best.score) best = { t, nameCol, descCol, slotCol, dataRows, score };
  }
  if (best) {
    const roles = [];
    for (const row of best.dataRows) {
      const cell = row[best.nameCol];
      if (!cell) continue;
      const parsed = parseRoleNameCell(cell, knownCompact);
      if (!parsed.name || NAME_HEADER.test(parsed.name) && parsed.name.length <= 4) continue;
      if (parsed.slots === null && best.slotCol >= 0) {
        const m = /(\d{1,2})/.exec(cellText(row[best.slotCol] || []));
        if (m) parsed.slots = Number(m[1]);
      }
      const description = best.descCol >= 0 ? cellText(row[best.descCol] || []) : '';
      roles.push({ ...parsed, description });
    }
    if (roles.length >= 2) return finish(roles, 'table');   // 역할이 하나뿐인 표는 양식(지원서 등)일 가능성이 커요
  }

  // 2) 문단: "(2명)" 처럼 인원이 붙은 짧은 줄을 역할 제목으로 (번호만 있는 줄은 제목으로 보지 않음 — 양식 문서를 역할로 오해하지 않도록)
  const paras = doc.blocks.filter((b) => b.type === 'p').map((b) => b.text.trim()).filter(Boolean);
  const HEADING_SLOT = /\(\s*\d{1,2}\s*명\s*\)|\d{1,2}\s*명\s*$/;
  const isHeading = (line) => line.length <= 40 && HEADING_SLOT.test(line);
  const roles = [];
  let current = null;
  for (const line of paras) {
    if (isHeading(line)) {
      const cleaned = line.replace(/^(\d{1,2}[.)]|[①-⑳●■◆▶•-])\s*/, '');
      const parsed = parseRoleNameCell([cleaned], knownCompact);
      if (!parsed.name) continue;
      current = { ...parsed, description: '' };
      roles.push(current);
    } else if (current) {
      current.description = `${current.description} ${line}`.trim();
    }
  }
  if (roles.length >= 2) return finish(roles, 'paragraphs');
  warnings.push('역할 이름과 설명이 들어 있는 표를 찾지 못했어요. 첫 열에 역할 이름, 다른 열에 설명이 있는 표가 있어야 해요.');
  return { roles: [], source: null, warnings };
}

export const DOC_LIMITS = LIMITS;
