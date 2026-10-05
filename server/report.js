// 학급 종합 보고서: 관계도 분석 · 갈등 가능성 · AI 분석 · 자리 배정 · 1인 1역 · 회차별 변화를 한 문서 모델로 모읍니다.
// 결과는 웹 보고서 화면(public/js/report.js)과 한글·워드 내보내기(export-docs.js)가 함께 씁니다.
import { computeStats, analyzeConflicts } from './analysis.js';
import { analyzeHistory } from './history.js';
import { roundRoom } from './rounds.js';
import { roomRoles, applicantCounts } from './roles.js';

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

  // 3. 갈등 가능성 분석
  heading('갈등 가능성 분석');
  para('안 좋은 사이로 표시된 관계마다 앞으로 갈등이 생길 가능성을 응답 방향, 이유의 심각도, 공통 친구, 지목 횟수, 고립 여부로 어림한 참고용 수치예요. 학생을 판단하는 근거가 아니라 먼저 관심을 기울일 관계를 찾는 도구로 써 주세요.', 'muted');
  const flagged = analysis.pairs.filter((p) => p.ab === 'bad' || p.ba === 'bad');
  if (!flagged.length) para('안 좋은 사이로 표시된 관계가 아직 없어요.');
  else {
    const top = flagged.slice(0, 20);
    const direction = (p) => (p.ab === 'bad' && p.ba === 'bad' ? '서로 안 좋은 사이' : p.ab === 'bad' ? `${p.aName} → ${p.bName}` : `${p.bName} → ${p.aName}`);
    blocks.push({
      type: 'table',
      caption: `주의가 필요한 관계 (가능성 높은 순, ${top.length}쌍${flagged.length > top.length ? ` / 전체 ${flagged.length}쌍` : ''})`,
      columns: [{ label: '학생', width: 0.24 }, { label: '가능성', width: 0.1 }, { label: '수준', width: 0.1 }, { label: '방향', width: 0.2 }, { label: '주요 근거', width: 0.36 }],
      rows: top.map((p) => [bold(`${p.aName} ↔ ${p.bName}`), center(`${p.probability}%`), center(LEVEL_KO[p.level] || p.level), direction(p), (p.factors || []).slice(0, 3).map((f) => f.label).join(' · ')]),
      header: true,
    });
  }

  // 4. AI 분석
  const ai = round.aiAnalysis;
  if (ai) {
    heading('AI 분석');
    para(`AI가 학생 응답(가명 처리), 선생님 메모, 성향 설문, 지원서를 함께 읽고 쓴 내용이에요. ${String(ai.createdAt || '').slice(0, 10)} 기준이며 참고용이에요.`, 'muted');
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
      const roles = roomRoles(room);
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
  const seating = room.seating;
  const notes = room.teacherNotes || { students: {}, rules: [] };
  if (seating?.layout?.blocks?.length) {
    heading('자리 배정');
    para(`${String(seating.updatedAt || '').slice(0, 10)}에 저장한 자리표예요. 학생 시점(칠판이 위)으로 그렸어요.`, 'muted');
    blocks.push({
      type: 'seatmap',
      podium: 'top',
      blocks: seating.layout.blocks.map((b, bi) => ({
        cols: b.cols,
        rows: b.rows,
        cells: Array.from({ length: b.rows }, (_, r) => Array.from({ length: b.cols }, (_, c) => { const sid = seating.seats?.[`b${bi}-r${r}-c${c}`]; return sid ? nameOf(sid) : ''; })),
      })),
    });
    const seated = new Set(Object.values(seating.seats || {}));
    const unseated = students.filter((s) => !seated.has(s.id)).map((s) => s.name);
    if (unseated.length) para(`자리가 없는 학생: ${unseated.join(', ')}`, 'muted');
  }
  const memoLines = [];
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
  if (memoLines.length) {
    if (!seating?.layout?.blocks?.length) heading('선생님 메모 · 규칙');
    else sub('선생님 메모 · 규칙');
    list(memoLines);
  }

  // 6. 1인 1역
  const roles = roomRoles(room);
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
  const history = analyzeHistory(room);
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
      list([
        `새로 생긴 갈등 ${ch.newConflicts.length}쌍${ch.newConflicts.length ? `: ${ch.newConflicts.map(pairName).join(', ')}` : ''}`,
        `계속되는 갈등 ${ch.persistent.length}쌍${ch.persistent.length ? `: ${ch.persistent.map(pairName).join(', ')}` : ''}`,
        `해소된 갈등 ${ch.resolved.length}쌍${ch.resolved.length ? `: ${ch.resolved.map(pairName).join(', ')}` : ''}`,
        ch.improved.length ? `좋아진 학생: ${ch.improved.slice(0, 10).map((s) => s.name).join(', ')}` : '',
        ch.worsened.length ? `관심이 필요한 학생: ${ch.worsened.slice(0, 10).map((s) => s.name).join(', ')}` : '',
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
