// 의존성 없는 zip 만들기 (HWPX · DOCX 내보내기용)
import zlib from 'node:zlib';

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

/** DOS 날짜·시각 (zip 항목용) */
function dosDateTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  const year = Math.max(1980, d.getFullYear());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, day: day & 0xffff };
}

/**
 * zip 파일을 만듭니다.
 * @param {Array<{ name: string, data: string|Buffer, store?: boolean }>} entries 순서대로 기록 (HWPX 는 mimetype 을 맨 앞에 압축 없이)
 */
export function makeZip(entries, { date = new Date() } = {}) {
  const { time, day } = dosDateTime(date);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8');
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const method = entry.store ? 0 : 8;
    const stored = entry.store ? data : zlib.deflateRawSync(data, { level: 6 });
    const crc = crc32(data);
    // 일반 플래그: deflate 는 0x0004(한글 저장 파일과 같게), 이름에 ASCII 가 아닌 글자가 있으면 0x0800(UTF-8)
    const flags = (method === 8 ? 0x0004 : 0) | (/[^\x20-\x7e]/.test(entry.name) ? 0x0800 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
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
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
