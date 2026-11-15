// 친한 무리 찾기: 좋은 사이 표시를 바탕으로 자연스럽게 뭉친 학생들을 묶고, 무리 사이의 안 좋은 사이를 셉니다.
// 규칙 기반 추정이라 참고용이에요. 같은 입력이면 항상 같은 결과가 나옵니다(무작위 없음).
//
// 방법: 가중 그래프(서로 좋은 사이 = 2, 한쪽만 좋은 사이 = 1, 둘 중 한 명이라도 안 좋은 사이로 표시하면 연결 없음)에서
//       모듈성(modularity)을 가장 크게 올리는 두 무리를 차례로 합치는 탐욕 병합. 학급 크기(80명 이하)에서는 충분히 빨라요.

const MUTUAL = 2;
const ONE_WAY = 1;

/**
 * @param {{ students: {id,name}[], relations: object }} room  회차 하나(roundRoom 결과)
 * @returns {{ groups: {id, members: string[], mutual: number, internalBad: number}[], ungrouped: string[],
 *            between: {a, b, bad: number, pairs: {from, to}[]}[], groupOf: Record<string, number> }}
 */
export function detectGroups(room) {
  const ids = (room.students || []).map((s) => s.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const rel = room.relations || {};
  const typeOf = (a, b) => rel[a]?.[b]?.type || 'none';
  const n = ids.length;

  // 가중치 행렬 (대칭)
  const w = Array.from({ length: n }, () => new Float64Array(n));
  let total = 0;   // 모든 간선 가중치의 합 (m)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const ab = typeOf(ids[i], ids[j]);
      const ba = typeOf(ids[j], ids[i]);
      if (ab === 'bad' || ba === 'bad') continue;
      const weight = ab === 'good' && ba === 'good' ? MUTUAL : ab === 'good' || ba === 'good' ? ONE_WAY : 0;
      if (!weight) continue;
      w[i][j] = weight; w[j][i] = weight; total += weight;
    }
  }

  // 탐욕 모듈성 병합: community[c] = 구성원 index 목록
  let communities = ids.map((_, i) => [i]);
  if (total > 0) {
    const degree = ids.map((_, i) => w[i].reduce((a, b) => a + b, 0));
    const between = (A, B) => { let s = 0; for (const i of A) for (const j of B) s += w[i][j]; return s; };
    const degOf = (A) => A.reduce((s, i) => s + degree[i], 0);
    for (;;) {
      let best = null;
      for (let x = 0; x < communities.length; x++) {
        for (let y = x + 1; y < communities.length; y++) {
          const e = between(communities[x], communities[y]);
          if (!e) continue;
          // ΔQ = e_xy/m − (d_x · d_y) / (2m²)
          const gain = e / total - (degOf(communities[x]) * degOf(communities[y])) / (2 * total * total);
          if (gain > 1e-12 && (!best || gain > best.gain + 1e-12)) best = { x, y, gain };
        }
      }
      if (!best) break;
      const merged = [...communities[best.x], ...communities[best.y]].sort((a, b) => a - b);
      communities = communities.filter((_, k) => k !== best.x && k !== best.y);
      communities.push(merged);
      communities.sort((a, b) => a[0] - b[0]);   // 다음 탐색 순서를 항상 같게
    }
  }

  // 2명 이상만 무리로. 큰 무리부터, 같으면 명단에서 앞선 학생이 있는 무리부터 번호를 붙여요
  const multi = communities.filter((c) => c.length >= 2).sort((a, b) => b.length - a.length || a[0] - b[0]);
  const groupOf = {};
  const groups = multi.map((members, k) => {
    let mutual = 0; let internalBad = 0;
    for (let x = 0; x < members.length; x++) {
      for (let y = x + 1; y < members.length; y++) {
        const a = ids[members[x]]; const b = ids[members[y]];
        if (typeOf(a, b) === 'good' && typeOf(b, a) === 'good') mutual++;
        if (typeOf(a, b) === 'bad' || typeOf(b, a) === 'bad') internalBad++;
      }
    }
    for (const i of members) groupOf[ids[i]] = k + 1;
    return { id: k + 1, members: members.map((i) => ids[i]), mutual, internalBad };
  });
  const ungrouped = ids.filter((id) => !groupOf[id]);

  // 무리 사이의 안 좋은 사이 (방향 있는 표시를 하나씩 셉니다)
  const pairMap = new Map();
  for (const [from, targets] of Object.entries(rel)) {
    if (!index.has(from)) continue;
    for (const [to, r] of Object.entries(targets || {})) {
      if (r?.type !== 'bad' || !index.has(to)) continue;
      const ga = groupOf[from]; const gb = groupOf[to];
      if (!ga || !gb || ga === gb) continue;
      const key = ga < gb ? `${ga}|${gb}` : `${gb}|${ga}`;
      const entry = pairMap.get(key) || { a: Math.min(ga, gb), b: Math.max(ga, gb), bad: 0, pairs: [] };
      entry.bad++;
      entry.pairs.push({ from, to });
      pairMap.set(key, entry);
    }
  }
  const betweenGroups = [...pairMap.values()].sort((x, y) => y.bad - x.bad || x.a - y.a || x.b - y.b);
  return { groups, ungrouped, between: betweenGroups, groupOf };
}
