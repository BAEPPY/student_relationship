import { FileStore } from './store.js';
import { PgStore } from './pgstore.js';

/**
 * 환경에 맞는 저장소를 엽니다.
 * - DATABASE_URL(또는 POSTGRES_URL) 이 있으면 PostgreSQL
 * - 없으면 JSON 파일 (서버리스 환경에서는 메모리 → 저장되지 않음을 알림)
 */
export async function openStore({
  databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || '',
  dataFile = null,
  serverless = false,
} = {}) {
  const url = String(databaseUrl || '').trim();
  let notice = null;
  if (url) {
    try {
      const store = await PgStore.connect(url);
      return { store, kind: 'postgres', notice: null };
    } catch (err) {
      console.error('[store] DATABASE_URL 로 PostgreSQL 에 연결하지 못했습니다:', err.message);
      notice = serverless
        ? 'DATABASE_URL 로 데이터베이스에 연결하지 못했어요. 지금은 아무것도 저장되지 않으니 연결 문자열을 확인하고 다시 배포해 주세요.'
        : 'DATABASE_URL 로 데이터베이스에 연결하지 못해 임시 파일에 저장하고 있어요. 서버가 재시작되면 데이터가 지워질 수 있으니 DATABASE_URL 값을 확인하거나 결과를 내보내 두세요.';
    }
  }
  if (serverless) {
    return {
      store: new FileStore(null),
      kind: 'memory',
      notice: notice || '데이터베이스가 연결되지 않아 만든 교실이 저장되지 않아요. Vercel 프로젝트의 Storage 탭에서 Neon 데이터베이스를 연결한 뒤 다시 배포해 주세요.',
    };
  }
  return { store: new FileStore(dataFile), kind: 'file', notice };
}
