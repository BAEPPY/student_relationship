// 1인 1역 자동 배정 (규칙 기반). 다른 모듈을 불러오지 않는 순수 ESM 모듈입니다.
//
// ■ 점수 — 학생 한 명을 어떤 역할에 넣을 때 얻는 점수 (선생님이 설명에서 보는 기준)
//   지망 순위    1지망 100 · 2지망 60 · 3지망 30  (지원하지 않은 역할에 들어가면 0)
//   정성 보너스  '하고 싶은 이유'가 60자 이상 +20, 30자 이상 +10
//               '우리 반에 도움 되는 점'을 적으면 +5, '나에게 도움 되는 점'을 적으면 +5
//   역할 이해    이유에 역할 이름·설명과 겹치는 낱말(한글 2자 이상, 조사·흔한 말 제외)이 있으면 +5
//   선택 사항    balancePriority가 있으면 확인된 학기 희망 외 배정을 참고해 지망한 역할에만 최대 +20
// ■ 감점 (점수에서 뺌)
//   사이가 안 좋은 두 학생(한쪽이라도 '안 좋은 사이'로 표시) 또는 선생님이 떨어뜨리기로 한 쌍이
//   같은 역할(정원 2명 이상)에 함께 들어가면 쌍마다 −80
//   배정 못 받은 학생이 있는데 빈자리를 남기면 자리마다 −10
// ■ 절대 규칙 (점수와 상관없이 항상 지킴)
//   정원 초과 금지 · 지난달 역할 금지(excluded) · 한 학생은 한 역할만 · 없는 역할을 적은 지망은 무시
// ■ 과정
//   ① 점수가 높은 지망부터 탐욕적으로 배정 (같은 점수는 seed 로 섞은 순서 → 같은 seed 면 같은 결과)
//   ② 지원서가 없거나 지망이 모두 찬 학생은 지원자가 적은 역할의 빈자리부터 배치 (제외 규칙·감점 고려)
//   ③ 한 명 이동 · 두 명 교환 · 빈자리 연쇄 이동으로 총점(점수 합 − 감점)이 오르는 동안 개선 (국소 탐색, 횟수 제한)
//   Math.random 은 쓰지 않고 작은 시드 난수(mulberry32)만 씁니다.
//
// assignRoles({ students, roles, applications, excluded, relations, apartPairs, seed })
//   students:     [{ id, name }]
//   roles:        [{ id, name, slots, description? }]
//   applications: { [studentId]: { choices: [{ roleId, reason, helpClass, helpSelf }] } }  (1지망부터, 최대 3개)
//   excluded:     { [studentId]: [roleId] }   지난달에 맡아서 이번 달에 금지된 역할
//   relations:    [{ from, to, type: 'good'|'bad' }]
//   apartPairs:   [[a, b]]   교사가 떨어뜨리기로 지정한 쌍
//   seed:         number
// → { assignments: { [roleId]: [studentId] }, unassigned: [studentId], explanations: { [studentId]: string },
//     warnings: [string], stats: { firstChoice, secondChoice, thirdChoice, fallback, noApplication, unassigned, students, slots } }
//
// repairAssignment({ assignments, explanations, ...같은 입력 }) → 같은 결과 모양.
//   외부(AI)가 만든 배정에서 없는 학생/역할 · 중복 · 지난달 역할 · 정원 초과를 고치고 빈자리를 채웁니다.
//   손대지 않은 학생의 설명은 그대로 두고, 바뀐 학생에게는 새 설명을, 고친 내용은 warnings 에 적습니다.

export const CHOICE_POINTS = [100, 60, 30];
export const CONFLICT_PENALTY = 80;
export const EMPTY_SLOT_PENALTY = 10;
const MAX_ITERATIONS = 400;
const EPS = 1e-9;

// ---------- 시드 난수 ----------

