import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uniqueRoundName, nextRoundName, monthName } from '../server/rounds.js';

test('uniqueRoundName: 비어 있으면 그대로, 겹치면 2차·3차 … 로 붙인다', () => {
  const room = { rounds: [{ name: '2026년 10월' }, { name: '2026년 10월 2차' }] };
  assert.equal(uniqueRoundName({ rounds: [] }, '2026년 10월'), '2026년 10월');
  assert.equal(uniqueRoundName(room, '2026년 10월'), '2026년 10월 3차');
  assert.equal(uniqueRoundName(room, '2026년 11월'), '2026년 11월');
  assert.equal(uniqueRoundName(null, '2026년 9월'), '2026년 9월');
});

test('nextRoundName: 지금 달 이름을 쓰고, 같은 달에 이미 조사했으면 2차', () => {
  const now = new Date('2026-10-29T03:00:00.000Z');
  assert.equal(monthName(now), '2026년 10월');
  assert.equal(nextRoundName({ rounds: [] }, now), '2026년 10월');
  assert.equal(nextRoundName({ rounds: [{ name: '2026년 10월' }] }, now), '2026년 10월 2차');
});
