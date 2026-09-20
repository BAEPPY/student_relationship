import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { Store } from './store.js';
import { newToken, newId } from './tokens.js';
import { REASON_CATALOG, isValidTag } from './reasons.js';
import { computeStats, listRelations, analyzeConflicts } from './analysis.js';

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

export function createApp({ store = new Store(null), baseUrl = process.env.BASE_URL || '' } = {}) {
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
  function requireRoom(req) {
    const room = store.findRoomByAdminToken(req.params.adminToken);
    if (!room) throw new HttpError(404, '교실을 찾을 수 없어요. 관리자 링크를 확인해 주세요.');
    return room;
  }

  function requireStudent(req) {
    const found = store.findStudentByToken(req.params.token);
    if (!found) throw new HttpError(404, '링크가 올바르지 않아요. 선생님께 QR 코드를 다시 받아 주세요.');
    return found;
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
  app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
  app.get('/t/:adminToken', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'teacher.html')));
  app.get('/t/:adminToken/print', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'print.html')));
  app.get('/s/:token', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'student.html')));
  app.use(express.static(PUBLIC_DIR, { index: false }));

  // ---------- room creation ----------
  app.post('/api/rooms', (req, res) => {
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
    store.putRoom(room);
    res.status(201).json({ id: room.id, name: room.name, adminToken: room.adminToken, adminUrl: adminUrl(req, room), studentCount: room.students.length });
  });

  // 체험용 예시 교실 (임의의 관계 데이터 포함)
  app.post('/api/rooms/demo', (req, res) => {
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
    store.putRoom(room);
    res.status(201).json({ id: room.id, name: room.name, adminToken: room.adminToken, adminUrl: adminUrl(req, room), studentCount: room.students.length });
  });

  // ---------- teacher API ----------
  app.get('/api/teacher/:adminToken', (req, res) => {
    const room = requireRoom(req);
    res.json(teacherView(req, room));
  });

  app.patch('/api/teacher/:adminToken', (req, res) => {
    const room = requireRoom(req);
    const body = req.body || {};
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
    store.putRoom(room);
    res.json(teacherView(req, room));
  });

  app.delete('/api/teacher/:adminToken', (req, res) => {
    const room = requireRoom(req);
    store.deleteRoom(room.id);
    res.json({ ok: true });
  });

  app.post('/api/teacher/:adminToken/students', (req, res) => {
    const room = requireRoom(req);
    const names = parseStudentNames(req.body?.name ?? req.body?.students);
    if (names.length === 0) throw bad('학생 이름을 입력해 주세요.');
    if (room.students.length + names.length > LIMITS.students) throw bad(`학생은 최대 ${LIMITS.students}명까지 등록할 수 있어요.`);
    for (const n of names) {
      if (room.students.some((s) => s.name === n)) throw bad(`이미 있는 이름이에요: ${n}`);
    }
    for (const n of names) room.students.push(makeStudent(n));
    store.putRoom(room);
    res.status(201).json(teacherView(req, room));
  });

  app.patch('/api/teacher/:adminToken/students/:studentId', (req, res) => {
    const room = requireRoom(req);
    const student = room.students.find((s) => s.id === req.params.studentId);
    if (!student) throw new HttpError(404, '학생을 찾을 수 없어요.');
    const name = cleanName(req.body?.name);
    if (!name || name.length > LIMITS.studentName) throw bad('이름이 올바르지 않아요.');
    if (room.students.some((s) => s.id !== student.id && s.name === name)) throw bad(`이미 있는 이름이에요: ${name}`);
    student.name = name;
    store.putRoom(room);
    res.json(teacherView(req, room));
  });

  app.delete('/api/teacher/:adminToken/students/:studentId', (req, res) => {
    const room = requireRoom(req);
    const idx = room.students.findIndex((s) => s.id === req.params.studentId);
    if (idx === -1) throw new HttpError(404, '학생을 찾을 수 없어요.');
    const [student] = room.students.splice(idx, 1);
    delete room.relations[student.id];
    delete room.submissions[student.id];
    for (const targets of Object.values(room.relations)) delete targets[student.id];
    store.putRoom(room);
    res.json(teacherView(req, room));
  });

  // 학생 응답 초기화
  app.post('/api/teacher/:adminToken/students/:studentId/reset', (req, res) => {
    const room = requireRoom(req);
    const student = room.students.find((s) => s.id === req.params.studentId);
    if (!student) throw new HttpError(404, '학생을 찾을 수 없어요.');
    delete room.relations[student.id];
    delete room.submissions[student.id];
    store.putRoom(room);
    res.json(teacherView(req, room));
  });

  // 학생 링크(QR) 재발급 - 기존 링크는 더 이상 동작하지 않음
  app.post('/api/teacher/:adminToken/students/:studentId/rotate', (req, res) => {
    const room = requireRoom(req);
    const student = room.students.find((s) => s.id === req.params.studentId);
    if (!student) throw new HttpError(404, '학생을 찾을 수 없어요.');
    student.token = newToken(16);
    store.putRoom(room);
    res.json(teacherView(req, room));
  });

  app.get('/api/teacher/:adminToken/qr/:studentId.svg', async (req, res) => {
    const room = requireRoom(req);
    const student = room.students.find((s) => s.id === req.params.studentId);
    if (!student) throw new HttpError(404, '학생을 찾을 수 없어요.');
    const svg = await QRCode.toString(studentUrl(req, student), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
  });

  app.get('/api/teacher/:adminToken/export.json', (req, res) => {
    const room = requireRoom(req);
    const view = teacherView(req, room);
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(room.name)}.json`);
    res.json({ exportedAt: new Date().toISOString(), room: view.room, students: view.students.map(({ token, url, ...s }) => s), relations: view.relations, analysis: view.analysis });
  });

  app.get('/api/teacher/:adminToken/export.csv', (req, res) => {
    const room = requireRoom(req);
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
  app.get('/api/student/:token', (req, res) => {
    const { room, student } = requireStudent(req);
    res.json(studentView(req, room, student));
  });

  app.put('/api/student/:token/relations', (req, res) => {
    const { room, student } = requireStudent(req);
    if (room.locked) throw new HttpError(403, '선생님이 제출을 마감했어요. 더 이상 수정할 수 없어요.');

    const classmates = new Set(room.students.filter((s) => s.id !== student.id).map((s) => s.id));
    const input = req.body?.relations;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('보낸 내용이 올바르지 않아요.');

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
    store.putRoom(room);
    res.json(studentView(req, room, student));
  });

  // ---------- fallbacks ----------
  app.use('/api', (req, res) => res.status(404).json({ error: '없는 주소예요.' }));
  app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html')));

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