export function mulberry32(seed) {
  let a = (Math.trunc(Number(seed) || 0)) >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------- 한국어 도우미 ----------

function hasFinalConsonant(word) {
  const ch = String(word || '').trim().slice(-1);
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
  if (/[0-9]/.test(ch)) return '013678'.includes(ch);
  return false;
}

/** josa('사과', '는/은') → '는' */
function josa(word, pair) {
  const [vowel, consonant] = pair.split('/');
  return hasFinalConsonant(word) ? consonant : vowel;
}

const quote = (name) => `‘${name}’`;

// 역할 이해 판단에서 무시하는 흔한 말 (조사를 뗀 형태)
const STOP_WORDS = new Set((
  '친구 우리 그리고 그래서 그런데 하지만 때문 때문에 정말 너무 같이 함께 많이 열심히 선생님 매일 하고 해요 해서 하는 하면 해도 합니다 ' +
  '있는 있어 있어요 있으면 있다면 없는 없어 없으면 없도록 싶어 싶어요 싶습니다 싶다 싶고 되는 되면 되고 되기 되도록 하기 하도록 ' +
  '모두 다른 같은 이번 지난 역할 도움 제가 저는 나는 내가 저도 나도 자기 자신 생각 좋아 좋아요 좋은 좋을 좋고 좋게 좋다 ' +
  '잘하 잘해 잘해요 그것 이것 사람 여러 가지 하나 한다 해줘 해주 주고 받고 보고 그냥 아주 조금 항상 언제나 이유 학생 ' +
  '위해 위해서 통해 대해 그런 이런 저런 어떤 무엇 누구 누구나 언제 어디 거기 여기 그래 때는 때도 때마다 수가 수도 것도 것은 ' +
  '것이 것을 거예요 거에요 입니다 이에요 예요 에요 않아요 않고 않는 않아 않도록 않게 말고 먼저 가장 다시 특히 나중 바로 ' +
  '그때 이제 아직 벌써 매우 더욱 보다 보면 하며 하면서 해야 하겠습니다 하겠어요 할게요 할래요 할수 있게'
).split(' '));
const PARTICLE_RE = /(으로|에서|에게|한테|까지|부터|처럼|이나|이랑|들이|들을|들의|들은|들도|들과|하고|이고|라고|라는|이라|도|들|을|를|이|가|은|는|와|과|의|에|로|만)$/;

function hangulTokens(text) {
  return String(text || '').match(/[가-힣]+/g) || [];
}

function stemOf(token) {
  let t = token;
  for (let i = 0; i < 3; i++) {
    const m = PARTICLE_RE.exec(t);
    if (!m || t.length - m[0].length < 2) break;
    t = t.slice(0, t.length - m[0].length);
  }
  return t;
}

function stems(text) {
  const out = new Set();
  for (const tok of hangulTokens(text)) {
    const s = stemOf(tok);
    if (s.length >= 2 && !STOP_WORDS.has(s)) out.add(s);
  }
  return out;
}

/** 이유 글에 역할 이름·설명과 겹치는 의미 있는 낱말(한글 2자 이상)이 있는지 */
export function sharesRoleWord(reason, role) {
  const reasonText = String(reason || '');
  const roleText = `${role?.name || ''} ${role?.description || ''}`;
  if (!reasonText.trim() || !roleText.trim()) return false;
  for (const s of stems(roleText)) if (reasonText.includes(s)) return true;
  for (const s of stems(reasonText)) if (roleText.includes(s)) return true;
  return false;
}

// ---------- 점수 ----------

/**
 * 지망 하나의 점수. choiceIndex 는 0부터(0 = 1지망).
 * → { score, base, reasonLength, lengthBonus, helpClass, helpSelf, helpBonus, understanding, understandingBonus }
 */
export function scoreApplication(choiceIndex, choice, role) {
  const index = Number.isInteger(choiceIndex) ? choiceIndex : Math.trunc(Number(choiceIndex) || 0);
  const base = CHOICE_POINTS[index] ?? 0;
  const reason = String(choice?.reason ?? '').replace(/\s+/g, ' ').trim();
  const reasonLength = reason.length;
  const lengthBonus = reasonLength >= 60 ? 20 : reasonLength >= 30 ? 10 : 0;
  const helpClass = String(choice?.helpClass ?? '').trim().length > 0;
  const helpSelf = String(choice?.helpSelf ?? '').trim().length > 0;
  const helpBonus = (helpClass ? 5 : 0) + (helpSelf ? 5 : 0);
  const understanding = sharesRoleWord(reason, role);
  const understandingBonus = understanding ? 5 : 0;
  return {
    score: base + lengthBonus + helpBonus + understandingBonus,
    base,
    reasonLength,
    lengthBonus,
    helpClass,
    helpSelf,
    helpBonus,
    understanding,
    understandingBonus,
  };
}

// ---------- 문제 정리 ----------

const pairKey = (a, b) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

function buildProblem(input = {}) {
  const students = [];
  const studentIndex = new Map();
  for (const s of Array.isArray(input.students) ? input.students : []) {
    const id = String(s?.id ?? '');
    if (!id || studentIndex.has(id)) continue;
    const st = { id, name: String(s?.name ?? id), order: students.length };
    students.push(st);
    studentIndex.set(id, st);
  }

  const roles = [];
  const roleIndex = new Map();
  for (const r of Array.isArray(input.roles) ? input.roles : []) {
    const id = String(r?.id ?? '');
    if (!id || roleIndex.has(id)) continue;
    const slots = Math.max(0, Math.trunc(Number(r?.slots) || 0));
    const role = { id, name: String(r?.name ?? id), slots, description: String(r?.description ?? ''), order: roles.length };
    roles.push(role);
    roleIndex.set(id, role);
  }

  const excluded = new Map();
  for (const [sid, list] of Object.entries(input.excluded || {})) {
    if (!studentIndex.has(sid)) continue;
    excluded.set(sid, new Set((Array.isArray(list) ? list : []).map(String).filter((rid) => roleIndex.has(rid))));
  }

  const conflicts = new Set();
  const addPair = (x, y) => {
    const a = String(x ?? '');
    const b = String(y ?? '');
    if (!a || !b || a === b || !studentIndex.has(a) || !studentIndex.has(b)) return;
    conflicts.add(pairKey(a, b));
  };
  for (const r of Array.isArray(input.relations) ? input.relations : []) if (r?.type === 'bad') addPair(r.from, r.to);
  for (const p of Array.isArray(input.apartPairs) ? input.apartPairs : []) if (Array.isArray(p) && p.length >= 2) addPair(p[0], p[1]);

  const apps = new Map();
  const balancePriority = new Map();
  for (const s of students) {
    const value = input.balancePriority?.[s.id];
    const bonus = Math.max(0, Math.min(20, Number(value?.bonus) || 0));
    if (bonus) balancePriority.set(s.id, { ...value, bonus });
  }
  const applicants = new Map(roles.map((r) => [r.id, 0]));
  const scores = new Map();
  for (const s of students) {
    const app = input.applications?.[s.id];
    const raw = Array.isArray(app?.choices) ? app.choices : [];
    const choices = [];
    const seenRoles = new Set();
    raw.forEach((c, i) => {
      if (i >= CHOICE_POINTS.length) return;
      const roleId = String(c?.roleId ?? '');
      const role = roleIndex.get(roleId);
      if (!role || seenRoles.has(roleId)) return; // 없는 역할·중복 지망은 무시
      seenRoles.add(roleId);
      const detail = scoreApplication(i, c, role);
      const isExcluded = Boolean(excluded.get(s.id)?.has(roleId));
      choices.push({ roleId, index: i, score: detail.score + (balancePriority.get(s.id)?.bonus || 0), detail, excluded: isExcluded });
      if (!isExcluded) applicants.set(roleId, applicants.get(roleId) + 1);
    });
    if (!choices.length) continue;
    const valid = choices.filter((c) => !c.excluded);
    apps.set(s.id, { choices, valid, excludedChoices: choices.filter((c) => c.excluded) });
    scores.set(s.id, new Map(valid.map((c) => [c.roleId, c])));
  }

  return { students, studentIndex, roles, roleIndex, excluded, conflicts, apps, applicants, scores, balancePriority };
}

// ---------- 상태 ----------

function makeState(P) {
  // filled: ② 단계(빈자리 배치)로 들어간 학생들 (안내 문구용)
  return { roleOf: new Map(), members: new Map(P.roles.map((r) => [r.id, []])), filled: new Set() };
}

function place(state, sid, roleId) {
  state.roleOf.set(sid, roleId);
  state.members.get(roleId).push(sid);
}

function unplace(state, sid) {
  const roleId = state.roleOf.get(sid);
  if (roleId === undefined) return;
  const list = state.members.get(roleId);
  const i = list.indexOf(sid);
  if (i >= 0) list.splice(i, 1);
  state.roleOf.delete(sid);
}

const allowed = (P, sid, roleId) => !P.excluded.get(sid)?.has(roleId);
const isFull = (P, state, roleId) => state.members.get(roleId).length >= P.roleIndex.get(roleId).slots;
const freeSlots = (P, state, roleId) => Math.max(0, P.roleIndex.get(roleId).slots - state.members.get(roleId).length);
const scoreOf = (P, sid, roleId) => P.scores.get(sid)?.get(roleId)?.score ?? 0;

/** sid 가 roleId 에 들어갈 때 생기는(또는 들어 있어서 생긴) 충돌 쌍 수. except 는 세지 않음 */
function conflictsIn(P, state, sid, roleId, except = null) {
  let n = 0;
  for (const m of state.members.get(roleId)) {
    if (m === sid || m === except) continue;
    if (P.conflicts.has(pairKey(sid, m))) n++;
  }
  return n;
}

function emptySlotTotal(P, state) {
  let n = 0;
  for (const r of P.roles) n += freeSlots(P, state, r.id);
  return n;
}

const emptyPenalty = (empty, unassigned) => EMPTY_SLOT_PENALTY * Math.max(0, Math.min(empty, unassigned));

// ---------- ① 지망 점수 순 탐욕 배정 ----------

function greedyApplications(P, state, rng) {
  const entries = [];
  for (const s of P.students) {
    if (state.roleOf.has(s.id)) continue;
    const app = P.apps.get(s.id);
    if (!app) continue;
    for (const c of app.valid) entries.push({ sid: s.id, roleId: c.roleId, score: c.score, eff: c.score, penalized: false, done: false });
  }
  shuffle(entries, rng);
  for (;;) {
    let best = null;
    for (const e of entries) if (!e.done && (best === null || e.eff > best.eff)) best = e;
    if (!best) break;
    if (state.roleOf.has(best.sid) || isFull(P, state, best.roleId)) { best.done = true; continue; }
    const conf = conflictsIn(P, state, best.sid, best.roleId);
    if (conf > 0 && !best.penalized) { // 충돌이 있으면 감점한 점수로 다시 줄을 섬
      best.penalized = true;
      best.eff = best.score - CONFLICT_PENALTY * conf;
      continue;
    }
    best.done = true;
    if (best.eff < 0) continue; // 감점이 더 크면 빈자리 배치로 넘김
    place(state, best.sid, best.roleId);
  }
}

// ---------- ② 남은 학생을 빈자리에 배치 ----------

function fillRemaining(P, state, rng) {
  const pending = P.students.filter((s) => !state.roleOf.has(s.id));
  shuffle(pending, rng);
  const priority = (sid) => {
    const app = P.apps.get(sid);
    if (!app) return [0, 0];
    return [1, app.valid.reduce((m, c) => Math.max(m, c.score), 0)];
  };
  pending.sort((a, b) => {
    const [pa, qa] = priority(a.id);
    const [pb, qb] = priority(b.id);
    return pb - pa || qb - qa;
  });
  for (const s of pending) {
    let best = null;
    let bestKey = null;
    for (const r of P.roles) {
      if (isFull(P, state, r.id) || !allowed(P, s.id, r.id)) continue;
      const key = [conflictsIn(P, state, s.id, r.id), P.applicants.get(r.id), -freeSlots(P, state, r.id)];
      if (!best || key[0] < bestKey[0] || (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))) {
        best = r;
        bestKey = key;
      }
    }
    if (best) {
      place(state, s.id, best.id);
      state.filled.add(s.id);
    }
  }
}

