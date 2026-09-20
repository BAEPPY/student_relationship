import fs from 'node:fs';
import path from 'node:path';

/**
 * 아주 단순한 JSON 파일 저장소.
 * - 모든 데이터는 메모리에 있고, 변경될 때마다 파일에 원자적으로 기록합니다.
 * - file 이 null 이면 메모리에만 저장합니다(테스트용).
 */
export class Store {
  constructor(file = null) {
    this.file = file;
    this.data = { version: 1, rooms: {} };
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.rooms) this.data = parsed;
      }
    } catch (err) {
      // 손상된 파일은 백업해 두고 빈 상태로 시작합니다.
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try { fs.copyFileSync(this.file, backup); } catch { /* ignore */ }
      console.error(`[store] 데이터 파일을 읽지 못했습니다. 백업: ${backup}`, err);
    }
  }

  save() {
    if (!this.file) return;
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  // ---- rooms ----
  get rooms() { return this.data.rooms; }

  getRoom(id) { return this.data.rooms[id] || null; }

  putRoom(room) {
    this.data.rooms[room.id] = room;
    this.save();
    return room;
  }

  deleteRoom(id) {
    delete this.data.rooms[id];
    this.save();
  }

  findRoomByAdminToken(token) {
    if (!token) return null;
    return Object.values(this.data.rooms).find((r) => r.adminToken === token) || null;
  }

  findStudentByToken(token) {
    if (!token) return null;
    for (const room of Object.values(this.data.rooms)) {
      const student = room.students.find((s) => s.token === token);
      if (student) return { room, student };
    }
    return null;
  }
}
