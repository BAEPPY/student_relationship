// 학생이 관계의 이유로 고를 수 있는 객관적 선택지 목록.
// weight 는 갈등 분석에서 사용하는 심각도 가중치입니다.

export const GOOD_REASONS = [
  { id: 'fun', label: '같이 놀면 재미있어요' },
  { id: 'kind', label: '친절하고 배려해 줘요' },
  { id: 'help', label: '어려울 때 도와줘요' },
  { id: 'talk', label: '이야기가 잘 통해요' },
  { id: 'hobby', label: '좋아하는 것이 비슷해요' },
  { id: 'trust', label: '믿을 수 있어요' },
  { id: 'teamwork', label: '같이 활동하면 잘 돼요' },
];

export const BAD_REASONS = [
  { id: 'tease', label: '놀리거나 험담해요', weight: 10 },
  { id: 'hurt', label: '때리거나 괴롭혀요', weight: 15 },
  { id: 'exclude', label: '무시하거나 따돌려요', weight: 12 },
  { id: 'rude', label: '말을 함부로 해요', weight: 6 },
  { id: 'fight', label: '싸운 적이 있어요', weight: 10 },
  { id: 'promise', label: '약속을 안 지켜요', weight: 4 },
  { id: 'stuff', label: '내 물건을 함부로 해요', weight: 4 },
  { id: 'mismatch', label: '성격이 잘 안 맞아요', weight: 3 },
];

export const REASON_CATALOG = { good: GOOD_REASONS, bad: BAD_REASONS };

const goodIds = new Set(GOOD_REASONS.map((r) => r.id));
const badIds = new Set(BAD_REASONS.map((r) => r.id));
const badWeight = new Map(BAD_REASONS.map((r) => [r.id, r.weight]));

export function isValidTag(type, id) {
  return type === 'good' ? goodIds.has(id) : type === 'bad' ? badIds.has(id) : false;
}

export function tagWeight(id) {
  return badWeight.get(id) || 0;
}

export function tagLabel(type, id) {
  const list = type === 'good' ? GOOD_REASONS : BAD_REASONS;
  return list.find((r) => r.id === id)?.label || id;
}
