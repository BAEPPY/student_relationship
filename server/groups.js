import { newId } from './tokens.js';

export const GROUP_LIMITS = { minSize: 2, maxSize: 8, activities: 200, title: 80, groupName: 30, students: 80, apartPairs: 3160 };
const clone = (value) => structuredClone(value);
const keyOf = (a, b) => [a, b].sort().join('|');
const error = (message, status = 400) => Object.assign(new Error(message), { status });
const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

export function teacherGroupApartPairs(room) {
  const known = new Set(room.students.map(({ id }) => id));
  const pairs = new Map();
  for (const rule of room.teacherNotes?.rules || []) {
    if (rule.type !== 'apart' || !known.has(rule.a) || !known.has(rule.b) || rule.a === rule.b) continue;
    const [a, b] = [rule.a, rule.b].sort();
    pairs.set(keyOf(a, b), { a, b });
  }
  return [...pairs.values()];
}

export function groupCapacities(count, size) {
  if (count < 2) throw error('참여 학생이 2명 이상이어야 모둠을 만들 수 있어요.');
  const groupCount = Math.ceil(count / size);
  return Array.from({ length: groupCount }, (_, index) => Math.floor(count / groupCount) + (index < count % groupCount ? 1 : 0));
}

/** Only explicit teacher constraints enter the activity, never student answers or access tokens. */
export function normalizeGroupOptions(room, body = {}) {
  const title = clean(body.title);
  if (!title || title.length > GROUP_LIMITS.title) throw error(`활동 이름을 1~${GROUP_LIMITS.title}자로 적어 주세요.`);
  const activityDate = String(body.activityDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(activityDate) || !Number.isFinite(Date.parse(`${activityDate}T00:00:00.000Z`)) || new Date(`${activityDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== activityDate) throw error('활동 날짜를 올바르게 선택해 주세요.');
  const groupSize = Number(body.groupSize);
  if (!Number.isInteger(groupSize) || groupSize < GROUP_LIMITS.minSize || groupSize > GROUP_LIMITS.maxSize) throw error('모둠 최대 인원은 2~8명으로 선택해 주세요.');
  if (typeof body.roundId !== 'string' || !body.roundId) throw error('활동의 기준 회차를 선택해 주세요.');
  const known = new Set(room.students.map(({ id }) => id));
  if (known.size > GROUP_LIMITS.students) throw error('모둠 편성은 학생 80명까지 지원해요.');
  if (!Array.isArray(body.absentIds) || body.absentIds.length > known.size) throw error('빠지는 학생 목록이 올바르지 않아요.');
  const absentIds = [...new Set(body.absentIds)];
  if (absentIds.length !== body.absentIds.length || absentIds.some((id) => !known.has(id))) throw error('빠지는 학생 목록에 중복되거나 없는 학생이 있어요. 최신 명단을 확인해 주세요.');
  if (!Array.isArray(body.apartPairs) || body.apartPairs.length > GROUP_LIMITS.apartPairs) throw error('분리할 학생 목록이 올바르지 않아요.');
  const apart = new Map(teacherGroupApartPairs(room).map((pair) => [keyOf(pair.a, pair.b), pair]));
  for (const pair of body.apartPairs) {
    if (!pair || !known.has(pair.a) || !known.has(pair.b) || pair.a === pair.b) throw error('분리할 학생 두 명을 서로 다르게 선택해 주세요.');
    const [a, b] = [pair.a, pair.b].sort();
    apart.set(keyOf(a, b), { a, b });
  }
  const participants = room.students.filter(({ id }) => !absentIds.includes(id)).map(({ id }) => id);
  groupCapacities(participants.length, groupSize);
  return { title, activityDate, roundId: body.roundId, groupSize, avoidRepeats: body.avoidRepeats === true, absentIds, apartPairs: [...apart.values()] };
}

export function validateGroupActivity(room, body) {
  const options = normalizeGroupOptions(room, body);
  const present = new Set(room.students.filter(({ id }) => !options.absentIds.includes(id)).map(({ id }) => id));
  const capacities = groupCapacities(present.size, options.groupSize);
  if (!Array.isArray(body.groups) || body.groups.length !== capacities.length) throw error(`현재 인원에는 ${capacities.length}개 모둠이 필요해요. 조건에 맞게 다시 편성해 주세요.`);
  const seen = new Set();
  const groupIds = new Set();
  const apart = new Set(options.apartPairs.map(({ a, b }) => keyOf(a, b)));
  const groups = body.groups.map((group) => {
    if (!group || typeof group.id !== 'string' || !/^[A-Za-z0-9_-]{1,50}$/.test(group.id) || groupIds.has(group.id)) throw error('모둠 식별자가 중복되거나 올바르지 않아요.');
    groupIds.add(group.id);
    const name = clean(group.name);
    if (!name || name.length > GROUP_LIMITS.groupName) throw error(`모둠 이름은 1~${GROUP_LIMITS.groupName}자로 적어 주세요.`);
    if (!Array.isArray(group.studentIds) || group.studentIds.length > options.groupSize) throw error('모둠의 최대 인원을 넘었어요.');
    const members = [];
    for (const id of group.studentIds) {
      if (!present.has(id)) throw error('빠지는 학생 또는 명단에 없는 학생이 모둠에 있어요. 최신 명단을 확인해 주세요.');
      if (seen.has(id)) throw error('한 학생이 두 번 배정되어 있어요.');
      if (members.some((other) => apart.has(keyOf(id, other)))) throw error('반드시 분리할 학생이 같은 모둠에 있어요. 두 학생을 다른 모둠으로 옮겨 주세요.');
      members.push(id);
      seen.add(id);
    }
    return { id: group.id, name, studentIds: members };
  });
  if (seen.size !== present.size) throw error('아직 배정되지 않은 참여 학생이 있어요. 모두 배정한 뒤 저장해 주세요.');
  if (groups.map((group) => group.studentIds.length).sort((a, b) => b - a).some((size, i) => size !== capacities[i])) throw error('모둠별 인원 차이는 1명 이내여야 해요. 큰 모둠에서 작은 모둠으로 옮기거나 두 학생을 맞바꿔 주세요.');
  return { ...options, groups };
}

function random(seed) {
  let value = (Number(seed) >>> 0) || 1;
  return () => {
    value += 0x6D2B79F5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function repeatCounts(room, options, excludeId) {
  const counts = new Map();
  for (const activity of room.groupActivities || []) {
    if (activity.id === excludeId || activity.activityDate > options.activityDate) continue;
    for (const group of activity.groups || []) {
      const ids = group.studentIds || [];
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        const key = keyOf(ids[i], ids[j]);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
  }
  return counts;
}

export function groupMetrics(room, activity, excludeId = null) {
  const counts = repeatCounts(room, activity, excludeId);
  let repeatedPairs = 0;
  let repeatWeight = 0;
  for (const group of activity.groups) for (let i = 0; i < group.studentIds.length; i++) for (let j = i + 1; j < group.studentIds.length; j++) {
    const times = counts.get(keyOf(group.studentIds[i], group.studentIds[j])) || 0;
    if (times) repeatedPairs++;
    repeatWeight += times;
  }
  return { participants: activity.groups.reduce((sum, group) => sum + group.studentIds.length, 0), groups: activity.groups.length, repeatedPairs, repeatWeight };
}

/** Bounded seeded search: separation and balance are hard constraints; repetition is a soft preference. */
export function previewGroups(room, body, { seed = body?.seed || 1, excludeId = null } = {}) {
  const options = normalizeGroupOptions(room, body);
  const ids = room.students.filter(({ id }) => !options.absentIds.includes(id)).map(({ id }) => id);
  const capacities = groupCapacities(ids.length, options.groupSize);
  const active = new Set(ids);
  const neighbors = new Map(ids.map((id) => [id, new Set()]));
  for (const { a, b } of options.apartPairs) if (active.has(a) && active.has(b)) { neighbors.get(a).add(b); neighbors.get(b).add(a); }
  const repeated = options.avoidRepeats ? repeatCounts(room, options, excludeId) : new Map();
  const rng = random(seed);
  let best = null;
  let bestCost = Infinity;
  let searched = 0;
  const cost = (id, members) => members.reduce((sum, other) => sum + (repeated.get(keyOf(id, other)) || 0), 0);
  const valid = (id, members) => members.every((other) => !neighbors.get(id).has(other));
  for (let attempt = 0; attempt < 24; attempt++) {
    const order = ids.map((id) => ({ id, rank: rng() })).sort((a, b) => neighbors.get(b.id).size - neighbors.get(a.id).size || a.rank - b.rank).map(({ id }) => id);
    const members = capacities.map(() => []);
    let nodes = 0;
    function search(index) {
      if (index === order.length) return true;
      if (++nodes > 5000) return false;
      const id = order[index];
      const choices = [];
      const emptySizes = new Set();
      for (let g = 0; g < members.length; g++) {
        if (members[g].length >= capacities[g] || !valid(id, members[g])) continue;
        if (!members[g].length) {
          if (emptySizes.has(capacities[g])) continue;
          emptySizes.add(capacities[g]);
        }
        choices.push({ g, cost: cost(id, members[g]), fill: members[g].length / capacities[g], rank: rng() });
      }
      choices.sort((a, b) => a.cost - b.cost || a.fill - b.fill || a.rank - b.rank);
      for (const { g } of choices) {
        members[g].push(id);
        if (search(index + 1)) return true;
        members[g].pop();
        if (nodes > 5000) break;
      }
      return false;
    }
    const found = search(0);
    searched += nodes;
    if (!found) continue;
    let total = members.reduce((sum, group) => sum + group.reduce((value, id, i) => value + cost(id, group.slice(i + 1)), 0), 0);
    // Improve repeat counts with swaps; fixed capacities and all separation constraints remain intact.
    for (let pass = 0; options.avoidRepeats && total > 0 && pass < 6; pass++) {
      let change = null;
      for (let a = 0; a < members.length; a++) for (let b = a + 1; b < members.length; b++) {
        for (let i = 0; i < members[a].length; i++) for (let j = 0; j < members[b].length; j++) {
          const x = members[a][i], y = members[b][j];
          const left = members[a].filter((id) => id !== x), right = members[b].filter((id) => id !== y);
          if (!valid(x, right) || !valid(y, left)) continue;
          const delta = cost(y, left) + cost(x, right) - cost(x, left) - cost(y, right);
          if (delta < (change?.delta || 0)) change = { a, b, i, j, delta };
        }
      }
      if (!change) break;
      const { a, b, i, j, delta } = change;
      [members[a][i], members[b][j]] = [members[b][j], members[a][i]];
      total += delta;
    }
    if (total < bestCost) { best = clone(members); bestCost = total; }
    if (bestCost === 0) break;
  }
  if (!best) return { candidate: null, metrics: null, warnings: ['조건을 모두 지키는 편성안을 찾지 못했어요. 분리 조건이나 모둠 최대 인원을 확인해 주세요. 제한된 탐색 결과이므로 가능한 안이 전혀 없다는 뜻은 아니에요.'], searched };
  const candidate = validateGroupActivity(room, { ...options, groups: best.map((studentIds, index) => ({ id: `g${index + 1}`, name: `${index + 1}모둠`, studentIds })) });
  const metrics = groupMetrics(room, candidate, excludeId);
  const warnings = [];
  if (capacities.includes(1)) warnings.push('참여 인원이 홀수이거나 적어 1명인 모둠이 생겼어요. 최대 인원을 늘려 모두 함께 활동하도록 바꿀 수 있어요.');
  if (options.avoidRepeats && metrics.repeatedPairs) warnings.push(`이전 활동에서 함께했던 ${metrics.repeatedPairs}쌍이 포함돼요. 반복은 가능한 범위에서 줄이며, 분리 조건은 모두 지켜요.`);
  return { candidate, metrics, warnings, searched };
}

export function createGroupActivity(room, body, { now = new Date().toISOString(), id = newId() } = {}) {
  const mutationId = body.clientMutationId;
  if (mutationId !== undefined && (typeof mutationId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(mutationId))) throw error('저장 요청 정보가 올바르지 않아요.');
  const fields = validateGroupActivity(room, body);
  const existing = mutationId && (room.groupActivities || []).find((activity) => activity.clientMutationId === mutationId);
  if (existing) {
    if (Object.entries(fields).every(([key, value]) => JSON.stringify(value) === JSON.stringify(existing[key]))) return clone(existing);
    throw error('앞선 저장 요청이 이미 처리됐지만 지금 편집안과 내용이 달라요. 앞서 저장한 활동을 확인하거나 별도 새 활동으로 저장해 주세요.', 409);
  }
  if ((room.groupActivities || []).length >= GROUP_LIMITS.activities) throw error(`활동은 ${GROUP_LIMITS.activities}개까지 보관할 수 있어요. 필요 없는 활동을 삭제한 뒤 저장해 주세요.`, 409);
  const activity = { ...fields, id, createdAt: now, updatedAt: now, version: 1, ...(mutationId ? { clientMutationId: mutationId } : {}) };
  room.groupActivities = [activity, ...(room.groupActivities || [])];
  return clone(activity);
}

export function updateGroupActivity(room, id, body, now = new Date().toISOString()) {
  const index = (room.groupActivities || []).findIndex((activity) => activity.id === id);
  if (index < 0) throw error('활동을 찾을 수 없어요. 삭제되었는지 확인해 주세요.', 404);
  const old = room.groupActivities[index];
  if (!Number.isInteger(body.expectedVersion) || body.expectedVersion !== old.version) throw error('다른 화면에서 이 활동이 변경됐어요. 편집안은 그대로 두고 최신 기록을 확인해 주세요.', 409);
  const activity = { ...validateGroupActivity(room, body), id: old.id, createdAt: old.createdAt, updatedAt: now, version: old.version + 1, ...(old.clientMutationId ? { clientMutationId: old.clientMutationId } : {}) };
  room.groupActivities[index] = activity;
  return clone(activity);
}

export function deleteGroupActivity(room, id, expectedVersion) {
  const activity = (room.groupActivities || []).find((item) => item.id === id);
  if (!activity) throw error('활동을 찾을 수 없어요.', 404);
  if (!Number.isInteger(expectedVersion) || expectedVersion !== activity.version) throw error('다른 화면에서 이 활동이 변경됐어요. 최신 기록을 확인한 뒤 삭제해 주세요.', 409);
  room.groupActivities = room.groupActivities.filter((item) => item.id !== id);
}

/** Scrub all stored copies and user-written labels; a privacy edit invalidates stale editors. */
export function removeStudentGroups(room, student, now = new Date().toISOString()) {
  const sid = typeof student === 'string' ? student : student.id;
  const name = typeof student === 'string' ? '' : student.name;
  let changed = 0;
  for (const activity of room.groupActivities || []) {
    const before = JSON.stringify(activity);
    activity.absentIds = (activity.absentIds || []).filter((id) => id !== sid);
    activity.apartPairs = (activity.apartPairs || []).filter((pair) => pair.a !== sid && pair.b !== sid);
    const scrub = (value) => name ? String(value || '').split(name).join('(삭제된 학생)') : value;
    activity.title = scrub(activity.title);
    for (const group of activity.groups || []) { group.studentIds = group.studentIds.filter((id) => id !== sid); group.name = scrub(group.name); }
    if (JSON.stringify(activity) !== before) { activity.version = (activity.version || 0) + 1; activity.updatedAt = now; changed++; }
  }
  return changed;
}

/** Keep free-text labels aligned with a renamed student so later deletion can scrub their name. */
export function renameStudentGroups(room, student, oldName, newName, now = new Date().toISOString()) {
  if (!student?.id || !oldName || oldName === newName) return 0;
  const rename = (value, max) => String(value || '').split(oldName).join(newName).slice(0, max);
  let changed = 0;
  for (const activity of room.groupActivities || []) {
    const before = JSON.stringify(activity);
    activity.title = rename(activity.title, GROUP_LIMITS.title);
    for (const group of activity.groups || []) group.name = rename(group.name, GROUP_LIMITS.groupName);
    if (JSON.stringify(activity) !== before) { activity.version = (activity.version || 0) + 1; activity.updatedAt = now; changed++; }
  }
  return changed;
}

/** Returns removed count. Activity edits use the same rolling retention cutoff as other teacher records. */
export function pruneGroupActivities(room, cutoff) {
  const before = room.groupActivities || [];
  const keep = before.filter((activity) => (activity.updatedAt || activity.createdAt || `${activity.activityDate}T00:00:00.000Z`) >= cutoff);
  if (keep.length !== before.length) room.groupActivities = keep;
  return before.length - keep.length;
}
