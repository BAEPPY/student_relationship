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
import { purgeExpired, purgeAll, retentionView, roundExpiresAt, dropStaleAiSeating, RETENTION_MONTHS } from './retention.js';
import { DEFAULT_ROLES, TRAITS, BODY_TRAITS, SELECTION_CRITERIA, normalizeRoles, roomRoles, previousRoleIds, parseHistoryText, validateProfile, validateBody, validateApplication, applicantCounts } from './roles.js';
import { assignRoles, repairAssignment } from './assign.js';
import { DEFAULT_MODEL, aiEnabled, createAiClient, aiAnalyzeRelationships, aiAssignRoles, aiAssignSeats } from './ai.js';
import { repairSeating } from './seating.js';
import * as pages from './pages.js';
import { findStudents } from '../public/js/notes-parser.js';
import { extractDocument, documentToText, extractRoles, extractRoster, DOC_LIMITS } from './docfiles.js';
import { buildRolesHwpx, buildRolesDocx, makeHwpxDocument, makeDocxDocument } from './export-docs.js';
import { reportDocument } from './report.js';
import { validateDraft, studentDraftView, saveStudentDraft, clearStudentDraft, removeStudentFromDrafts } from './student-drafts.js';
import { seatingView, saveRoundSeating, removeStudentSeating, walkSeatings } from './seating-history.js';
import { captureAnalysisContext, describeAnalysisContext } from './analysis-context.js';
import { registerGroupRoutes } from './group-routes.js';
import { removeStudentGroups, renameStudentGroups } from './groups.js';
import { registerFollowupRoutes } from './followup-routes.js';
import { followupSummary, removeStudentFollowups, renameStudentFollowups } from './followups.js';
import { summarizeRoleBalance, captureRoleBalanceSnapshot, roleBalancePriorities } from './role-balance.js';

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
  const minBad = room.minBad ?? 1;
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

