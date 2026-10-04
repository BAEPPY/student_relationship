import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { FileStore } from './store.js';
import { newToken, newId } from './tokens.js';
import { REASON_CATALOG, isValidTag } from './reasons.js';
import { computeStats, listRelations, analyzeConflicts } from './analysis.js';
import { ensureRounds, currentRound, findRound, roundRoom, roundView, makeRound, monthName } from './rounds.js';
import { analyzeHistory } from './history.js';
import * as pages from './pages.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const LIMITS = {
  roomName: 60,
  roundName: 40,
  studentName: 30,
  students: 80,
  reason: 300,
  minRelations: 10,
  minEach: 10,
  rounds: 36,
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

function parseMin(v, fallback) {
  const n = Number.parseInt(v ?? fallback, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(LIMITS.minEach, n));
}

/** 교실의 최소 표시 인원: 좋은 사이 / 안 좋은 사이 각각 */
function minimums(room) {
  const minGood = room.minGood ?? room.minRelations ?? 3;
  const minBad = room.minBad ?? 3;
  return { minGood, minBad };
}

function newRoom(name, names, minGood, minBad) {
  const now = new Date().toISOString();
  const round = makeRound(monthName(now), now);
  return {
    id: newId(6),
    name,
    adminToken: newToken(24),
    createdAt: now,
    minGood,
    minBad,
    students: names.map(makeStudent),
    rounds: [round],
    currentRoundId: round.id,
  };
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
    return ensureRounds(room);
  }

  async function requireStudent(req) {
    const found = await store.findStudentByToken(req.params.token);
    if (!found) throw new HttpError(404, '링크가 올바르지 않아요. 선생님께 QR 코드를 다시 받아 주세요.');
    ensureRounds(found.room);
    return found;
  }

  // 교실을 잠그고(저장소에 따라) 읽어서 고친 뒤 저장합니다. mutator 가 던지면 아무것도 바뀌지 않습니다.
  async function mutateRoom(room, mutator) {
    const updated = await store.updateRoom(room.id, (fresh) => { ensureRounds(fresh); mutator(fresh); });
    if (!updated) throw new HttpError(404, '교실을 찾을 수 없어요. 관리자 링크를 확인해 주세요.');
    return updated;
  }

  function findStudent(room, studentId) {
    const student = room.students.find((s) => s.id === studentId);
    if (!student) throw new HttpError(404, '학생을 찾을 수 없어요.');
    return student;
  }

  function requireRound(room, roundId) {
    const round = findRound(room, roundId);
    if (!round) throw new HttpError(404, '회차를 찾을 수 없어요.');
    return round;
  }

  // 반 인원이 적으면 최소 인원도 그만큼 줄어듭니다 (둘을 합쳐 반 친구 수를 넘지 않게)
  function effectiveMins(room, classmateCount) {
    let { minGood, minBad } = minimums(room);
    if (minGood + minBad > classmateCount) {
      const scale = classmateCount / (minGood + minBad || 1);
      minGood = Math.floor(minGood * scale);
      minBad = Math.floor(minBad * scale);
    }
    return { minGood: Math.max(0, minGood), minBad: Math.max(0, minBad) };
  }

  function roundSummary(room, round) {
    const rr = roundRoom(room, round);
    const stats = computeStats(rr);
    const submitted = Object.values(stats).filter((s) => s.submitted).length;
    return {
      ...roundView(round),
      submitted,
      total: room.students.length,
      good: Object.values(stats).reduce((n, s) => n + s.outGood.length, 0),
      bad: Object.values(stats).reduce((n, s) => n + s.outBad.length, 0),
    };
  }

  function teacherView(req, room, roundId = null) {
    const round = roundId ? requireRound(room, roundId) : currentRound(room);
    const rr = roundRoom(room, round);
    const stats = computeStats(rr);
    const analysis = analyzeConflicts(rr, stats);
    return {
      room: {
        id: room.id,
        name: room.name,
        createdAt: room.createdAt,
        locked: Boolean(round.closedAt),
        minGood: minimums(room).minGood,
        minBad: minimums(room).minBad,
        minRelations: minimums(room).minGood + minimums(room).minBad,
        adminUrl: adminUrl(req, room),
      },
      round: roundView(round),
      currentRoundId: currentRound(room).id,
      rounds: room.rounds.map((r) => roundSummary(room, r)),
      students: room.students.map((s) => ({
        id: s.id,
        name: s.name,
        token: s.token,
        url: studentUrl(req, s),
        submitted: stats[s.id].submitted,
        submittedAt: stats[s.id].submittedAt,
      })),
      relations: listRelations(rr),
      stats,
      analysis,
      history: analyzeHistory(room),
      catalog: REASON_CATALOG,
      notice: storageNotice,
      seating: room.seating || null,
      teacherNotes: room.teacherNotes || { students: {}, rules: [] },
    };
  }

  function studentView(req, room, student) {
    const round = currentRound(room);
    const classmates = room.students.filter((s) => s.id !== student.id).map((s) => ({ id: s.id, name: s.name }));
    const mine = round.relations?.[student.id] || {};
    const relations = {};
    for (const c of classmates) if (mine[c.id]) relations[c.id] = mine[c.id];
    const mins = effectiveMins(room, classmates.length);
    return {
      room: { name: room.name, locked: Boolean(round.closedAt), minGood: mins.minGood, minBad: mins.minBad, minRelations: mins.minGood + mins.minBad },
      round: roundView(round),
      me: { id: student.id, name: student.name },
      classmates,
      relations,
      submittedAt: round.submissions?.[student.id]?.submittedAt || null,
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
    const minGood = parseMin(req.body?.minGood, 3);
    const minBad = parseMin(req.body?.minBad, 3);

    const room = newRoom(name, names, minGood, minBad);
    await store.createRoom(room);
    res.status(201).json({ id: room.id, name: room.name, adminToken: room.adminToken, adminUrl: adminUrl(req, room), studentCount: room.students.length });
  });

  // 체험용 예시 교실 (세 회차의 임의 관계 데이터 포함)
  app.post('/api/rooms/demo', async (req, res) => {
    const names = ['김하늘', '이도윤', '박서연', '최지우', '정민준', '강예린', '조현우', '윤서아', '임시우', '한지민', '오준서', '서다은'];
    const room = newRoom('예시 교실 (체험용)', names, 3, 3);
    const ids = room.students.map((s) => s.id);
    const goodTags = REASON_CATALOG.good.map((r) => r.id);
    const badTags = REASON_CATALOG.bad.map((r) => r.id);
    // 결정적인 의사난수(같은 패턴이 매번 나오도록)
    let seed = 7;
    const rand = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];

    const now = new Date();
    const monthsAgo = (k) => new Date(now.getFullYear(), now.getMonth() - k, 5, 9, 0, 0);
    const makeRelations = (prev, at, skipLast) => {
      const relations = {};
      const submissions = {};
      ids.forEach((from, i) => {
        if (skipLast && i === ids.length - 1) return; // 지금 회차는 한 명 미제출 상태로
        const rels = {};
        const others = ids.filter((x) => x !== from);
        // 지난 회차 관계를 70% 유지하고 일부는 바뀜
        for (const [to, rel] of Object.entries(prev?.[from] || {})) if (rand() < 0.7) rels[to] = { ...rel, updatedAt: at };
        const need = (type) => Object.values(rels).filter((x) => x.type === type).length < 3;
        while (need('good') || need('bad') || Object.keys(rels).length < 6) {
          const to = pick(others);
          if (rels[to]) continue;
          const isBad = need('bad') ? true : need('good') ? false : rand() < 0.4;
          rels[to] = isBad
            ? { type: 'bad', tags: [pick(badTags)], reason: rand() < 0.5 ? '지난주에 말다툼을 했어요.' : '', updatedAt: at }
            : { type: 'good', tags: rand() < 0.7 ? [pick(goodTags)] : [], reason: rand() < 0.3 ? '쉬는 시간에 항상 같이 놀아요.' : '', updatedAt: at };
        }
        relations[from] = rels;
        submissions[from] = { submittedAt: at };
      });
      return { relations, submissions };
    };

    room.rounds = [];
    let prev = null;
    for (let k = 2; k >= 0; k--) {
      const at = monthsAgo(k).toISOString();
      const data = makeRelations(prev, at, k === 0);
      room.rounds.push({ id: newId(), name: monthName(at), startedAt: at, closedAt: k === 0 ? null : monthsAgo(k - 1).toISOString(), ...data });
      prev = data.relations;
    }
    room.currentRoundId = room.rounds[room.rounds.length - 1].id;
    await store.createRoom(room);
    res.status(201).json({ id: room.id, name: room.name, adminToken: room.adminToken, adminUrl: adminUrl(req, room), studentCount: room.students.length });
  });

  // ---------- teacher API ----------
  app.get('/api/teacher/:adminToken', async (req, res) => {
    const room = await requireRoom(req);
    res.json(teacherView(req, room, req.query.round ? String(req.query.round) : null));
  });

  app.patch('/api/teacher/:adminToken', async (req, res) => {
    const found = await requireRoom(req);
    const body = req.body || {};
    const room = await mutateRoom(found, (room) => {
      if (typeof body.locked === 'boolean') {
        const round = currentRound(room);
        round.closedAt = body.locked ? (round.closedAt || new Date().toISOString()) : null;
      }
      if (body.minGood !== undefined || body.minBad !== undefined) {
        const cur = minimums(room);
        const g = body.minGood !== undefined ? Number.parseInt(body.minGood, 10) : cur.minGood;
        const b = body.minBad !== undefined ? Number.parseInt(body.minBad, 10) : cur.minBad;
        if (!Number.isFinite(g) || g < 0 || g > LIMITS.minEach || !Number.isFinite(b) || b < 0 || b > LIMITS.minEach) throw bad(`최소 인원은 각각 0~${LIMITS.minEach} 사이여야 해요.`);
        room.minGood = g;
        room.minBad = b;
        delete room.minRelations;
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

  // ---------- rounds ----------
  // 새 회차 시작: 지금 회차를 마감하고 빈 회차를 엽니다.
  app.post('/api/teacher/:adminToken/rounds', async (req, res) => {
    const found = await requireRoom(req);
    const name = cleanName(req.body?.name) || monthName();
    if (name.length > LIMITS.roundName) throw bad(`회차 이름은 ${LIMITS.roundName}자 이하로 적어 주세요.`);
    let created = null;
    const room = await mutateRoom(found, (room) => {
      if (room.rounds.length >= LIMITS.rounds) throw bad(`회차는 ${LIMITS.rounds}개까지 만들 수 있어요.`);
      if (room.rounds.some((r) => r.name === name)) throw bad(`같은 이름의 회차가 이미 있어요: ${name}`);
      const now = new Date().toISOString();
      const cur = currentRound(room);
      if (!cur.closedAt) cur.closedAt = now;
      created = makeRound(name, now);
      room.rounds.push(created);
      room.currentRoundId = created.id;
    });
    res.status(201).json(teacherView(req, room, created.id));
  });

  // 회차 이름 바꾸기 / 마감 / 마감 해제 (마감 해제는 가장 최근 회차만)
  app.patch('/api/teacher/:adminToken/rounds/:roundId', async (req, res) => {
    const found = await requireRoom(req);
    requireRound(found, req.params.roundId);
    const body = req.body || {};
    const room = await mutateRoom(found, (room) => {
      const round = requireRound(room, req.params.roundId);
      if (body.name !== undefined) {
        const name = cleanName(body.name);
        if (!name || name.length > LIMITS.roundName) throw bad('회차 이름이 올바르지 않아요.');
        if (room.rounds.some((r) => r.id !== round.id && r.name === name)) throw bad(`같은 이름의 회차가 이미 있어요: ${name}`);
        round.name = name;
      }
      if (typeof body.closed === 'boolean') {
        if (!body.closed && round.id !== currentRound(room).id) throw bad('지난 회차는 다시 열 수 없어요. 새 회차를 시작해 주세요.');
        round.closedAt = body.closed ? (round.closedAt || new Date().toISOString()) : null;
      }
    });
    res.json(teacherView(req, room, req.params.roundId));
  });

  app.delete('/api/teacher/:adminToken/rounds/:roundId', async (req, res) => {
    const found = await requireRoom(req);
    requireRound(found, req.params.roundId);
    const room = await mutateRoom(found, (room) => {
      if (room.rounds.length <= 1) throw bad('회차가 하나뿐이면 지울 수 없어요. 대신 학생 응답 초기화를 사용해 주세요.');
      room.rounds = room.rounds.filter((r) => r.id !== req.params.roundId);
      if (room.currentRoundId === req.params.roundId) room.currentRoundId = room.rounds[room.rounds.length - 1].id;
    });
    res.json(teacherView(req, room));
  });

  // ---------- students ----------
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
      for (const round of room.rounds) {
        delete round.relations[student.id];
        delete round.submissions[student.id];
        for (const targets of Object.values(round.relations)) delete targets[student.id];
      }
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

  // 학생 응답 초기화 (기본: 지금 회차, body.roundId 로 지정 가능)
  app.post('/api/teacher/:adminToken/students/:studentId/reset', async (req, res) => {
    const found = await requireRoom(req);
    findStudent(found, req.params.studentId);
    const roundId = req.body?.roundId ? String(req.body.roundId) : null;
    const room = await mutateRoom(found, (room) => {
      const student = findStudent(room, req.params.studentId);
      const round = roundId ? requireRound(room, roundId) : currentRound(room);
      delete round.relations[student.id];
      delete round.submissions[student.id];
    });
    res.json(teacherView(req, room, roundId));
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
    const rounds = room.rounds.map((r) => {
      const rr = roundRoom(room, r);
      const stats = computeStats(rr);
      return { ...roundView(r), relations: listRelations(rr), analysis: analyzeConflicts(rr, stats) };
    });
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(room.name)}.json`);
    res.json({ exportedAt: new Date().toISOString(), room: view.room, students: view.students.map(({ token, url, ...s }) => s), rounds, history: view.history, teacherNotes: view.teacherNotes, seating: view.seating });
  });

  app.get('/api/teacher/:adminToken/export.csv', async (req, res) => {
    const room = await requireRoom(req);
    const nameOf = Object.fromEntries(room.students.map((s) => [s.id, s.name]));
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['회차', '보낸 학생', '받은 학생', '관계', '선택한 이유', '직접 쓴 이유', '수정 시각'].map(esc).join(',')];
    for (const round of room.rounds) {
      for (const r of listRelations(roundRoom(room, round))) {
        rows.push([round.name, nameOf[r.from], nameOf[r.to], r.type === 'good' ? '좋은 사이' : '안 좋은 사이', r.tagLabels.join('; '), r.reason, r.updatedAt].map(esc).join(','));
      }
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
    const roundId = req.body?.roundId ? String(req.body.roundId) : null;

    const room = await mutateRoom(found, (room) => {
      const student = room.students.find((s) => s.id === me.id && s.token === me.token);
      if (!student) throw new HttpError(404, '링크가 올바르지 않아요. 선생님께 QR 코드를 다시 받아 주세요.');
      const round = currentRound(room);
      if (roundId && roundId !== round.id) throw new HttpError(409, '선생님이 새 조사를 시작했어요. 화면을 새로고침한 뒤 다시 표시해 주세요.');
      if (round.closedAt) throw new HttpError(403, '선생님이 이번 조사를 마감했어요. 더 이상 수정할 수 없어요.');

      const classmates = new Set(room.students.filter((s) => s.id !== student.id).map((s) => s.id));
      const now = new Date().toISOString();
      const prev = round.relations[student.id] || {};
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
      const mins = effectiveMins(room, classmates.size);
      const goodCount = Object.values(next).filter((r) => r.type === 'good').length;
      const badCount = Object.values(next).filter((r) => r.type === 'bad').length;
      if (goodCount < mins.minGood) throw bad(`좋은 사이를 ${mins.minGood}명 이상 표시해 주세요. (지금 ${goodCount}명)`);
      if (badCount < mins.minBad) throw bad(`안 좋은 사이를 ${mins.minBad}명 이상 표시해 주세요. (지금 ${badCount}명)`);

      round.relations[student.id] = next;
      round.submissions[student.id] = { submittedAt: now, firstSubmittedAt: round.submissions[student.id]?.firstSubmittedAt || now };
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
