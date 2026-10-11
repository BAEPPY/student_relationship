// 확정한 배정과 당시 지망만으로 학기 균형을 계산합니다. 초안·현재 지원서로 과거를 추정하지 않습니다.
const owns = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);
const monthOf = (text) => {
  const m = /(\d{4})\s*년\s*(\d{1,2})\s*월/.exec(String(text || ''));
  return m && +m[2] >= 1 && +m[2] <= 12 ? +m[1] * 12 + +m[2] - 1 : null;
};
const dateMonth = (text) => {
  // 회차 startedAt은 UTC 문자열이지만 학기 경계는 한국 달력입니다.
  const date = new Date(new Date(text).getTime() + 9 * 60 * 60 * 1000);
  return Number.isFinite(date.getTime()) ? date.getUTCFullYear() * 12 + date.getUTCMonth() : null;
};
function semesterAt(month) {
  const year = Math.floor(month / 12), m = month % 12;
  return `${m < 2 ? year - 1 : year}-${m >= 2 && m <= 7 ? 1 : 2}`;
}
function semesterInfo(id) {
  const match = /^(\d{4})-([12])$/.exec(String(id || ''));
  if (!match) { const error = new Error('학기는 YYYY-1 또는 YYYY-2 형식으로 골라 주세요.'); error.status = 400; throw error; }
  const year = +match[1], term = +match[2];
  const startMonth = year * 12 + (term === 1 ? 2 : 8);
  return { id, label: `${year}학년도 ${term}학기`, startMonth, endMonth: startMonth + 5, range: term === 1 ? `${year}년 3~8월` : `${year}년 9월~${year + 1}년 2월` };
}

/** 공개 시 역할 이력과 공개된 배정 양쪽의 balanceSnapshot에 보관합니다. 이유 글·학생 이름은 복제하지 않습니다. */
export function captureRoleBalanceSnapshot(room, round, now = new Date().toISOString(), previousAssignment = null) {
  const choicesByStudent = Object.create(null);
  const previous = (room.roleHistory || []).find((record) => record.roundId === round.id || record.month === round.name)
    || (previousAssignment?.published ? previousAssignment : null);
  const roleFor = (assignments, sid) => Object.keys(assignments || {}).find((id) => Array.isArray(assignments[id]) && assignments[id].includes(sid));
  for (const student of room.students || []) {
    const oldRole = roleFor(previous?.assignments, student.id);
    if (oldRole && oldRole === roleFor(round.roleAssignment?.assignments, student.id)) {
      // 같은 배정을 다시 공개해도 나중에 고친 지원서로 당시의 희망 여부를 바꾸지 않습니다.
      const oldChoices = previous.balanceSnapshot?.choicesByStudent?.[student.id];
      if (Array.isArray(oldChoices)) choicesByStudent[student.id] = [...oldChoices];
      continue;
    }
    const choices = round.applications?.[student.id]?.choices;
    if (!Array.isArray(choices) || !choices.some((choice) => typeof choice?.roleId === 'string' && choice.roleId)) continue;
    choicesByStudent[student.id] = choices.slice(0, 3).map((choice) => String(choice?.roleId || ''));
  }
  return { version: 1, capturedAt: now, choicesByStudent, roleNames: Object.fromEntries((room.roles || []).map((role) => [role.id, role.name])) };
}

