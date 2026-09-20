import { tagWeight, tagLabel } from './reasons.js';

/**
 * 학생별 통계: 받은/준 좋은·안 좋은 사이 목록, 연결 수(degree), 제출 여부
 */
export function computeStats(room) {
  const stats = {};
  for (const s of room.students) {
    stats[s.id] = {
      id: s.id,
      name: s.name,
      inGood: [],
      inBad: [],
      outGood: [],
      outBad: [],
      degree: 0,
      submitted: Boolean(room.submissions?.[s.id]),
      submittedAt: room.submissions?.[s.id]?.submittedAt || null,
    };
  }
  for (const [from, targets] of Object.entries(room.relations || {})) {
    if (!stats[from]) continue;
    for (const [to, rel] of Object.entries(targets || {})) {
      if (!stats[to] || to === from) continue;
      if (rel.type === 'good') {
        stats[from].outGood.push(to);
        stats[to].inGood.push(from);
      } else if (rel.type === 'bad') {
        stats[from].outBad.push(to);
        stats[to].inBad.push(from);
      }
    }
  }
  for (const s of Object.values(stats)) {
    s.degree = s.inGood.length + s.inBad.length + s.outGood.length + s.outBad.length;
  }
  return stats;
}

/** 평면 배열 형태의 관계 목록 */
export function listRelations(room) {
  const ids = new Set(room.students.map((s) => s.id));
  const out = [];
  for (const [from, targets] of Object.entries(room.relations || {})) {
    if (!ids.has(from)) continue;
    for (const [to, rel] of Object.entries(targets || {})) {
      if (!ids.has(to) || to === from) continue;
      out.push({
        from,
        to,
        type: rel.type,
        tags: rel.tags || [],
        tagLabels: (rel.tags || []).map((t) => tagLabel(rel.type, t)),
        reason: rel.reason || '',
        updatedAt: rel.updatedAt || null,
      });
    }
  }
  return out;
}

const BASE = {
  'bad/bad': 78,
  'bad/none': 48,
  'bad/good': 40,
  'good/good': 4,
  'good/none': 8,
};

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function levelOf(p) {
  if (p >= 70) return 'high';
  if (p >= 40) return 'medium';
  return 'low';
}

/**
 * 두 학생 사이에 앞으로 갈등이 생길 "추정 확률"(%)을 계산합니다.
 * 단순한 규칙 기반 추정치이며, 근거(factors)를 함께 돌려줍니다.
 */
