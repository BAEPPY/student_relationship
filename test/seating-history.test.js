import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ensureSeatingHistory, seatingView, saveRoundSeating, walkSeatings, removeStudentSeating, SEATING_HISTORY_LIMIT } from '../server/seating-history.js';
import { seatingMetrics, repairSeatAssignment, sameSeatConfig } from '../public/js/seating-compare.js';
import { repairSeating } from '../server/seating.js';

const seat = (sid = 'a') => ({ layout: { blocks: [{ cols: 2, rows: 3 }] }, seats: { 'b0-r0-c0': sid }, pinned: [], options: { friends: 'any' }, zones: {}, climate: 'off', roleSeats: {} });
const fixture = () => ({ currentRoundId: 'new', rounds: [{ id: 'old', startedAt: '2026-09-01' }, { id: 'new', startedAt: '2026-10-01' }] });

test('legacy unscoped seating migrates to the current round once and never appears in a later round', () => {
  const room = { ...fixture(), seating: seat() };
  ensureSeatingHistory(room);
  assert.equal(room.seating, undefined);
  assert.equal(room.rounds[0].seating, undefined);
  assert.equal(room.rounds[1].seating.seats['b0-r0-c0'], 'a');
  assert.equal(room.rounds[1].seatingHistory.length, 1);
  room.rounds.push({ id: 'later' }); room.currentRoundId = 'later';
  ensureSeatingHistory(room);
  assert.equal(seatingView(room, room.rounds[2]).seating, null);
  assert.equal(room.rounds[1].seatingHistory.length, 1);
});

test('explicit legacy round association wins over the current round; an unknown association is not reassigned', () => {
  const room = { ...fixture(), seating: { ...seat(), roundId: 'old' } };
  ensureSeatingHistory(room);
  assert.ok(room.rounds[0].seating);
  assert.equal(seatingView(room, room.rounds[1]).seating, null);
  const unknown = { ...fixture(), seating: { ...seat(), roundId: 'removed' } };
  ensureSeatingHistory(unknown);
  assert.ok(unknown.rounds.every((round) => !round.seating));
});

test('legacy migration uses a deterministic version across separate PG-style read copies and key ordering', () => {
  const raw = { ...fixture(), seating: seat() };
  const a = structuredClone(raw), b = structuredClone(raw);
  b.seating = Object.fromEntries(Object.entries(b.seating).reverse());
  ensureSeatingHistory(a); ensureSeatingHistory(b);
  assert.equal(a.rounds[1].seating.versionId, b.rounds[1].seating.versionId);
  const changed = structuredClone(raw); changed.seating.seats['b0-r0-c0'] = 'b'; ensureSeatingHistory(changed);
  assert.notEqual(changed.rounds[1].seating.versionId, a.rounds[1].seating.versionId);
});

test('read projection supports raw legacy reports without mutating fixtures or copying to past reports', () => {
  const room = { ...fixture(), seating: seat() }, before = structuredClone(room);
  assert.equal(seatingView(room, room.rounds[0]).seating, null);
  const view = seatingView(room, room.rounds[1]);
  view.seating.seats['b0-r0-c0'] = 'changed';
  assert.deepEqual(room, before);
  assert.equal(seatingView({ seating: seat() }, { id: 'only-round' }).seating.seats['b0-r0-c0'], 'a');
});

test('saving creates independent immutable versions in one round and keeps the last ten', () => {
  const room = fixture(), round = room.rounds[0];
  const first = seat();
  saveRoundSeating(room, round, first, { id: 'v1', now: '2026-10-01T00:00:00Z', label: '첫 배치' });
  first.seats['b0-r0-c0'] = 'input-mutated';
  round.seating.seats['b0-r0-c0'] = 'current-mutated';
  assert.equal(round.seatingHistory[0].seating.seats['b0-r0-c0'], 'a');
  for (let n = 2; n <= 12; n++) saveRoundSeating(room, round, seat(`s${n}`), { id: `v${n}` });
  assert.equal(round.seatingHistory.length, SEATING_HISTORY_LIMIT);
  assert.equal(round.seatingHistory[0].id, 'v12');
  assert.equal(round.seatingHistory.at(-1).id, 'v3');
  assert.equal(seatingView(room, room.rounds[1]).seating, null);
});

test('restoring history writes a new version without changing the selected old snapshot', () => {
  const room = fixture(), round = room.rounds[1];
  saveRoundSeating(room, round, seat('a'), { id: 'v1' });
  saveRoundSeating(room, round, seat('b'), { id: 'v2' });
  const old = structuredClone(round.seatingHistory[1]);
  saveRoundSeating(room, round, old.seating, { id: 'v3', source: 'restore', sourceHistoryId: 'v1', label: '첫 배치 복원' });
  assert.equal(round.seating.seats['b0-r0-c0'], 'a');
  assert.equal(round.seatingHistory[0].sourceHistoryId, 'v1');
  assert.deepEqual(round.seatingHistory[2], old);
  assert.throws(() => saveRoundSeating(room, round, seat(), { sourceHistoryId: 'other-round-version' }), /이 회차/);
});

test('student deletion visits every saved and historical copy and removes its pinned assignment', () => {
  const room = fixture();
  for (const round of room.rounds) {
    saveRoundSeating(room, round, { ...seat(), pinned: ['b0-r0-c0'] });
    saveRoundSeating(room, round, seat('b'));
  }
  removeStudentSeating(room, 'a');
  let visited = 0;
  walkSeatings(room, (plan) => { visited++; assert.ok(!Object.values(plan.seats).includes('a')); if (!plan.seats['b0-r0-c0']) assert.deepEqual(plan.pinned, []); });
  assert.equal(visited, 6);
});

