// 새 학기 첫 조사 (round.kind === 'intro'): 반이 바뀌고 처음 하는 조사.
// 학생은 "아는 친구"를 고르고, 예전에 좋은 사이였는지 · 그냥 아는 사이인지 · 안 좋은 사이였는지와 어떻게 아는 사이인지 표시합니다.
//
// 저장하는 곳
// - 예전에 좋은 사이 / 안 좋은 사이 → 평소처럼 round.relations (관계도 · 관심 점수 · 친한 무리 · 자리 배정이 그대로 동작해요)
// - 아는 친구 전체(그냥 아는 사이 포함)와 '어떻게 아는 사이' → round.known[보낸 학생][받은 학생] = { how: [], note?, updatedAt }
//   (note 는 '그냥 아는 사이'에 적은 한마디. 좋은/안 좋은 사이의 글은 relations 의 reason 에 있어요)

export const KNOW_HOW = [
  { id: 'lastyear', label: '작년에 같은 반', emoji: '🏫' },
  { id: 'before', label: '예전에 같은 반', emoji: '📚' },
  { id: 'academy', label: '학원 · 방과후', emoji: '✏️' },
  { id: 'neighbor', label: '같은 동네 · 놀이터', emoji: '🏘️' },
  { id: 'family', label: '가족끼리 알아요', emoji: '👨‍👩‍👧' },
  { id: 'kinder', label: '유치원 · 어린이집', emoji: '🧸' },
  { id: 'other', label: '그 밖에', emoji: '💭' },
];
const howIds = new Set(KNOW_HOW.map((h) => h.id));
const howLabels = new Map(KNOW_HOW.map((h) => [h.id, h.label]));

export const QUALITY_KO = { good: '예전에 좋은 사이', bad: '예전에 안 좋은 사이', know: '그냥 아는 사이' };

export const isIntro = (round) => round?.kind === 'intro';
/** 요청에서 받은 조사 종류 → 'intro' | 'regular' */
export const parseKind = (value) => (value === 'intro' ? 'intro' : 'regular');
export const isValidHow = (id) => howIds.has(id);
export const howLabel = (id) => howLabels.get(id) || id;

/** 보내온 '어떻게 아는 사이' 목록에서 아는 항목만, 중복 없이 (모양이 다르면 null) */
export function cleanHow(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.length > 30) return null;
  const out = [...new Set(input.map(String))];
  return out.every(isValidHow) ? out : null;
}

/** 회차의 '아는 사이' 표시를 한 줄씩: 명단에 있는 학생끼리만. quality 는 예전 사이(good · bad · know). */
export function listKnown(room, round) {
  const roster = new Set((room.students || []).map((s) => s.id));
  const out = [];
  for (const from of roster) {
    const mine = round?.known?.[from];
    if (!mine) continue;
    for (const [to, entry] of Object.entries(mine)) {
      if (!roster.has(to) || to === from || !entry) continue;
      const rel = round.relations?.[from]?.[to];
      const quality = rel?.type === 'good' || rel?.type === 'bad' ? rel.type : 'know';
      const how = Array.isArray(entry.how) ? entry.how.filter(isValidHow) : [];
      out.push({
        from, to, quality, how, howLabels: how.map(howLabel),
        note: quality === 'know' ? String(entry.note || '') : String(rel?.reason || ''),
        updatedAt: entry.updatedAt || null,
      });
    }
  }
  return out;
}

/**
 * 선생님 화면용 요약.
 * - students[sid]: { knows(내가 안다고 한 친구 수), knownBy(나를 안다고 한 친구 수), mutual(서로 안다고 한 수) }
 * - knowsNobody: 제출했는데 아는 친구가 없다고 한 학생
 * - knownByNobody: 제출한 친구 가운데 아무도 안다고 하지 않은 학생 (제출이 2명 이상일 때만 셉니다)
 */
export function knownSummary(room, round) {
  const students = room.students || [];
  const list = listKnown(room, round);
  const per = Object.fromEntries(students.map((s) => [s.id, { knows: 0, knownBy: 0, mutual: 0 }]));
  const keys = new Set(list.map((k) => `${k.from}>${k.to}`));
  const howCount = new Map();
  let mutualPairs = 0;
  for (const k of list) {
    per[k.from].knows++;
    per[k.to].knownBy++;
    if (keys.has(`${k.to}>${k.from}`)) { per[k.from].mutual++; if (k.from < k.to) mutualPairs++; }
    for (const id of k.how) howCount.set(id, (howCount.get(id) || 0) + 1);
  }
  const submitted = students.filter((s) => round?.submissions?.[s.id]);
  return {
    students: per,
    total: list.length,
    mutualPairs,
    submittedCount: submitted.length,
    knowsNobody: submitted.filter((s) => per[s.id].knows === 0).map((s) => s.id),
    knownByNobody: submitted.length >= 2 ? students.filter((s) => per[s.id].knownBy === 0).map((s) => s.id) : [],
    how: KNOW_HOW.map((h) => ({ id: h.id, label: h.label, count: howCount.get(h.id) || 0 })).filter((h) => h.count),
  };
}

/** 학생을 지우면 그 학생이 표시한 것과, 다른 학생이 그 학생을 안다고 한 표시를 함께 지웁니다. */
export function removeStudentFromKnown(round, studentId) {
  if (!round?.known) return;
  delete round.known[studentId];
  for (const targets of Object.values(round.known)) if (targets) delete targets[studentId];
}

/** 이 회차에 응답(제출 · 관계 · 아는 사이 표시)이 하나라도 있는지 — 있으면 조사 종류를 바꿀 수 없어요. */
export function roundHasResponses(round) {
  const any = (map) => Object.values(map || {}).some((v) => v && Object.keys(v).length);
  return Object.keys(round?.submissions || {}).length > 0 || any(round?.relations) || any(round?.known);
}
