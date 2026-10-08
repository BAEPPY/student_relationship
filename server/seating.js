// 자리 배정 보정 (순수 함수) — AI 가 만든 배정안을 교실 규칙에 맞게 고칩니다.
//
// layoutSeats(layout) → [{ id, b, r, c }]   배치의 모든 좌석 (분단 → 줄 → 칸 순서, id 는 'b0-r0-c0' 꼴)
// repairSeating({ assignment, students, layout, fixedSeats, roleSeats, roleAssignment })
//   → { seats: { seatId: studentId }, warnings: string[] }
//   - 배치에 없는 좌석, 명단에 없는 학생은 버립니다.
//   - 📌 고정 자리(fixedSeats: seatId → sid)는 무조건 그 학생이 앉습니다.
//   - 🎒 역할 자리(roleSeats: seatId → roleId)는 그 역할 담당(roleAssignment[roleId]) 중 한 명이 앉습니다.
//     AI 가 이미 담당 학생을 앉혔으면 그대로 두고, 아니면 아직 자리가 정해지지 않은 담당 학생을 옮겨 앉힙니다.
//     담당 학생이 없거나 모두 다른 고정·역할 자리에 앉았으면 보통 자리처럼 씁니다.
//   - 한 학생은 한 자리만 (겹치면 배치 순서상 앞의 자리만 인정). 자리가 없는 학생은 빈자리에 앞줄부터 채웁니다.
//   - 자리가 모자라면 warnings 에 '자리가 N개 부족해요.' 를 넣습니다.

export function layoutSeats(layout) {
  const list = [];
  (Array.isArray(layout?.blocks) ? layout.blocks : []).forEach((b, bi) => {
    const rows = Number(b?.rows) || 0;
    const cols = Number(b?.cols) || 0;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) list.push({ id: `b${bi}-r${r}-c${c}`, b: bi, r, c });
  });
  return list;
}

export function repairSeating({ assignment = {}, students = [], layout, fixedSeats = {}, roleSeats = {}, roleAssignment = {} } = {}) {
  const seatList = layoutSeats(layout);
  const seatIds = seatList.map((s) => s.id);
  const inLayout = new Set(seatIds);
  const ids = [...new Set((Array.isArray(students) ? students : []).map((s) => (typeof s === 'string' ? s : s?.id)).filter(Boolean).map(String))];
  const known = new Set(ids);

  const seats = {};
  const placed = new Set();
  const put = (seatId, sid) => { seats[seatId] = sid; placed.add(sid); };
  // AI 배정안에서 이 자리에 앉힌 학생 (명단에 있고 아직 자리가 없을 때만)
  const wanted = (seatId) => {
    const sid = assignment?.[seatId];
    return sid != null && known.has(String(sid)) && !placed.has(String(sid)) ? String(sid) : null;
  };
  const holdersOf = (roleId) => (Array.isArray(roleAssignment?.[roleId]) ? roleAssignment[roleId] : []).map(String).filter((sid) => known.has(sid));

  // 1) 고정 자리: 무조건 그 학생
  for (const [seatId, sid] of Object.entries(fixedSeats || {})) {
    const id = sid == null ? '' : String(sid);
    if (!inLayout.has(seatId) || !known.has(id) || placed.has(id) || seats[seatId]) continue;
    put(seatId, id);
  }

  // 2) 역할 자리: 먼저 AI 가 담당 학생을 맞게 앉힌 자리는 그대로 두고, 남은 역할 자리에는 아직 자리가 없는 담당 학생을 옮겨 앉힘
  const roleSeatIds = seatIds.filter((id) => roleSeats?.[id] && !seats[id]);
  for (const seatId of roleSeatIds) {
    const sid = wanted(seatId);
    if (sid && holdersOf(roleSeats[seatId]).includes(sid)) put(seatId, sid);
  }
  for (const seatId of roleSeatIds) {
    if (seats[seatId]) continue;
    const holder = holdersOf(roleSeats[seatId]).find((sid) => !placed.has(sid));
    if (holder) put(seatId, holder);
  }

  // 3) 나머지 자리는 AI 배정안대로 (겹치면 앞의 자리만, 담당이 없는 역할 자리는 보통 자리)
  for (const seatId of seatIds) {
    if (seats[seatId]) continue;
    const sid = wanted(seatId);
    if (sid) put(seatId, sid);
  }

  // 4) 자리가 없는 학생은 빈자리에 앞줄부터
  const empty = seatList.filter((s) => !seats[s.id]).sort((x, y) => x.r - y.r || x.b - y.b || x.c - y.c).map((s) => s.id);
  for (const sid of ids) {
    if (placed.has(sid)) continue;
    const seatId = empty.shift();
    if (!seatId) break;
    put(seatId, sid);
  }

  const warnings = [];
  const short = ids.filter((sid) => !placed.has(sid)).length;
  if (short) warnings.push(`자리가 ${short}개 부족해요.`);
  return { seats, warnings };
}
