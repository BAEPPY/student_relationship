// 학생별 상담 보고서: 한 학생의 회차별 관계 변화 · 돌아보기 · 성향 · 역할 · AI 학급 분석 발췌 · 상담 기록 · AI 상담 도움말을
// 한 문서 모델로 모읍니다. (학급 전체 보고서는 server/report.js)
import { createHash } from 'node:crypto';
import { computeStats, analyzeConflicts } from './analysis.js';
import { roundRoom } from './rounds.js';
import { TRAITS, roomRoles } from './roles.js';
import { tagLabel } from './reasons.js';
import { classScore } from './history.js';
import { detectGroups } from './cliques.js';

const MAX_ROUNDS = 8;                 // 보고서·AI 에 넣는 최근 회차 수
const MAX_FOLLOWUPS = 20;
const LEVEL_KO = { high: '높음', medium: '주의', low: '낮음' };
const TREND_KO = { new: '이번에 새로', continuing: '계속됨', improving: '나아지는 중', resolved: '이번엔 사라짐', unclear: '판단 어려움' };
const FLAG_KO = { isolated: '고립 위험', targeted: '여러 명이 안 좋게 지목', 'many-conflicts': '안 좋은 사이 다수 표시' };
const SCORE_FACE = ['', '😢', '😕', '😐', '🙂', '😄'];
const traitLabel = new Map(TRAITS.map((t) => [t.id, t.label]));
const pad2 = (n) => String(n).padStart(2, '0');
function dateLabel(d = new Date()) {
  const kst = new Date(new Date(d).getTime() + 9 * 3600 * 1000);
  return `${kst.getUTCFullYear()}.${pad2(kst.getUTCMonth() + 1)}.${pad2(kst.getUTCDate())}`;
}
const center = (text) => ({ text: String(text), align: 'center' });
const bold = (text) => ({ text: String(text), bold: true });

/**
 * 한 학생의 회차별 자료 (오래된 순, 최근 maxRounds 개). 보고서와 AI 상담 분석이 같은 자료를 씁니다.
 * 관계는 { id(상대), type, tags, reason } 로, 지금 명단에 있는 학생만 담습니다.
 */
export function studentTimeline(room, studentId, { maxRounds = MAX_ROUNDS } = {}) {
  const roles = roomRoles(room);
  return (room.rounds || []).slice(-maxRounds).map((r) => {
    const rr = roundRoom(room, r);
    const stats = computeStats(rr);
    const analysis = analyzeConflicts(rr, stats);
    const st = stats[studentId];
    const rel = (from, to) => {
      const x = r.relations?.[from]?.[to];
      return { type: x?.type || 'none', tags: x?.tags || [], reason: String(x?.reason || '').trim() };
    };
    const received = (ids) => ids.map((id) => ({ id, ...rel(id, studentId) }));
    const given = (ids) => ids.map((id) => ({ id, ...rel(studentId, id) }));
    const assigned = [];
    if (r.roleAssignment?.published) {
      for (const [roleId, sids] of Object.entries(r.roleAssignment.assignments || {})) if ((sids || []).includes(studentId)) assigned.push(roleId);
    }
    const ai = r.aiAnalysis || null;
    return {
      id: r.id, name: r.name, open: !r.closedAt, startedAt: r.startedAt || null, closedAt: r.closedAt || null,
      submitted: Boolean(st?.submitted), submittedAt: st?.submittedAt || null,
      submittedIds: room.students.filter((s) => stats[s.id]?.submitted).map((s) => s.id),
      classSubmitted: analysis.submittedCount, total: room.students.length,
      inGood: received(st?.inGood || []), inBad: received(st?.inBad || []),
      outGood: given(st?.outGood || []), outBad: given(st?.outBad || []),
      flags: analysis.studentRisk?.[studentId]?.flags || [],
      pairs: analysis.pairs.filter((p) => (p.a === studentId || p.b === studentId) && (p.ab === 'bad' || p.ba === 'bad'))
        .map((p) => ({ other: p.a === studentId ? p.b : p.a, probability: p.probability, level: p.level })),
      closer: r.closerFriends?.[studentId] || null,
      classScore: classScore(r, room.students),
      profile: r.profiles?.[studentId] || null,
      application: r.applications?.[studentId] || null,
      assignedRoles: assigned.map((id) => roles.find((x) => x.id === id)?.name || '(지워진 역할)'),
      ai: ai ? {
        createdAt: ai.createdAt || null,
        student: (ai.students || []).find((s) => s.id === studentId) || null,
        pairs: (ai.pairs || []).filter((p) => p.a === studentId || p.b === studentId),
      } : null,
    };
  });
}

