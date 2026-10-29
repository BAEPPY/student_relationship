import { TRAITS, validateBody } from './roles.js';
import { isValidTag } from './reasons.js';

const SECTIONS = ['profile', 'application', 'relations'];          // 단계(step) 이름
const SECTION_KEYS = [...SECTIONS, 'closerFriends'];                // 초안으로 보관하는 내용 (친해진 친구는 관계 지도 단계의 일부)
const traitIds = new Set(TRAITS.map((trait) => trait.id));
const bad = (message) => Object.assign(new Error(message), { status: 400 });
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function text(value, limit) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > limit) throw bad(`임시 저장할 글은 ${limit}자 이하로 적어 주세요.`);
  return value; // 작성 중인 공백도 보존합니다. 최종 제출에서만 정리합니다.
}

function traits(value, limit) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > limit || value.some((id) => !traitIds.has(id))) throw bad('임시 저장할 성향 항목이 올바르지 않아요.');
  return [...new Set(value)];
}

/** 최종 제출 조건(최소 친구 수·이유 길이·역할 선택)을 적용하지 않는 비공개 초안입니다. */
export function validateDraft(input, room, studentId) {
  if (!object(input) || typeof input.roundId !== 'string' || !input.roundId || input.roundId.length > 128) throw bad('임시 저장할 회차를 확인해 주세요.');
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw bad('임시 저장 버전을 확인해 주세요.');
  const mutationId = input.mutationId ?? null;
  if (mutationId !== null && (typeof mutationId !== 'string' || !mutationId || mutationId.length > 128)) throw bad('임시 저장 요청 번호가 올바르지 않아요.');
  const step = input.step ?? null;
  if (step !== null && !SECTIONS.includes(step)) throw bad('임시 저장할 단계를 확인해 주세요.');
  if (!object(input.sections) || Object.keys(input.sections).some((key) => !SECTION_KEYS.includes(key))) throw bad('임시 저장할 내용이 올바르지 않아요.');
  const sections = {};
  const classmates = new Set(room.students.filter((student) => student.id !== studentId).map((student) => student.id));
  for (const [key, value] of Object.entries(input.sections)) {
    if (!object(value)) throw bad('임시 저장할 내용이 올바르지 않아요.');
    if (key === 'closerFriends') {
      const rawIds = value.ids ?? [];
      if (!Array.isArray(rawIds) || rawIds.length > 1000) throw bad('임시 저장할 친해진 친구 목록이 올바르지 않아요.');
      const ids = [...new Set(rawIds)];   // 개수 검사는 중복을 뺀 뒤에
      if (ids.length > classmates.size || ids.some((id) => !classmates.has(id))) throw bad('임시 저장할 친해진 친구 목록에 우리 반 친구가 아닌 학생이 포함되어 있어요.');
      sections.closerFriends = { ids, text: text(value.text, 300), review: text(value.review, 300) };
    } else if (key === 'profile') {
      sections.profile = {
        traits: traits(value.traits, TRAITS.length),
        partnerTraits: traits(value.partnerTraits, 3),
        partnerText: text(value.partnerText, 300),
        body: validateBody(value.body),
      };
    } else if (key === 'application') {
      const choices = value.choices ?? [];
      if (!Array.isArray(choices) || choices.length > 3 || choices.some((choice) => !object(choice))) throw bad('임시 지원서는 3지망까지만 저장할 수 있어요.');
      sections.application = { choices: choices.map((choice) => ({
        // 역할이 편집·삭제되어도 작성 중인 글은 보관하고 최종 제출에서 검증합니다.
        roleId: text(choice.roleId, 100),
        reason: text(choice.reason, 600),
        helpClass: text(choice.helpClass, 600),
        helpSelf: text(choice.helpSelf, 600),
      })) };
    } else {
      const relations = {};
      if (Object.keys(value).length > classmates.size) throw bad('임시 관계에 우리 반 친구가 아닌 학생이 포함되어 있어요.');
      for (const [target, relation] of Object.entries(value)) {
        if (!classmates.has(target) || !object(relation)) throw bad('임시 관계에 우리 반 친구가 아닌 학생이 포함되어 있어요.');
        const type = relation.type ?? null;
        if (type !== null && type !== 'good' && type !== 'bad') throw bad('임시 관계 종류가 올바르지 않아요.');
        const tags = relation.tags ?? [];
        if (!Array.isArray(tags) || tags.length > 30 || tags.some((tag) => !isValidTag(type, tag))) throw bad('임시 관계의 이유 항목이 올바르지 않아요.');
        relations[target] = { type, tags: [...new Set(tags)], reason: text(relation.reason, 300) };
      }
      sections.relations = relations;
    }
  }
  return { step, sections, mutationId };
}

/** 이 뷰는 학생 본인의 응답에서만 사용합니다. 교사·분석·내보내기에 포함하지 않습니다. */
export function studentDraftView(round, studentId) {
  return structuredClone({ revision: 0, updatedAt: null, step: null, sections: {}, mutationId: null, ...round.studentDrafts?.[studentId] });
}

export function saveStudentDraft(round, studentId, expectedRevision, draft) {
  const current = studentDraftView(round, studentId);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw bad('임시 저장 버전을 확인해 주세요.');
  if (expectedRevision !== current.revision) {
    throw Object.assign(new Error('다른 화면에서 임시 저장 내용이 바뀌었어요. 현재 내용을 보관한 뒤 새로고침해 주세요.'), { status: 409, code: 'DRAFT_CONFLICT', draft: current });
  }
  round.studentDrafts ||= {};
  round.studentDrafts[studentId] = { ...draft(), revision: current.revision + 1, updatedAt: new Date().toISOString() };
}

/**
 * 비어 있어도 버전을 올려 최종 제출·초기화보다 늦게 도착한 초안이 되살아나지 않게 합니다.
 * section 은 하나 또는 여러 개(배열)를 받고, 한 번에 지워 버전은 한 번만 올립니다.
 */
export function clearStudentDraft(round, studentId, section = null) {
  const draft = studentDraftView(round, studentId);
  if (section) {
    for (const key of [].concat(section)) {
      delete draft.sections[key];
      if (draft.step === key) draft.step = null;
    }
  } else {
    draft.sections = {};
    draft.step = null;
  }
  if (!Object.keys(draft.sections).length) draft.updatedAt = null;
  draft.mutationId = null;
  draft.revision++;
  round.studentDrafts ||= {};
  round.studentDrafts[studentId] = draft;
}

export function removeStudentFromDrafts(round, studentId) {
  delete round.studentDrafts?.[studentId];
  for (const draft of Object.values(round.studentDrafts || {})) {
    let changed = false;
    if (Object.hasOwn(draft.sections.relations || {}, studentId)) {
      delete draft.sections.relations[studentId];
      changed = true;
    }
    const closer = draft.sections.closerFriends;
    if (Array.isArray(closer?.ids) && closer.ids.includes(studentId)) {
      closer.ids = closer.ids.filter((id) => id !== studentId);
      changed = true;
    }
    if (changed) {
      draft.mutationId = null;
      draft.revision++;
    }
  }
}
