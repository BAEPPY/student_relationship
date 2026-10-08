// 자동 배정(담금질)의 비용 모델 (순수 함수) — 브라우저(자리 배정 페이지)와 테스트가 같은 숫자를 씁니다. seat-geometry.js 만 의존해요.
//
// 비용이 클수록 먼저 지켜요. 우선순위:
//   ① 📌 고정·🎒 역할 자리(아예 움직이지 않음) · 선생님 규칙(떨어뜨리기 400 / 가까이 앉히기 -60, 가까이 앉히기는 갈등·지난 짝꿍 비용을 덮어요)
//   ② 갈등 회피: 안 좋은 사이는 CONFLICT_BASE + 갈등 가능성(2~97) → 어떤 이웃(대각선 0.3 까지)이 되든 지난 짝꿍 반복(80)보다 비싸고,
//      짝꿍이면 지난 짝꿍 세 쌍(240)보다도 비싸요. 가능성이 높을수록 더 멀리.
//   ③ 선생님이 표시한 👓 앞자리 필요: 앞 두 줄 밖이면 60 + 줄×30 (3번째 줄 120) → 지난 짝꿍 반복(80)보다 먼저 지켜요
//   ④ 다양한 짝: 지난 자리표 i(0 = 가장 최근)에서 짝꿍이었던 쌍 80×0.5^i(최소 5), 이웃이었던 쌍 16×0.5^i(최소 1), 같은 분단 4×0.5^i(최소 0.5)
//   ⑤ 학생이 고른 몸 특징: 눈 나쁨 최대 12+줄×5, 키 줄×1.5, 바람 자리 불일치 25 — 지난 자리표가 없는 처음 자리표에서만 자연히 앞줄로 가요
//
// buildPastPenalty(list) → { [a]: { [b]: { mate, near, block } } }   지난 자리표 목록(최신이 앞)에서 쌍별 페널티 합 (양방향 같은 객체)
// makeCostModel(ctx) → { pairCost(a, b, rule?), seatCost(seatId, sid), varietyCost(assign, pairs, groups?), totalCost(assign, pairs, groups?) }   ctx 는 화면 상태를 그때그때 읽는 함수들
import { seatedPairs } from './seat-geometry.js';

export const COST = Object.freeze({
  RULE_APART: 400,       // ① 떨어뜨리기 규칙인 두 학생이 이웃
  RULE_TOGETHER: 60,     // ① 가까이 앉히기 규칙인 두 학생이 이웃 (보너스)
  CONFLICT_BASE: 250,    // ② 안 좋은 사이: 이 값 + 갈등 가능성. 0.3 × (250 + 40) = 87 > PAST_MATE, 250 + 40 > PAST_MATE × 3
  AI_WARN: 40,           // 학생이 표시하지 않은 쌍이라도 AI 예측 갈등 가능성이 이 값 이상이면 가능성 × AI_WARN_SCALE 만큼 떨어뜨려요
  AI_WARN_SCALE: 0.6,
  FRONT_ROWS: 2,         // 앞자리로 인정하는 줄 수
  PAST_MATE: 80,         // ④ 지난 자리표에서 짝꿍이었던 쌍 (× 0.5^i, 최소 5) — 강하게
  PAST_NEAR: 16,         // ④ 짝꿍은 아니지만 이웃(앞뒤·대각선·통로 건너)이었던 쌍 (× 0.5^i, 최소 1) — 약하게
  PAST_BLOCK: 4,         // ④ 같은 분단에 있었던 쌍이 다시 같은 분단에 앉을 때 (× 0.5^i, 최소 0.5) — 더 약하게
  ZONE_MISMATCH: 25,     // ⑤ 추위 잘 타는데 냉방 바람 자리 / 더위 잘 타는데 난방 바람 자리
  ZONE_PREFER: 6,        // ⑤ 그 반대쪽(더위 잘 타는데 냉방 바람 자리 등)은 조금 선호
});

const rowOf = (seatId) => Number(seatId.split('-')[1].slice(1));

/** 선생님이 표시한 👓 앞자리 필요 학생이 row 번째 줄(0부터)에 앉을 때 비용 */
export const teacherFrontCost = (row) => (row < COST.FRONT_ROWS ? row * 8 : 60 + row * 30);
/** 학생이 눈이 나쁜 편이라고 고른 경우 row 번째 줄에 앉을 때 비용 (👓 교사 지정보다 훨씬 낮아요) */
export const sightCost = (row) => (row < COST.FRONT_ROWS ? row * 2 : 12 + row * 5);