test('comparison counts observed adjacent pairs and separate rule/front/role violations on the same inputs', () => {
  const plan = { ...seat(), seats: { 'b0-r0-c0': 'a', 'b0-r0-c1': 'b', 'b0-r2-c0': 'c' }, roleSeats: { 'b0-r0-c0': 'cleaner' } };
  const context = { students: ['a', 'b', 'c'], relations: [{ from: 'a', to: 'b', type: 'bad' }, { from: 'b', to: 'a', type: 'bad' }],
    rules: [{ a: 'a', b: 'b', type: 'apart' }, { a: 'a', b: 'c', type: 'together' }], notes: { c: { front: true } }, roleAssignment: { cleaner: ['c'] }, baseline: plan };
  assert.deepEqual(seatingMetrics(plan, context), { assigned: 3, unassigned: 0, badAdjacent: 1, apartViolations: 1, togetherViolations: 1,
    ruleViolations: 2, frontViolations: 1, roleViolations: 1, moved: 0, layoutChanged: false });
  const alternate = structuredClone(plan); alternate.seats['b0-r0-c0'] = 'c'; alternate.seats['b0-r2-c0'] = 'a';
  const metrics = seatingMetrics(alternate, context);
  assert.equal(metrics.moved, 2); assert.equal(metrics.badAdjacent, 0); assert.equal(metrics.ruleViolations, 1);
  assert.equal(metrics.frontViolations, 0); assert.equal(metrics.roleViolations, 0);
  assert.equal(plan.seats['b0-r0-c0'], 'a');
});

test('comparison uses null for missing baseline, includes placement transitions, and excludes missing students', () => {
  const plan = { ...seat(), seats: { 'b0-r0-c0': 'a', 'b0-r0-c1': 'removed' } };
  assert.equal(seatingMetrics(null), null);
  const before = seatingMetrics(plan, { students: ['a', 'b'] });
  assert.equal(before.moved, null); assert.equal(before.unassigned, 1);
  const next = { ...seat(), seats: { 'b0-r0-c1': 'b' } };
  assert.equal(seatingMetrics(next, { students: ['a', 'b'], baseline: plan }).moved, 2);
});

test('AI proposal repair preserves current pins and role holders and agrees with server repair', () => {
  const input = { students: ['a', 'b', 'c'], layout: seat().layout, assignment: { 'b0-r0-c0': 'c', 'b0-r0-c1': 'a', 'b0-r1-c0': 'b' },
    fixedSeats: { 'b0-r0-c0': 'a' }, roleSeats: { 'b0-r0-c1': 'cleaner' }, roleAssignment: { cleaner: ['c'] } };
  const result = repairSeatAssignment(input);
  assert.equal(result.seats['b0-r0-c0'], 'a'); assert.equal(result.seats['b0-r0-c1'], 'c');
  assert.equal(new Set(Object.values(result.seats)).size, 3);
  assert.deepEqual(result.seats, repairSeating(input).seats);
  assert.ok(result.adjusted > 0);
});

test('configuration equality ignores object key order but detects changed layout/pins', () => {
  assert.equal(sameSeatConfig({ zones: { a: 'ac' }, fixed: { a: 'student' } }, { fixed: { a: 'student' }, zones: { a: 'ac' } }), true);
  assert.equal(sameSeatConfig({ fixed: { a: 'student' } }, { fixed: { b: 'student' } }), false);
});

test('cached auto-assignment objective matches direct calculation across candidate swaps', async () => {
  const source = await readFile(new URL('../public/js/seats.js', import.meta.url), 'utf8');
  const costs = source.slice(source.indexOf('function singleSeatCost('), source.indexOf('// ---------- 자동 배정'));
  const objective = new Function(`
    const FRONT_ROWS=2;
    const rowOf=(id)=>Number(id.split('-')[1].slice(1));
    const needsFront=(sid)=>sid==='a';
    const bodyOf=(sid)=>sid==='b'?{height:'tall',heat:'yes'}:{sight:'poor',cold:'yes'};
    const blockRowsOf=()=>3;
    const zoneFeel=(id)=>id==='b0-r0-c0'?'cool':id==='b0-r2-c0'?'warm':null;
    const pairCost=(a,b)=>!a||!b?0:((a==='a'&&b==='b')||(a==='b'&&b==='a'))?400:-8;
    ${costs}
    return {singleSeatCost,totalCost,pairCost};
  `)();
  const slots = ['b0-r0-c0', 'b0-r1-c0', 'b0-r2-c0'], ids = ['a', 'b', 'c'];
  const pairs = [[slots[0], slots[1], .6], [slots[1], slots[2], .6]];
  const cache = { pairs: Object.fromEntries(ids.map((a) => [a, Object.fromEntries(ids.map((b) => [b, objective.pairCost(a, b)]))])),
    seats: Object.fromEntries(slots.map((slot) => [slot, Object.fromEntries(ids.map((sid) => [sid, objective.singleSeatCost(slot, sid)]))])) };
  for (const permutation of [['a','b','c'], ['b','a','c'], ['c','b','a'], ['a',null,'b']]) {
    const assignment = Object.fromEntries(slots.map((slot, i) => [slot, permutation[i]]));
    assert.equal(objective.totalCost(assignment, pairs, cache), objective.totalCost(assignment, pairs));
  }
});
