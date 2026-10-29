import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previousHistoryFor, previousRoleIds } from '../server/roles.js';

const at = (d) => `2026-${d}T00:00:00.000Z`;
function room() {
  const r1 = { id: 'r-sep', name: '2026년 9월' };
  const r2 = { id: 'r-oct', name: '2026년 10월' };
  const r3 = { id: 'r-oct2', name: '2026년 10월 2차' };
  return {
    rounds: [r1, r2, r3],
    roleHistory: [
      { month: '2026년 9월', roundId: 'r-sep', source: 'published', assignments: { board: ['a'] }, updatedAt: at('09-30') },
      { month: '2026년 10월', roundId: 'r-oct', source: 'published', assignments: { library: ['a'], board: ['b'] }, updatedAt: at('10-08') },
    ],
  };
}

test('같은 달 2차 회차에서는 앞 회차(10월 1차)에서 공개한 역할이 지난 역할이다', () => {
  const rm = room();
  const prev = previousHistoryFor(rm, rm.rounds[2]);
  assert.equal(prev.month, '2026년 10월');
  assert.deepEqual(previousRoleIds(rm, rm.rounds[2]), { month: '2026년 10월', byStudent: { a: ['library'], b: ['board'] } });
});

test('10월 1차 회차의 지난 역할은 9월이고, 뒤 회차(10월 2차)에서 공개한 기록은 쓰지 않는다', () => {
  const rm = room();
  rm.roleHistory.push({ month: '2026년 10월 2차', roundId: 'r-oct2', source: 'published', assignments: { board: ['c'] }, updatedAt: at('10-30') });
  assert.equal(previousHistoryFor(rm, rm.rounds[1]).month, '2026년 9월');
  assert.equal(previousHistoryFor(rm, rm.rounds[0]), null);
});

test('회차 연결이 없는 같은 달 기록(지난 기록 올리기)은 앞선 기록으로 본다', () => {
  const rm = { rounds: [{ id: 'r-oct2', name: '2026년 10월 2차' }], roleHistory: [{ month: '2026년 10월', assignments: { board: ['a'] }, updatedAt: at('10-01') }] };
  assert.equal(previousHistoryFor(rm, rm.rounds[0]).month, '2026년 10월');
});
