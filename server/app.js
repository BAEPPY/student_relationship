import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { FileStore } from './store.js';
import { newToken, newId } from './tokens.js';
import { REASON_CATALOG, isValidTag } from './reasons.js';
import { computeStats, listRelations, analyzeConflicts } from './analysis.js';
import * as pages from './pages.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const LIMITS = {
  roomName: 60,
  studentName: 30,
  students: 80,
  reason: 300,
  minRelations: 10,
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (msg) => new HttpError(400, msg);

function cleanName(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

function parseStudentNames(input) {
  const raw = Array.isArray(input) ? input.join('\n') : String(input ?? '');
  const names = raw
    .split(/[\n,、，;]+/)
    .map(cleanName)
    .filter(Boolean);
  const unique = [];
  const seen = new Set();
  for (const n of names) {
    if (n.length > LIMITS.studentName) throw bad(`이름은 ${LIMITS.studentName}자 이하로 입력해 주세요: ${n.slice(0, 10)}…`);
    if (seen.has(n)) throw bad(`같은 이름이 두 번 있어요: ${n}. 구분할 수 있게 적어 주세요 (예: 김민준A, 김민준B).`);
    seen.add(n);
    unique.push(n);
  }
  return unique;
}

function makeStudent(name) {
  return { id: newId(), name, token: newToken(16), createdAt: new Date().toISOString() };
}

export function createApp({ store = new FileStore(null), baseUrl = process.env.BASE_URL || '', storageNotice = null, storageKind = 'file' } = {}) {
  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '300kb' }));
  app.use((req, res, next) => {
    // 토큰이 담긴 주소가 다른 사이트로 새지 않도록
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    next();
  });

  const publicBase = (req) => (baseUrl ? baseUrl.replace(/\/+$/, '') : `${req.protocol}://${req.get('host')}`);
  const studentUrl = (req, student) => `${publicBase(req)}/s/${student.token}`;
  const adminUrl = (req, room) => `${publicBase(req)}/t/${room.adminToken}`;

  // ---------- helpers ----------
  async function requireRoom(req) {
    const room = await store.findRoomByAdminToken(req.params.adminToken);
    if (!room) throw new HttpError(404, '교실을 찾을 수 없어요. 관리자 링크를 확인해 주세요.');
    return room;
  }

  async function requireStudent(req) {
    const found = await store.findStudentByToken(req.params.token);
    if (!found) throw new HttpError(404, '링크가 올바르지 않아요. 선생님께 QR 코드를 다시 받아 주세요.');
    return found;
  }

  // 교실을 잠그고(저장소에 따라) 읽어서 고친 뒤 저장합니다. mutator 가 던지면 아무것도 바뀌지 않습니다.
  async function mutateRoom(room, mutator) {
    const updated = await store.updateRoom(room.id, mutator);
    if (!updated) throw new HttpError(404, '교실을 찾을 수 없어요. 관리자 링크를 확인해 주세요.');
    return updated;
  }

  function findStudent(room, studentId) {
    const student = room.students.find((s) => s.id === studentId);
    if (!student) throw new HttpError(404, '학생을 찾을 수 없어요.');
    return student;
  }

  function effectiveMin(room, classmateCount) {
    return Math.max(0, Math.min(room.minRelations ?? 3, classmateCount));
  }

  function teacherView(req, room) {
    const stats = computeStats(room);
    const analysis = analyzeConflicts(room, stats);
    return {
      room: {
        id: room.id,
        name: room.name,
        createdAt: room.createdAt,
        locked: Boolean(room.locked),
        minRelations: room.minRelations ?? 3,
        adminUrl: adminUrl(req, room),
      },
      students: room.students.map((s) => ({
        id: s.id,
        name: s.name,
        token: s.token,
        url: studentUrl(req, s),
        submitted: stats[s.id].submitted,
        submittedAt: stats[s.id].submittedAt,
      })),
      relations: listRelations(room),
      stats,
      analysis,
      catalog: REASON_CATALOG,
      notice: storageNotice,
      seating: room.seating || null,
      teacherNotes: room.teacherNotes || { students: {}, rules: [] },
    };
  }

  function studentView(req, room, student) {
    const classmates = room.students.filter((s) => s.id !== student.id).map((s) => ({ id: s.id, name: s.name }));
    const mine = room.relations?.[student.id] || {};
    const relations = {};
    for (const c of classmates) if (mine[c.id]) relations[c.id] = mine[c.id];
    return {
      room: { name: room.name, locked: Boolean(room.locked), minRelations: effectiveMin(room, classmates.length) },
      me: { id: student.id, name: student.name },
      classmates,
      relations,
      submittedAt: room.submissions?.[student.id]?.submittedAt || null,
      catalog: REASON_CATALOG,
    };
  }

  // ---------- pages ----------
  const page = (html) => (req, res) => res.type('html').send(html);
  app.get('/', page(pages.index));
  app.get('/t/:adminToken', page(pages.teacher));
  app.get('/t/:adminToken/print', page(pages.print));
  app.get('/t/:adminToken/seats', page(pages.seats));
  app.get('/s/:token', page(pages.student));
  app.use(express.static(PUBLIC_DIR, { index: false }));

  app.get('/api/health', (req, res) => res.json({ ok: true, storage: storageKind, notice: storageNotice || null }));

  // ---------- room creation ----------
  app.post('/api/rooms', async (req, res) => {
    const name = cleanName(req.body?.name);
    if (!name) throw bad('교실 이름을 입력해 주세요.');
    if (name.length > LIMITS.roomName) throw bad(`교실 이름은 ${LIMITS.roomName}자 이하로 입력해 주세요.`);
    const names = parseStudentNames(req.body?.students);
    if (names.length < 2) throw bad('학생을 2명 이상 입력해 주세요.');
    if (names.length > LIMITS.students) throw bad(`학생은 최대 ${LIMITS.students}명까지 등록할 수 있어요.`);
    let minRelations = Number.parseInt(req.body?.minRelations ?? 3, 10);
    if (!Number.isFinite(minRelations)) minRelations = 3;
    minRelations = Math.max(1, Math.min(LIMITS.minRelations, minRelations));

    const room = {
      id: newId(6),
      name,
      adminToken: newToken(24),
      createdAt: new Date().toISOString(),
      locked: false,
      minRelations,
      students: names.map(makeStudent),
      relations: {},
      submissions: {},
    };
    await store.createRoom(room);
    res.status(201).json({ id: room.id, name: room.name, adminToken: room.adminToken, adminUrl: adminUrl(req, room), studentCount: room.students.length });
  });

  // 체험용 예시 교실 (임의의 관계 데이터 포함)
  app.post('/api/rooms/demo', async (req, res) => {
    const names = ['김하늘', '이도윤', '박서연', '최지우', '정민준', '강예린', '조현우', '윤서아', '임시우', '한지민', '오준서', '서다은'];
    const room = {
      id: newId(6),
      name: '예시 교실 (체험용)',
      adminToken: newToken(24),
      createdAt: new Date().toISOString(),
      locked: false,
      minRelations: 3,
      students: names.map(makeStudent),
      relations: {},
      submissions: {},
    };
    const ids = room.students.map((s) => s.id);
    const goodTags = REASON_CATALOG.good.map((r) => r.id);
    const badTags = REASON_CATALOG.bad.map((r) => r.id);
    // 결정적인 의사난수(같은 패턴이 매번 나오도록)
    let seed = 7;
    const rand = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    const now = new Date().toISOString();
    ids.forEach((from, i) => {
      if (i === ids.length - 1) return; // 한 명은 미제출로 남겨 둠
      const rels = {};
      const count = 3 + Math.floor(rand() * 3);
      const others = ids.filter((x) => x !== from);
      while (Object.keys(rels).length < count) {
        const to = pick(others);
        if (rels[to]) continue;
        const isBad = rand() < 0.3;
        rels[to] = isBad
          ? { type: 'bad', tags: [pick(badTags)], reason: rand() < 0.5 ? '지난주에 말다툼을 했어요.' : '', updatedAt: now }
          : { type: 'good', tags: rand() < 0.7 ? [pick(goodTags)] : [], reason: rand() < 0.3 ? '쉬는 시간에 항상 같이 놀아요.' : '', updatedAt: now };
      }
      room.relations[from] = rels;
      room.submissions[from] = { submittedAt: now };
    });
    await store.createRoom(room);
    res.status(201).json({ id: room.id, name: room.name, adminToken: room.adminToken, adminUrl: adminUrl(req, room), studentCount: room.students.length });
  });

  // ---------- teacher API ----------
  app.get('/api/teacher/:adminToken', async (req, res) => {
    const room = await requireRoom(req);
    res.json(teacherView(req, room));
  });

  app.patch('/api/teacher/:adminToken', async (req, res) => {
    const found = await requireRoom(req);
    const body = req.body || {};
    const room = await mutateRoom(found, (room) => {
      if (typeof body.locked === 'boolean') room.locked = body.locked;
      if (body.minRelations !== undefined) {
        const n = Number.parseInt(body.minRelations, 10);
        if (!Number.isFinite(n) || n < 1 || n > LIMITS.minRelations) throw bad(`최소 인원은 1~${LIMITS.minRelations} 사이여야 해요.`);
        room.minRelations = n;
      }
      if (body.name !== undefined) {
        const name = cleanName(body.name);
        if (!name || name.length > LIMITS.roomName) throw bad('교실 이름이 올바르지 않아요.');
        room.name = name;
      }
    });
    res.json(teacherView(req, room));
  });

  app.delete('/api/teacher/:adminToken', async (req, res) => {
    const room = await requireRoom(req);
    await store.deleteRoom(room.id);
    res.json({ ok: true });
  });

  app.post('/api/teacher/:adminToken/students', async (req, res) => {
    const found = await requireRoom(req);
    const names = parseStudentNames(req.body?.name ?? req.body?.students);
    if (names.length === 0) throw bad('학생 이름을 입력해 주세요.');
    const room = await mutateRoom(found, (room) => {
      if (room.students.length + names.length > LIMITS.students) throw bad(`학생은 최대 ${LIMITS.students}명까지 등록할 수 있어요.`);
      for (const n of names) {
        if (room.students.some((s) => s.name === n)) throw bad(`이미 있는 이름이에요: ${n}`);
      }
      for (const n of names) room.students.push(makeStudent(n));
    });
    res.status(201).json(teacherView(req, room));
  });

  app.patch('/api/teacher/:adminToken/students/:studentId', async (req, res) => {
    const found = await requireRoom(req);
    findStudent(found, req.params.studentId);
    const name = cleanName(req.body?.name);
    if (!name || name.length > LIMITS.studentName) throw bad('이름이 올바르지 않아요.');
    const room = await mutateRoom(found, (room) => {
      const student = findStudent(room, req.params.studentId);
      if (room.students.some((s) => s.id !== student.id && s.name === name)) throw bad(`이미 있는 이름이에요: ${name}`);
      student.name = name;
    });
    res.json(teacherView(req, room));
  });

  app.delete('/api/teacher/:adminToken/students/:studentId', async (req, res) => {
    const found = await requireRoom(req);
    findStudent(found, req.params.studentId);
    const room = await mutateRoom(found, (room) => {
      const idx = room.students.findIndex((s) => s.id === req.params.studentId);
      if (idx === -1) throw new HttpError(404, '학생을 찾을 수 없어요.');
      const [student] = room.students.splice(idx, 1);
      room.relations ||= {};
      room.submissions ||= {};
      delete room.relations[student.id];
      delete room.submissions[student.id];
      for (const targets of Object.values(room.relations)) delete targets[student.id];
      if (room.teacherNotes) {
        delete room.teacherNotes.students?.[student.id];
        room.teacherNotes.rules = (room.teacherNotes.rules || []).filter((r) => r.a !== student.id && r.b !== student.id);
      }
      if (room.seating?.seats) {
        for (const [seatId, sid] of Object.entries(room.seating.seats)) if (sid === student.id) delete room.seating.seats[seatId];
      }
    });
    res.json(teacherView(req, room));
  });

  // 교사 메모와 지정 규칙 (앞자리 필요, 떨어뜨리기/가까이 앉히기)
  app.put('/api/teacher/:adminToken/notes', async (req, res) => {
    const found = await requireRoom(req);
    const body = req.body || {};
    const ids = new Set(found.students.map((st) => st.id));
    const students = {};
    for (const [sid, n] of Object.entries(body.notes || {})) {
      if (!ids.has(sid)) throw bad('없는 학생이 메모에 포함되어 있어요.');
      const memo = String(n?.memo ?? '').trim();
      if (memo.length > LIMITS.reason) throw bad(`메모는 ${LIMITS.reason}자 이하로 적어 주세요.`);
      const front = Boolean(n?.front);
      if (memo || front) students[sid] = { memo, front };
    }
    const rules = [];
    const seen = new Set();
    for (const r of Array.isArray(body.rules) ? body.rules : []) {
      if (!r || !['apart', 'together'].includes(r.type)) throw bad('규칙 종류는 떨어뜨리기 또는 가까이 앉히기여야 해요.');
      if (!ids.has(r.a) || !ids.has(r.b) || r.a === r.b) throw bad('규칙의 학생이 올바르지 않아요.');
      const key = [r.a, r.b].sort().join('|');
      if (seen.has(key)) throw bad('같은 두 학생에 대한 규칙이 두 개 있어요.');
      seen.add(key);
      rules.push({ type: r.type, a: r.a, b: r.b, note: String(r.note ?? '').trim().slice(0, 100) });
    }
    if (rules.length > 100) throw bad('규칙은 100개까지 만들 수 있어요.');
    const room = await mutateRoom(found, (rm) => { rm.teacherNotes = { students, rules, updatedAt: new Date().toISOString() }; });
    res.json(teacherView(req, room));
  });

  // 학생 응답 초기화
  app.post('/api/teacher/:adminToken/students/:studentId/reset', async (req, res) => {
    const found = await requireRoom(req);
    findStudent(found, req.params.studentId);
    const room = await mutateRoom(found, (room) => {
      const student = findStudent(room, req.params.studentId);
      room.relations ||= {};
      room.submissions ||= {};
      delete room.relations[student.id];
      delete room.submissions[student.id];
    });
    res.json(teacherView(req, room));
  });

  // 학생 링크(QR) 재발급 - 기존 링크는 더 이상 동작하지 않음
  app.post('/api/teacher/:adminToken/students/:studentId/rotate', async (req, res) => {
    const found = await requireRoom(req);
    findStudent(found, req.params.studentId);
    const room = await mutateRoom(found, (room) => {
      findStudent(room, req.params.studentId).token = newToken(16);
    });
    res.json(teacherView(req, room));
  });

  // 자리 배정 저장
  app.put('/api/teacher/:adminToken/seating', async (req, res) => {
    const found = await requireRoom(req);
    const body = req.body || {};
    const blocks = Array.isArray(body.layout?.blocks) ? body.layout.blocks : null;
    if (!blocks || blocks.length < 1 || blocks.length > 6) throw bad('교실 배치는 1~6개 블록으로 입력해 주세요.');
    const layout = { blocks: blocks.map((b) => {
      const cols = Number.parseInt(b?.cols, 10);
      const rows = Number.parseInt(b?.rows, 10);
      if (!(cols >= 1 && cols <= 4) || !(rows >= 1 && rows <= 10)) throw bad('블록은 가로 1~4, 세로 1~10 사이여야 해요.');
      return { cols, rows };
    }) };
    const validSeat = /^b\d+-r\d+-c\d+$/;
    const seats = {};
    const used = new Set();
    for (const [seatId, studentId] of Object.entries(body.seats || {})) {
      if (!validSeat.test(seatId)) throw bad('좌석 정보가 올바르지 않아요.');
      if (!studentId) continue;
      if (!found.students.some((st) => st.id === studentId)) throw bad('없는 학생이 좌석에 포함되어 있어요.');
      if (used.has(studentId)) throw bad('한 학생이 두 자리에 배정되어 있어요.');
      used.add(studentId);
      seats[seatId] = studentId;
    }
    const pinned = [...new Set((Array.isArray(body.pinned) ? body.pinned : []).filter((id) => validSeat.test(id)))];
    const options = { friends: ['near', 'any', 'apart'].includes(body.options?.friends) ? body.options.friends : 'any' };
    const room = await mutateRoom(found, (r) => { r.seating = { layout, seats, pinned, options, updatedAt: new Date().toISOString() }; });
    res.json(teacherView(req, room));
  });

  app.get('/api/teacher/:adminToken/qr/:studentId.svg', async (req, res) => {
    const room = await requireRoom(req);
    const student = findStudent(room, req.params.studentId);
    const svg = await QRCode.toString(studentUrl(req, student), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
  });

  app.get('/api/teacher/:adminToken/export.json', async (req, res) => {
    const room = await requireRoom(req);
    const view = teacherView(req, room);
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(room.name)}.json`);
    res.json({ exportedAt: new Date().toISOString(), room: view.room, students: view.students.map(({ token, url, ...s }) => s), relations: view.relations, analysis: view.analysis, teacherNotes: view.teacherNotes, seating: view.seating });
  });

  app.get('/api/teacher/:adminToken/export.csv', async (req, res) => {
    const room = await requireRoom(req);
    const nameOf = Object.fromEntries(room.students.map((s) => [s.id, s.name]));
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['보낸 학생', '받은 학생', '관계', '선택한 이유', '직접 쓴 이유', '수정 시각'].map(esc).join(',')];
    for (const r of listRelations(room)) {
      rows.push([nameOf[r.from], nameOf[r.to], r.type === 'good' ? '좋은 사이' : '안 좋은 사이', r.tagLabels.join('; '), r.reason, r.updatedAt].map(esc).join(','));
    }
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(room.name)}.csv`);
    res.type('text/csv; charset=utf-8').send(`﻿${rows.join('\r\n')}`);
  });

  // ---------- student API ----------
  app.get('/api/student/:token', async (req, res) => {
    const { room, student } = await requireStudent(req);
    res.json(studentView(req, room, student));
  });

  app.put('/api/student/:token/relations', async (req, res) => {
    const { room: found, student: me } = await requireStudent(req);
    const input = req.body?.relations;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('보낸 내용이 올바르지 않아요.');

    const room = await mutateRoom(found, (room) => {
      const student = room.students.find((s) => s.id === me.id && s.token === me.token);
      if (!student) throw new HttpError(404, '링크가 올바르지 않아요. 선생님께 QR 코드를 다시 받아 주세요.');
      if (room.locked) throw new HttpError(403, '선생님이 제출을 마감했어요. 더 이상 수정할 수 없어요.');

      const classmates = new Set(room.students.filter((s) => s.id !== student.id).map((s) => s.id));
      const now = new Date().toISOString();
      const prev = room.relations?.[student.id] || {};
      const next = {};
      for (const [toId, r] of Object.entries(input)) {
        if (!classmates.has(toId)) throw bad('우리 반 친구가 아닌 학생이 포함되어 있어요.');
        if (!r || (r.type !== 'good' && r.type !== 'bad')) throw bad('관계 종류는 좋은 사이 또는 안 좋은 사이여야 해요.');
        const tags = Array.isArray(r.tags) ? [...new Set(r.tags.map(String))] : [];
        for (const t of tags) if (!isValidTag(r.type, t)) throw bad('선택한 이유가 올바르지 않아요.');
        const reason = String(r.reason ?? '').trim();
        if (reason.length > LIMITS.reason) throw bad(`이유는 ${LIMITS.reason}자 이하로 적어 주세요.`);
        if (r.type === 'bad' && tags.length === 0 && !reason) {
          const name = room.students.find((s) => s.id === toId)?.name || '';
          throw bad(`${name}와(과) 안 좋은 사이인 이유를 꼭 적어 주세요.`);
        }
        const unchanged = prev[toId] && prev[toId].type === r.type && prev[toId].reason === reason && JSON.stringify(prev[toId].tags || []) === JSON.stringify(tags);
        next[toId] = { type: r.type, tags, reason, updatedAt: unchanged ? prev[toId].updatedAt : now };
      }
      const min = effectiveMin(room, classmates.size);
      if (Object.keys(next).length < min) throw bad(`친구를 ${min}명 이상 표시해 주세요. (지금 ${Object.keys(next).length}명)`);

      room.relations ||= {};
      room.submissions ||= {};
      room.relations[student.id] = next;
      room.submissions[student.id] = { submittedAt: now, firstSubmittedAt: room.submissions[student.id]?.firstSubmittedAt || now };
    });
    res.json(studentView(req, room, room.students.find((s) => s.id === me.id)));
  });

  // ---------- fallbacks ----------
  app.use('/api', (req, res) => res.status(404).json({ error: '없는 주소예요.' }));
  app.use((req, res) => res.status(404).type('html').send(pages.notFound));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    const message = status >= 500 ? '서버에 문제가 생겼어요. 잠시 후 다시 시도해 주세요.' : err.message;
    if (req.path.startsWith('/api')) res.status(status).json({ error: message });
    else res.status(status).type('text/plain').send(message);
  });

  return app;
}