/**
 * 지난 자리표들에서 짝꿍/이웃/같은 분단이었던 쌍의 페널티를 미리 합산해 둬요 (totalCost 가 쌍마다 찾아봐요).
 * 담금질이 totalCost 를 수만 번 부르므로 문자열 키 대신 out[a][b] 두 단계 객체로 두고(양방향 같은 객체) 돌려줘요. 비어 있으면 {}.
 * @param {Array<{ layout: object, seats: object }>} list 최신이 앞 (i 번째는 0.5^i 로 약해져요)
 */
export function buildPastPenalty(list) {
  const out = {};
  const entryOf = (a, b) => {
    const row = (out[a] ||= {});
    if (!row[b]) { const e = { mate: 0, near: 0, block: 0 }; row[b] = e; (out[b] ||= {})[a] = e; }
    return row[b];
  };
  (list || []).forEach((arr, i) => {
    const decay = 0.5 ** i;
    for (const { a, b, label } of seatedPairs(arr.layout, arr.seats)) {
      const entry = entryOf(a, b);
      if (label === '짝꿍') entry.mate += Math.max(5, COST.PAST_MATE * decay);
      else entry.near += Math.max(1, COST.PAST_NEAR * decay);
    }
    // 같은 분단에 있었던 쌍 (짝꿍·이웃 여부와 상관없이)
    const byBlock = {};
    for (const [seatId, sid] of Object.entries(arr.seats || {})) if (sid) (byBlock[seatId.split('-')[0]] ||= []).push(sid);
    for (const members of Object.values(byBlock)) {
      for (let x = 0; x < members.length; x++) for (let y = x + 1; y < members.length; y++) {
        if (members[x] !== members[y]) entryOf(members[x], members[y]).block += Math.max(0.5, COST.PAST_BLOCK * decay);
      }
    }
  });
  return out;
}

/**
 * 비용 모델을 만들어요. ctx 의 함수들은 화면 상태를 그때그때 읽어요 (안 주면 "아무 정보 없음"으로 쳐요).
 *   rule(a, b) → { type: 'apart' | 'together' } | null   선생님 지정 규칙
 *   rel(a, b) → 'good' | 'bad' | 'none'                  a 가 b 를 어떻게 표시했는지
 *   prob(a, b) → number | undefined                      규칙 기반 갈등 분석의 갈등 가능성
 *   aiProb(a, b) → number | undefined                    AI 자리 배정이 예측한 갈등 가능성
 *   isolated(sid) → boolean                              고립 위험 학생인지
 *   friends() → 'any' | 'near' | 'apart'                 친한 친구 옵션
 *   pastPenalty() → buildPastPenalty 결과 | null         다양한 짝이 꺼져 있거나 지난 자리표가 없으면 null (그 계산을 통째로 건너뛰어요)
 *   needsFront(sid) → boolean                            선생님이 표시한 👓 앞자리 필요
 *   body(sid) → { sight, height, cold, heat }            학생이 고른 몸 특징
 *   zoneFeel(seatId) → 'cool' | 'warm' | null            바람 자리가 지금 어떻게 느껴지는지
 *   blockRows(seatId) → number                           그 자리가 속한 분단의 줄 수 (키 큰 학생의 뒤쪽 선호용)
 */