/** 선택 회차까지의 확인된 기록. 같은 달/회차의 공개 배정과 이력은 한 번만 셉니다. */
export function summarizeRoleBalance(room, round, { semester, beforeRound = false, now = new Date().toISOString() } = {}) {
  const rounds = room.rounds || [];
  const selectedIndex = rounds.findIndex((r) => r.id === round.id);
  const selectedMonth = monthOf(round.name) ?? dateMonth(round.startedAt || round.createdAt) ?? dateMonth(now);
  const selectedSemester = semesterInfo(semester || semesterAt(selectedMonth));
  const roundIndex = new Map(rounds.map((r, index) => [r.id, index]));
  const roundMap = new Map(rounds.map((r) => [r.id, r]));
  const raw = [
    ...rounds.filter((r) => r.roleAssignment?.published).map((r) => ({ ...r.roleAssignment, roundId: r.id, month: r.name, source: 'published', recordKind: 'round', stamp: r.roleAssignment.updatedAt || r.roleAssignment.publishedAt || r.roleAssignment.createdAt || '' })),
    ...(room.roleHistory || []).map((h) => ({ ...h, recordKind: 'history', stamp: h.updatedAt || '' })),
  ];
  const schoolYear = semesterAt(selectedMonth).slice(0, 4);
  const eligible = [], semesterIds = new Set([`${schoolYear}-1`, `${schoolYear}-2`, selectedSemester.id]);
  let undatedRecordCount = 0;
  for (const record of raw) {
    const linked = roundMap.get(record.roundId);
    const month = monthOf(record.month) ?? (linked ? dateMonth(linked.startedAt || linked.createdAt) : null);
    if (month === null) { undatedRecordCount++; continue; }
    if (month > selectedMonth || (selectedIndex >= 0 && roundIndex.has(record.roundId) && roundIndex.get(record.roundId) > selectedIndex)) continue;
    if (beforeRound && (record.roundId === round.id || month >= selectedMonth)) continue;
    semesterIds.add(semesterAt(month));
    eligible.push({ ...record, monthIndex: month });
  }
  // 같은 달의 재공개/가져오기 중 가장 최근 기록. 동시각이면 공개 이력을 우선합니다.
  eligible.sort((a, b) => String(b.stamp).localeCompare(String(a.stamp)) || Number(b.recordKind === 'history') - Number(a.recordKind === 'history'));
  const seenMonths = new Set(), seenRounds = new Set(), records = [];
  for (const record of eligible) {
    if (seenMonths.has(record.monthIndex) || (record.roundId && seenRounds.has(record.roundId))) continue;
    seenMonths.add(record.monthIndex);
    if (record.roundId) seenRounds.add(record.roundId);
    if (record.monthIndex >= selectedSemester.startMonth && record.monthIndex <= selectedSemester.endMonth) records.push(record);
  }
  records.sort((a, b) => a.monthIndex - b.monthIndex);
  const students = (room.students || []).map((student) => {
    let assignmentCount = 0, firstChoiceCount = 0, anyWishCount = 0, knownApplicationCount = 0, unknownDataCount = 0, consecutiveNonWishCount = 0;
    const roleCounts = Object.create(null), roleNames = Object.create(null);
    for (const record of records) {
      const roleId = Object.keys(record.assignments || {}).find((id) => Array.isArray(record.assignments[id]) && record.assignments[id].includes(student.id));
      if (!roleId) continue;
      assignmentCount++;
      roleCounts[roleId] = (roleCounts[roleId] || 0) + 1;
      roleNames[roleId] = record.balanceSnapshot?.roleNames?.[roleId] || (room.roles || []).find((role) => role.id === roleId)?.name || '삭제된 역할';
      const snapshot = record.balanceSnapshot;
      const choices = snapshot?.version === 1 && owns(snapshot.choicesByStudent, student.id) ? snapshot.choicesByStudent[student.id] : null;
      if (!Array.isArray(choices) || !choices.some((id) => typeof id === 'string' && id)) {
        unknownDataCount++;
        consecutiveNonWishCount = 0; // 알 수 없는 기간을 건너뛰어 연속 실패로 부풀리지 않습니다.
        continue;
      }
      knownApplicationCount++;
      if (choices[0] === roleId) firstChoiceCount++;
      if (choices.includes(roleId)) { anyWishCount++; consecutiveNonWishCount = 0; }
      else consecutiveNonWishCount++;
    }
    return { id: student.id, name: student.name, assignmentCount, firstChoiceCount, anyWishCount, knownApplicationCount, unknownDataCount, consecutiveNonWishCount, distinctRoleCount: Object.keys(roleCounts).length, roleCounts, roleNames };
  });
  return {
    semester: selectedSemester,
    semesters: [...semesterIds].sort().reverse().map(semesterInfo),
    throughRound: { id: round.id, name: round.name }, beforeRound,
    recordCount: records.length, undatedRecordCount, students,
    notice: '확정·공개한 배정과 저장한 과거 기록만 집계해요. 당시 지원서가 없는 기록은 자료 없음이며 희망 실패로 세지 않아요. 같은 달의 기록은 최근 것 하나만 세요.',
  };
}

/** 최대 20점: 지망 간 기본점수 차이(최소 30), 갈등 감점(80)보다 작은 보조 점수입니다. */
export function roleBalancePriorities(summary) {
  const out = Object.create(null);
  for (const student of summary.students || []) {
    const nonWishCount = Math.max(0, student.knownApplicationCount - student.anyWishCount);
    const bonus = Math.min(20, nonWishCount * 3 + student.consecutiveNonWishCount * 4);
    if (bonus > 0) out[student.id] = { bonus, nonWishCount, consecutiveNonWishCount: student.consecutiveNonWishCount, semesterLabel: summary.semester.label };
  }
  return out;
}
