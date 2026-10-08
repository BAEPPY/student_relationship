// 좌석 기하 (순수 함수) — 브라우저(자리 배정 페이지)와 서버(AI 자리 배정·보정)가 같이 씁니다. 의존성 없음.
//
// layoutSeats(layout) → [{ id: 'b0-r0-c0', b, r, c }]   배치의 모든 좌석 (분단 → 줄 → 칸 순서)
// neighborPairs(layout) → [seatA, seatB, weight, label]   이웃 자리 쌍
//   - 짝꿍 1.0: 같은 분단 같은 줄의 바로 옆 칸
//   - 앞뒤 0.6: 같은 분단 같은 칸의 바로 앞·뒤 줄
//   - 대각선 0.3: 같은 분단 바로 앞·뒤 줄의 옆 칸 (양쪽)
//   - 통로 건너 0.35: 이웃한 분단의 같은 줄에서 통로를 사이에 둔 가장자리 자리 (두 분단 중 짧은 줄 수까지)
// seatedPairs(layout, seats) → [{ a, b, label, weight }]   두 자리 모두 학생이 앉은 이웃 쌍 (seats: seatId → studentId)
// deskmatePairs(layout, seats) → [[a, b], …]   그중 짝꿍('짝꿍' 라벨)만

const blocksOf = (layout) => (Array.isArray(layout?.blocks) ? layout.blocks : []);
const seatId = (b, r, c) => `b${b}-r${r}-c${c}`;

export function layoutSeats(layout) {
  const list = [];
  blocksOf(layout).forEach((b, bi) => {
    const rows = Number(b?.rows) || 0;
    const cols = Number(b?.cols) || 0;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) list.push({ id: seatId(bi, r, c), b: bi, r, c });
  });
  return list;
}

export function neighborPairs(layout) {
  const blocks = blocksOf(layout);
  const pairs = [];
  blocks.forEach((blk, bi) => {
    const rows = Number(blk?.rows) || 0;
    const cols = Number(blk?.cols) || 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (c + 1 < cols) pairs.push([seatId(bi, r, c), seatId(bi, r, c + 1), 1.0, '짝꿍']);
        if (r + 1 < rows) pairs.push([seatId(bi, r, c), seatId(bi, r + 1, c), 0.6, '앞뒤']);
        if (r + 1 < rows && c + 1 < cols) pairs.push([seatId(bi, r, c), seatId(bi, r + 1, c + 1), 0.3, '대각선']);
        if (r + 1 < rows && c > 0) pairs.push([seatId(bi, r, c), seatId(bi, r + 1, c - 1), 0.3, '대각선']);
      }
    }
    const next = blocks[bi + 1];
    if (next) {
      const shared = Math.min(rows, Number(next?.rows) || 0);
      for (let r = 0; r < shared; r++) pairs.push([seatId(bi, r, cols - 1), seatId(bi + 1, r, 0), 0.35, '통로 건너']);
    }
  });
  return pairs;
}

export function seatedPairs(layout, seats) {
  const at = (id) => (seats && seats[id] != null && seats[id] !== '' ? String(seats[id]) : null);
  const out = [];
  for (const [x, y, weight, label] of neighborPairs(layout)) {
    const a = at(x);
    const b = at(y);
    if (a && b && a !== b) out.push({ a, b, label, weight });
  }
  return out;
}

export function deskmatePairs(layout, seats) {
  return seatedPairs(layout, seats).filter((p) => p.label === '짝꿍').map((p) => [p.a, p.b]);
}
