import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { openStore } from './storage.js';
import { purgeAll, RETENTION_MONTHS } from './retention.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'rooms.json');

const { store, kind, notice } = await openStore({ dataFile: DATA_FILE });
if (kind === 'postgres') {
  console.log('저장소: PostgreSQL (DATABASE_URL)');
} else {
  console.log(`저장소: JSON 파일 (${DATA_FILE})`);
  console.log('  ※ 클라우드 무료 서버는 재시작 시 파일이 지워질 수 있어요. 오래 보관하려면 DATABASE_URL 을 설정하세요.');
}

const app = createApp({ store, storageKind: kind, storageNotice: notice });

// 보관 기간(기본 14개월)이 지난 응답 정리: 시작할 때 한 번, 그 뒤 하루에 한 번
async function runRetention() {
  try {
    const r = await purgeAll(store);
    if (r.deletedRounds || r.deletedRooms) console.log(`[보관 정책] ${RETENTION_MONTHS}개월이 지난 데이터 정리: 회차 ${r.deletedRounds}개, 교실 ${r.deletedRooms}개 삭제`);
  } catch (err) {
    console.error('[보관 정책] 정리 중 오류:', err.message);
  }
}
runRetention();
setInterval(runRetention, 24 * 60 * 60 * 1000).unref();
app.listen(PORT, '0.0.0.0', () => {
  console.log('학생 관계 마인드맵 서버 실행 중');
  console.log(`  이 컴퓨터에서:      http://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  같은 Wi-Fi 기기에서: http://${ip}:${PORT}`);
  if (process.env.BASE_URL) console.log(`  공개 주소(BASE_URL): ${process.env.BASE_URL}`);
});

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  return out;
}