// ---------- ③ 국소 탐색 ----------

function localSearch(P, state, rng, maxIterations = MAX_ITERATIONS) {
  const order = shuffle(P.students.map((s) => s.id), rng);
  for (let iter = 0; iter < maxIterations; iter++) {
    let best = null;
    // 총점이 오르거나, 총점은 같은데 충돌 쌍이 줄어드는 변화만 받아들임 (사전식 증가 → 반드시 끝남)
    const consider = (delta, conflictDelta, apply) => {
      if (!(delta > EPS || (delta > -EPS && conflictDelta < 0))) return;
      if (!best || delta > best.delta + EPS || (Math.abs(delta - best.delta) <= EPS && conflictDelta < best.conflictDelta)) {
        best = { delta, conflictDelta, apply };
      }
    };
    const unassigned = order.filter((sid) => !state.roleOf.has(sid));
    const empty = emptySlotTotal(P, state);
    const penNow = emptyPenalty(empty, unassigned.length);
    const penAfterFill = emptyPenalty(empty - 1, unassigned.length - 1);

    // 한 명 이동 (빈자리로)
    for (const sid of order) {
      const from = state.roleOf.get(sid) ?? null;
      for (const r of P.roles) {
        if (r.id === from || isFull(P, state, r.id) || !allowed(P, sid, r.id)) continue;
        const confTo = conflictsIn(P, state, sid, r.id);
        const confFrom = from ? conflictsIn(P, state, sid, from) : 0;
        let delta = scoreOf(P, sid, r.id) - (from ? scoreOf(P, sid, from) : 0) - CONFLICT_PENALTY * (confTo - confFrom);
        if (!from) delta += penNow - penAfterFill;
        consider(delta, confTo - confFrom, () => { unplace(state, sid); place(state, sid, r.id); });
      }
    }

    // 두 명 교환
    for (let i = 0; i < order.length; i++) {
      const a = order[i];
      const ra = state.roleOf.get(a);
      if (!ra) continue;
      for (let j = i + 1; j < order.length; j++) {
        const b = order[j];
        const rb = state.roleOf.get(b);
        if (!rb || rb === ra || !allowed(P, a, rb) || !allowed(P, b, ra)) continue;
        const before = conflictsIn(P, state, a, ra) + conflictsIn(P, state, b, rb);
        const after = conflictsIn(P, state, a, rb, b) + conflictsIn(P, state, b, ra, a);
        const delta = scoreOf(P, a, rb) + scoreOf(P, b, ra) - scoreOf(P, a, ra) - scoreOf(P, b, rb) - CONFLICT_PENALTY * (after - before);
        consider(delta, after - before, () => {
          unplace(state, a); unplace(state, b);
          place(state, a, rb); place(state, b, ra);
        });
      }
    }

    // 배정 못 받은 학생이 자리를 넘겨받음 (자리를 내준 학생은 미배정)
    for (const u of unassigned) {
      for (const a of order) {
        const ra = state.roleOf.get(a);
        if (!ra || !allowed(P, u, ra)) continue;
        const before = conflictsIn(P, state, a, ra);
        const after = conflictsIn(P, state, u, ra, a);
        const delta = scoreOf(P, u, ra) - scoreOf(P, a, ra) - CONFLICT_PENALTY * (after - before);
        consider(delta, after - before, () => { unplace(state, a); place(state, u, ra); });
      }
    }

    // 연쇄 이동: v 가 빈자리 X 로 옮기고, 미배정 u 가 v 의 자리 Y 를 받음
    if (unassigned.length && empty > 0) {
      for (const u of unassigned) {
        for (const v of order) {
          const Y = state.roleOf.get(v);
          if (!Y || !allowed(P, u, Y)) continue;
          for (const X of P.roles) {
            if (X.id === Y || isFull(P, state, X.id) || !allowed(P, v, X.id)) continue;
            const before = conflictsIn(P, state, v, Y);
            const after = conflictsIn(P, state, v, X.id) + conflictsIn(P, state, u, Y, v);
            const delta = scoreOf(P, u, Y) + scoreOf(P, v, X.id) - scoreOf(P, v, Y) - CONFLICT_PENALTY * (after - before) + (penNow - penAfterFill);
            consider(delta, after - before, () => {
              unplace(state, v); place(state, v, X.id); place(state, u, Y);
            });
          }
        }
      }
    }

    if (!best) break;
    best.apply();
  }
}

