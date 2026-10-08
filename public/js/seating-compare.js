// Pure, browser/server-test shared comparison. Every plan is evaluated against the same supplied observations.
const pairKey = (a, b) => [a, b].sort().join('|');

export function layoutSeatList(layout) {
  const list = [];
  (layout?.blocks || []).forEach((block, b) => {
    for (let r = 0; r < block.rows; r++) for (let c = 0; c < block.cols; c++) list.push({ id: `b${b}-r${r}-c${c}`, b, r, c });
  });
  return list;
}

export function adjacentSeatPairs(layout) {
  const pairs = [];
  const id = (b, r, c) => `b${b}-r${r}-c${c}`;
  (layout?.blocks || []).forEach((block, b, blocks) => {
    for (let r = 0; r < block.rows; r++) for (let c = 0; c < block.cols; c++) {
      if (c + 1 < block.cols) pairs.push([id(b, r, c), id(b, r, c + 1), 1]);
      if (r + 1 < block.rows) pairs.push([id(b, r, c), id(b, r + 1, c), 0.6]);
      if (r + 1 < block.rows && c + 1 < block.cols) pairs.push([id(b, r, c), id(b, r + 1, c + 1), 0.3]);
      if (r + 1 < block.rows && c > 0) pairs.push([id(b, r, c), id(b, r + 1, c - 1), 0.3]);
    }
    if (blocks[b + 1]) for (let r = 0; r < Math.min(block.rows, blocks[b + 1].rows); r++) pairs.push([id(b, r, block.cols - 1), id(b + 1, r, 0), 0.35]);
  });
  return pairs;
}

export function seatingMetrics(plan, { students = [], relations = [], rules = [], notes = {}, roleAssignment = {}, baseline = null } = {}) {
  if (!plan) return null;
  const known = new Set(students.map((s) => typeof s === 'string' ? s : s.id));
  const slots = layoutSeatList(plan.layout);
  const valid = new Set(slots.map((s) => s.id));
  const seatOf = {};
  for (const [seat, sid] of Object.entries(plan.seats || {})) if (valid.has(seat) && known.has(sid) && !seatOf[sid]) seatOf[sid] = seat;
  const badPairs = new Set(relations.filter((r) => r.type === 'bad').map((r) => pairKey(r.from, r.to)));
  const adjacent = new Set(adjacentSeatPairs(plan.layout).map(([a, b]) => pairKey(a, b)));
  const adjacentStudents = new Set();
  for (const [a, b] of adjacentSeatPairs(plan.layout)) {
    const sa = plan.seats?.[a], sb = plan.seats?.[b];
    if (known.has(sa) && known.has(sb) && sa !== sb) adjacentStudents.add(pairKey(sa, sb));
  }
  let apartViolations = 0, togetherViolations = 0, frontViolations = 0;
  for (const rule of rules) {
    const a = seatOf[rule.a], b = seatOf[rule.b];
    if (!a || !b) continue;
    const near = adjacent.has(pairKey(a, b));
    if (rule.type === 'apart' && near) apartViolations++;
    if (rule.type === 'together' && !near) togetherViolations++;
  }
  for (const [sid, note] of Object.entries(notes)) {
    if (note.front && seatOf[sid] && Number(seatOf[sid].split('-')[1].slice(1)) >= 2) frontViolations++;
  }
  const roleSlots = {};
  for (const [seat, roleId] of Object.entries(plan.roleSeats || {})) if (valid.has(seat)) (roleSlots[roleId] ||= []).push(seat);
  let roleViolations = 0;
  for (const [roleId, assignedSlots] of Object.entries(roleSlots)) {
    const holders = (roleAssignment[roleId] || []).filter((sid) => known.has(sid));
    const fulfilled = new Set(assignedSlots.map((seat) => plan.seats?.[seat]).filter((sid) => holders.includes(sid)));
    roleViolations += Math.max(0, Math.min(holders.length, assignedSlots.length) - fulfilled.size);
  }
  const baselineSeat = {};
  for (const [seat, sid] of Object.entries(baseline?.seats || {})) if (known.has(sid)) baselineSeat[sid] = seat;
  return { assigned: Object.keys(seatOf).length, unassigned: known.size - Object.keys(seatOf).length,
    badAdjacent: [...adjacentStudents].filter((key) => badPairs.has(key)).length,
    apartViolations, togetherViolations, ruleViolations: apartViolations + togetherViolations, frontViolations, roleViolations,
    moved: baseline ? [...known].filter((sid) => (baselineSeat[sid] || null) !== (seatOf[sid] || null)).length : null,
    layoutChanged: Boolean(baseline && JSON.stringify(baseline.layout) !== JSON.stringify(plan.layout)) };
}

/** Reapplying an AI proposal must obey the editor's current pins and role seats. */
export function repairSeatAssignment({ assignment = {}, students = [], layout, fixedSeats = {}, roleSeats = {}, roleAssignment = {} }) {
  const list = layoutSeatList(layout), valid = new Set(list.map((s) => s.id));
  const ids = [...new Set(students.map((s) => typeof s === 'string' ? s : s.id))], known = new Set(ids);
  const seats = {}, used = new Set();
  const put = (seat, sid) => { seats[seat] = sid; used.add(sid); };
  const holders = (roleId) => (roleAssignment[roleId] || []).filter((sid) => known.has(sid));
  for (const [seat, sid] of Object.entries(fixedSeats)) if (valid.has(seat) && known.has(sid) && !used.has(sid)) put(seat, sid);
  const roleSlotIds = list.map((s) => s.id).filter((seat) => roleSeats[seat] && !seats[seat]);
  for (const seat of roleSlotIds) {
    const sid = assignment[seat];
    if (known.has(sid) && !used.has(sid) && holders(roleSeats[seat]).includes(sid)) put(seat, sid);
  }
  for (const seat of roleSlotIds) {
    if (seats[seat]) continue;
    const sid = holders(roleSeats[seat]).find((id) => !used.has(id));
    if (sid) put(seat, sid);
  }
  for (const { id: seat } of list) {
    const sid = assignment[seat];
    if (!seats[seat] && known.has(sid) && !used.has(sid)) put(seat, sid);
  }
  const empty = list.filter((s) => !seats[s.id]).sort((a, b) => a.r - b.r || a.b - b.b || a.c - b.c).map((s) => s.id);
  for (const sid of ids) if (!used.has(sid) && empty.length) put(empty.shift(), sid);
  return { seats, unassigned: ids.filter((sid) => !used.has(sid)).length,
    adjusted: Object.entries(seats).filter(([seat, sid]) => assignment[seat] !== sid).length };
}

export function sameSeatConfig(a, b) {
  function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    return value;
  }
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}
