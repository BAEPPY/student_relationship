import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStats, analyzeConflicts, listRelations } from '../server/analysis.js';
import { analyzeHistory } from '../server/history.js';
import { ensureRounds } from '../server/rounds.js';

function room(overrides = {}) {
  return {
    id: 'r1',
    name: '테스트',
    students: [
      { id: 'a', name: '가' },
      { id: 'b', name: '나' },
      { id: 'c', name: '다' },
      { id: 'd', name: '라' },
    ],
    relations: {},
    submissions: {},
    ...overrides,
  };
}

test('computeStats: 받은/준 관계와 degree 를 센다', () => {
  const r = room({
    relations: {
      a: { b: { type: 'good' }, c: { type: 'bad', tags: ['tease'] } },
      b: { a: { type: 'good' } },
    },
    submissions: { a: { submittedAt: 'x' }, b: { submittedAt: 'x' } },
  });
  const s = computeStats(r);
  assert.deepEqual(s.a.outGood, ['b']);
  assert.deepEqual(s.a.outBad, ['c']);
  assert.deepEqual(s.a.inGood, ['b']);
  assert.equal(s.a.degree, 3);
  assert.equal(s.c.degree, 1);
  assert.equal(s.c.submitted, false);
  assert.equal(listRelations(r).length, 3);
});

test('computeStats: 없는 학생을 향한 관계는 무시한다', () => {
  const r = room({ relations: { a: { zzz: { type: 'good' }, a: { type: 'good' } } } });
  const s = computeStats(r);
  assert.equal(s.a.degree, 0);
  assert.equal(listRelations(r).length, 0);
});

test('analyzeConflicts: 서로 안 좋은 사이가 한쪽만 안 좋은 사이보다 높다', () => {
  const mutual = room({ relations: { a: { b: { type: 'bad', tags: [] , reason: '싫어요' } }, b: { a: { type: 'bad', tags: [], reason: '싫어요' } } } });
  const oneWay = room({ relations: { a: { b: { type: 'bad', tags: [], reason: '싫어요' } } } });
  const pm = analyzeConflicts(mutual).pairs[0];
  const po = analyzeConflicts(oneWay).pairs[0];
  assert.ok(pm.probability > po.probability);
  assert.equal(pm.level, 'high');
  assert.ok(pm.probability >= 2 && pm.probability <= 97);
});

test('analyzeConflicts: 심각한 이유는 확률을 높이고 근거가 남는다', () => {
  const mild = room({ relations: { a: { b: { type: 'bad', tags: ['mismatch'], reason: '' } } } });
  const severe = room({ relations: { a: { b: { type: 'bad', tags: ['hurt', 'exclude'], reason: '' } } } });
  const pmild = analyzeConflicts(mild).pairs[0];
  const psev = analyzeConflicts(severe).pairs[0];
  assert.ok(psev.probability > pmild.probability);
  assert.ok(psev.factors.some((f) => f.kind === 'severity' && f.label.includes('때리거나 괴롭혀요')));
});

test('analyzeConflicts: 관계 정보가 없는 쌍은 계산하지 않고, 좋은 사이는 낮음', () => {
  const r = room({ relations: { a: { b: { type: 'good', tags: ['fun'] } }, b: { a: { type: 'good', tags: [] } } } });
  const a = analyzeConflicts(r);
  assert.equal(a.pairs.length, 1);
  assert.equal(a.pairs[0].level, 'low');
  assert.equal(a.mutualGood, 1);
  assert.equal(a.mutualBad, 0);
});

