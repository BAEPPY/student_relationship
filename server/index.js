import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { FileStore } from './store.js';
import { PgStore } from './pgstore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'rooms.json');
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();

let store;
let storageNotice = null;
if (DATABASE_URL) {
  try {
    store = await PgStore.connect(DATABASE_URL);
    console.log('저장소: PostgreSQL (DATABASE_URL)');
  } catch (err) {
    console.error('[store] DATABASE_URL 로 PostgreSQL 에 연결하지 못했습니다:', err.message);
    storageNotice = 'DATABASE_URL 로 데이터베이스에 연결하지 못해 임시 파일에 저장하고 있어요. 서버가 재시작되면 데이터가 지워질 수 있으니 DATABASE_URL 값을 확인하거나 결과를 내보내 두세요.';
  }
}
if (!store) {
  store = new FileStore(DATA_FILE);
  console.log(`저장소: JSON 파일 (${DATA_FILE})`);
  console.log('  ※ 클라우드 무료 서버는 재시작 시 파일이 지워질 수 있어요. 오래 보관하려면 DATABASE_URL 을 설정하세요.');
}

const app = createApp({ store, storageNotice });
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