/** 이 학생의 상담·관찰 기록 (최근 것부터) */
export function studentFollowups(room, studentId, limit = MAX_FOLLOWUPS) {
  return (room.followups || []).filter((f) => (f.studentIds || []).includes(studentId))
    .sort((a, b) => String(b.observedDate).localeCompare(String(a.observedDate)) || String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, limit)
    .map((f) => ({ id: f.id, observedDate: f.observedDate, observation: f.observation || '', action: f.action || '', nextCheckDate: f.nextCheckDate || null, status: f.status, studentIds: f.studentIds || [] }));
}

/** AI 상담 도움말을 만들 때의 입력 지문 — 그 뒤 자료가 바뀌었는지 알려 주는 용도 (원문은 저장하지 않음) */
export function studentReportFingerprint(room, studentId) {
  const student = room.students.find((s) => s.id === studentId);
  const timeline = studentTimeline(room, studentId).map(({ ai, ...round }) => ({
    ...round,
    ai: ai ? { student: ai.student, pairs: ai.pairs } : null,
  }));
  const notes = room.teacherNotes || {};
  const snapshot = {
    name: student?.name || '', roster: room.students.map((s) => [s.id, s.name]),
    timeline,
    memo: notes.students?.[studentId] || null,
    rules: (notes.rules || []).filter((r) => r.a === studentId || r.b === studentId),
    followups: studentFollowups(room, studentId),
  };
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

/** 두 회차 사이에 달라진 점 (두 회차 모두 응답한 친구의 표시만 비교) */
function changesBetween(prev, last, nameOf) {
  const both = new Set(prev.submittedIds.filter((id) => last.submittedIds.includes(id)));
  const ids = (list) => new Set(list.filter((x) => both.has(x.id)).map((x) => x.id));
  const diff = (a, b) => [...b].filter((id) => !a.has(id)).map(nameOf);
  const lines = [];
  const add = (label, names) => { if (names.length) lines.push(`${label}: ${names.join(', ')}`); };
  add('새로 나를 안 좋은 사이로 표시한 친구', diff(ids(prev.inBad), ids(last.inBad)));
  add('나를 안 좋은 사이로 표시하지 않게 된 친구', diff(ids(last.inBad), ids(prev.inBad)));
  add('새로 나를 좋은 사이로 표시한 친구', diff(ids(prev.inGood), ids(last.inGood)));
  add('나를 좋은 사이로 표시하지 않게 된 친구', diff(ids(last.inGood), ids(prev.inGood)));
  if (prev.submitted && last.submitted) {
    const mine = (list) => new Set(list.map((x) => x.id));
    add('내가 새로 안 좋은 사이로 표시한 친구', diff(mine(prev.outBad), mine(last.outBad)));
    add('내가 안 좋은 사이 표시를 거둔 친구', diff(mine(last.outBad), mine(prev.outBad)));
  }
  return { lines, comparable: both.size, mineComparable: prev.submitted && last.submitted };
}

/**
 * 학생별 상담 보고서 문서 모델.
 * @param {{ room, studentId, now?: Date, followups?: boolean, ai?: boolean }} input
 * @returns {{ title, subtitle, meta: string[], blocks: object[] } | null} 학생이 없으면 null
 */
export function studentReportDocument({ room, studentId, now = new Date(), followups = true, ai = true }) {
  const student = room.students.find((s) => s.id === studentId);
  if (!student) return null;
  const nameOf = (id) => room.students.find((s) => s.id === id)?.name || '(삭제된 학생)';
  const names = (list) => list.map((x) => nameOf(x.id));
  const timeline = studentTimeline(room, studentId);
  const last = timeline[timeline.length - 1] || null;
  const blocks = [];
  let section = 0;
  const heading = (text) => blocks.push({ type: 'heading', text: `${++section}. ${text}`, level: 2 });
  const sub = (text) => blocks.push({ type: 'heading', text, level: 3 });
  const para = (text, style) => blocks.push({ type: 'paragraph', text, ...(style ? { style } : {}) });
  const list = (items) => { if (items.length) blocks.push({ type: 'list', items }); };
  const withReason = (x) => `${nameOf(x.id)}${[...(x.tags || []).map((t) => tagLabel(x.type, t)), x.reason].filter(Boolean).length ? ` — ${[...(x.tags || []).map((t) => tagLabel(x.type, t)), x.reason ? `“${x.reason}”` : ''].filter(Boolean).join(', ')}` : ''}`;

  // 1. 한눈에 보기
  heading('한눈에 보기');
  if (last) {
    const score = last.closer?.score;
    blocks.push({ type: 'stats', items: [
      { label: '받은 좋은 사이', value: `${last.inGood.length}명`, sub: `${last.name} 기준` },
      { label: '받은 안 좋은 사이', value: `${last.inBad.length}명`, sub: last.flags.length ? last.flags.map((f) => FLAG_KO[f] || f).join(' · ') : '특이 표시 없음' },
      { label: '보낸 좋은 사이', value: `${last.outGood.length}명`, sub: last.submitted ? '본인 응답' : '아직 제출 전' },
      { label: '보낸 안 좋은 사이', value: `${last.outBad.length}명`, sub: last.submitted ? '본인 응답' : '아직 제출 전' },
      { label: '우리 반 점수', value: Number.isInteger(score) ? `${SCORE_FACE[score]} ${score}/5` : '–', sub: last.classScore.scoreCount ? `학급 평균 ${last.classScore.scoreAvg} (${last.classScore.scoreCount}명)` : '학급 응답 없음' },
    ] });
    para(`${last.name} 회차 기준이에요. 학급 제출 ${last.classSubmitted}/${last.total}명${last.submitted ? '' : ` · ${student.name} 학생은 이 회차에 아직 제출하지 않았어요`}. 받은 관계는 응답한 친구의 표시만 셉니다.`, 'muted');
  } else {
    para('아직 조사 회차가 없어요.', 'muted');
  }

  // 2. 회차별 변화
  heading('회차별 변화');
  if (timeline.length) {
    blocks.push({ type: 'chart', caption: '받은 좋은 사이 · 안 좋은 사이 (회차별)', labels: timeline.map((t) => t.name.replace(/^\d{4}년 /, '')), series: [
      { label: '받은 좋은 사이', kind: 'good', values: timeline.map((t) => t.inGood.length) },
      { label: '받은 안 좋은 사이', kind: 'bad', values: timeline.map((t) => t.inBad.length) },
    ] });
    blocks.push({
      type: 'table',
      caption: `회차별 관계 수 (${timeline.length}개 회차)`,
      columns: [{ label: '회차', width: 0.2 }, { label: '제출', width: 0.1 }, { label: '받은 좋은', width: 0.11 }, { label: '받은 안 좋은', width: 0.12 }, { label: '보낸 좋은', width: 0.11 }, { label: '보낸 안 좋은', width: 0.12 }, { label: '우리 반 점수', width: 0.12 }, { label: '표시', width: 0.12 }],
      rows: timeline.map((t) => [bold(t.name), center(t.submitted ? '제출' : '미제출'), center(t.inGood.length), center(t.inBad.length), center(t.submitted ? t.outGood.length : '–'), center(t.submitted ? t.outBad.length : '–'),
        center(Number.isInteger(t.closer?.score) ? `${t.closer.score}/5` : '–'), t.flags.map((f) => FLAG_KO[f] || f).join(', ')]),
      header: true,
    });
    if (timeline.length >= 2) {
      const prev = timeline[timeline.length - 2];
      const ch = changesBetween(prev, last, nameOf);
      sub(`${prev.name} → ${last.name} 달라진 점`);
      if (ch.lines.length) list(ch.lines);
      else para(ch.comparable ? '두 회차 모두 응답한 친구들의 표시에서는 달라진 점이 없어요.' : '두 회차 모두 응답한 친구가 없어 비교할 수 없어요.', 'muted');
      para(`받은 관계는 두 회차 모두 응답한 친구 ${ch.comparable}명의 표시만 비교했어요.${ch.mineComparable ? '' : ` ${student.name} 학생이 두 회차 모두 제출하지 않아 보낸 관계는 비교하지 않았어요.`}`, 'muted');
    }
  } else para('아직 조사 회차가 없어요.', 'muted');

  // 3. 관계 상세 (최근 회차)
  if (last) {
    heading(`관계 상세 (${last.name})`);
    sub(`나를 좋은 사이로 표시한 친구 (${last.inGood.length})`);
    if (last.inGood.length) list(last.inGood.map(withReason)); else para('없어요.', 'muted');
    sub(`나를 안 좋은 사이로 표시한 친구 (${last.inBad.length})`);
    if (last.inBad.length) list(last.inBad.map(withReason)); else para('없어요.', 'muted');
    sub(`내가 좋은 사이로 표시한 친구 (${last.outGood.length})`);
    if (last.outGood.length) list(last.outGood.map(withReason)); else para(last.submitted ? '없어요.' : '아직 제출하지 않았어요.', 'muted');
    sub(`내가 안 좋은 사이로 표시한 친구 (${last.outBad.length})`);
    if (last.outBad.length) list(last.outBad.map(withReason)); else para(last.submitted ? '없어요.' : '아직 제출하지 않았어요.', 'muted');
    // 친한 무리: 학급 전체에서 좋은 사이로 뭉친 무리 가운데 이 학생이 든 곳 (보고서에서만 계산 — AI 입력 지문에는 넣지 않아요)
    const lastRound = (room.rounds || []).find((r) => r.id === last.id);
    const cliques = lastRound ? detectGroups(roundRoom(room, lastRound)) : null;
    if (cliques?.groups.length) {
      sub('친한 무리 (규칙 기반 추정)');
      const group = cliques.groups.find((g) => g.members.includes(studentId));
      if (group) {
        const mates = group.members.filter((id) => id !== studentId).map(nameOf);
        const clashes = cliques.between.filter((b) => b.a === group.id || b.b === group.id)
          .map((b) => `무리 ${b.a === group.id ? b.b : b.a}와(과) ${b.bad}건`);
        para(`좋은 사이 표시를 따라 묶어 보면 ${mates.join(', ')} 학생과 같은 무리예요 (무리 ${group.id} · ${group.members.length}명 · 서로 좋은 사이 ${group.mutual}쌍).${group.internalBad ? ` 이 무리 안에 안 좋은 사이로 표시한 쌍이 ${group.internalBad}쌍 있어요.` : ''}${clashes.length ? ` 이 무리와 다른 무리 사이의 안 좋은 사이: ${clashes.join(', ')}.` : ''}`);
      } else {
        para(`좋은 사이로 이어진 친구가 없어 어느 무리에도 들지 않았어요.${last.submitted ? '' : ' 아직 제출하지 않아서일 수 있어요.'}`);
      }
      para('무리는 학급 전체 응답을 규칙으로 묶은 참고용 추정이에요. 실제 어울리는 모습과 다를 수 있어요.', 'muted');
    }
    if (last.pairs.length) {
      sub('관계 관심 점수 (규칙 기반 · 발생 확률 아님)');
      list(last.pairs.map((p) => `${nameOf(p.other)}: ${p.probability}/100점 (${LEVEL_KO[p.level] || p.level})`));
    }
  }

  // 4. 돌아보기
  heading('돌아보기 (학생이 직접 적음)');
  const reviews = [...timeline].reverse().map((t) => {
    const c = t.closer;
    if (!c) return '';
    const parts = [];
    if (Number.isInteger(c.score)) parts.push(`우리 반 점수 ${c.score}/5${t.classScore.scoreCount ? ` (학급 평균 ${t.classScore.scoreAvg})` : ''}`);
    if (c.review) parts.push(`한 달은: “${c.review}”`);
    const friends = (c.ids || []).filter((id) => room.students.some((s) => s.id === id)).map(nameOf);
    if (friends.length || c.text) parts.push(`친해진 친구: ${friends.length ? friends.join(', ') : '(고른 친구 없음)'}${c.text ? ` — “${c.text}”` : ''}`);
    return parts.length ? `${t.name} · ${parts.join(' · ')}` : '';
  }).filter(Boolean);
  if (reviews.length) list(reviews); else para('돌아보기를 적은 회차가 없어요.', 'muted');

  // 5. 성향 · 1인 1역
  heading('성향 · 1인 1역');
  const withProfile = [...timeline].reverse().find((t) => t.profile);
  if (withProfile) {
    const p = withProfile.profile;
    const traits = (p.traits || []).map((t) => traitLabel.get(t) || t);
    const partner = (p.partnerTraits || []).map((t) => traitLabel.get(t) || t);
    list([
      `나의 성향 (${withProfile.name}): ${traits.length ? traits.join(', ') : '고른 항목 없음'}`,
      partner.length ? `짝에게 바라는 점: ${partner.join(', ')}` : '',
      p.partnerText ? `짝에 대한 생각: “${p.partnerText}”` : '',
    ].filter(Boolean));
  } else para('성향 설문을 낸 회차가 없어요.', 'muted');
  const roles = roomRoles(room);
  const roleName = (id) => roles.find((r) => r.id === id)?.name || '(지워진 역할)';
  const held = (room.roleHistory || []).map((h) => {
    const mine = Object.entries(h.assignments || {}).filter(([, sids]) => (sids || []).includes(studentId)).map(([roleId]) => roleName(roleId));
    return mine.length ? `${h.month}: ${mine.join(', ')}` : '';
  }).filter(Boolean);
  const withApp = [...timeline].reverse().find((t) => (t.application?.choices || []).length);
  const roleLines = [
    held.length ? `맡았던 역할 — ${held.join(' · ')}` : '',
    withApp ? `지원서 (${withApp.name}) — ${withApp.application.choices.map((c, i) => `${i + 1}지망 ${roleName(c.roleId)}${c.reason ? ` “${c.reason}”` : ''}`).join(' / ')}` : '',
  ].filter(Boolean);
  if (roleLines.length) list(roleLines); else para('1인 1역 기록이 없어요.', 'muted');

  // 6. AI 학급 분석에서 본 이 학생
  const withAi = [...timeline].reverse().find((t) => t.ai && (t.ai.student || t.ai.pairs.length));
  if (withAi) {
    heading('AI 학급 분석에서 본 이 학생');
    para(`${withAi.name} 회차의 학급 AI 분석(${String(withAi.ai.createdAt || '').slice(0, 10)})에서 이 학생 부분만 옮겼어요. 참고용이에요.`, 'muted');
    const s = withAi.ai.student;
    if (s) list([
      s.summary ? `요약: ${s.summary}` : '',
      s.strengths ? `강점: ${s.strengths}` : '',
      s.watch ? `살펴볼 점: ${s.watch}` : '',
      s.trend ? `지난 회차와 견주면: ${s.trend}` : '',
      (s.roleFit || []).length ? `잘 맞는 역할: ${s.roleFit.map((f) => roleName(f.roleId)).join(', ')}` : '',
    ].filter(Boolean));
    const pairs = withAi.ai.pairs.filter((p) => room.students.some((x) => x.id === (p.a === studentId ? p.b : p.a)));
    if (pairs.length) blocks.push({
      type: 'table',
      caption: `눈여겨볼 관계 (${pairs.length})`,
      columns: [{ label: '상대', width: 0.14 }, { label: '위험도', width: 0.09 }, { label: '흐름', width: 0.12 }, { label: '분석', width: 0.33 }, { label: '교실에서 해 볼 일', width: 0.32 }],
      rows: pairs.map((p) => [bold(nameOf(p.a === studentId ? p.b : p.a)), center(LEVEL_KO[p.riskLevel] || p.riskLevel), center(p.trend ? TREND_KO[p.trend] || '' : ''), p.analysis || '', p.advice || '']),
      header: true,
    });
  }

  // 7. 선생님 메모 · 규칙
  const notes = room.teacherNotes || {};
  const memo = notes.students?.[studentId];
  const rules = (notes.rules || []).filter((r) => r.a === studentId || r.b === studentId);
  if (memo?.memo || memo?.front || rules.length) {
    heading('선생님 메모 · 규칙');
    list([
      memo?.memo ? `메모: ${memo.memo}` : '',
      memo?.front ? '앞자리 필요(👓)로 표시함' : '',
      ...rules.map((r) => `${r.type === 'apart' ? '떨어뜨리기' : '가까이 앉히기'}: ${nameOf(r.a === studentId ? r.b : r.a)}${r.note ? ` — ${r.note}` : ''}`),
    ].filter(Boolean));
  }

  // 8. 상담 · 관찰 기록
  if (followups) {
    const entries = studentFollowups(room, studentId);
    heading('상담 · 관찰 기록');
    if (entries.length) blocks.push({
      type: 'table',
      caption: `최근 ${entries.length}건`,
      columns: [{ label: '날짜', width: 0.13 }, { label: '관찰·상담 내용', width: 0.37 }, { label: '한 일·도움', width: 0.24 }, { label: '다음 확인', width: 0.13 }, { label: '상태', width: 0.13 }],
      rows: entries.map((f) => [center(f.observedDate), `${f.observation}${f.studentIds.length > 1 ? `\n(함께: ${f.studentIds.filter((id) => id !== studentId).map(nameOf).join(', ')})` : ''}`, f.action || '', center(f.nextCheckDate || '–'), center(f.status === 'completed' ? '확인 완료' : '확인 필요')]),
      header: true,
    });
    else para('이 학생의 상담·관찰 기록이 없어요. "상담·후속 확인" 페이지에서 적을 수 있어요.', 'muted');
  }

  // 9. AI 상담 도움말
  const saved = room.studentReports?.[studentId] || null;
  if (ai && saved) {
    heading('AI 상담 도움말');
    const stale = saved.fingerprint && saved.fingerprint !== studentReportFingerprint(room, studentId);
    para(`AI가 이 학생의 회차별 응답·돌아보기·선생님 메모·상담 기록(가명 처리)을 읽고 쓴 도움말이에요. ${String(saved.createdAt || '').slice(0, 10)} 기준이며 참고용이에요.${stale ? ' 그 뒤 자료가 바뀌었어요. 다시 만들면 최신 자료로 써 줘요.' : ''}`, 'muted');
    if (saved.overview) { sub('전체 흐름'); para(saved.overview); }
    if (saved.trend) para(saved.trend);
    if ((saved.watchPoints || []).length) { sub('선생님이 더 관심 둘 점'); list(saved.watchPoints.map((w) => `${w.title}${w.detail ? ` — ${w.detail}` : ''}`)); }
    const c = saved.counseling || {};
    if (c.approach || (c.questions || []).length || (c.tips || []).length) {
      sub('학생과 상담할 때');
      if (c.approach) para(c.approach);
      if ((c.questions || []).length) list(c.questions.map((q) => `물어볼 말: “${q}”`));
      if ((c.tips || []).length) list(c.tips);
    }
    const p = saved.parentTalk || {};
    if (p.opening || (p.points || []).length || p.closing) {
      sub('학부모님께 이렇게 말해 보세요');
      if (p.opening) para(`“${p.opening}”`);
      if ((p.points || []).length) list(p.points.map((x) => `“${x}”`));
      if (p.closing) para(`“${p.closing}”`);
      para('학부모 상담에서는 다른 학생의 이름이나 누가 어떻게 표시했는지는 전하지 않아요.', 'muted');
    }
    if (saved.cautions) { sub('유의할 점'); para(saved.cautions); }
  }

  para('학생 이름과 응답은 개인정보예요. 이 보고서는 선생님의 상담 준비용이며, 인쇄하거나 파일로 보관할 때는 다른 사람이 보지 않도록 조심해 주세요. 수치와 AI 도움말은 참고용이고 학생을 판단하는 근거가 아니에요.', 'note');

  return {
    title: `${student.name} 학생 관계 보고서`,
    subtitle: `${room.name} · 만든 날짜 ${dateLabel(now)} · 학생 관계 마인드맵`,
    meta: [timeline.length ? `조사 ${timeline.length}개 회차 (${timeline[0].name}${timeline.length > 1 ? ` ~ ${last.name}` : ''})` : '조사 회차 없음'],
    blocks,
  };
}