test('analyzeConflicts: 고립 위험과 다수 지목 플래그', () => {
  const r = room({
    relations: {
      a: { d: { type: 'bad', tags: ['tease'] }, b: { type: 'good' } },
      b: { d: { type: 'bad', tags: ['tease'] }, a: { type: 'good' } },
      c: { d: { type: 'bad', tags: ['tease'] }, a: { type: 'good' } },
    },
    submissions: { a: { submittedAt: 'x' }, b: { submittedAt: 'x' }, c: { submittedAt: 'x' } },
  });
  const a = analyzeConflicts(r);
  assert.deepEqual(a.isolated, ['라']);
  assert.ok(a.studentRisk.d.flags.includes('isolated'));
  assert.ok(a.studentRisk.d.flags.includes('targeted'));
  assert.equal(a.mostDisliked[0].name, '라');
  assert.equal(a.mostDisliked[0].count, 3);
  const pair = a.pairs.find((p) => (p.a === 'a' && p.b === 'd') || (p.a === 'd' && p.b === 'a'));
  assert.ok(pair.factors.some((f) => f.label.includes('3명에게')));
  assert.ok(pair.factors.some((f) => f.label.includes('고립')));
});

test('analyzeConflicts: 공통 친구가 많을수록 갈등 가능성이 오른다', () => {
  const base = { a: { b: { type: 'bad', tags: ['rude'] } } };
  const noShared = room({ relations: base });
  const shared = room({ relations: { ...base, c: { a: { type: 'good' }, b: { type: 'good' } }, d: { a: { type: 'good' }, b: { type: 'good' } } } });
  const p1 = analyzeConflicts(noShared).pairs.find((p) => p.a === 'a' && p.b === 'b');
  const p2 = analyzeConflicts(shared).pairs.find((p) => p.a === 'a' && p.b === 'b');
  assert.equal(p2.probability - p1.probability, 8);
});

test('analyzeHistory: 새로 생긴/해소된/계속되는 갈등과 학생 변화', () => {
  const r = room();
  r.rounds = [
    { id: 'r1', name: '9월', startedAt: 'x', closedAt: 'y', relations: { a: { b: { type: 'bad', tags: ['tease'] }, c: { type: 'bad', tags: ['tease'] } }, b: { a: { type: 'good' } } }, submissions: { a: { submittedAt: 'x' }, b: { submittedAt: 'x' } } },
    { id: 'r2', name: '10월', startedAt: 'y', closedAt: null, relations: { a: { c: { type: 'bad', tags: ['tease'] }, d: { type: 'bad', tags: ['hurt'] } }, b: { a: { type: 'good' } } }, submissions: { a: { submittedAt: 'y' }, b: { submittedAt: 'y' } } },
  ];
  r.currentRoundId = 'r2';
  const h = analyzeHistory(r);
  assert.equal(h.trend.length, 2);
  assert.deepEqual(h.trend.map((t) => t.bad), [2, 2]);
  assert.deepEqual(h.changes.newConflicts.map((p) => [p.a, p.b].sort().join('')), ['ad']);
  assert.deepEqual(h.changes.resolved.map((p) => [p.a, p.b].sort().join('')), ['ab']);
  assert.deepEqual(h.changes.persistent.map((p) => [p.a, p.b].sort().join('')), ['ac']);
  const d = h.changes.worsened.find((s) => s.id === 'd');
  assert.equal(d.inBadDelta, 1);
  const b = h.changes.improved.find((s) => s.id === 'b');
  assert.equal(b.inBadDelta, -1);
  assert.equal(h.pairHistory.length, 3);
});

test('ensureRounds: 예전 구조를 회차로 바꾸고, 여러 번 불러도 같다', () => {
  const r = room({ relations: { a: { b: { type: 'good' } } }, submissions: { a: { submittedAt: 'x' } }, locked: true, createdAt: '2026-09-10T00:00:00.000Z' });
  ensureRounds(r);
  assert.equal(r.rounds.length, 1);
  assert.equal(r.rounds[0].name, '2026년 9월');
  assert.ok(r.rounds[0].closedAt);
  assert.equal(r.relations, undefined);
  assert.equal(r.locked, undefined);
  const snapshot = JSON.stringify(r);
  ensureRounds(r);
  assert.equal(JSON.stringify(r), snapshot);
});
