import { computeStats, analyzeConflicts } from './analysis.js';
import { roundRoom, roundView } from './rounds.js';

const pairKey = (a, b) => [a, b].sort().join('|');

/**
 * 회차별 변화 분석: 학급 추세, 학생별 변화, 새로 생긴/해소된/계속되는 갈등.
 */
export function analyzeHistory(room) {
  const rounds = room.rounds.map((r) => {
    const rr = roundRoom(room, r);
    const stats = computeStats(rr);
    const analysis = analyzeConflicts(rr, stats);
    return { round: roundView(r), stats, analysis, relations: r.relations };
  });

  const trend = rounds.map(({ round, analysis }) => ({
    id: round.id,
    name: round.name,
    open: round.open,
    submitted: analysis.submittedCount,
    total: analysis.totalStudents,
    good: analysis.goodCount,
    bad: analysis.badCount,
    mutualGood: analysis.mutualGood,
    mutualBad: analysis.mutualBad,
    isolated: analysis.isolated.length,
    highRisk: analysis.pairs.filter((p) => p.probability >= 70).length,
  }));

  const students = room.students.map((s) => ({
    id: s.id,
    name: s.name,
    rounds: rounds.map(({ round, stats, analysis }) => ({
      id: round.id,
      submitted: stats[s.id].submitted,
      inGood: stats[s.id].inGood.length,
      inBad: stats[s.id].inBad.length,
      outGood: stats[s.id].outGood.length,
      outBad: stats[s.id].outBad.length,
      flags: analysis.studentRisk[s.id].flags,
    })),
  }));

  const nameOf = (id) => room.students.find((s) => s.id === id)?.name || '?';
  const typeOf = (relations, a, b) => relations[a]?.[b]?.type || 'none';

  // 안 좋은 사이가 한 번이라도 있었던 쌍의 회차별 이력
  const keys = new Set();
  for (const { relations } of rounds) {
    for (const [from, targets] of Object.entries(relations)) {
      for (const [to, rel] of Object.entries(targets)) if (rel.type === 'bad') keys.add(pairKey(from, to));
    }
  }
  const pairHistory = [...keys].map((key) => {
    const [a, b] = key.split('|');
    return {
      a, b, aName: nameOf(a), bName: nameOf(b),
      rounds: rounds.map(({ round, relations, stats }) => ({
        id: round.id,
        ab: typeOf(relations, a, b),
        ba: typeOf(relations, b, a),
        aSubmitted: stats[a]?.submitted || false,
        bSubmitted: stats[b]?.submitted || false,
      })),
    };
  }).filter((p) => room.students.some((s) => s.id === p.a) && room.students.some((s) => s.id === p.b));

  let changes = null;
  if (rounds.length >= 2) {
    const last = rounds[rounds.length - 1];
    const prev = rounds[rounds.length - 2];
    const hasBad = (r, a, b) => typeOf(r.relations, a, b) === 'bad' || typeOf(r.relations, b, a) === 'bad';
    const newConflicts = [];
    const resolved = [];
    const persistent = [];
    for (const p of pairHistory) {
      const lastBad = hasBad(last, p.a, p.b);
      const prevBad = hasBad(prev, p.a, p.b);
      const bothSubmittedLast = last.stats[p.a].submitted || last.stats[p.b].submitted;
      const entry = { a: p.a, b: p.b, aName: p.aName, bName: p.bName, probability: last.analysis.pairs.find((x) => pairKey(x.a, x.b) === pairKey(p.a, p.b))?.probability ?? null };
      if (lastBad && !prevBad) newConflicts.push(entry);
      else if (lastBad && prevBad) persistent.push(entry);
      else if (!lastBad && prevBad && bothSubmittedLast) resolved.push(entry);
    }
    const studentChanges = students.map((s) => {
      const l = s.rounds[s.rounds.length - 1];
      const p = s.rounds[s.rounds.length - 2];
      return {
        id: s.id, name: s.name,
        inGoodDelta: l.inGood - p.inGood,
        inBadDelta: l.inBad - p.inBad,
        newlyIsolated: l.flags.includes('isolated') && !p.flags.includes('isolated'),
        recovered: !l.flags.includes('isolated') && p.flags.includes('isolated'),
      };
    });
    changes = {
      lastId: last.round.id, lastName: last.round.name, prevId: prev.round.id, prevName: prev.round.name,
      newConflicts, resolved, persistent,
      improved: studentChanges.filter((s) => s.inBadDelta < 0 || s.inGoodDelta > 0 || s.recovered).sort((x, y) => (y.inGoodDelta - y.inBadDelta) - (x.inGoodDelta - x.inBadDelta)),
      worsened: studentChanges.filter((s) => s.inBadDelta > 0 || s.newlyIsolated || s.inGoodDelta < 0).sort((x, y) => (y.inBadDelta - y.inGoodDelta) - (x.inBadDelta - x.inGoodDelta)),
    };
  }

  return { trend, students, pairHistory, changes };
}