// aiClient: 테스트에서 가짜 Claude 클라이언트를 넣을 때만 사용합니다. 평소에는 ANTHROPIC_API_KEY 로 켭니다.
export function createApp({ store = new FileStore(null), baseUrl = process.env.BASE_URL || '', storageNotice = null, storageKind = 'file', aiClient = null } = {}) {
  const aiOn = () => Boolean(aiClient) || aiEnabled();
  const makeAi = () => createAiClient(aiClient ? { client: aiClient } : undefined);
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
  // 보관 기간이 지난 회차는 교실을 열 때마다 정리합니다 (예약 작업과 별개로 이중 안전장치)
  async function applyRetention(room) {
    const probe = purgeExpired(structuredClone(room));
    if (!probe.changed) return room;
    if (probe.deleteRoom) {
      await store.deleteRoom(room.id);
      throw new HttpError(410, `이 교실은 ${RETENTION_MONTHS}개월 동안 사용되지 않아 보관 기간이 끝나 삭제되었어요.`);
    }
    const updated = await store.updateRoom(room.id, (fresh) => { ensureRounds(fresh); purgeExpired(fresh); });
    return updated || room;
  }

  async function requireRoom(req) {
    const room = await store.findRoomByAdminToken(req.params.adminToken);
    if (!room) throw new HttpError(404, '교실을 찾을 수 없어요. 관리자 링크를 확인해 주세요.');
    return applyRetention(ensureRounds(room));
  }

  async function requireStudent(req) {
    const found = await store.findStudentByToken(req.params.token);
    if (!found) throw new HttpError(404, '링크가 올바르지 않아요. 선생님께 QR 코드를 다시 받아 주세요.');
    ensureRounds(found.room);
    const room = await applyRetention(found.room);
    const student = room.students.find((st) => st.id === found.student.id) || found.student;
    return { room, student };
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
      expiresAt: roundExpiresAt(round),
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
    analysis.context = captureAnalysisContext(room, round);
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
        body: s.body || {},                       // 학생이 고른 몸 특징 (시력·키·추위·더위)
      })),
      relations: listRelations(rr),
      stats,
      analysis,
      history: analyzeHistory(room),
      catalog: REASON_CATALOG,
      notice: storageNotice,
      ...seatingView(room, round),
      aiSeating: aiSeatingView(room, round),
      teacherNotes: room.teacherNotes || { students: {}, rules: [] },
      followupSummary: followupSummary(room),
      retention: retentionView(room),
      ...rolesView(room, round),
    };
  }

  function aiAnalysisView(room, round) {
    if (!round.aiAnalysis) return null;
    return { ...round.aiAnalysis, context: describeAnalysisContext(round.aiAnalysis.provenance, captureAnalysisContext(room, round)) };
  }

  function aiSeatingView(room, round) {
    if (!round.aiSeating) return null;
    return { ...round.aiSeating, context: describeAnalysisContext(round.aiSeating.provenance, captureAnalysisContext(room, round, { kind: 'seating', extra: round.aiSeating.inputConfig || null })) };
  }

  // 1인 1역 관련 정보 (선생님 화면용)
  function rolesView(room, round) {
    const roles = roomRoles(room);
    const prev = previousRoleIds(room, round);
    return {
      roles,
      roleHistory: room.roleHistory || [],
      previousRoles: prev,                       // { month, byStudent: { sid: [roleId] } }
      roleBalance: summarizeRoleBalance(room, round),
      applications: round.applications || {},    // { sid: { choices, updatedAt } }
      profiles: round.profiles || {},            // { sid: { traits, partnerTraits, partnerText, updatedAt } }
      applicantCounts: applicantCounts(roles, round.applications || {}),
      roleAssignment: round.roleAssignment || null,
      aiAnalysis: aiAnalysisView(room, round),
      ai: { enabled: aiOn(), model: process.env.AI_MODEL || DEFAULT_MODEL },
      traits: TRAITS,
      bodyTraits: BODY_TRAITS,
      selectionCriteria: SELECTION_CRITERIA,
    };
  }

  function studentView(req, room, student) {
    const round = currentRound(room);
    const classmates = room.students.filter((s) => s.id !== student.id).map((s) => ({ id: s.id, name: s.name }));
    const mine = round.relations?.[student.id] || {};
    const relations = {};
    for (const c of classmates) if (mine[c.id]) relations[c.id] = mine[c.id];
    const mins = effectiveMins(room, classmates.length);
    const roles = roomRoles(room);
    const prev = previousRoleIds(room, round);
    const excludedRoleIds = prev.byStudent[student.id] || [];
    const assignment = round.roleAssignment;
    let assignedRole = null;
    if (assignment?.published) {
      for (const [roleId, sids] of Object.entries(assignment.assignments || {})) {
        if ((sids || []).includes(student.id)) assignedRole = roles.find((r) => r.id === roleId) || null;
      }
    }
    return {
      room: { name: room.name, locked: Boolean(round.closedAt), minGood: mins.minGood, minBad: mins.minBad, minRelations: mins.minGood + mins.minBad, rolesEnabled: roles.length > 0 },
      round: roundView(round),
      me: { id: student.id, name: student.name, body: student.body || {} },
      classmates,
      relations,
      submittedAt: round.submissions?.[student.id]?.submittedAt || null,
      draft: studentDraftView(round, student.id),
      catalog: REASON_CATALOG,
      // 1인 1역 · 성향
      roles,
      excludedRoleIds,
      previousRoleMonth: prev.month,
      profile: round.profiles?.[student.id] || null,
      application: round.applications?.[student.id] || null,
      assignedRole,
      traits: TRAITS,
      bodyTraits: BODY_TRAITS,
      selectionCriteria: SELECTION_CRITERIA,
    };
  }

  // ---------- pages ----------
  const page = (html) => (req, res) => res.type('html').send(html);
  app.get('/', page(pages.index));
  app.get('/t/:adminToken', page(pages.teacher));
  app.get('/t/:adminToken/print', page(pages.print));
  app.get('/t/:adminToken/seats', page(pages.seats));
  app.get('/t/:adminToken/roles', page(pages.roles));
  app.get('/t/:adminToken/groups', page(pages.groups));
  app.get('/t/:adminToken/followups', page(pages.followups));
  app.get('/t/:adminToken/report', (req, res) => res.type('html').send(pages.report || pages.notFound));
  app.get('/s/:token', page(pages.student));
  app.use(express.static(PUBLIC_DIR, { index: false }));

  registerGroupRoutes(app, { requireRoom, mutateRoom, requireRound, currentRound });
  registerFollowupRoutes(app, { requireRoom, mutateRoom });

  app.get('/api/health', (req, res) => res.json({ ok: true, storage: storageKind, notice: storageNotice || null, retentionMonths: RETENTION_MONTHS }));

  // 보관 기간이 지난 데이터 정리. CRON_SECRET 이 설정되어 있으면 그 값으로만 호출할 수 있습니다.
  const purgeHandler = async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (secret && req.get('authorization') !== `Bearer ${secret}`) throw new HttpError(401, '권한이 없어요.');
    const result = await purgeAll(store);
    res.json({ ok: true, retentionMonths: RETENTION_MONTHS, ...result });
  };
  app.get('/api/maintenance/purge', purgeHandler);
  app.post('/api/maintenance/purge', purgeHandler);

  // ---------- 파일 올리기 공통 ----------
  const rawFile = express.raw({ type: () => true, limit: DOC_LIMITS.file });
  const uploadedName = (req) => { try { return decodeURIComponent(req.get('x-file-name') || ''); } catch { return ''; } };

  // 학생 명단 파일(한글·워드·텍스트) → 이름 목록 (저장하지 않음; 교실 만들기 화면과 선생님 페이지에서 사용)
  app.post('/api/roster/parse', rawFile, async (req, res) => {
    const doc = extractDocument(req.body, uploadedName(req));
    const result = extractRoster(doc);
    res.json({ format: doc.format, ...result });
  });

  // ---------- room creation ----------
  app.post('/api/rooms', async (req, res) => {
    const name = cleanName(req.body?.name);
    if (!name) throw bad('교실 이름을 입력해 주세요.');
    if (name.length > LIMITS.roomName) throw bad(`교실 이름은 ${LIMITS.roomName}자 이하로 입력해 주세요.`);
    const names = parseStudentNames(req.body?.students);
    if (names.length < 2) throw bad('학생을 2명 이상 입력해 주세요.');
    if (names.length > LIMITS.students) throw bad(`학생은 최대 ${LIMITS.students}명까지 등록할 수 있어요.`);
    const minGood = parseMin(req.body?.minGood, 3);
    const minBad = parseMin(req.body?.minBad, 1);

    const room = newRoom(name, names, minGood, minBad);
    await store.createRoom(room);
    res.status(201).json({ id: room.id, name: room.name, adminToken: room.adminToken, adminUrl: adminUrl(req, room), studentCount: room.students.length });
  });

  // 체험용 예시 교실 (세 회차의 임의 관계 데이터 포함)
  app.post('/api/rooms/demo', async (req, res) => {
    const names = ['김하늘', '이도윤', '박서연', '최지우', '정민준', '강예린', '조현우', '윤서아', '임시우', '한지민', '오준서', '서다은'];
    const room = newRoom('예시 교실 (체험용)', names, 3, 1);
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
            ? { type: 'bad', tags: rand() < 0.7 ? [pick(badTags)] : [], reason: pick(['지난주에 말다툼을 했어요.', '자꾸 놀려서 속상해요.', '내 물건을 허락 없이 가져갔어요.', '같이 놀 때 자기 마음대로만 해요.']), updatedAt: at }
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
        const oldName = round.name;
        round.name = name;
        // 이 회차에서 공개한 배정 기록도 같은 이름을 따라갑니다.
        const history = room.roleHistory || [];
        const mine = history.find((h) => h.roundId === round.id || (h.source === 'published' && h.month === oldName));
        if (mine) {
          mine.roundId = round.id;
          mine.month = name;
          room.roleHistory = history.filter((h) => h === mine || h.month !== name);
        }
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
      if (room.groupActivities) room.groupActivities = room.groupActivities.filter((a) => a.roundId !== req.params.roundId);
      if (room.currentRoundId === req.params.roundId) room.currentRoundId = room.rounds[room.rounds.length - 1].id;
      dropStaleAiSeating(room);   // 그 회차 응답으로 만든 AI 자리 배정안(실명이 든 갈등 예측)도 함께 지움
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

  // 여러 명 한 번에 추가 (명단 파일에서 읽은 이름 등). 이미 있는 이름은 건너뜁니다.
  app.post('/api/teacher/:adminToken/students/bulk', async (req, res) => {
    const found = await requireRoom(req);
    const names = parseStudentNames(req.body?.names ?? req.body?.students);
    if (names.length === 0) throw bad('학생 이름을 입력해 주세요.');
    let added = [];
    let skipped = [];
    const room = await mutateRoom(found, (room) => {
      const have = new Set(room.students.map((s) => s.name));
      added = names.filter((n) => !have.has(n));
      skipped = names.filter((n) => have.has(n));
      if (room.students.length + added.length > LIMITS.students) throw bad(`학생은 최대 ${LIMITS.students}명까지 등록할 수 있어요. (지금 ${room.students.length}명 + ${added.length}명)`);
      for (const n of added) room.students.push(makeStudent(n));
    });
    res.status(added.length ? 201 : 200).json({ ...teacherView(req, room), added, skipped });
  });

  app.patch('/api/teacher/:adminToken/students/:studentId', async (req, res) => {
    const found = await requireRoom(req);
    findStudent(found, req.params.studentId);
    const name = cleanName(req.body?.name);
    if (!name || name.length > LIMITS.studentName) throw bad('이름이 올바르지 않아요.');
    const room = await mutateRoom(found, (room) => {
      const student = findStudent(room, req.params.studentId);
      if (room.students.some((s) => s.id !== student.id && s.name === name)) throw bad(`이미 있는 이름이에요: ${name}`);
      const oldName = student.name;
      student.name = name;
      renameInAiTexts(room, oldName, name);
      renameStudentGroups(room, student, oldName, name);
      renameStudentFollowups(room, student, oldName, name);
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
        removeStudentFromDrafts(round, student.id);
        delete round.relations[student.id];
        delete round.submissions[student.id];
        for (const targets of Object.values(round.relations)) delete targets[student.id];
        delete round.profiles?.[student.id];
        delete round.applications?.[student.id];
        if (round.roleAssignment) {
          const ra = round.roleAssignment;
          for (const [rid, list] of Object.entries(ra.assignments || {})) ra.assignments[rid] = (list || []).filter((x) => x !== student.id);
          if (ra.explanations) delete ra.explanations[student.id];
          if (ra.balanceSnapshot?.choicesByStudent) delete ra.balanceSnapshot.choicesByStudent[student.id];
          ra.unassigned = (ra.unassigned || []).filter((x) => x !== student.id);
        }
        if (round.aiAnalysis) scrubAiAnalysis(round.aiAnalysis, student);
        if (round.aiSeating) scrubAiSeating(round.aiSeating, student);
      }
      for (const h of room.roleHistory || []) {
        for (const [rid, list] of Object.entries(h.assignments || {})) h.assignments[rid] = (list || []).filter((x) => x !== student.id);
        if (h.balanceSnapshot?.choicesByStudent) delete h.balanceSnapshot.choicesByStudent[student.id];
      }
      if (room.teacherNotes) {
        delete room.teacherNotes.students?.[student.id];
        room.teacherNotes.rules = (room.teacherNotes.rules || []).filter((r) => r.a !== student.id && r.b !== student.id);
      }
      removeStudentSeating(room, student.id);
      removeStudentGroups(room, student);
      removeStudentFollowups(room, student);
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
      clearStudentDraft(round, student.id);
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

  // 자리 배정 본문 검증 (PUT /seating 과 POST /ai/seating 이 같이 씀)
  const SEAT_ZONES = ['ac'];   // 자리 환경 종류: ac = 냉난방기 바람 자리
  const validSeat = /^b\d+-r\d+-c\d+$/;
  function parseSeatingBody(body, room) {
    const blocks = Array.isArray(body.layout?.blocks) ? body.layout.blocks : null;
    if (!blocks || blocks.length < 1 || blocks.length > 6) throw bad('교실 배치는 1~6개 블록으로 입력해 주세요.');
    const layout = { blocks: blocks.map((b) => {
      const cols = Number.parseInt(b?.cols, 10);
      const rows = Number.parseInt(b?.rows, 10);
      if (!(cols >= 1 && cols <= 4) || !(rows >= 1 && rows <= 10)) throw bad('블록은 가로 1~4, 세로 1~10 사이여야 해요.');
      return { cols, rows };
    }) };
    const seats = {};
    const used = new Set();
    for (const [seatId, studentId] of Object.entries(body.seats || {})) {
      if (!validSeat.test(seatId)) throw bad('좌석 정보가 올바르지 않아요.');
      if (!studentId) continue;
      if (!room.students.some((st) => st.id === studentId)) throw bad('없는 학생이 좌석에 포함되어 있어요.');
      if (used.has(studentId)) throw bad('한 학생이 두 자리에 배정되어 있어요.');
      used.add(studentId);
      seats[seatId] = studentId;
    }
    const pinned = [...new Set((Array.isArray(body.pinned) ? body.pinned : []).filter((id) => validSeat.test(id)))];
    const options = { friends: ['near', 'any', 'apart'].includes(body.options?.friends) ? body.options.friends : 'any' };
    // 자리 환경: 냉난방기 바람이 닿는 자리(zones: seatId → 'ac') 와 지금 냉방/난방 중인지(climate)
    const zones = {};
    for (const [seatId, zone] of Object.entries(body.zones || {})) {
      if (!validSeat.test(seatId)) throw bad('좌석 정보가 올바르지 않아요.');
      if (!zone) continue;
      if (!SEAT_ZONES.includes(zone)) throw bad('자리 환경 표시가 올바르지 않아요.');
      zones[seatId] = zone;
    }
    const climate = ['cool', 'warm', 'off'].includes(body.climate) ? body.climate : 'off';
    // 역할 자리: 이번 회차에 그 역할을 맡은 학생이 앉는 자리 (roleSeats: seatId → roleId)
    const roleIds = new Set(roomRoles(room).map((r) => r.id));
    const roleSeats = {};
    for (const [seatId, roleId] of Object.entries(body.roleSeats || {})) {
      if (!validSeat.test(seatId)) throw bad('좌석 정보가 올바르지 않아요.');
      if (!roleId) continue;
      if (!roleIds.has(roleId)) throw bad('역할 자리에 없는 역할이 있어요.');
      roleSeats[seatId] = roleId;
    }
    return { layout, seats, pinned, options, zones, climate, roleSeats };
  }

  // 자리 배정 저장
  app.put('/api/teacher/:adminToken/seating', async (req, res) => {
    const found = await requireRoom(req);
    const requestedRound = req.body?.roundId || req.query.round || currentRound(found).id;
    if (req.body?.roundId && req.query.round && req.body.roundId !== req.query.round) throw bad('저장할 회차가 일치하지 않아요.');
    const roundId = requireRound(found, String(requestedRound)).id;
    const label = cleanName(req.body?.label || '');
    if (label.length > 80) throw bad('자리표 이름은 80자 이하로 적어 주세요.');
    const room = await mutateRoom(found, (room) => {
      const round = requireRound(room, roundId);
      if (Object.hasOwn(req.body || {}, 'expectedVersionId') && req.body.expectedVersionId !== (round.seating?.versionId || null)) {
        throw new HttpError(409, '다른 화면에서 자리표를 저장했어요. 최신 자리표를 다시 불러와 비교한 뒤 저장해 주세요.');
      }
      const parsed = parseSeatingBody(req.body || {}, room);
      const sourceHistoryId = typeof req.body?.sourceHistoryId === 'string' ? req.body.sourceHistoryId : null;
      if (sourceHistoryId && !(round.seatingHistory || []).some((entry) => entry.id === sourceHistoryId)) throw bad('복원할 자리표 이력을 찾을 수 없어요. 다시 불러와 주세요.');
      const source = sourceHistoryId ? 'restore' : ['automatic', 'ai'].includes(req.body?.source) ? req.body.source : 'manual';
      saveRoundSeating(room, round, parsed, { label, source, sourceHistoryId });
    });
    res.json(teacherView(req, room, roundId));
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
      return { ...roundView(r), relations: listRelations(rr), analysis: { ...analyzeConflicts(rr, stats), context: captureAnalysisContext(room, r) }, profiles: r.profiles || {}, applications: r.applications || {}, roleAssignment: r.roleAssignment || null, aiAnalysis: aiAnalysisView(room, r), ...seatingView(room, r), aiSeating: aiSeatingView(room, r) };
    });
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(room.name)}.json`);
    res.json({ exportedAt: new Date().toISOString(), room: view.room, students: view.students.map(({ token, url, ...s }) => s), rounds, history: view.history, teacherNotes: view.teacherNotes, seating: view.seating, roles: view.roles, roleHistory: view.roleHistory, groupActivities: room.groupActivities || [], followups: room.followups || [] });
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
    res.set('Cache-Control', 'no-store');
    res.json(studentView(req, room, student));
  });

  app.put('/api/student/:token/draft', async (req, res) => {
    const { room: found, student: me } = await requireStudent(req);
    let saved;
    await mutateRoom(found, (room) => {
      const student = room.students.find((s) => s.id === me.id && s.token === me.token);
      if (!student) throw new HttpError(404, '링크가 올바르지 않아요. 선생님께 QR 코드를 다시 받아 주세요.');
      const round = currentRound(room);
      if (typeof req.body?.roundId === 'string' && req.body.roundId && req.body.roundId !== round.id) throw Object.assign(new HttpError(409, '선생님이 새 조사를 시작했어요. 화면을 새로고침해 주세요.'), { code: 'ROUND_CHANGED', currentRoundId: round.id });
      // 마감은 최종 제출만 막습니다. 작성 중인 내용은 마감 직후에도 보존합니다.
      saveStudentDraft(round, student.id, req.body?.revision, () => validateDraft(req.body, room, student.id));
      saved = studentDraftView(round, student.id);
    });
    res.set('Cache-Control', 'no-store').json({ draft: saved });
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
        if (r.type === 'bad' && reason.length < 2) {
          const name = room.students.find((s) => s.id === toId)?.name || '';
          throw bad(`${name}와(과) 안 좋은 사이인 이유를 직접 적어 주세요. (2자 이상)`);
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
      clearStudentDraft(round, student.id, 'relations');
    });
    res.json(studentView(req, room, room.students.find((s) => s.id === me.id)));
  });

  // 학생: 나의 성향 · 짝 희망 (①②③)
  app.put('/api/student/:token/profile', async (req, res) => {
    const { room: found, student: me } = await requireStudent(req);
    const profile = validateProfile(req.body || {});
    const body = req.body?.body === undefined ? null : validateBody(req.body.body);   // 몸 특징은 학생 정보에 남아 회차가 바뀌어도 유지
    const roundId = req.body?.roundId ? String(req.body.roundId) : null;
    // 특정 친구 이름은 적을 수 없음 (③ 특정인 X)
    if (profile.partnerText) {
      const { sids } = findStudents(profile.partnerText, found.students.filter((s) => s.id !== me.id));
      if (sids.length) {
        const names = sids.map((id) => found.students.find((s) => s.id === id)?.name).filter(Boolean).join(', ');
        throw bad(`특정 친구의 이름(${names})은 적을 수 없어요. 어떤 성격의 짝이 좋은지 적어 주세요.`);
      }
    }
    const room = await mutateRoom(found, (room) => {
      const student = room.students.find((s) => s.id === me.id && s.token === me.token);
      if (!student) throw new HttpError(404, '링크가 올바르지 않아요. 선생님께 QR 코드를 다시 받아 주세요.');
      const round = currentRound(room);
      if (roundId && roundId !== round.id) throw new HttpError(409, '선생님이 새 조사를 시작했어요. 화면을 새로고침한 뒤 다시 표시해 주세요.');
      if (round.closedAt) throw new HttpError(403, '선생님이 이번 조사를 마감했어요. 더 이상 수정할 수 없어요.');
      round.profiles ||= {};
      round.profiles[student.id] = { ...profile, updatedAt: new Date().toISOString() };
      if (body) student.body = body;
      clearStudentDraft(round, student.id, 'profile');
    });
    res.json(studentView(req, room, room.students.find((s) => s.id === me.id)));
  });

  // 학생: 1인 1역 지원서
  app.put('/api/student/:token/application', async (req, res) => {
    const { room: found, student: me } = await requireStudent(req);
    const roundId = req.body?.roundId ? String(req.body.roundId) : null;
    const room = await mutateRoom(found, (room) => {
      const student = room.students.find((s) => s.id === me.id && s.token === me.token);
      if (!student) throw new HttpError(404, '링크가 올바르지 않아요. 선생님께 QR 코드를 다시 받아 주세요.');
      const round = currentRound(room);
      if (roundId && roundId !== round.id) throw new HttpError(409, '선생님이 새 조사를 시작했어요. 화면을 새로고침한 뒤 다시 표시해 주세요.');
      if (round.closedAt) throw new HttpError(403, '선생님이 이번 조사를 마감했어요. 더 이상 수정할 수 없어요.');
      const roles = roomRoles(room);
      if (!roles.length) throw bad('아직 선생님이 역할을 정하지 않았어요.');
      const excluded = previousRoleIds(room, round).byStudent[student.id] || [];
      const application = validateApplication(req.body || {}, roles, excluded);
      round.applications ||= {};
      round.applications[student.id] = { ...application, updatedAt: new Date().toISOString() };
      clearStudentDraft(round, student.id, 'application');
    });
    res.json(studentView(req, room, room.students.find((s) => s.id === me.id)));
  });

  // ---------- 선생님: 1인 1역 ----------
  app.put('/api/teacher/:adminToken/roles', async (req, res) => {
    const found = await requireRoom(req);
    const roles = normalizeRoles(req.body?.roles);
    const room = await mutateRoom(found, (room) => {
      room.roles = roles;
      reconcileRoles(room);
    });
    res.json(teacherView(req, room, req.query.round ? String(req.query.round) : null));
  });

  app.post('/api/teacher/:adminToken/roles/default', async (req, res) => {
    const found = await requireRoom(req);
    const room = await mutateRoom(found, (room) => {
      room.roles = structuredClone(DEFAULT_ROLES);
      reconcileRoles(room);   // 없어진 역할의 배정·역할 자리를 정리 (PUT /roles 와 같은 처리)
    });
    res.json(teacherView(req, room));
  });

  // 지난달 현황 텍스트 미리보기 (저장하지 않음)
  app.post('/api/teacher/:adminToken/roles/history/parse', async (req, res) => {
    const room = await requireRoom(req);
    const roles = roomRoles(room);
    if (!roles.length) throw bad('먼저 역할 목록을 만들어 주세요.');
    const text = String(req.body?.text ?? '');
    if (text.length > 20000) throw bad('내용이 너무 길어요.');
    res.json(parseHistoryText(text, room.students, roles));
  });

  // 파일 업로드(한글·워드·텍스트) → 본문을 읽어 지난달 현황 미리보기 (저장하지 않음)
  app.post('/api/teacher/:adminToken/roles/history/upload', rawFile, async (req, res) => {
    const room = await requireRoom(req);
    const roles = roomRoles(room);
    if (!roles.length) throw bad('먼저 역할 목록을 만들어 주세요.');
    const doc = extractDocument(req.body, uploadedName(req));
    const text = documentToText(doc).slice(0, 20000);
    const tables = doc.blocks.filter((b) => b.type === 'table').length;
    const parsed = parseHistoryText(text, room.students, roles);
    // 반 명단과 맞는 이름이 없을 때 선생님이 원인을 알 수 있도록, 파일에서 읽힌 이름을 함께 돌려줍니다.
    const foundNames = extractRoster(doc).names.slice(0, 60);
    res.json({ format: doc.format, tables, paragraphs: doc.blocks.filter((b) => b.type === 'p').length, text, foundNames, ...parsed });
  });

  // 파일 업로드 → 역할 목록 미리보기 (저장하지 않음; 선생님이 편집기에서 확인한 뒤 저장)
  app.post('/api/teacher/:adminToken/roles/upload', rawFile, async (req, res) => {
    const room = await requireRoom(req);
    const doc = extractDocument(req.body, uploadedName(req));
    const knownNames = [...DEFAULT_ROLES, ...roomRoles(room)].map((r) => r.name);
    const tables = doc.blocks.filter((b) => b.type === 'table').length;
    res.json({ format: doc.format, tables, paragraphs: doc.blocks.filter((b) => b.type === 'p').length, preview: documentToText(doc).slice(0, 800), ...extractRoles(doc, { knownNames }) });
  });

  // 배정표 내보내기: 한글(hwpx) · 워드(docx). 공개 여부와 상관없이 지금 저장된 배정으로 만듭니다.
  const exportRoles = (kind) => async (req, res) => {
    const room = await requireRoom(req);
    const round = req.query.round ? requireRound(room, String(req.query.round)) : currentRound(room);
    const assignment = round.roleAssignment;
    if (!assignment?.assignments) throw bad('아직 배정이 없어요. 먼저 자동 배정이나 직접 배정을 한 뒤 저장해 주세요.');
    const input = { room, round, roles: roomRoles(room), students: room.students, assignment, reasons: req.query.reasons === '1' };
    const file = kind === 'hwpx' ? buildRolesHwpx(input) : buildRolesDocx(input);
    const base = `1인1역_${round.name}`.replace(/[\\/:*?"<>|]+/g, ' ').trim();
    const ascii = `roles_${round.name.replace(/[^0-9A-Za-z]+/g, '-').replace(/^-|-$/g, '') || 'export'}`;
    res.setHeader('Content-Type', kind === 'hwpx' ? 'application/hwp+zip' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    // 한글 이름은 filename* 로, 옛 브라우저용으로 영문 이름을 함께 보냅니다.
    res.setHeader('Content-Disposition', `attachment; filename="${ascii}.${kind}"; filename*=UTF-8''${encodeURIComponent(base)}.${kind}`);
    res.send(file);
  };
  app.get('/api/teacher/:adminToken/roles/export.hwpx', exportRoles('hwpx'));
  app.get('/api/teacher/:adminToken/roles/export.docx', exportRoles('docx'));

  // 종합 보고서: 관계도 분석 · 갈등 가능성 · AI 분석 · 자리 · 1인 1역 · 회차별 변화를 한 문서로 모읍니다.
  const reportFor = (req, room) => {
    const round = req.query.round ? requireRound(room, String(req.query.round)) : currentRound(room);
    return { round, doc: reportDocument({ room, round, reasons: req.query.reasons === '1' }) };
  };
  app.get('/api/teacher/:adminToken/report.json', async (req, res) => {
    const room = await requireRoom(req);
    const { round, doc } = reportFor(req, room);
    res.json({ ...doc, round: { id: round.id, name: round.name }, rounds: room.rounds.map((r) => ({ id: r.id, name: r.name })) });
  });
  const exportReport = (kind) => async (req, res) => {
    const room = await requireRoom(req);
    const { round, doc } = reportFor(req, room);
    const file = kind === 'hwpx' ? makeHwpxDocument(doc) : makeDocxDocument(doc);
    const base = `종합보고서_${round.name}`.replace(/[\\/:*?"<>|]+/g, ' ').trim();
    const ascii = `report_${round.name.replace(/[^0-9A-Za-z]+/g, '-').replace(/^-|-$/g, '') || 'export'}`;
    res.setHeader('Content-Type', kind === 'hwpx' ? 'application/hwp+zip' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${ascii}.${kind}"; filename*=UTF-8''${encodeURIComponent(base)}.${kind}`);
    res.send(file);
  };
  app.get('/api/teacher/:adminToken/report.hwpx', exportReport('hwpx'));
  app.get('/api/teacher/:adminToken/report.docx', exportReport('docx'));

  // 지난달(또는 어떤 달) 배정 기록 저장/수정
  app.put('/api/teacher/:adminToken/roles/history', async (req, res) => {
    const found = await requireRoom(req);
    const month = cleanName(req.body?.month);
    if (!month || month.length > LIMITS.roundName) throw bad('달 이름을 입력해 주세요. (예: 2026년 9월)');
    const room = await mutateRoom(found, (room) => {
      const roleIds = new Set(roomRoles(room).map((r) => r.id));
      const studentIds = new Set(room.students.map((s) => s.id));
      const assignments = {};
      const seen = new Set();
      for (const [roleId, sids] of Object.entries(req.body?.assignments || {})) {
        if (!roleIds.has(roleId)) throw bad('없는 역할이 포함되어 있어요.');
        const list = [];
        for (const sid of Array.isArray(sids) ? sids : []) {
          if (!studentIds.has(sid)) throw bad('없는 학생이 포함되어 있어요.');
          if (seen.has(sid)) throw bad('한 학생이 두 역할에 들어 있어요.');
          seen.add(sid);
          list.push(sid);
        }
        if (list.length) assignments[roleId] = list;
      }
      room.roleHistory ||= [];
      const entry = { month, assignments, source: String(req.body?.source || 'import'), updatedAt: new Date().toISOString() };
      const idx = room.roleHistory.findIndex((h) => h.month === month);
      if (idx >= 0) room.roleHistory[idx] = entry; else room.roleHistory.push(entry);
      if (room.roleHistory.length > 36) room.roleHistory = room.roleHistory.slice(-36);
    });
    res.json(teacherView(req, room, req.query.round ? String(req.query.round) : null));
  });

  app.delete('/api/teacher/:adminToken/roles/history/:month', async (req, res) => {
    const found = await requireRoom(req);
    const month = String(req.params.month);
    const room = await mutateRoom(found, (room) => { room.roleHistory = (room.roleHistory || []).filter((h) => h.month !== month); });
    res.json(teacherView(req, room));
  });

  app.get('/api/teacher/:adminToken/roles/balance', async (req, res) => {
    const room = await requireRoom(req);
    const round = req.query.round ? requireRound(room, String(req.query.round)) : currentRound(room);
    res.set('Cache-Control', 'no-store').json({ roleBalance: summarizeRoleBalance(room, round, { semester: req.query.semester }) });
  });

  // 자동 배정 (rules: 규칙 기반, ai: Claude API) → 회차에 초안으로 저장
  app.post('/api/teacher/:adminToken/roles/assign', async (req, res) => {
    const found = await requireRoom(req);
    const roundId = req.body?.roundId ? String(req.body.roundId) : null;
    const round = roundId ? requireRound(found, roundId) : currentRound(found);
    const roles = roomRoles(found);
    if (!roles.length) throw bad('먼저 역할 목록을 만들어 주세요.');
    const method = req.body?.method === 'ai' ? 'ai' : 'rules';
    const inputs = assignmentInputs(found, round);
    if (req.body?.balancePreference !== undefined && typeof req.body.balancePreference !== 'boolean') throw bad('희망 역할 우선 고려 설정이 올바르지 않아요.');
    if (req.body?.balancePreference) {
      if (method === 'ai') throw bad('학기 누적 희망 역할 우선 고려는 규칙 배정에서 사용할 수 있어요.');
      inputs.balancePriority = roleBalancePriorities(summarizeRoleBalance(found, round, { semester: req.body?.semester, beforeRound: true }));
    }
    let result;
    let notes = '';
    let truncated = false;
    if (method === 'ai') {
      if (!aiOn()) throw bad('AI 배정을 쓰려면 서버에 ANTHROPIC_API_KEY 를 설정해 주세요.');
      const ai = makeAi();
      const aiResult = await aiAssignRoles({ ai, ...inputs, profiles: round.profiles || {} });
      result = repairAssignment({ assignments: aiResult.assignments, explanations: aiResult.explanations, ...inputs });
      notes = aiResult.notes || '';
      truncated = Boolean(aiResult.truncated);
    } else {
      result = assignRoles({ ...inputs, seed: Number(req.body?.seed) || 1 });
    }
    const room = await mutateRoom(found, (room) => {
      const r = requireRound(room, round.id);
      assertAiRosterUnchanged(found, room);
      r.roleAssignment = {
        assignments: result.assignments,
        explanations: result.explanations || {},
        warnings: result.warnings || [],
        unassigned: result.unassigned || [],
        stats: result.stats || null,
        method,
        notes,
        truncated,
        createdAt: new Date().toISOString(),
        published: false,
        publishedAt: null,
      };
    });
    res.json(teacherView(req, room, round.id));
  });

  // 배정 수정 / 확정(공개). 공개하면 그 달 기록(roleHistory)에도 저장되어 다음 달 금지 규칙에 쓰입니다.
  app.put('/api/teacher/:adminToken/roles/assignment', async (req, res) => {
    const found = await requireRoom(req);
    const roundId = req.body?.roundId ? String(req.body.roundId) : null;
    const round = roundId ? requireRound(found, roundId) : currentRound(found);
    const room = await mutateRoom(found, (room) => {
      const r = requireRound(room, round.id);
      const roleMap = new Map(roomRoles(room).map((x) => [x.id, x]));
      const studentIds = new Set(room.students.map((s) => s.id));
      const assignments = {};
      const seen = new Set();
      for (const [roleId, sids] of Object.entries(req.body?.assignments || {})) {
        const role = roleMap.get(roleId);
        if (!role) throw bad('없는 역할이 포함되어 있어요.');
        const list = [];
        for (const sid of Array.isArray(sids) ? sids : []) {
          if (!studentIds.has(sid)) throw bad('없는 학생이 포함되어 있어요.');
          if (seen.has(sid)) throw bad('한 학생이 두 역할에 들어 있어요.');
          seen.add(sid);
          list.push(sid);
        }
        if (list.length > role.slots) throw bad(`${role.name}의 인원(${role.slots}명)을 넘었어요. (지금 ${list.length}명)`);
        assignments[roleId] = list;
      }
      const prev = r.roleAssignment || {};
      const published = Boolean(req.body?.published);
      r.roleAssignment = {
        ...prev,
        assignments,
        explanations: typeof req.body?.explanations === 'object' && req.body.explanations ? req.body.explanations : (prev.explanations || {}),
        unassigned: room.students.map((s) => s.id).filter((id) => !seen.has(id)),
        method: prev.method || 'manual',
        createdAt: prev.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        published,
        publishedAt: published ? (prev.publishedAt || new Date().toISOString()) : null,
      };
      if (published) {
        room.roleHistory ||= [];
        const balanceSnapshot = captureRoleBalanceSnapshot(room, r, undefined, prev);
        r.roleAssignment.balanceSnapshot = balanceSnapshot;
        const entry = { roundId: r.id, month: r.name, assignments, source: 'published', updatedAt: new Date().toISOString(), balanceSnapshot };
        const idx = room.roleHistory.findIndex((h) => h.roundId === r.id || h.month === r.name);
        if (idx >= 0) room.roleHistory[idx] = entry; else room.roleHistory.push(entry);
        // 같은 회차의 옛 기록(이름이 바뀌기 전 등)은 하나만 남깁니다.
        room.roleHistory = room.roleHistory.filter((h) => h === entry || (h.roundId !== r.id && h.month !== r.name));
      }
    });
    res.json(teacherView(req, room, round.id));
  });

  // AI 관계·역할 분석 → 회차에 저장
  app.post('/api/teacher/:adminToken/ai/analyze', async (req, res) => {
    const found = await requireRoom(req);
    if (!aiOn()) throw bad('AI 분석을 쓰려면 서버에 ANTHROPIC_API_KEY 를 설정해 주세요.');
    const roundId = req.body?.roundId ? String(req.body.roundId) : null;
    const round = roundId ? requireRound(found, roundId) : currentRound(found);
    const rr = roundRoom(found, round);
    const stats = computeStats(rr);
    const analysis = analyzeConflicts(rr, stats);
    const ai = makeAi();
    const provenance = captureAnalysisContext(found, round);
    const result = await aiAnalyzeRelationships({
      ai,
      students: found.students.map((s) => ({ id: s.id, name: s.name })),
      relations: listRelations(rr),
      pairs: analysis.pairs,
      teacherNotes: found.teacherNotes || { students: {}, rules: [] },
      profiles: round.profiles || {},
      applications: round.applications || {},
      roles: roomRoles(found),
      previousRoles: previousRoleIds(found, round),
    });
    const room = await mutateRoom(found, (room) => {
      const r = requireRound(room, round.id);
      r.aiAnalysis = { ...result, provenance, createdAt: new Date().toISOString(), model: ai?.model || null };
      assertAiRosterUnchanged(found, room);
    });
    res.json(teacherView(req, room, round.id));
  });

  // AI 자리 배정은 선택 회차에 보관하고, 자리표 적용은 선생님이 확인한 뒤 저장합니다.
  app.post('/api/teacher/:adminToken/ai/seating', async (req, res) => {
    const found = await requireRoom(req);
    if (!aiOn()) throw bad('AI 자리 배정을 쓰려면 서버에 ANTHROPIC_API_KEY 를 설정해 주세요.');
    if (!found.students.length) throw bad('학생이 없어요. 먼저 학생을 등록해 주세요.');   // 빈 명단으로 유료 호출을 하지 않도록
    const roundId = req.body?.roundId ? String(req.body.roundId) : null;
    const round = roundId ? requireRound(found, roundId) : currentRound(found);
    const { layout, seats, pinned, options, zones, climate, roleSeats } = parseSeatingBody(req.body || {}, found);
    const fixedSeats = {};                       // 📌 고정 자리 중 학생이 앉아 있는 자리
    for (const seatId of pinned) if (seats[seatId]) fixedSeats[seatId] = seats[seatId];
    const rr = roundRoom(found, round);
    const stats = computeStats(rr);
    const analysis = analyzeConflicts(rr, stats);
    const roleAssignment = round.roleAssignment?.assignments || {};
    const students = found.students.map((s) => ({ id: s.id, name: s.name }));
    const ai = makeAi();
    const inputConfig = { layout, fixedSeats, zones, climate, roleSeats, options };
    const provenance = captureAnalysisContext(found, round, { kind: 'seating', extra: inputConfig });
    const result = await aiAssignSeats({
      ai,
      students,
      relations: listRelations(rr),
      pairs: analysis.pairs,
      teacherNotes: found.teacherNotes || { students: {}, rules: [] },
      profiles: round.profiles || {},
      bodies: Object.fromEntries(found.students.map((s) => [s.id, s.body || {}])),
      roles: roomRoles(found).map((r) => ({ id: r.id, name: r.name })),
      roleAssignment,
      aiAnalysis: round.aiAnalysis || null,
      isolated: Object.values(analysis.studentRisk).filter((s) => s.flags.includes('isolated')).map((s) => s.id),
      layout,
      fixedSeats,
      zones,
      climate,
      roleSeats,
      options,
    });
    const repaired = repairSeating({ assignment: result.assignment, students, layout, fixedSeats, roleSeats, roleAssignment });
    const room = await mutateRoom(found, (room) => {
      const r = requireRound(room, round.id);
      assertAiRosterUnchanged(found, room);
      r.aiSeating = {
        roundId: round.id,
        roundName: round.name,
        createdAt: new Date().toISOString(),
        model: ai?.model || null,
        provenance,
        inputConfig,
        truncated: Boolean(result.truncated),
        pairs: result.pairs,
        assignment: repaired.seats,
        explanations: result.explanations,
        notes: result.notes,
        warnings: repaired.warnings,
      };
    });
    res.json(teacherView(req, room, round.id));
  });

  /** 삭제된 학생의 흔적을 AI 자리 배정안에서 지웁니다. 글에 남은 이름은 '(삭제된 학생)'으로 바꿉니다. */
  function scrubAiSeating(a, student) {
    scrubAiProvenance(a, student.id);
    for (const [seatId, sid] of Object.entries(a.inputConfig?.fixedSeats || {})) if (sid === student.id) delete a.inputConfig.fixedSeats[seatId];
    a.pairs = (a.pairs || []).filter((p) => p.a !== student.id && p.b !== student.id);
    for (const [seatId, sid] of Object.entries(a.assignment || {})) if (sid === student.id) delete a.assignment[seatId];
    if (a.explanations) delete a.explanations[student.id];
    const name = String(student.name || '').trim();
    if (name.length < 2) return;
    const wipe = (t) => (typeof t === 'string' ? t.split(name).join('(삭제된 학생)') : t);
    a.notes = wipe(a.notes);
    for (const p of a.pairs) p.reason = wipe(p.reason);
    for (const sid of Object.keys(a.explanations || {})) a.explanations[sid] = wipe(a.explanations[sid]);
    a.warnings = (a.warnings || []).map(wipe);
  }

  /**
   * 학생 이름을 바꾸면 AI 분석·AI 자리 배정안의 글에 실명으로 들어 있던 옛 이름도 새 이름으로 바꿉니다.
   * (가명 처리는 지금 명단의 이름만 알아서, 그대로 두면 다음 AI 요청 때 옛 실명이 프롬프트에 섞여 나갑니다.)
   */
  function renameInAiTexts(room, oldName, newName) {
    const from = String(oldName || '').trim();
    if (from.length < 2 || from === newName) return;
    const swap = (t) => (typeof t === 'string' ? t.split(from).join(newName) : t);
    for (const round of room.rounds || []) {
      const a = round.aiAnalysis;
      if (!a) continue;
      a.summary = swap(a.summary);
      for (const p of a.pairs || []) { p.analysis = swap(p.analysis); p.advice = swap(p.advice); p.conflictType = swap(p.conflictType); }
      for (const s of a.students || []) {
        s.summary = swap(s.summary); s.strengths = swap(s.strengths); s.watch = swap(s.watch);
        for (const f of s.roleFit || []) f.reason = swap(f.reason);
      }
    }
    for (const round of room.rounds || []) {
      const b = round.aiSeating;
      if (!b) continue;
      b.notes = swap(b.notes);
      for (const p of b.pairs || []) p.reason = swap(p.reason);
      for (const sid of Object.keys(b.explanations || {})) b.explanations[sid] = swap(b.explanations[sid]);
      b.warnings = (b.warnings || []).map(swap);
    }
  }

  /** 삭제된 학생의 흔적을 AI 분석 결과에서 지웁니다. 자유 서술에 남은 이름은 '(삭제된 학생)'으로 바꿉니다. */
  function scrubAiAnalysis(a, student) {
    scrubAiProvenance(a, student.id);
    a.pairs = (a.pairs || []).filter((p) => p.a !== student.id && p.b !== student.id);
    a.students = (a.students || []).filter((s) => s.id !== student.id);
    const name = String(student.name || '').trim();
    if (name.length < 2) return;
    const wipe = (t) => (typeof t === 'string' ? t.split(name).join('(삭제된 학생)') : t);
    a.summary = wipe(a.summary);
    for (const p of a.pairs) { p.analysis = wipe(p.analysis); p.advice = wipe(p.advice); p.conflictType = wipe(p.conflictType); }
    for (const s of a.students) {
      s.summary = wipe(s.summary); s.strengths = wipe(s.strengths); s.watch = wipe(s.watch);
      for (const f of s.roleFit || []) f.reason = wipe(f.reason);
    }
  }

  function scrubAiProvenance(result, studentId) {
    const provenance = result.provenance;
    if (!provenance) return;
    provenance.evidence = (provenance.evidence || []).filter((item) => !(item.studentIds || []).includes(studentId) && item.from !== studentId && item.to !== studentId);
    if (provenance.coverage) provenance.coverage.missingStudentIds = (provenance.coverage.missingStudentIds || []).filter((id) => id !== studentId);
    // Keep the original fingerprint so changes to the roster remain visibly stale.
  }

  function assertAiRosterUnchanged(before, current) {
    const roster = (room) => JSON.stringify(room.students.map(({ id, name }) => ({ id, name })));
    if (roster(before) !== roster(current)) throw new HttpError(409, '분석 중 학생 명단이 바뀌었어요. 최신 명단으로 다시 분석해 주세요.');
  }

  /** 역할 목록이 바뀐 뒤: 지워진 역할에 배정돼 있던 학생은 미배정으로 돌리고 경고를 남깁니다. 정원이 줄어든 역할도 알립니다. */
  function reconcileRoles(room) {
    const roleMap = new Map(roomRoles(room).map((r) => [r.id, r]));
    // 지워진 역할의 역할 자리는 보통 자리로 돌립니다.
    walkSeatings(room, (seating) => {
      for (const [seatId, rid] of Object.entries(seating.roleSeats || {})) if (!roleMap.has(rid)) delete seating.roleSeats[seatId];
    });
    for (const round of room.rounds || []) {
      const ra = round.roleAssignment;
      if (!ra?.assignments) continue;
      const warnings = (ra.warnings || []).filter((w) => !w.startsWith('역할 목록이 바뀌어'));
      const dropped = [];
      for (const [rid, list] of Object.entries(ra.assignments)) {
        const role = roleMap.get(rid);
        if (!role) {
          dropped.push(...(list || []));
          delete ra.assignments[rid];
          continue;
        }
        if ((list || []).length > role.slots) warnings.push(`역할 목록이 바뀌어 ‘${role.name}’ 인원(${role.slots}명)보다 많은 ${list.length}명이 배정돼 있어요. 배정을 고쳐 주세요.`);
      }
      if (dropped.length) {
        for (const sid of dropped) { if (ra.explanations) delete ra.explanations[sid]; }
        const placed = new Set(Object.values(ra.assignments).flat());
        ra.unassigned = (room.students || []).map((s) => s.id).filter((id) => !placed.has(id));
        const names = dropped.map((sid) => room.students.find((s) => s.id === sid)?.name).filter(Boolean).join(', ');
        warnings.push(`역할 목록이 바뀌어 ${dropped.length}명(${names})의 역할이 없어졌어요. 빈자리에 다시 배정해 주세요.${ra.published ? ' 공개된 배정이라 학생 화면에도 역할이 사라졌어요.' : ''}`);
      }
      ra.warnings = warnings;
      if (dropped.length && ra.published) {
        const entry = (room.roleHistory || []).find((h) => h.roundId === round.id || h.month === round.name);
        if (entry) entry.assignments = structuredClone(ra.assignments);
      }
    }
  }

  function assignmentInputs(room, round) {
    const rr = roundRoom(room, round);
    const apart = (room.teacherNotes?.rules || []).filter((r) => r.type === 'apart').map((r) => [r.a, r.b]);
    return {
      students: room.students.map((s) => ({ id: s.id, name: s.name })),
      roles: roomRoles(room).map((r) => ({ id: r.id, name: r.name, slots: r.slots, description: r.description })),
      applications: round.applications || {},
      excluded: previousRoleIds(room, round).byStudent,
      relations: listRelations(rr).map((r) => ({ from: r.from, to: r.to, type: r.type })),
      apartPairs: apart,
      previousRoles: previousRoleIds(room, round),
    };
  }

  // ---------- fallbacks ----------
  app.use('/api', (req, res) => res.status(404).json({ error: '없는 주소예요.' }));
  app.use((req, res) => res.status(404).type('html').send(pages.notFound));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    let message = status >= 500 && !err.expose ? '서버에 문제가 생겼어요. 잠시 후 다시 시도해 주세요.' : err.message;
    if (err.type === 'entity.too.large') message = '보낸 내용이 너무 커요. (파일은 6MB 까지)';
    if (req.path.startsWith('/api')) res.status(status).json({ error: message, ...(err.code === 'DRAFT_CONFLICT' ? { code: err.code, draft: err.draft } : {}), ...(err.code === 'ROUND_CHANGED' ? { code: err.code, currentRoundId: err.currentRoundId } : {}) });
    else res.status(status).type('text/plain').send(message);
  });

  return app;
}
