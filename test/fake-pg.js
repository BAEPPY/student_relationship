// pg.Pool 을 흉내 내는 아주 작은 가짜 구현 (PgStore 가 쓰는 SQL 문장만 이해합니다).
export class FakePool {
  constructor() {
    this.rows = new Map();
    this.log = [];
    this.ended = false;
  }

  async query(text, params) {
    return this.exec(text, params);
  }

  async connect() {
    const pool = this;
    let snapshot = null;
    return {
      async query(text, params) {
        pool.log.push(text);
        if (/^BEGIN/.test(text)) { snapshot = new Map(pool.rows); return { rows: [] }; }
        if (/^COMMIT/.test(text)) { snapshot = null; return { rows: [] }; }
        if (/^ROLLBACK/.test(text)) { if (snapshot) { pool.rows = snapshot; snapshot = null; } return { rows: [] }; }
        return pool.exec(text, params);
      },
      release() {},
    };
  }

  async end() { this.ended = true; }

  exec(text, params) {
    this.log.push(text);
    const clone = (v) => JSON.parse(JSON.stringify(v));
    const rows = this.rows;
    if (/^CREATE/.test(text)) return { rows: [] };
    if (/^INSERT INTO rooms/.test(text) || /^UPDATE rooms/.test(text)) { rows.set(params[0], JSON.parse(params[1])); return { rows: [] }; }
    if (/^DELETE FROM rooms/.test(text)) { rows.delete(params[0]); return { rows: [] }; }
    if (/WHERE id = \$1/.test(text)) { const d = rows.get(params[0]); return { rows: d ? [{ data: clone(d) }] : [] }; }
    if (/data->>'adminToken'/.test(text)) {
      for (const d of rows.values()) if (d.adminToken === params[0]) return { rows: [{ data: clone(d) }] };
      return { rows: [] };
    }
    if (/data->'students' @>/.test(text)) {
      const [{ token }] = JSON.parse(params[0]);
      for (const d of rows.values()) if (d.students.some((s) => s.token === token)) return { rows: [{ data: clone(d) }] };
      return { rows: [] };
    }
    throw new Error(`지원하지 않는 SQL: ${text}`);
  }
}