// ---------- 설명 · 경고 · 통계 ----------

function qualityParts(detail) {
  const parts = [];
  if (detail.reasonLength >= 60) parts.push(`이유를 정성껏 적음(${detail.reasonLength}자)`);
  else if (detail.reasonLength >= 30) parts.push(`이유를 충실히 적음(${detail.reasonLength}자)`);
  if (detail.helpClass && detail.helpSelf) parts.push('우리 반·나에게 도움 되는 점 모두 적음');
  else if (detail.helpClass) parts.push('우리 반에 도움 되는 점 적음');
  else if (detail.helpSelf) parts.push('나에게 도움 되는 점 적음');
  if (detail.understanding) parts.push('역할을 잘 이해함');
  return parts;
}

function whySkipped(P, state, sid, choice) {
  const role = P.roleIndex.get(choice.roleId);
  const members = state.members.get(choice.roleId);
  if (members.length >= role.slots) {
    const details = members.map((m) => P.scores.get(m)?.get(choice.roleId) || null);
    const others = members.map((m) => scoreOf(P, m, choice.roleId));
    const quality = (c) => (c?.detail ? c.detail.score - c.detail.base : 0);
    if (details.length && details.every((d) => d && d.index < choice.index)) return '더 높은 지망으로 쓴 친구들로 찼어요';
    if (details.length && details.every((d) => d && d.index <= choice.index) && details.every((d) => quality(d) > quality(choice))) return '더 정성껏 쓴 친구들로 찼어요';
    if (others.length && others.every((s) => s > choice.score)) return '더 높은 지망이거나 더 정성껏 쓴 친구들로 찼어요';
    if (others.length && others.every((s) => s >= choice.score)) return '같은 점수인 친구들로 찼어요(추첨)';
    return '이미 찼어요';
  }
  if (conflictsIn(P, state, sid, choice.roleId) > 0) return '같이 두지 않는 게 좋은 친구가 있어요';
  return '자리가 남아 있어요 (직접 옮겨도 돼요)';
}