export function makeCostModel(ctx = {}) {
  const c = {
    rule: () => null, rel: () => 'none', prob: () => undefined, aiProb: () => undefined, isolated: () => false, friends: () => 'any',
    pastPenalty: () => null, needsFront: () => false, body: () => ({}), zoneFeel: () => null, blockRows: () => 1,
    ...ctx,
  };

  /** 두 학생이 이웃(가중치 1 기준)일 때의 비용. rule 을 넘기면 다시 찾지 않아요 */
  function pairCost(a, b, rule = c.rule(a, b)) {
    if (!a || !b) return 0;
    let cost = 0;
    // ① 교사 지정 규칙이 가장 강함. 가까이 앉히기는 선생님이 알고 정한 것이라 안 좋은 사이·AI 경고 비용을 더하지 않아요
    if (rule?.type === 'apart') cost += COST.RULE_APART;
    const together = rule?.type === 'together';
    if (together) cost -= COST.RULE_TOGETHER;
    const ab = c.rel(a, b);
    const ba = c.rel(b, a);
    const aiP = c.aiProb(a, b);
    if (!together) {
      // ② 안 좋은 사이: AI 가 예측한 갈등 가능성이 있으면 그걸, 없으면 규칙 기반 분석값. CONFLICT_BASE 를 더해 지난 짝꿍 반복보다 늘 비싸게
      if (ab === 'bad' || ba === 'bad') cost += COST.CONFLICT_BASE + (aiP ?? c.prob(a, b) ?? 50);
      // 학생은 안 좋은 사이로 표시하지 않았지만 AI 가 갈등이 생길 수 있다고 본 쌍도 조금 떨어뜨려요
      else if (aiP >= COST.AI_WARN) cost += aiP * COST.AI_WARN_SCALE;
    }
    const mutualGood = ab === 'good' && ba === 'good';
    const anyGood = ab === 'good' || ba === 'good';
    const friends = c.friends();
    if (friends === 'near') cost -= mutualGood ? 10 : anyGood ? 4 : 0;
    if (friends === 'apart') cost += mutualGood ? 8 : anyGood ? 3 : 0;
    if (c.isolated(a) && ba === 'good') cost -= 8;
    if (c.isolated(b) && ab === 'good') cost -= 8;
    return cost;
  }

  /** ④ 다양한 짝 비용: 지난 자리표에서 짝꿍/이웃/같은 분단이었던 쌍이 다시 그렇게 앉을 때. pairs: neighborPairs(layout), groups: 분단별 좌석 id 묶음(없으면 같은 분단 항은 생략) */
  function varietyCost(assign, pairs, groups = null) {
    const past = c.pastPenalty();
    if (!past) return 0;
    let sum = 0;
    for (const [x, y, w, label] of pairs) {
      const a = assign[x];
      const b = assign[y];
      if (!a || !b) continue;
      // 선생님이 가까이 앉히기로 정한 쌍은 지난 짝꿍이어도 그대로 둬요 (① > ④)
      if (c.rule(a, b)?.type === 'together') continue;
      const p = past[a]?.[b];
      if (!p) continue;
      if (label === '짝꿍') sum += p.mate || p.near / 2;     // 짝꿍 반복은 강하게 (짝꿍은 아니었지만 이웃이었다면 그 절반)
      else sum += p.near * w;                                // 앞뒤·대각선·통로 건너 반복은 약하게
    }
    // 같은 분단 반복은 그보다 더 약하게: 지난 자리표에서 같은 분단이었던 두 학생이 다시 같은 분단에 앉으면 조금만 더해요
    if (groups) {
      for (const ids of groups) {
        for (let x = 0; x < ids.length; x++) {
          const a = assign[ids[x]];
          const row = a ? past[a] : null;
          if (!row) continue;
          for (let y = x + 1; y < ids.length; y++) {
            const b = assign[ids[y]];
            const p = b ? row[b] : null;
            if (p) sum += p.block;
          }
        }
      }
    }
    return sum;
  }

  /** 한 자리에 한 학생이 앉을 때의 비용 (줄·앞자리 필요·몸 특징·바람 자리) */
  function seatCost(seatId, sid) {
    if (!sid) return 0;
    const row = rowOf(seatId);
    let sum = 0.8 * row;                                   // 학생이 자리보다 적으면 앞줄부터
    if (c.needsFront(sid)) sum += teacherFrontCost(row);   // ③ 앞자리 필요 학생 (교사 지정) — 지난 짝꿍 반복보다 먼저
    // ⑤ 학생이 고른 몸 특징: 눈이 나쁘면 앞줄, 키가 작으면 앞쪽·크면 뒤쪽을 조금 선호.
    //    다양한 짝(지난 짝꿍 페널티 80)보다 낮게 둬서, 지난 자리표가 없는 처음 자리표에서만 자연히 앞줄로 가요
    const body = c.body(sid);
    if (body.sight === 'poor') sum += sightCost(row);
    if (body.height === 'short') sum += row * 1.5;
    if (body.height === 'tall') sum += (c.blockRows(seatId) - 1 - row) * 1.5;
    // 냉난방기 바람 자리: 추위를 잘 타면 냉방 바람을, 더위를 잘 타면 난방 바람을 피하고 반대쪽은 조금 선호
    const feel = c.zoneFeel(seatId);
    if (feel === 'cool') { if (body.cold === 'yes') sum += COST.ZONE_MISMATCH; if (body.heat === 'yes') sum -= COST.ZONE_PREFER; }
    if (feel === 'warm') { if (body.heat === 'yes') sum += COST.ZONE_MISMATCH; if (body.cold === 'yes') sum -= COST.ZONE_PREFER; }
    return sum;
  }

  /**
   * 자리표 전체의 비용. assign: seatId → studentId | null, pairs: neighborPairs(layout), groups: 분단별 좌석 id 묶음(같은 분단 반복 페널티용, 없으면 생략)
   */
  function totalCost(assign, pairs, groups = null) {
    let sum = 0;
    for (const [x, y, w] of pairs) {
      const a = assign[x];
      const b = assign[y];
      if (a && b) sum += w * pairCost(a, b);
    }
    sum += varietyCost(assign, pairs, groups);
    for (const [seatId, sid] of Object.entries(assign)) if (sid) sum += seatCost(seatId, sid);
    return sum;
  }

  return { pairCost, seatCost, varietyCost, totalCost };
}
