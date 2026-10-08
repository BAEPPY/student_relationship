import { test } from 'node:test';
import assert from 'node:assert/strict';
import { purgeExpired, retentionView, addMonths, purgeAll, roomLastActivity, dropStaleAiSeating } from '../server/retention.js';
import { FileStore } from '../server/store.js';

const NOW = new Date('2026-10-05T00:00:00.000Z');
const iso = (d) => new Date(d).toISOString();
const monthsAgo = (n, day = 5) => iso(new Date(Date.UTC(2026, 9 - n, day)));

function round(name, startedMonthsAgo, closedMonthsAgo, submitted = ['a']) {
  return {
    id: `r${name}`, name, startedAt: monthsAgo(startedMonthsAgo), closedAt: closedMonthsAgo === null ? null : monthsAgo(closedMonthsAgo),
    relations: {}, submissions: Object.fromEntries(submitted.map((s) => [s, { submittedAt: monthsAgo(startedMonthsAgo) }])),
  };
}
function room(rounds, extra = {}) {
  return { id: 'x', name: '반', adminToken: 't', createdAt: monthsAgo(20), students: [{ id: 'a', name: '가', token: 'k' }], rounds, currentRoundId: rounds[rounds.length - 1]?.id, ...extra };
}

test('addMonths: 월말 처리', () => {
  assert.equal(addMonths('2026-01-31T00:00:00.000Z', 1).toISOString(), '2026-02-28T00:00:00.000Z');
  assert.equal(addMonths('2026-10-05T00:00:00.000Z', -14).toISOString(), '2025-08-05T00:00:00.000Z');
});

test('14개월이 지난 회차만 삭제되고 기록이 남는다', () => {
  const r = room([round('A', 16, 15), round('B', 13, 12), round('C', 1, null)]);
  const res = purgeExpired(r, NOW);
  assert.equal(res.changed, true);
  assert.equal(res.deleteRoom, false);
  assert.deepEqual(res.removed.map((x) => x.name), ['A']);
  assert.deepEqual(r.rounds.map((x) => x.name), ['B', 'C']);
  assert.equal(r.retentionLog.length, 1);
  assert.equal(r.retentionLog[0].name, 'A');
  assert.equal(r.retentionLog[0].submitted, 1);
  assert.equal(purgeExpired(r, NOW).changed, false);
});

test('열려 있는 회차는 최근 제출이 있으면 유지된다', () => {
  const r = room([{ ...round('OLD', 20, null), submissions: { a: { submittedAt: monthsAgo(2) } } }]);
  assert.equal(purgeExpired(r, NOW).changed, false);
});

test('모든 회차가 만료되고 교실 활동도 없으면 교실 삭제', () => {
  const r = room([round('A', 18, 17)]);
  const res = purgeExpired(r, NOW);
  assert.equal(res.deleteRoom, true);
});

test('모든 회차가 만료됐지만 최근 메모 활동이 있으면 빈 회차로 유지', () => {
  const r = room([round('A', 18, 17)], { teacherNotes: { students: {}, rules: [], updatedAt: monthsAgo(1) } });
  const res = purgeExpired(r, NOW);
  assert.equal(res.deleteRoom, false);
  assert.equal(r.rounds.length, 1);
  assert.equal(Object.keys(r.rounds[0].submissions).length, 0);
  assert.equal(r.currentRoundId, r.rounds[0].id);
});

test('retentionView: 60일 안에 삭제될 회차를 알려 준다', () => {
  const r = room([round('A', 13, 13), round('B', 6, 5), round('C', 1, null)]);
  const v = retentionView(r, NOW);
  assert.equal(v.months, 14);
  assert.deepEqual(v.expiring.map((x) => x.name), ['A']);
  assert.equal(v.expiring[0].expiresAt, addMonths(monthsAgo(13), 14).toISOString());
});

test('purgeAll: 저장소의 모든 교실에 적용', async () => {
  const store = new FileStore(null);
  store.createRoom({ ...room([round('A', 18, 17)]), id: 'dead', adminToken: 'd' });
  store.createRoom({ ...room([round('A', 16, 15), round('B', 1, null)]), id: 'alive', adminToken: 'l' });
  store.createRoom({ ...room([round('B', 1, null)]), id: 'fresh', adminToken: 'f' });
  const res = await purgeAll(store, NOW);
  assert.deepEqual(res, { rooms: 3, deletedRooms: 1, deletedRounds: 2 });
  assert.equal(store.getRoom('dead'), null);
  assert.deepEqual(store.getRoom('alive').rounds.map((x) => x.name), ['B']);
  assert.equal(store.getRoom('fresh').rounds.length, 1);
});