function exclusionNote(P, app) {
  if (!app?.excludedChoices.length) return '';
  const names = app.excludedChoices.map((c) => P.roleIndex.get(c.roleId).name);
  return `지난달 역할이라 ${names.map(quote).join(', ')}${josa(names[names.length - 1], '는/은')} 제외`;
}

function explain(P, state, sid) {
  const roleId = state.roleOf.get(sid) ?? null;
  const role = roleId ? P.roleIndex.get(roleId) : null;
  const app = P.apps.get(sid) || null;
  const excl = exclusionNote(P, app);

  if (!role) {
    const free = P.roles.filter((r) => !isFull(P, state, r.id));
    const noApp = app ? '' : '지원서가 없고 ';
    if (!free.length) return excl ? `${excl}했고, 자리가 부족해 배정되지 않았어요.` : `${noApp}남은 자리가 없어 배정되지 않았어요.`;
    if (free.every((r) => !allowed(P, sid, r.id))) return `${noApp}남은 자리가 지난달 역할뿐이라 배정되지 않았어요.`;
    return `${noApp}남은 자리에 같이 두지 않는 게 좋은 친구가 있어 배정되지 않았어요.`;
  }

  const choice = app?.valid.find((c) => c.roleId === roleId) || null;
  if (!choice) {
    if (!app) return `지원서가 없어 빈자리인 ${quote(role.name)}에 배정`;
    if (!app.valid.length) return `지망한 역할이 모두 지난달 역할이라 빈자리인 ${quote(role.name)}에 배정`;
    const blocked = app.valid.some((c) => !isFull(P, state, c.roleId) && conflictsIn(P, state, sid, c.roleId) > 0);
    const why = blocked ? '차 있거나 같이 두지 않는 게 좋은 친구가 있어' : '모두 차서';
    if (excl) return `${excl}하고, 나머지 지망은 ${why} 빈자리인 ${quote(role.name)}에 배정`;
    return `지망한 역할이 ${why} 빈자리인 ${quote(role.name)}에 배정`;
  }

  const head = choice.index === 0 ? '1지망 ✓' : `${choice.index + 1}지망 배정`;
  let line = excl ? `${excl}하고 ${head}` : head;

  const groups = new Map(); // 이유별로 묶어 "1지망 ‘A’, 2지망 ‘B’는 …" 꼴로
  for (const c of app.valid) {
    if (c.index >= choice.index) continue;
    const why = whySkipped(P, state, sid, c);
    const name = P.roleIndex.get(c.roleId).name;
    if (!groups.has(why)) groups.set(why, []);
    groups.get(why).push({ label: `${c.index + 1}지망 ${quote(name)}`, name });
  }
  if (groups.size) {
    const notes = [...groups].map(([why, items]) => `${items.map((x) => x.label).join(', ')}${josa(items[items.length - 1].name, '는/은')} ${why}`);
    line += ` (${notes.join(', ')})`;
  }

  const quality = qualityParts(choice.detail);
  if (quality.length) line += ` · ${quality.join(' · ')}`;
  if (conflictsIn(P, state, sid, roleId) > 0) line += ' · ⚠ 같이 두지 않는 게 좋은 친구와 같은 역할';
  return line;
}