export function analyzeConflicts(room, stats = computeStats(room)) {
  const rel = room.relations || {};
  const get = (a, b) => rel[a]?.[b] || null;
  const typeOf = (r) => (r ? r.type : 'none');
  const nameOf = (id) => stats[id]?.name || id;
  const submittedCount = Object.values(stats).filter((s) => s.submitted).length;
  const ids = room.students.map((s) => s.id);

  // 좋은 사이(어느 방향이든)로 연결된 이웃 집합
  const goodNeighbors = {};
  for (const id of ids) {
    goodNeighbors[id] = new Set([...stats[id].inGood, ...stats[id].outGood]);
  }

  const pairs = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i];
      const b = ids[j];
      const ab = get(a, b);
      const ba = get(b, a);
      const tAB = typeOf(ab);
      const tBA = typeOf(ba);
      if (tAB === 'none' && tBA === 'none') continue; // 정보 없음 → 추정하지 않음

      const key = [tAB, tBA].sort().join('/');
      let score = BASE[key];
      const factors = [];

      if (key === 'bad/bad') {
        factors.push({ label: '서로를 안 좋은 사이로 표시함', delta: 0, kind: 'base' });
      } else if (key === 'bad/none') {
        const from = tAB === 'bad' ? a : b;
        const to = from === a ? b : a;
        factors.push({ label: `${nameOf(from)} → ${nameOf(to)} 한쪽만 안 좋은 사이로 표시함`, delta: 0, kind: 'base' });
      } else if (key === 'bad/good') {
        const from = tAB === 'bad' ? a : b;
        const to = from === a ? b : a;
        factors.push({
          label: `${nameOf(to)}은(는) 좋은 사이로, ${nameOf(from)}은(는) 안 좋은 사이로 표시함 (기대 불일치)`,
          delta: 0,
          kind: 'base',
        });
      } else if (key === 'good/good') {
        factors.push({ label: '서로를 좋은 사이로 표시함', delta: 0, kind: 'base' });
      } else {
        factors.push({ label: '한쪽만 좋은 사이로 표시함', delta: 0, kind: 'base' });
      }

      const hasBad = tAB === 'bad' || tBA === 'bad';
      if (hasBad) {
        // 1) 이유의 심각도
        let severity = 0;
        const labels = [];
        for (const r of [ab, ba]) {
          if (!r || r.type !== 'bad') continue;
          const tags = r.tags || [];
          if (tags.length === 0 && (r.reason || '').trim()) severity += 3;
          for (const t of tags) {
            severity += tagWeight(t);
            labels.push(tagLabel('bad', t));
          }
        }
        severity = Math.min(25, severity);
        if (severity > 0) {
          factors.push({
            label: `안 좋은 이유의 심각도${labels.length ? ` (${[...new Set(labels)].join(', ')})` : ''}`,
            delta: severity,
            kind: 'severity',
          });
          score += severity;
        }

        // 2) 공통 친구가 많으면 같은 무리에서 자주 마주침 → 갈등이 드러나기 쉬움
        let shared = 0;
        for (const c of goodNeighbors[a]) if (goodNeighbors[b].has(c)) shared++;
        if (shared > 0) {
          const delta = Math.min(12, shared * 4);
          factors.push({ label: `공통 친구 ${shared}명 (같은 무리에서 자주 마주침)`, delta, kind: 'structure' });
          score += delta;
        }

        // 3) 여러 학생에게 안 좋은 사이로 지목된 학생이 포함됨
        for (const [from, to] of [[a, b], [b, a]]) {
          if (typeOf(get(from, to)) !== 'bad') continue;
          const inBad = stats[to].inBad.length;
          if (inBad >= 3) {
            factors.push({ label: `${nameOf(to)}이(가) ${inBad}명에게 안 좋은 사이로 지목됨`, delta: 6, kind: 'structure' });
            score += 6;
          }
          // 4) 고립 위험: 아무도 좋은 사이로 지목하지 않음
          if (submittedCount >= 3 && stats[to].inGood.length === 0) {
            factors.push({ label: `${nameOf(to)}을(를) 좋은 사이로 지목한 학생이 없음 (고립 위험)`, delta: 5, kind: 'structure' });
            score += 5;
          }
        }
      }

      const probability = clamp(Math.round(score), 2, 97);
      pairs.push({
        a,
        b,
        aName: nameOf(a),
        bName: nameOf(b),
        ab: tAB,
        ba: tBA,
        probability,
        level: levelOf(probability),
        factors,
      });
    }
  }

  pairs.sort((x, y) => y.probability - x.probability || x.aName.localeCompare(y.aName, 'ko'));

  // 학생별 위험도: 자신이 포함된 쌍 중 최대값
  const studentRisk = {};
  for (const id of ids) studentRisk[id] = { id, name: nameOf(id), max: 0, pairs: 0, flags: [] };
  for (const p of pairs) {
    for (const id of [p.a, p.b]) {
      studentRisk[id].max = Math.max(studentRisk[id].max, p.probability);
      if (p.ab === 'bad' || p.ba === 'bad') studentRisk[id].pairs++;
    }
  }
  for (const id of ids) {
    const s = stats[id];
    if (submittedCount >= 3 && s.inGood.length === 0 && s.inBad.length > 0) studentRisk[id].flags.push('isolated');
    if (s.inBad.length >= 3) studentRisk[id].flags.push('targeted');
    if (s.outBad.length >= 3) studentRisk[id].flags.push('many-conflicts');
  }

  const mutualBad = pairs.filter((p) => p.ab === 'bad' && p.ba === 'bad').length;
  const mutualGood = pairs.filter((p) => p.ab === 'good' && p.ba === 'good').length;
  const isolated = ids.filter((id) => studentRisk[id].flags.includes('isolated')).map((id) => nameOf(id));

  const byInGood = [...ids].sort((x, y) => stats[y].inGood.length - stats[x].inGood.length);
  const byInBad = [...ids].sort((x, y) => stats[y].inBad.length - stats[x].inBad.length);

  return {
    submittedCount,
    totalStudents: ids.length,
    goodCount: Object.values(stats).reduce((n, s) => n + s.outGood.length, 0),
    badCount: Object.values(stats).reduce((n, s) => n + s.outBad.length, 0),
    mutualGood,
    mutualBad,
    isolated,
    mostLiked: byInGood.filter((id) => stats[id].inGood.length > 0).slice(0, 3).map((id) => ({ id, name: nameOf(id), count: stats[id].inGood.length })),
    mostDisliked: byInBad.filter((id) => stats[id].inBad.length > 0).slice(0, 3).map((id) => ({ id, name: nameOf(id), count: stats[id].inBad.length })),
    pairs,
    studentRisk,
  };
}
