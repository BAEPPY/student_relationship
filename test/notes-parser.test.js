import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTeacherNotes, findStudents } from '../public/js/notes-parser.js';

const students = [
  { id: 'a', name: '김하늘' }, { id: 'b', name: '이도윤' }, { id: 'c', name: '박서연' },
  { id: 'd', name: '최지우' }, { id: 'e', name: '정민준' }, { id: 'f', name: '박하늘' },
];
const rules = (r) => r.items.filter((i) => i.kind === 'rule').map((i) => `${i.type}:${[i.a, i.b].sort().join('')}`).sort();
const fronts = (r) => r.items.filter((i) => i.kind === 'front').map((i) => i.sid).sort();
const memos = (r) => r.items.filter((i) => i.kind === 'memo').map((i) => `${i.sid}:${i.memo}`);

test('앞자리 필요 + 메모', () => {
  const r = parseTeacherNotes('김하늘은 시력이 나빠서 앞자리에 앉아야 함', students);
  assert.deepEqual(fronts(r), ['a']);
  assert.deepEqual(memos(r), ['a:시력이 나빠서 앞자리에 앉아야 함']);
  assert.deepEqual(rules(r), []);
});

test('두 학생 떨어뜨리기', () => {
  const r = parseTeacherNotes('이도윤과 박서연은 자주 싸움.', students);
  assert.deepEqual(rules(r), ['apart:bc']);
  assert.deepEqual(memos(r), []);
});

test('가까이 앉히기 (도우미)', () => {
  const r = parseTeacherNotes('최지우, 정민준 짝으로 앉히면 좋겠음 (최지우가 잘 도와줌)', students);
  assert.deepEqual(rules(r), ['together:de']);
});

test('쉼표로 나뉜 서로 다른 학생 메모', () => {
  const r = parseTeacherNotes('김하늘 시력 나쁨, 이도윤 산만함', students);
  assert.deepEqual(fronts(r), ['a']);
  assert.deepEqual(memos(r).sort(), ['a:시력 나쁨', 'b:산만함']);
  assert.deepEqual(rules(r), []);
});

test('성 없이 이름만 써도 찾는다 (유일할 때만)', () => {
  const r = parseTeacherNotes('도윤이랑 서연이가 요즘 자꾸 부딪힘', students);
  assert.deepEqual(rules(r), ['apart:bc']);
  // 하늘: 김하늘/박하늘 둘이라 이름만으로는 못 찾음
  const r2 = parseTeacherNotes('하늘이는 앞자리', students);
  assert.deepEqual(r2.items, []);
  assert.deepEqual(r2.unmatched, ['하늘이는 앞자리']);
});

test('학생이 없는 문장은 인식 못 함 목록으로', () => {
  const r = parseTeacherNotes('오늘 날씨 좋음\n- 다음 주 자리 바꾸기', students);
  assert.deepEqual(r.items, []);
  assert.deepEqual(r.unmatched, ['오늘 날씨 좋음', '다음 주 자리 바꾸기']);
});

test('셋이 싸우면 세 쌍 모두 떨어뜨리기', () => {
  const r = parseTeacherNotes('김하늘, 이도윤, 박서연 셋이 자주 다툼', students);
  assert.deepEqual(rules(r), ['apart:ab', 'apart:ac', 'apart:bc']);
});

test('마지막 표현이 결정: 예전엔 싸웠지만 지금은 같이 앉혀도 됨', () => {
  const r = parseTeacherNotes('김하늘과 이도윤은 예전에 싸웠지만 요즘은 잘 지내서 같이 앉혀도 됨', students);
  assert.deepEqual(rules(r), ['together:ab']);
});

test('앞자리 + 다른 학생과 다툼이 한 문장에', () => {
  const r = parseTeacherNotes('최지우는 눈이 나쁘고 정민준과 자주 다툼', students);
  assert.deepEqual(rules(r), ['apart:de']);
  assert.deepEqual(fronts(r), ['d']);
});

test('쉼표 뒤 이어지는 문장은 앞 학생과 짝지음', () => {
  const r = parseTeacherNotes('최지우는 시력이 나빠 앞자리, 그리고 정민준과 자주 다툼', students);
  assert.deepEqual(fronts(r), ['d']);
  assert.deepEqual(rules(r), ['apart:de']);
});

test('한 학생만 언급된 도우미 문장은 메모로', () => {
  const r = parseTeacherNotes('김하늘은 안경을 안 써서 칠판이 잘 안 보임. 이도윤은 도우미 역할을 잘함', students);
  assert.deepEqual(fronts(r), ['a']);
  assert.deepEqual(rules(r), []);
  assert.ok(memos(r).includes('b:도우미 역할을 잘함'));
});

test('번호 목록과 줄바꿈이 섞인 붙여넣기', () => {
  const text = `1. 김하늘 - 시력 나쁨 (안경)
2. 이도윤, 박서연: 같은 모둠에 두면 안 됨
3. 최지우 ↔ 정민준 단짝, 붙여 앉히면 수업 방해
4. 정민준은 발표를 잘함`;
  const r = parseTeacherNotes(text, students);
  assert.deepEqual(fronts(r), ['a']);
  assert.deepEqual(rules(r), ['apart:bc', 'apart:de']);
  assert.ok(memos(r).includes('e:발표를 잘함'));
});

test('같은 쌍은 마지막 규칙만 남는다', () => {
  const r = parseTeacherNotes('김하늘과 이도윤 싸움\n김하늘과 이도윤은 화해해서 같이 앉혀도 됨', students);
  assert.deepEqual(rules(r), ['together:ab']);
});

test('findStudents: 긴 이름 우선, 등장 순서 유지', () => {
  const { sids } = findStudents('박하늘이 김하늘을 도와줌', students);
  assert.deepEqual(sids, ['f', 'a']);
});

test('같은 줄에서 이름 없이 이어지는 문장은 앞 학생 이야기로 본다', () => {
  const r = parseTeacherNotes('이도윤과 박서연은 자주 싸움. 지난달에도 크게 다툼\n오늘 회의 정리', students);
  assert.deepEqual(rules(r), ['apart:bc']);
  assert.equal(r.items.find((i) => i.kind === 'rule').source, '이도윤과 박서연은 자주 싸움 / 지난달에도 크게 다툼');
  assert.deepEqual(r.unmatched, ['오늘 회의 정리']);
});
