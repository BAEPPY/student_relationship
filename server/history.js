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
    return { round: roundView(r), stats, analysis, relations: r.relations || {} };
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
    const pending = [];
    const names = (ids) => ids.map(nameOf);
    const reporters = (r, a, b) => [a, b].filter((id) => typeOf(r.relations, id, id === a ? b : a) === 'bad');
    const pendingPair = (entry, missing, round, reasonCode, reason) => ({
      ...entry, reason, reasonCode,
      missingStudentIds: missing, missingStudentNames: names(missing),
      missingRoundId: round.round.id, missingRoundName: round.round.name,
    });
    for (const p of pairHistory) {
      const lastBad = hasBad(last, p.a, p.b);
      const prevBad = hasBad(prev, p.a, p.b);
      const entry = { a: p.a, b: p.b, aName: p.aName, bName: p.bName, probability: last.analysis.pairs.find((x) => pairKey(x.a, x.b) === pairKey(p.a, p.b))?.probability ?? null };
      if (lastBad && !prevBad) {
        // 이번에 처음 응답한 학생의 부정 표시를 '새로 생긴 갈등'으로 단정하지 않습니다.
        const missing = reporters(last, p.a, p.b).filter((id) => !prev.stats[id].submitted);
        if (missing.length) pending.push(pendingPair(entry, missing, prev, 'missing_previous_response', `이번에 안 좋은 사이로 표시한 ${names(missing).join(', ')}의 이전 회차 응답이 없어 새로 생긴 갈등인지 판단을 보류해요.`));
        else newConflicts.push(entry);
      } else if (lastBad && prevBad) persistent.push(entry);
      else if (!lastBad && prevBad) {
        // 반대쪽 학생의 응답만으로는 이전의 부정 표시가 사라졌다고 볼 수 없습니다.
        const missing = reporters(prev, p.a, p.b).filter((id) => !last.stats[id].submitted);
        if (missing.length) pending.push(pendingPair(entry, missing, last, 'missing_current_response', `이전에 안 좋은 사이로 표시한 ${names(missing).join(', ')}이 이번 회차에 아직 응답하지 않아 해소 판단을 보류해요.`));
        else resolved.push(entry);
      }
    }
    const studentChanges = [];
    const studentPending = [];
    for (const s of students) {
      // 받은 관계는 본인 외의 응답자만 비교합니다. 제출자 수가 같아도 사람이 바뀌면 보류합니다.
      const peers = room.students.map((student) => student.id).filter((id) => id !== s.id);
      const previous = peers.filter((id) => prev.stats[id].submitted);
      const current = peers.filter((id) => last.stats[id].submitted);
      const common = previous.filter((id) => last.stats[id].submitted);
      const missingPrevious = current.filter((id) => !prev.stats[id].submitted);
      const missingCurrent = previous.filter((id) => !last.stats[id].submitted);
      if (missingPrevious.length || missingCurrent.length || !common.length) {
        const changed = missingPrevious.length > 0 || missingCurrent.length > 0;
        const missing = changed ? [...new Set([...missingPrevious, ...missingCurrent])] : peers;
        studentPending.push({
          id: s.id, name: s.name,
          reasonCode: changed ? 'response_cohort_changed' : 'no_comparable_responses',
          reason: changed
            ? `두 회차의 응답자가 달라 받은 관계 수만으로 좋아짐·악화·고립 위험의 변화를 판단하지 않아요. (${names(missing).join(', ')})`
            : '두 회차에 모두 응답한 친구가 없어 학생 변화를 판단하기 어려워요.',
          missingStudentIds: missing, missingStudentNames: names(missing),
          missingPreviousStudentIds: changed ? missingPrevious : peers,
          missingCurrentStudentIds: changed ? missingCurrent : peers,
          comparableRespondentCount: common.length,
          previousRespondentCount: previous.length, currentRespondentCount: current.length,
        });
        continue;
      }
      const counts = (r) => ({
        good: common.filter((id) => typeOf(r.relations, id, s.id) === 'good').length,
        bad: common.filter((id) => typeOf(r.relations, id, s.id) === 'bad').length,
      });
      const p = counts(prev);
      const l = counts(last);
      // 본인의 제출로 전체 제출 수가 2→3이 되어 생긴 플래그 변화도 학생 변화로 세지 않습니다.
      const enoughResponses = prev.analysis.submittedCount >= 3 && last.analysis.submittedCount >= 3;
      const wasIsolated = enoughResponses && p.good === 0 && p.bad > 0;
      const isIsolated = enoughResponses && l.good === 0 && l.bad > 0;
      studentChanges.push({
        id: s.id, name: s.name,
        inGoodDelta: l.good - p.good,
        inBadDelta: l.bad - p.bad,
        newlyIsolated: isIsolated && !wasIsolated,
        recovered: !isIsolated && wasIsolated,
        comparableRespondentCount: common.length,
      });
    }
    changes = {
      lastId: last.round.id, lastName: last.round.name, prevId: prev.round.id, prevName: prev.round.name,
      newConflicts, resolved, persistent, pending, studentPending,
      comparison: { method: 'same_respondents', description: '학생 변화는 두 회차에 모두 응답한 같은 친구들의 표시를 비교해요. 응답자가 달라지면 판단을 보류해요.' },
      improved: studentChanges.filter((s) => s.inBadDelta < 0 || s.inGoodDelta > 0 || s.recovered).sort((x, y) => (y.inGoodDelta - y.inBadDelta) - (x.inGoodDelta - x.inBadDelta)),
      worsened: studentChanges.filter((s) => s.inBadDelta > 0 || s.newlyIsolated || s.inGoodDelta < 0).sort((x, y) => (y.inBadDelta - y.inGoodDelta) - (x.inBadDelta - x.inGoodDelta)),
    };
  }

  return { trend, students, pairHistory, changes };
}
