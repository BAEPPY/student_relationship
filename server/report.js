// 학급 종합 보고서: 관계 관심 점수 · AI 분석 · 자리 배정 · 1인 1역 · 회차별 변화를 한 문서 모델로 모읍니다.
// 결과는 웹 보고서 화면(public/js/report.js)과 한글·워드 내보내기(export-docs.js)가 함께 씁니다.
import { computeStats, analyzeConflicts } from './analysis.js';
import { analyzeHistory } from './history.js';
import { roundRoom } from './rounds.js';
import { roomRoles, applicantCounts, bodyLabels, BODY_TRAITS } from './roles.js';
import { captureAnalysisContext, describeAnalysisContext } from './analysis-context.js';
import { seatingView } from './seating-history.js';

const pad2 = (n) => String(n).padStart(2, '0');
function dateLabel(d = new Date()) {
  const kst = new Date(d.getTime() + 9 * 3600000);
  return `${kst.getUTCFullYear()}.${pad2(kst.getUTCMonth() + 1)}.${pad2(kst.getUTCDate())}`;
}
const LEVEL_KO = { high: '높음', medium: '주의', low: '낮음' };
const REL_KO = { good: '좋은 사이', bad: '안 좋은 사이', none: '표시 없음' };
const center = (text) => ({ text: String(text), align: 'center' });
const bold = (text) => ({ text: String(text), bold: true });

/**
 * 보고서 문서 모델.
 * @param {{ room, round, reasons?: boolean, now?: Date }} input
 * @returns {{ title, subtitle, meta: string[], blocks: object[] }}
 */
