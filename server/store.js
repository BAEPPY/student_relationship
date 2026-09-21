import fs from 'node:fs';
import path from 'node:path';

/**
 * JSON 파일 저장소 (기본값).
 * - 모든 데이터는 메모리에 있고, 변경될 때마다 파일에 원자적으로 기록합니다.
 * - file 이 null 이면 메모리에만 저장합니다(테스트용).
 *
 * 모든 저장소는 같은 메서드를 제공하며, 결과는 값 또는 Promise 일 수 있습니다.
 * (app.js 는 항상 await 로 호출합니다.)
 */
export class FileStore {
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

  async init() { return this; }
  async close() {}

  getRoom(id) { return this.data.rooms[id] || null; }

  createRoom(room) {
    this.data.rooms[room.id] = room;
    this.save();
    return room;
  }

  /**
   * 교실을 읽고-고치고-저장하는 작업을 원자적으로 수행합니다.
   * mutator 가 예외를 던지면 아무것도 바뀌지 않습니다.
   */
  updateRoom(id, mutator) {
    const room = this.data.rooms[id];
    if (!room) return null;
    const copy = structuredClone(room);
    mutator(copy);
    this.data.rooms[id] = copy;
    this.save();
    return copy;
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

// 이전 이름과의 호환
export { FileStore as Store };