function standardWarnings(P, state) {
  const warnings = [];
  const totalSlots = P.roles.reduce((a, r) => a + r.slots, 0);
  const n = P.students.length;
  const unassigned = P.students.filter((s) => !state.roleOf.has(s.id));
  const emptyRoles = P.roles.filter((r) => freeSlots(P, state, r.id) > 0);

  if (unassigned.length) {
    if (totalSlots < n) warnings.push(`자리(${totalSlots})보다 학생(${n})이 많아 ${unassigned.length}명이 배정되지 않았어요.`);
    if (emptyRoles.length) {
      const names = unassigned.map((s) => s.name);
      const blocked = unassigned.every((s) => emptyRoles.every((r) => !allowed(P, s.id, r.id)));
      const why = blocked ? '남은 자리가 지난달 역할뿐이라' : '남은 자리가 지난달 역할이거나 같이 두지 않는 게 좋은 친구가 있는 역할뿐이라';
      warnings.push(`${names.join(', ')}${josa(names[names.length - 1], '는/은')} ${why} 배정되지 않았어요. 직접 조정해 주세요.`);
    }
  } else if (emptyRoles.length) {
    const list = emptyRoles.map((r) => `${r.name} ${freeSlots(P, state, r.id)}`).join(', ');
    warnings.push(`학생(${n})보다 자리(${totalSlots})가 많아 빈자리가 있어요: ${list}`);
  }

  for (const r of P.roles) {
    const members = state.members.get(r.id);
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        if (!P.conflicts.has(pairKey(members[i], members[j]))) continue;
        const a = P.studentIndex.get(members[i]).name;
        const b = P.studentIndex.get(members[j]).name;
        warnings.push(`${quote(r.name)}에 같이 두지 않는 게 좋은 친구(${a}, ${b})가 함께 배정됐어요. 확인해 주세요.`);
      }
    }
  }

  const noAppPlaced = P.students.filter((s) => !P.apps.has(s.id) && state.filled.has(s.id) && state.roleOf.has(s.id)).length;
  if (noAppPlaced) warnings.push(`지원서가 없는 학생 ${noAppPlaced}명은 지원자가 적은 역할의 빈자리에 배정했어요.`);
  return warnings;
}