export function reportDocument({ room, round, reasons = false, now = new Date() }) {
  const rr = roundRoom(room, round);
  const stats = computeStats(rr);
  const analysis = analyzeConflicts(rr, stats);
  const students = room.students;
  const nameOf = (id) => stats[id]?.name || students.find((s) => s.id === id)?.name || '(삭제된 학생)';
  const index = new Map(students.map((s, i) => [s.id, i + 1]));
  const blocks = [];
  let section = 0;
  const heading = (text) => blocks.push({ type: 'heading', text: `${++section}. ${text}`, level: 2 });
  const sub = (text) => blocks.push({ type: 'heading', text, level: 3 });
  const para = (text, style) => blocks.push({ type: 'paragraph', text, ...(style ? { style } : {}) });
  const list = (items) => { if (items.length) blocks.push({ type: 'list', items }); };
  const aiContext = (saved, kind = 'relationships', extra = null) => {
    const context = describeAnalysisContext(saved.provenance, captureAnalysisContext(room, round, { kind, extra }));
    const label = { fresh: '현재 입력과 일치', stale: '입력 변경 · 재분석 필요', unknown: '분석 당시 근거 확인 불가' }[context.status];
    const coverage = context.inputCoverage;
    const current = context.currentCoverage;
    para(`AI 분석 상태: ${label}.${coverage ? ` 분석 당시 제출 ${coverage.submitted}/${coverage.total}명(${coverage.percent}%).${coverage.complete ? '' : ' 미제출 응답이 있어 분석 자료가 부족해요.'}` : ' 이전 결과에는 분석 당시 제출 현황과 근거 기록이 없어요.'} 현재 제출 ${current.submitted}/${current.total}명(${current.percent}%).`, 'muted');
    if (context.evidence.length) {
      const counts = {};
      for (const evidence of context.evidence) counts[evidence.kind] = (counts[evidence.kind] || 0) + 1;
      const labels = { submission: '관계 설문 제출', relation: '관계 표시', profile: '성향 설문', application: '역할 지원서', 'teacher-note': '교사 메모', 'teacher-rule': '교사 규칙' };
      para(`분석 근거: ${Object.entries(counts).map(([key, count]) => `${labels[key] || key} ${count}건`).join(' · ')}${context.sourceUpdatedAt ? ` · 최근 응답·메모 기록 ${context.sourceUpdatedAt.replace('T', ' ').slice(0, 16)} (UTC)` : ''}.`, 'muted');
    }
  };

  // 1. 한눈에 보기
  heading('한눈에 보기');
  const high = analysis.pairs.filter((p) => p.level === 'high').length;
  const medium = analysis.pairs.filter((p) => p.level === 'medium').length;
  const pct = analysis.totalStudents ? Math.round((analysis.submittedCount / analysis.totalStudents) * 100) : 0;
  blocks.push({ type: 'stats', items: [
    { label: '제출', value: `${analysis.submittedCount} / ${analysis.totalStudents}명`, sub: `${pct}% 제출` },
    { label: '좋은 사이', value: `${analysis.goodCount}개`, sub: `서로 좋은 사이 ${analysis.mutualGood}쌍` },
    { label: '안 좋은 사이', value: `${analysis.badCount}개`, sub: `서로 안 좋은 사이 ${analysis.mutualBad}쌍` },
    { label: '주의가 필요한 관계', value: `${high + medium}쌍`, sub: `높음 ${high} · 주의 ${medium}` },
    { label: '고립 위험', value: `${analysis.isolated.length}명`, sub: analysis.isolated.length ? analysis.isolated.join(', ') : '좋은 사이로 지목받지 못한 학생이 없어요' },
  ] });
  if (analysis.submittedCount < analysis.totalStudents) {
    const pending = students.filter((s) => !stats[s.id].submitted).map((s) => s.name);
    para(`아직 제출하지 않은 학생 ${pending.length}명: ${pending.join(', ')}`, 'muted');
    para('자료 부족: 아직 제출하지 않은 학생의 관계는 알 수 없어요. 지목 수가 적거나 표시가 없다는 사실만으로 관계가 좋거나 갈등이 해소됐다고 판단하지 않아요.', 'muted');
  }

  // 2. 학생별 관계
  heading('학생별 관계');
  para('"받은"은 친구들이 나를 고른 수, "보낸"은 내가 고른 수예요. 표시 칸에는 고립 위험(좋은 사이로 지목받지 못함), 지목 많음(안 좋은 사이로 3명 이상이 지목), 갈등 많음(안 좋은 사이를 3명 이상 표시)을 적어요.', 'muted');
  const FLAG_KO = { isolated: '고립 위험', targeted: '지목 많음', 'many-conflicts': '갈등 많음' };
  blocks.push({
    type: 'table',
    columns: [{ label: '번호', width: 0.08 }, { label: '이름', width: 0.18 }, { label: '제출', width: 0.1 }, { label: '받은 ❤️', width: 0.12 }, { label: '받은 ⚡', width: 0.12 }, { label: '보낸 ❤️', width: 0.12 }, { label: '보낸 ⚡', width: 0.12 }, { label: '표시', width: 0.16 }],
    rows: students.map((s) => {
      const st = stats[s.id];
      const flags = (analysis.studentRisk[s.id]?.flags || []).map((f) => FLAG_KO[f] || f).join(', ');
      return [center(index.get(s.id)), bold(s.name), center(st.submitted ? '제출' : '미제출'), center(st.inGood.length), center(st.inBad.length), center(st.outGood.length), center(st.outBad.length), flags];
    }),
    header: true,
  });
  list([
    analysis.mostLiked.length ? `좋은 사이로 많이 지목된 학생: ${analysis.mostLiked.map((x) => `${x.name} ${x.count}명`).join(', ')}` : '',
    analysis.mostDisliked.length ? `안 좋은 사이로 많이 지목된 학생: ${analysis.mostDisliked.map((x) => `${x.name} ${x.count}명`).join(', ')}` : '',
  ].filter(Boolean));

  // 3. 관계 관심 점수
  heading('관계 관심 점수');
  para('응답 방향, 이유의 심각도, 공통 친구, 지목 횟수, 고립 여부를 정해진 규칙으로 합친 관심 점수(100점 척도)예요. 실제 갈등 발생 확률을 뜻하지 않아요. 제출률과 주요 근거를 함께 보고 먼저 살펴볼 관계를 찾는 참고자료로 써 주세요.', 'muted');
  const flagged = analysis.pairs.filter((p) => p.ab === 'bad' || p.ba === 'bad');
  if (!flagged.length) para('안 좋은 사이로 표시된 관계가 아직 없어요.');
  else {
    const top = flagged.slice(0, 20);
    const direction = (p) => (p.ab === 'bad' && p.ba === 'bad' ? '서로 안 좋은 사이' : p.ab === 'bad' ? `${p.aName} → ${p.bName}` : `${p.bName} → ${p.aName}`);
    blocks.push({
      type: 'table',
      caption: `주의가 필요한 관계 (관심 점수 높은 순, ${top.length}쌍${flagged.length > top.length ? ` / 전체 ${flagged.length}쌍` : ''})`,
      columns: [{ label: '학생', width: 0.22 }, { label: '관심 점수', width: 0.12 }, { label: '수준', width: 0.1 }, { label: '방향', width: 0.2 }, { label: '주요 근거 · 응답 범위', width: 0.36 }],
      rows: top.map((p) => {
        const submitted = Number(stats[p.a]?.submitted) + Number(stats[p.b]?.submitted);
        return [bold(`${p.aName} ↔ ${p.bName}`), center(`${p.attentionScore ?? p.probability}/100점`), center(LEVEL_KO[p.level] || p.level), direction(p), [(p.factors || []).slice(0, 3).map((f) => f.label).join(' · '), `두 학생 중 ${submitted}/2명 제출${submitted < 2 ? ' · 자료 부족' : ''}`].filter(Boolean).join('\n')];
      }),
      header: true,
    });
  }

  const roles = roomRoles(room);

  // 4. AI 분석
  const ai = round.aiAnalysis;
  if (ai) {
    heading('AI 분석');
    para(`AI가 학생 응답(가명 처리), 선생님 메모, 성향 설문, 지원서를 함께 읽고 쓴 내용이에요. ${String(ai.createdAt || '').slice(0, 10)} 기준이며 참고용이에요.`, 'muted');
    aiContext(ai);
    if (ai.summary) para(ai.summary);
    const pairs = (ai.pairs || []).filter((p) => stats[p.a] && stats[p.b]);
    if (pairs.length) {
      blocks.push({
        type: 'table',
        caption: `눈여겨볼 관계 (${pairs.length}쌍)`,
        columns: [{ label: '학생', width: 0.2 }, { label: '위험도', width: 0.1 }, { label: '갈등 성격', width: 0.14 }, { label: '분석', width: 0.28 }, { label: '교실에서 해 볼 일', width: 0.28 }],
        rows: pairs.map((p) => [bold(`${nameOf(p.a)} ↔ ${nameOf(p.b)}`), center(LEVEL_KO[p.riskLevel] || p.riskLevel), p.conflictType || '', p.analysis || '', p.advice || '']),
        header: true,
      });
    }
    const aiStudents = (ai.students || []).filter((s) => stats[s.id]);
    if (aiStudents.length) {
      const roleName = (id) => roles.find((r) => r.id === id)?.name || '(지워진 역할)';
      blocks.push({
        type: 'table',
        caption: '학생별 AI 요약',
        columns: [{ label: '이름', width: 0.14 }, { label: '요약', width: 0.3 }, { label: '강점', width: 0.18 }, { label: '살펴볼 점', width: 0.18 }, { label: '잘 맞는 역할', width: 0.2 }],
        rows: aiStudents.map((s) => [bold(nameOf(s.id)), s.summary || '', s.strengths || '', s.watch || '', (s.roleFit || []).map((f) => roleName(f.roleId)).join(', ')]),
        header: true,
      });
    }
  }

  // 5. 자리 배정
  const seating = seatingView(room, round).seating;
  const notes = room.teacherNotes || { students: {}, rules: [] };
  const CLIMATE_KO = { cool: '지금 냉방 중 (바람 자리가 시원함)', warm: '지금 난방 중 (바람 자리가 따뜻함)', off: '지금은 꺼짐' };
  // 🎒 역할 자리(seating.roleSeats: 좌석 → 역할 id): 이번 회차에 그 역할을 맡은 학생이 앉는 자리. 배치 안에 있고 역할이 아직 있는 것만, 분단 → 줄 → 칸 순서
  const roleNameOf = (id) => roles.find((r) => r.id === id)?.name || '';
  const roleHolders = (roleId) => (round.roleAssignment?.assignments?.[roleId] || []).filter((sid) => stats[sid]).map(nameOf);
  const seatPos = (seatId) => { const m = /^b(\d+)-r(\d+)-c(\d+)$/.exec(String(seatId)); return m ? { b: Number(m[1]), r: Number(m[2]), c: Number(m[3]) } : null; };
  const inLayout = (p) => Boolean(p && seating?.layout?.blocks?.[p.b] && p.r < seating.layout.blocks[p.b].rows && p.c < seating.layout.blocks[p.b].cols);
  const seatLabel = (p) => `${p.b + 1}분단 ${p.r + 1}번째 줄 ${p.c + 1}번째 자리`;
  const roleSeatList = Object.entries(seating?.roleSeats || {})
    .map(([seatId, roleId]) => ({ seatId, roleId, pos: seatPos(seatId) }))
    .filter((x) => inLayout(x.pos) && roleNameOf(x.roleId))
    .sort((x, y) => x.pos.b - y.pos.b || x.pos.r - y.pos.r || x.pos.c - y.pos.c);
  const hasSeatmap = Boolean(seating?.layout?.blocks?.length);
  if (hasSeatmap) {
    heading('자리 배정');
    const zoneCount = Object.values(seating.zones || {}).filter((z) => z === 'ac').length;
    para(`${String(seating.updatedAt || '').slice(0, 10)}에 저장한 자리표예요. 학생 시점(칠판이 위)으로 그렸어요.${zoneCount ? ` 🌀 표시는 냉난방기 바람 자리(${zoneCount}개) · ${CLIMATE_KO[seating.climate] || CLIMATE_KO.off}.` : ''}${roleSeatList.length ? ` 🎒 표시는 1인 1역 담당 학생이 앉는 역할 자리(${roleSeatList.length}개)예요.` : ''}`, 'muted');
    const roleAt = new Map(roleSeatList.map((x) => [x.seatId, roleNameOf(x.roleId)]));
    blocks.push({
      type: 'seatmap',
      podium: 'top',
      climate: seating.climate || 'off',
      blocks: seating.layout.blocks.map((b, bi) => ({
        cols: b.cols,
        rows: b.rows,
        cells: Array.from({ length: b.rows }, (_, r) => Array.from({ length: b.cols }, (_, c) => { const sid = seating.seats?.[`b${bi}-r${r}-c${c}`]; return sid ? nameOf(sid) : ''; })),
        zones: Array.from({ length: b.rows }, (_, r) => Array.from({ length: b.cols }, (_, c) => seating.zones?.[`b${bi}-r${r}-c${c}`] || '')),
        roles: Array.from({ length: b.rows }, (_, r) => Array.from({ length: b.cols }, (_, c) => roleAt.get(`b${bi}-r${r}-c${c}`) || '')),
      })),
    });
    const seated = new Set(Object.values(seating.seats || {}));
    const unseated = students.filter((s) => !seated.has(s.id)).map((s) => s.name);
    if (unseated.length) para(`자리가 없는 학생: ${unseated.join(', ')}`, 'muted');
  }
  const memoLines = [];
  // 학생이 고른 몸 특징 (보통은 제외)
  for (const t of BODY_TRAITS) {
    for (const opt of t.options) {
      if (!opt.short) continue;
      const names = students.filter((s) => s.body?.[t.id] === opt.id).map((s) => s.name);
      if (names.length) memoLines.push(`${opt.icon ? `${opt.icon} ` : ''}${opt.label.replace(/이에요$/, '')}: ${names.join(', ')}`);
    }
  }
  for (const s of students) {
    const n = notes.students?.[s.id];
    if (!n) continue;
    if (n.front) memoLines.push(`👓 앞자리 필요: ${s.name}`);
    if (n.memo) memoLines.push(`📝 ${s.name}: ${n.memo}`);
  }
  for (const r of notes.rules || []) {
    if (!stats[r.a] || !stats[r.b]) continue;
    memoLines.push(`${r.type === 'together' ? '⇢ 가까이 앉히기' : '↔ 떨어뜨리기'}: ${nameOf(r.a)} · ${nameOf(r.b)}${r.note ? ` (${r.note})` : ''}`);
  }
  for (const x of roleSeatList) {
    const who = roleHolders(x.roleId);
    memoLines.push(`🎒 역할 자리: ${roleNameOf(x.roleId)} → ${seatLabel(x.pos)} (담당: ${who.length ? who.join(', ') : '아직 없음'})`);
  }
  if (memoLines.length) {
    if (!hasSeatmap) heading('자리 배정 참고 (학생 특징 · 선생님 메모 · 규칙)');
    else sub('자리 배정 참고 (학생 특징 · 선생님 메모 · 규칙)');
    list(memoLines);
  }
  // 🤖 AI 자리 배정 메모: 이 회차 기준으로 만든 배정안(room.aiSeating)이 있을 때만, 자리 배정 섹션 끝에
  const aiSeat = round.aiSeating || (room.aiSeating && room.aiSeating.roundId === round.id ? room.aiSeating : null);
  if (aiSeat) {
    if (!hasSeatmap && !memoLines.length) {
      heading('자리 배정');
      para('아직 저장한 자리표가 없어요. 자리 배정 페이지에서 배정안을 확인한 뒤 저장하면 자리표가 여기에 들어가요.', 'muted');
    }
    sub('AI 자리 배정 메모');
    para(`${String(aiSeat.createdAt || '').slice(0, 10)}에 AI가 만든 자리 배정안의 메모예요(${aiSeat.roundName || round.name} 기준${aiSeat.model ? ` · ${aiSeat.model}` : ''}). 자리 배정 페이지에서 "AI 배정안 다시 적용"을 누르면 다시 불러올 수 있고, 참고용이에요.${aiSeat.truncated ? ' 자료가 길어 AI에 보낸 내용 일부가 생략됐어요.' : ''}`, 'muted');
    aiContext(aiSeat, 'seating', aiSeat.inputConfig || null);
    const warnings = (aiSeat.warnings || []).filter(Boolean);
    if (warnings.length) para(`확인할 점: ${warnings.join(' ')}`, 'muted');
    if (aiSeat.notes) para(String(aiSeat.notes));
    const aiPairs = (aiSeat.pairs || []).filter((p) => stats[p.a] && stats[p.b]).sort((x, y) => (Number(y.probability) || 0) - (Number(x.probability) || 0));
    if (aiPairs.length) {
      const top = aiPairs.slice(0, 10);
      blocks.push({
        type: 'table',
        caption: `AI 관계 관심 점수 (높은 순, ${top.length}쌍${aiPairs.length > top.length ? ` / 전체 ${aiPairs.length}쌍` : ''})`,
        columns: [{ label: '학생', width: 0.26 }, { label: '관심 점수', width: 0.14 }, { label: '이유', width: 0.6 }],
        rows: top.map((p) => [bold(`${nameOf(p.a)} ↔ ${nameOf(p.b)}`), center(`${Math.round(Number(p.attentionScore ?? p.probability) || 0)}/100점`), p.reason || '']),
        header: true,
      });
    } else para('AI가 별도로 관심을 제안한 학생 쌍이 없어요. 갈등이 없다는 뜻은 아니에요.', 'muted');
  }

  // 6. 1인 1역
  const assignment = round.roleAssignment;
  if (roles.length) {
    heading('1인 1역');
    const apps = round.applications || {};
    const profiles = round.profiles || {};
    const counts = applicantCounts(roles, apps);
    para(`역할 ${roles.length}개(${roles.reduce((n, r) => n + r.slots, 0)}자리) · 지원서 ${Object.keys(apps).length}/${students.length}명 · 성향 설문 ${Object.keys(profiles).length}/${students.length}명${assignment ? ` · 배정 ${assignment.published ? '공개됨' : '초안'}` : ' · 아직 배정 전'}`, 'muted');
    if (assignment?.assignments) {
      const placed = new Set();
      blocks.push({
        type: 'table',
        caption: '이번 달 배정표 (번호는 명단 순서)',
        columns: [{ label: '역할명', width: 0.3 }, { label: '인원', width: 0.1 }, { label: '지원', width: 0.1 }, { label: '담당 학생', width: 0.5 }],
        rows: roles.map((r) => {
          const sids = assignment.assignments[r.id] || [];
          sids.forEach((id) => placed.add(id));
          const empty = Math.max(0, r.slots - sids.length);
          const who = [sids.map((id) => `${index.get(id) ?? '?'} ${nameOf(id)}`).join('   '), empty ? `(빈자리 ${empty})` : ''].filter(Boolean).join('\n');
          return [bold(r.subtitle ? `${r.name}\n${r.subtitle}` : r.name), center(`${r.slots}명`), center(counts[r.id]?.total ?? 0), who];
        }),
        header: true,
      });
      const unassigned = students.filter((s) => !placed.has(s.id)).map((s) => `${index.get(s.id)} ${s.name}`);
      if (unassigned.length) para(`아직 배정되지 않은 학생 ${unassigned.length}명: ${unassigned.join(', ')}`, 'muted');
      if (reasons && assignment.explanations) {
        blocks.push({
          type: 'table',
          caption: '학생별 배정 이유 (선생님 참고용)',
          columns: [{ label: '번호', width: 0.08 }, { label: '이름', width: 0.16 }, { label: '역할', width: 0.26 }, { label: '배정 이유', width: 0.5 }],
          rows: students.map((s) => {
            const rid = Object.keys(assignment.assignments).find((k) => (assignment.assignments[k] || []).includes(s.id));
            return [center(index.get(s.id)), s.name, roles.find((r) => r.id === rid)?.name || '(미배정)', assignment.explanations[s.id] || ''];
          }),
          header: true,
        });
      }
    } else {
      para('아직 배정하지 않았어요. 1인 1역 페이지에서 규칙 배정이나 AI 배정을 돌린 뒤 저장하면 여기에 들어가요.');
    }
  }

  // 7. 회차별 변화
  const roundIndex = room.rounds.findIndex((item) => item.id === round.id);
  const history = analyzeHistory({ ...room, rounds: roundIndex >= 0 ? room.rounds.slice(0, roundIndex + 1) : [round] });
  if ((history.trend || []).length >= 2) {
    heading('회차별 변화');
    blocks.push({
      type: 'table',
      caption: '회차별 추세',
      columns: [{ label: '회차', width: 0.22 }, { label: '제출', width: 0.13 }, { label: '좋은 사이', width: 0.13 }, { label: '안 좋은 사이', width: 0.13 }, { label: '서로 안 좋음', width: 0.13 }, { label: '고립', width: 0.13 }, { label: '높음', width: 0.13 }],
      rows: history.trend.map((t) => [bold(t.name), center(`${t.submitted}/${t.total}`), center(t.good), center(t.bad), center(t.mutualBad), center(t.isolated), center(t.highRisk)]),
      header: true,
    });
    const ch = history.changes;
    if (ch) {
      const pairName = (p) => `${p.aName} ↔ ${p.bName}`;
      para(`${ch.prevName} → ${ch.lastName} 비교`, 'muted');
      para(ch.comparison.description, 'muted');
      list([
        `새로 생긴 갈등 ${ch.newConflicts.length}쌍${ch.newConflicts.length ? `: ${ch.newConflicts.map(pairName).join(', ')}` : ''}`,
        `계속되는 갈등 ${ch.persistent.length}쌍${ch.persistent.length ? `: ${ch.persistent.map(pairName).join(', ')}` : ''}`,
        `해소된 갈등 ${ch.resolved.length}쌍${ch.resolved.length ? `: ${ch.resolved.map(pairName).join(', ')}` : ''}`,
        `판단 보류 관계 ${ch.pending.length}쌍`,
        ...ch.pending.map((p) => `${pairName(p)}: ${p.reason}`),
        ch.improved.length ? `좋아진 학생: ${ch.improved.slice(0, 10).map((s) => s.name).join(', ')}` : '',
        ch.worsened.length ? `관심이 필요한 학생: ${ch.worsened.slice(0, 10).map((s) => s.name).join(', ')}` : '',
        `학생 변화 판단 보류 ${ch.studentPending.length}명`,
        ...ch.studentPending.map((s) => `${s.name}: ${s.reason}`),
      ].filter(Boolean));
    }
  }

  para('학생 이름과 응답은 개인정보예요. 보고서를 인쇄하거나 파일로 보관할 때는 다른 사람이 보지 않도록 조심해 주세요. 수치와 AI 분석은 참고용이며, 학생을 판단하는 근거가 아니에요.', 'note');

  return {
    title: `${room.name} ${round.name} 학급 종합 보고서`,
    subtitle: `만든 날짜 ${dateLabel(now)} · 응답 ${analysis.submittedCount}/${analysis.totalStudents}명 · 학생 관계 마인드맵`,
    meta: [],
    blocks,
  };
}