test('성향 설문·지원서·배정·AI 분석 시각도 회차 활동으로 보고, 오래된 1인 1역 기록은 지운다', () => {
  const r = round('옛 회차', 20, null, []);
  r.applications = { a: { choices: [], updatedAt: monthsAgo(2) } };
  const rm = room([r], { roleHistory: [{ month: '2024년 1월', assignments: {}, updatedAt: monthsAgo(30) }, { month: '2026년 8월', assignments: {}, updatedAt: monthsAgo(1) }, { month: '옛날', assignments: {} }] });
  const result = purgeExpired(rm, NOW);
  assert.equal(result.removed.length, 0, '최근 지원서가 있으면 회차 유지');
  assert.equal(result.changed, true, '오래된 기록이 지워져 변경됨');
  assert.deepEqual(rm.roleHistory.map((h) => h.month), ['2026년 8월', '옛날']);

  const r2 = round('AI만', 20, null, []);
  r2.aiAnalysis = { createdAt: monthsAgo(3) };
  const rm2 = room([r2]);
  assert.equal(purgeExpired(rm2, NOW).removed.length, 0);
  const r3 = round('공개만', 20, null, []);
  r3.roleAssignment = { publishedAt: monthsAgo(13) };
  assert.equal(purgeExpired(room([r3]), NOW).removed.length, 0);
  r3.roleAssignment = { publishedAt: monthsAgo(15) };
  assert.equal(purgeExpired(room([r3]), NOW).removed.length, 1);
});

test('AI 자리 배정안: 만든 시각은 교실 활동으로 세고, 그 회차가 지워지면 배정안도 지운다', () => {
  const seating = (roundId, createdAt) => ({ roundId, roundName: '옛 회차', createdAt, model: 'm', truncated: false, pairs: [{ a: 'a', b: 'b', probability: 70, reason: '가가 나를 놀려요.' }], assignment: { 'b0-r0-c0': 'a' }, explanations: { a: '앞에 앉았어요.' }, notes: '', warnings: [] });
  // 1) 회차는 다 만료됐지만 최근에 AI 배정안을 만들었으면 교실은 남는다 (활동으로 인정). 배정안의 회차는 지워지므로 배정안도 같이 사라진다
  const r1 = room([round('A', 18, 17)], { aiSeating: seating('rA', monthsAgo(1)) });
  assert.equal(roomLastActivity(r1), monthsAgo(1));
  assert.equal(retentionView(r1, NOW).roomExpiresAt, addMonths(monthsAgo(1), 14).toISOString());
  const res1 = purgeExpired(r1, NOW);
  assert.equal(res1.deleteRoom, false);
  assert.equal(res1.changed, true);
  assert.equal(r1.rounds.length, 1);
  assert.equal(r1.aiSeating, undefined, '지워진 회차 기준 배정안은 함께 삭제');

  // 2) 만료된 회차의 배정안만 지우고, 남은 회차의 배정안은 그대로
  const r2 = room([round('A', 16, 15), round('B', 1, null)], { aiSeating: seating('rA', monthsAgo(15)) });
  assert.deepEqual(purgeExpired(r2, NOW).removed.map((x) => x.name), ['A']);
  assert.equal(r2.aiSeating, undefined);
  const r3 = room([round('A', 16, 15), round('B', 1, null)], { aiSeating: seating('rB', monthsAgo(1)) });
  purgeExpired(r3, NOW);
  assert.equal(r3.aiSeating.roundId, 'rB', '남은 회차의 배정안은 유지');

  // 3) 지울 회차가 없어도 회차가 이미 없는 배정안이 남아 있으면 정리한다 (changed 로 저장 유도)
  const r4 = room([round('B', 1, null)], { aiSeating: seating('gone', monthsAgo(2)) });
  const res4 = purgeExpired(r4, NOW);
  assert.equal(res4.changed, true);
  assert.equal(res4.removed.length, 0);
  assert.equal(r4.aiSeating, undefined);
  assert.equal(purgeExpired(r4, NOW).changed, false);

  // dropStaleAiSeating 단독
  const r5 = room([round('B', 1, null)], { aiSeating: seating('rB', monthsAgo(1)) });
  assert.equal(dropStaleAiSeating(r5), false);
  assert.ok(r5.aiSeating);
  assert.equal(dropStaleAiSeating(room([round('B', 1, null)])), false, '배정안이 없으면 아무것도 안 함');
});
