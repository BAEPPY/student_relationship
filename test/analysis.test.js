import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStats, analyzeConflicts, listRelations } from '../server/analysis.js';

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