function buildResult(P, state, { explanations: previous = {}, keep = new Set(), warnings: extra = [] } = {}) {
  const byOrder = (a, b) => P.studentIndex.get(a).order - P.studentIndex.get(b).order;
  const assignments = {};
  for (const r of P.roles) assignments[r.id] = [...state.members.get(r.id)].sort(byOrder);
  const unassigned = P.students.filter((s) => !state.roleOf.has(s.id)).map((s) => s.id);

  const explanations = {};
  const stats = { firstChoice: 0, secondChoice: 0, thirdChoice: 0, fallback: 0, noApplication: 0, unassigned: unassigned.length, students: P.students.length, slots: P.roles.reduce((a, r) => a + r.slots, 0) };
  for (const s of P.students) {
    const prev = previous?.[s.id];
    explanations[s.id] = keep.has(s.id) && typeof prev === 'string' && prev.trim() ? prev : explain(P, state, s.id);
    const balance = P.balancePriority.get(s.id);
    if (balance) explanations[s.id] += ` · ${balance.semesterLabel || '선택 학기'} 희망 외 배정 ${balance.nonWishCount || 0}회(최근 연속 ${balance.consecutiveNonWishCount || 0}회)를 희망 역할 배정에서 추가로 고려했어요. 정원·제외 역할은 지키고 친구 관계도 함께 고려해요.`;
    const app = P.apps.get(s.id);
    if (!app) stats.noApplication++;
    const roleId = state.roleOf.get(s.id);
    if (!roleId) continue;
    const choice = app?.valid.find((c) => c.roleId === roleId);
    if (!choice) stats.fallback++;
    else if (choice.index === 0) stats.firstChoice++;
    else if (choice.index === 1) stats.secondChoice++;
    else stats.thirdChoice++;
  }

  return { assignments, unassigned, explanations, warnings: [...extra, ...standardWarnings(P, state)], stats };
}

// ---------- 공개 API ----------

export function assignRoles(input = {}) {
  const P = buildProblem(input);
  const rng = mulberry32(input.seed ?? 1);
  const state = makeState(P);
  greedyApplications(P, state, rng);
  fillRemaining(P, state, rng);
  localSearch(P, state, rng);
  return buildResult(P, state);
}

