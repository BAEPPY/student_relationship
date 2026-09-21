/**
 * PostgreSQL 저장소. DATABASE_URL 이 설정되면 사용됩니다.
 * 교실 하나를 jsonb 한 행으로 저장하고, 수정은 행 잠금(FOR UPDATE) 트랜잭션 안에서
 * 처리해 여러 학생이 동시에 제출해도 응답이 유실되지 않게 합니다.
 *
 * Neon, Supabase, Render Postgres 등 어떤 PostgreSQL 이든 사용할 수 있습니다.
 */
export class PgStore {
  constructor(pool) {
    this.pool = pool;
  }

  static async connect(databaseUrl) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: databaseUrl, ssl: sslOptions(databaseUrl), max: 5 });
    const store = new PgStore(pool);
    await store.init();
    return store;
  }

  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS rooms_admin_token ON rooms ((data->>'adminToken'))`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS rooms_students ON rooms USING GIN ((data->'students'))`);
    return this;
  }

  async close() {
    await this.pool.end();
  }

  async getRoom(id) {
    const { rows } = await this.pool.query('SELECT data FROM rooms WHERE id = $1', [id]);
    return rows[0]?.data || null;
  }

  async createRoom(room) {
    await this.pool.query(
      'INSERT INTO rooms (id, data, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()',
      [room.id, JSON.stringify(room)],
    );
    return room;
  }

  async updateRoom(id, mutator) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT data FROM rooms WHERE id = $1 FOR UPDATE', [id]);
      if (!rows.length) {
        await client.query('ROLLBACK');
        return null;
      }
      const room = rows[0].data;
      mutator(room);
      await client.query('UPDATE rooms SET data = $2::jsonb, updated_at = now() WHERE id = $1', [id, JSON.stringify(room)]);
      await client.query('COMMIT');
      return room;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    } finally {
      client.release();
    }
  }

  async deleteRoom(id) {
    await this.pool.query('DELETE FROM rooms WHERE id = $1', [id]);
  }

  async findRoomByAdminToken(token) {
    if (!token) return null;
    const { rows } = await this.pool.query("SELECT data FROM rooms WHERE data->>'adminToken' = $1 LIMIT 1", [token]);
    return rows[0]?.data || null;
  }

  async findStudentByToken(token) {
    if (!token) return null;
    const { rows } = await this.pool.query("SELECT data FROM rooms WHERE data->'students' @> $1::jsonb LIMIT 1", [JSON.stringify([{ token }])]);
    const room = rows[0]?.data;
    if (!room) return null;
    const student = room.students.find((s) => s.token === token);
    return student ? { room, student } : null;
  }
}

/**
 * SSL 설정: 외부 호스팅 DB(Neon, Supabase, Render 외부 주소 등)는 SSL 이 필요하고,
 * 같은 네트워크 안의 내부 주소(localhost, Render 내부 호스트명)는 SSL 을 지원하지 않는 경우가 많습니다.
 * - DATABASE_SSL=false 또는 sslmode=disable → SSL 사용 안 함
 * - DATABASE_SSL_VERIFY=false → 인증서 검증 생략 (자체 서명 인증서를 쓰는 곳에서만)
 */
export function sslOptions(databaseUrl, env = process.env) {
  if (env.DATABASE_SSL === 'false' || /sslmode=disable/.test(databaseUrl)) return false;
  let host = '';
  try { host = new URL(databaseUrl).hostname; } catch { /* ignore */ }
  const internal = !host || host === 'localhost' || host === '127.0.0.1' || !host.includes('.');
  if (internal && env.DATABASE_SSL !== 'true') return false;
  return { rejectUnauthorized: env.DATABASE_SSL_VERIFY !== 'false' };
}
