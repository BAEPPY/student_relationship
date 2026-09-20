import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { Store } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'rooms.json');

const store = new Store(DATA_FILE);
const app = createApp({ store });

app.listen(PORT, () => {
  console.log(`학생 관계 마인드맵 서버 실행 중: http://localhost:${PORT}`);
  console.log(`데이터 파일: ${DATA_FILE}`);
});