export function repairAssignment(input = {}) {
  const P = buildProblem(input);
  const rng = mulberry32(input.seed ?? 1);
  const state = makeState(P);
  const nameOf = (sid) => P.studentIndex.get(sid)?.name ?? sid;
  const fixes = []; // 고친 내용. 빈자리를 채운 뒤에 문장으로 만듦 (옮겼는지, 자리가 없었는지 알 수 있도록)

  // 1) 입력을 걸러서 넣기: 없는 역할·없는 학생·중복·지난달 역할
  const original = new Map(); // sid → 입력에서 처음 나온(있고 허용되는 역할의) roleId
  const excludedSeen = new Set(); // 지난달 역할에만 적혀 있던 학생
  const unknownRoles = [];
  let unknownStudents = 0;
  for (const [roleId, list] of Object.entries(input.assignments && typeof input.assignments === 'object' ? input.assignments : {})) {
    if (!P.roleIndex.has(roleId)) { unknownRoles.push(roleId); continue; }
    for (const raw of Array.isArray(list) ? list : []) {
      const sid = String(raw ?? '');
      if (!P.studentIndex.has(sid)) { unknownStudents++; continue; }
      if (original.has(sid)) { fixes.push({ kind: 'duplicate', sid, first: original.get(sid) }); continue; }
      if (!allowed(P, sid, roleId)) { excludedSeen.add(sid); fixes.push({ kind: 'excluded', sid, roleId }); continue; }
      original.set(sid, roleId);
      place(state, sid, roleId);
    }
  }
  if (unknownRoles.length) fixes.push({ kind: 'unknownRoles', ids: unknownRoles });
  if (unknownStudents) fixes.push({ kind: 'unknownStudents', count: unknownStudents });

  // 2) 정원 초과: 그 역할을 높은 지망으로 쓴 학생 → 점수 높은 학생 → 먼저 적힌 학생 순으로 남김
  for (const r of P.roles) {
    const members = state.members.get(r.id);
    if (members.length <= r.slots) continue;
    const rank = (sid) => {
      const c = P.scores.get(sid)?.get(r.id);
      return [c ? c.index : CHOICE_POINTS.length, c ? -c.score : 0];
    };
    const ordered = members.map((sid, i) => ({ sid, i })).sort((a, b) => {
      const [ia, sa] = rank(a.sid);
      const [ib, sb] = rank(b.sid);
      return ia - ib || sa - sb || a.i - b.i;
    });
    const overflow = ordered.slice(r.slots).map((x) => x.sid);
    for (const sid of overflow) unplace(state, sid);
    fixes.push({ kind: 'overflow', roleId: r.id, sids: overflow });
  }

  // 3) 빠진 학생을 포함해 남은 학생을 assignRoles 와 같은 방법으로 채움
  const missing = P.students.filter((s) => !original.has(s.id) && !excludedSeen.has(s.id)).map((s) => s.id);
  if (missing.length) fixes.push({ kind: 'missing', sids: missing });
  greedyApplications(P, state, rng);
  fillRemaining(P, state, rng);

  // 4) 고친 내용을 문장으로
  const leftCount = (sids) => sids.filter((sid) => !state.roleOf.has(sid)).length;
  const warnings = fixes.map((f) => {
    switch (f.kind) {
      case 'duplicate':
        return `AI 결과에서 ${quote(nameOf(f.sid))}${josa(nameOf(f.sid), '가/이')} 두 역할에 들어 있어 첫 번째 역할(${quote(P.roleIndex.get(f.first).name)})만 남겼어요.`;
      case 'excluded': {
        const head = `AI 결과에서 ${quote(nameOf(f.sid))}${josa(nameOf(f.sid), '가/이')} 지난달 역할 ${quote(P.roleIndex.get(f.roleId).name)}에 다시 들어 있어`;
        return state.roleOf.has(f.sid) ? `${head} 다른 역할로 옮겼어요.` : `${head} 뺐어요. 남은 자리가 없어 배정되지 않았어요.`;
      }
      case 'unknownRoles':
        return `AI 결과에 없는 역할(${f.ids.map(quote).join(', ')})이 있어 뺐어요.`;
      case 'unknownStudents':
        return `AI 결과에 반 명단에 없는 학생 ${f.count}명이 있어 뺐어요.`;
      case 'overflow': {
        const head = `AI 결과에서 ${quote(P.roleIndex.get(f.roleId).name)} 정원 초과 ${f.sids.length}명`;
        const left = leftCount(f.sids);
        if (!left) return `${head}을 다른 역할로 옮겼어요.`;
        if (left === f.sids.length) return `${head}을 뺐어요. 남은 자리가 없어 배정되지 않았어요.`;
        return `${head} 중 ${f.sids.length - left}명은 다른 역할로 옮기고, 나머지 ${left}명은 남은 자리가 없어 배정되지 않았어요.`;
      }
      case 'missing': {
        const head = `AI 결과에 빠진 학생 ${f.sids.length}명(${f.sids.map(nameOf).join(', ')})`;
        const left = leftCount(f.sids);
        if (!left) return `${head}을 빈자리에 배정했어요.`;
        if (left === f.sids.length) return `${head}은 남은 자리가 없어 배정되지 않았어요.`;
        return `${head} 중 ${f.sids.length - left}명은 빈자리에 배정하고, 나머지 ${left}명은 남은 자리가 없어 배정되지 않았어요.`;
      }
      default:
        return '';
    }
  }).filter(Boolean);

  const keep = new Set(P.students.filter((s) => original.has(s.id) && state.roleOf.get(s.id) === original.get(s.id)).map((s) => s.id));
  return buildResult(P, state, { explanations: input.explanations || {}, keep, warnings });
}
