import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { studentTimeline, studentFollowups, studentReportDocument, studentReportFingerprint } from '../server/student-report.js';
import { buildStudentReportPrompt, aiStudentReport, createAiClient } from '../server/ai.js';
import { makeHwpxDocument, makeDocxDocument } from '../server/export-docs.js';

const at = '2026-10-05T00:00:00.000Z';
const BAD = '지난주 체육 시간에 공을 놓쳤다고 여러 번 놀려서 속상했어요.';
function room() {
  const students = [
    { id: 'a', name: '김하늘', token: 'SECRET-TOKEN-A' }, { id: 'b', name: '이도윤', token: 'SECRET-TOKEN-B' },
    { id: 'c', name: '박서연', token: 'SECRET-TOKEN-C' }, { id: 'd', name: '최지우', token: 'SECRET-TOKEN-D' },
  ];
  const r1 = {
    id: 'r1', name: '2026년 9월', startedAt: '2026-09-01T00:00:00.000Z', closedAt: '2026-09-30T00:00:00.000Z',
    relations: {
      b: { a: { type: 'bad', tags: [], reason: BAD, updatedAt: at } },
      c: { a: { type: 'bad', tags: ['tease'], reason: '', updatedAt: at } },
      d: { a: { type: 'good', tags: ['fun'], reason: '', updatedAt: at } },
      a: { d: { type: 'good', tags: [], reason: '같이 놀면 재밌어요', updatedAt: at }, b: { type: 'bad', tags: [], reason: '이도윤이 먼저 놀렸어요. 그래서 사이가 안 좋아요.', updatedAt: at } },
    },
    submissions: { a: { submittedAt: at }, b: { submittedAt: at }, c: { submittedAt: at }, d: { submittedAt: at } },
    closerFriends: { a: { ids: ['d'], text: '모둠에서 친해졌어요', review: '조금 힘들었어요', score: 2, updatedAt: at }, b: { ids: [], text: '', review: '', score: 4, updatedAt: at } },
    profiles: { a: { traits: ['quiet'], partnerTraits: [], partnerText: '차분한 짝이 좋아요', updatedAt: at } },
    roleAssignment: { published: true, assignments: { board: ['a'] } },
  };
  const r2 = {
    id: 'r2', name: '2026년 10월', startedAt: '2026-10-01T00:00:00.000Z', closedAt: null,
    relations: {
      b: { a: { type: 'bad', tags: [], reason: '아직도 가끔 놀려서 사이가 서먹해요. 사과를 안 했어요.', updatedAt: at } },
      c: { a: { type: 'good', tags: [], reason: '', updatedAt: at } },
      d: { a: { type: 'good', tags: [], reason: '', updatedAt: at } },
    },
    submissions: { b: { submittedAt: at }, c: { submittedAt: at }, d: { submittedAt: at } },
    closerFriends: { c: { ids: ['a'], text: '', review: '', score: 5, updatedAt: at } },
    aiAnalysis: {
      createdAt: '2026-10-06T00:00:00.000Z', summary: '요약',
      students: [{ id: 'a', summary: '조용하지만 박서연과 가까워졌어요.', strengths: '꼼꼼해요', watch: '이도윤과의 사이', trend: '9월보다 나아졌어요', roleFit: [{ roleId: 'board', reason: '꼼꼼' }] }],
      pairs: [{ a: 'a', b: 'b', riskLevel: 'medium', conflictType: '놀림', analysis: '두 회차 계속 안 좋은 사이예요.', advice: '자리를 떨어뜨려 보세요.', trend: 'continuing' }, { a: 'c', b: 'd', riskLevel: 'low', conflictType: '', analysis: '', advice: '', trend: 'unclear' }],
    },
  };
  return {
    id: 'room1', name: '5학년 10반', students, rounds: [r1, r2], currentRoundId: 'r2',
    roles: [{ id: 'board', name: '칠판 지킴이', slots: 1, description: '' }],
    roleHistory: [{ month: '2026년 9월', roundId: 'r1', assignments: { board: ['a'] }, updatedAt: at }],
    teacherNotes: { students: { a: { memo: '쉬는 시간에 혼자 있을 때가 많음', front: true } }, rules: [{ type: 'apart', a: 'a', b: 'b', note: '9월 다툼' }], updatedAt: at },
    followups: [
      { id: 'f1', version: 1, studentIds: ['a', 'b'], observedDate: '2026-09-20', observation: '김하늘과 이도윤이 급식 줄에서 말다툼', action: '둘과 따로 이야기함', nextCheckDate: '2026-10-10', status: 'open', createdAt: at, updatedAt: at },
      { id: 'f2', version: 1, studentIds: ['c'], observedDate: '2026-09-21', observation: '다른 학생 기록', action: '', nextCheckDate: null, status: 'completed', createdAt: at, updatedAt: at },
    ],
  };
}
const headings = (doc) => doc.blocks.filter((b) => b.type === 'heading').map((b) => b.text);
const texts = (doc) => JSON.stringify(doc);

describe('학생별 상담 보고서 (문서 모델)', () => {
  test('studentTimeline: 회차별 받은·보낸 관계, 표시, 돌아보기, 역할, AI 발췌를 오래된 순으로 모은다', () => {
    const t = studentTimeline(room(), 'a');
    assert.deepEqual(t.map((x) => x.name), ['2026년 9월', '2026년 10월']);
    assert.deepEqual(t[0].inBad.map((x) => x.id).sort(), ['b', 'c']);
    assert.equal(t[0].inBad.find((x) => x.id === 'b').reason, BAD);
    assert.deepEqual(t[0].outBad.map((x) => x.id), ['b']);
    assert.equal(t[0].submitted, true);
    assert.equal(t[1].submitted, false, '10월에는 미제출');
    assert.deepEqual(t[1].inGood.map((x) => x.id).sort(), ['c', 'd']);
    assert.deepEqual(t[1].outGood, []);
    assert.equal(t[0].closer.score, 2);
    assert.deepEqual(t[0].classScore, { scoreAvg: 3, scoreCount: 2 });
    assert.deepEqual(t[0].assignedRoles, ['칠판 지킴이']);
    assert.equal(t[1].ai.student.trend, '9월보다 나아졌어요');
    assert.equal(t[1].ai.pairs.length, 1, '이 학생이 들어간 조합만');
    assert.equal(t[0].ai, null);
    assert.deepEqual(studentTimeline(room(), 'a', { maxRounds: 1 }).map((x) => x.id), ['r2']);
    assert.deepEqual(studentFollowups(room(), 'a').map((f) => f.id), ['f1']);
  });

  test('문서: 한눈에 보기 · 회차별 변화(그래프·표·달라진 점) · 관계 상세 · 돌아보기 · 성향·역할 · AI 발췌 · 메모 · 상담 기록', () => {
    const doc = studentReportDocument({ room: room(), studentId: 'a', now: new Date('2026-10-20T03:00:00Z') });
    assert.equal(doc.title, '김하늘 학생 관계 보고서');
    assert.match(doc.subtitle, /5학년 10반 · 만든 날짜 2026\.10\.20/);
    assert.deepEqual(doc.meta, ['조사 2개 회차 (2026년 9월 ~ 2026년 10월)']);
    assert.deepEqual(headings(doc).filter((h) => /^\d+\./.test(h)), ['1. 한눈에 보기', '2. 회차별 변화', '3. 관계 상세 (2026년 10월)', '4. 돌아보기 (학생이 직접 적음)', '5. 성향 · 1인 1역', '6. AI 학급 분석에서 본 이 학생', '7. 선생님 메모 · 규칙', '8. 상담 · 관찰 기록']);
    const stats = doc.blocks.find((b) => b.type === 'stats').items;
    assert.deepEqual(stats.map((s) => `${s.label}=${s.value}`), ['받은 좋은 사이=2명', '받은 안 좋은 사이=1명', '보낸 좋은 사이=0명', '보낸 안 좋은 사이=0명', '우리 반 점수=–']);
    const chart = doc.blocks.find((b) => b.type === 'chart');
    assert.deepEqual(chart.labels, ['9월', '10월']);
    assert.deepEqual(chart.series.map((s) => s.values), [[1, 2], [2, 1]]);
    const table = doc.blocks.find((b) => b.type === 'table' && /회차별 관계 수/.test(b.caption));
    assert.deepEqual(table.rows.map((r) => r.map((c) => (typeof c === 'object' ? c.text : c))), [
      ['2026년 9월', '제출', '1', '2', '1', '1', '2/5', '여러 명이 안 좋게 지목'].slice(0, 7).concat([table.rows[0][7]]),
      ['2026년 10월', '미제출', '2', '1', '–', '–', '–', table.rows[1][7]],
    ]);
    const lists = doc.blocks.filter((b) => b.type === 'list').flatMap((b) => b.items);
    assert.ok(lists.includes('나를 안 좋은 사이로 표시하지 않게 된 친구: 박서연'), lists.join(' | '));
    assert.ok(lists.includes('새로 나를 좋은 사이로 표시한 친구: 박서연'));
    assert.ok(!lists.some((l) => l.startsWith('내가 새로')), '본인이 두 회차 모두 제출하지 않으면 보낸 관계는 비교하지 않음');
    assert.ok(lists.includes('이도윤 — “아직도 가끔 놀려서 사이가 서먹해요. 사과를 안 했어요.”'), '안 좋은 사이 이유');
    assert.ok(lists.includes('2026년 9월 · 우리 반 점수 2/5 (학급 평균 3) · 한 달은: “조금 힘들었어요” · 친해진 친구: 최지우 — “모둠에서 친해졌어요”'));
    assert.ok(lists.some((l) => l.startsWith('나의 성향 (2026년 9월): ')));
    assert.ok(lists.includes('맡았던 역할 — 2026년 9월: 칠판 지킴이'));
    assert.ok(lists.includes('지난 회차와 견주면: 9월보다 나아졌어요'));
    assert.ok(lists.includes('메모: 쉬는 시간에 혼자 있을 때가 많음') && lists.includes('떨어뜨리기: 이도윤 — 9월 다툼'));
    const aiPairs = doc.blocks.find((b) => b.type === 'table' && /눈여겨볼 관계/.test(b.caption));
    assert.deepEqual(aiPairs.rows.map((r) => [r[0].text, r[1].text, r[2].text]), [['이도윤', '주의', '계속됨']]);
    const fu = doc.blocks.find((b) => b.type === 'table' && /최근 1건/.test(b.caption));
    assert.equal(fu.rows[0][0].text, '2026-09-20');
    assert.match(fu.rows[0][1], /급식 줄에서 말다툼\n\(함께: 이도윤\)/);
    assert.ok(!texts(doc).includes('SECRET-TOKEN'), '토큰은 들어가지 않음');
    assert.ok(!texts(doc).includes('다른 학생 기록'), '다른 학생만의 상담 기록은 들어가지 않음');
    assert.equal(doc.blocks.at(-1).style, 'note');
    // 한글·워드로도 만들어짐 (chart 블록은 문서 파일에서는 표가 대신함)
    assert.ok(makeHwpxDocument(doc).length > 1000);
    assert.ok(makeDocxDocument(doc).length > 1000);
  });

  test('옵션: 상담 기록 빼기 · AI 도움말(있을 때만, 빼기 가능, 자료가 바뀌면 안내) · 없는 학생은 null', () => {
    const rm = room();
    const noFu = studentReportDocument({ room: rm, studentId: 'a', followups: false });
    assert.ok(!headings(noFu).some((h) => h.includes('상담 · 관찰 기록')));
    assert.ok(!texts(noFu).includes('급식 줄에서 말다툼'));
    assert.ok(!headings(noFu).some((h) => h.includes('AI 상담 도움말')), '저장된 도움말이 없으면 섹션 없음');
    rm.studentReports = { a: {
      fingerprint: studentReportFingerprint(rm, 'a'), createdAt: '2026-10-21T00:00:00.000Z', model: 'm',
      overview: '김하늘 학생은 조금씩 나아지고 있어요.', trend: '9월보다 좋아요.',
      watchPoints: [{ title: '쉬는 시간', detail: '혼자 있는지 살펴봐 주세요.' }],
      counseling: { approach: '편안하게 시작해요.', questions: ['요즘 쉬는 시간에 뭐 하고 놀아?'], tips: ['모둠을 바꿔 보세요.'] },
      parentTalk: { opening: '하늘이는 꼼꼼한 아이예요.', points: ['친구 관계가 조금씩 넓어지고 있어요.'], closing: '가정에서도 이야기 나눠 주세요.' },
      cautions: '10월에는 본인이 제출하지 않았어요.',
    } };
    const withAi = studentReportDocument({ room: rm, studentId: 'a' });
    assert.ok(headings(withAi).includes('9. AI 상담 도움말'));
    assert.deepEqual(headings(withAi).filter((h) => !/^\d+\./.test(h)).slice(-5), ['전체 흐름', '선생님이 더 관심 둘 점', '학생과 상담할 때', '학부모님께 이렇게 말해 보세요', '유의할 점']);
    const items = withAi.blocks.filter((b) => b.type === 'list').flatMap((b) => b.items);
    assert.ok(items.includes('쉬는 시간 — 혼자 있는지 살펴봐 주세요.') && items.includes('물어볼 말: “요즘 쉬는 시간에 뭐 하고 놀아?”') && items.includes('“친구 관계가 조금씩 넓어지고 있어요.”'));
    assert.ok(!texts(withAi).includes('그 뒤 자료가 바뀌었어요'));
    rm.rounds[1].relations.a = { d: { type: 'good', tags: [], reason: '', updatedAt: at } };
    rm.rounds[1].submissions.a = { submittedAt: at };
    assert.ok(texts(studentReportDocument({ room: rm, studentId: 'a' })).includes('그 뒤 자료가 바뀌었어요'), '입력이 바뀌면 안내');
    assert.ok(!headings(studentReportDocument({ room: rm, studentId: 'a', ai: false })).some((h) => h.includes('AI 상담 도움말')));
    assert.equal(studentReportDocument({ room: rm, studentId: 'ghost' }), null);
    // 회차가 없는 교실도 문서가 만들어짐
    const empty = studentReportDocument({ room: { name: '빈 반', students: [{ id: 'a', name: '김하늘' }], rounds: [] }, studentId: 'a' });
    assert.deepEqual(empty.meta, ['조사 회차 없음']);
  });
});

describe('AI 학생 상담 도움말 (프롬프트 · 결과)', () => {
  const input = () => {
    const rm = room();
    return {
      students: rm.students.map(({ id, name }) => ({ id, name })), studentId: 'a', timeline: studentTimeline(rm, 'a'),
      memo: rm.teacherNotes.students.a, rules: rm.teacherNotes.rules, followups: studentFollowups(rm, 'a'), roles: rm.roles,
    };
  };
  test('프롬프트: 대상 학생과 친구들이 가명으로만 들어가고 회차별 자료·메모·상담 기록이 담긴다', () => {
    const { system, user, me } = buildStudentReportPrompt(input());
    assert.equal(me, 'S1');
    for (const name of ['김하늘', '이도윤', '박서연', '최지우', '하늘', '도윤', '서연', '지우']) assert.ok(!user.includes(name), `실명: ${name}`);
    for (const secret of ['SECRET-TOKEN', '"a"', 'room1']) assert.ok(!user.includes(secret), secret);
    assert.match(user, /## 대상 학생\nS1 — 이 학생에 대한 상담 도움말을 써 주세요\./);
    assert.match(user, /## 2026년 9월\n- 대상 학생 제출함 · 학급 제출 4\/4 · 마감\n- 받은 좋은 사이 1명: S4\(같이 놀면 재미있어요\)\n- 받은 안 좋은 사이 2명: S2\("지난주 체육 시간에 공을 놓쳤다고 여러 번 놀려서 속상했어요\."\), S3\(놀리거나 험담해요\)/);
    assert.match(user, /- 보낸 안 좋은 사이 1명: S2\("S2이 먼저 놀렸어요\. 그래서 사이가 안 좋아요\."\)/);
    assert.match(user, /- 돌아보기: 우리 반 점수 2\/5 \(학급 평균 3\) · 한 달은: "조금 힘들었어요" · 친해진 친구: S4 — "모둠에서 친해졌어요"/);
    assert.match(user, /## 2026년 10월\n- 대상 학생 미제출 · 학급 제출 3\/4 · 진행 중/);
    assert.match(user, /- 보낸 관계: \(이 회차에는 제출하지 않아 자료 없음\)/);
    assert.match(user, /- 학급 AI 분석 요약: 조용하지만 S3과 가까워졌어요\. \/ S2과의 사이/);
    assert.match(user, /- 메모: "쉬는 시간에 혼자 있을 때가 많음"\n- 앞자리 필요로 표시함\n- 떨어뜨리기: S2 \("9월 다툼"\)/);
    assert.match(user, /- 2026-09-20 \(확인 필요\): "S1과 S2이 급식 줄에서 말다툼" \/ 한 일: "둘과 따로 이야기함"/);
    assert.ok(user.indexOf('## 2026년 9월') < user.indexOf('## 2026년 10월'), '오래된 순');
    assert.match(system, /parentTalk 에는 다른 학생의 가명·이름/);
  });
  test('결과: 가명을 실명으로 되돌리고, 학부모 멘트에서는 다른 학생이 드러나지 않게 가린다', async () => {
    const reply = {
      overview: 'S1은 S2와 서먹하지만 S3과 가까워졌어요.', trend: '9월보다 나아졌어요.',
      watchPoints: [{ title: 'S2와의 사이', detail: '계속 지켜봐 주세요.' }, { title: '', detail: '' }],
      counseling: { approach: 'S1에게 편안하게 물어봐요.', questions: ['요즘 누구랑 놀아?', '', 'q3', 'q4', 'q5', 'q6'], tips: ['모둠을 바꿔요.'] },
      parentTalk: { opening: 'S1은 꼼꼼해요.', points: ['S2와 다툰 적이 있지만 나아지고 있어요.', '이도윤이 놀렸다고 해요.'], closing: 'S1과 이야기 나눠 주세요.' },
      cautions: '자료가 부족해요.',
    };
    const calls = [];
    const client = { messages: { create: async (params) => { calls.push(params); return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(reply) }] }; } } };
    const result = await aiStudentReport({ ai: createAiClient({ apiKey: '', client, model: 'test-model' }), ...input() });
    const sent = JSON.stringify(calls[0]);
    for (const name of ['김하늘', '이도윤', '박서연', '최지우']) assert.ok(!sent.includes(name), name);
    assert.equal(calls[0].output_config.format.schema.required.join(), 'overview,trend,watchPoints,counseling,parentTalk,cautions');
    assert.equal(result.overview, '김하늘은 이도윤와 서먹하지만 박서연과 가까워졌어요.');
    assert.deepEqual(result.watchPoints, [{ title: '이도윤와의 사이', detail: '계속 지켜봐 주세요.' }]);
    assert.deepEqual(result.counseling.questions, ['요즘 누구랑 놀아?', 'q3', 'q4', 'q5'], '빈 질문은 빼고 5개까지');
    assert.equal(result.parentTalk.opening, '김하늘은 꼼꼼해요.');
    assert.deepEqual(result.parentTalk.points, ['다른 친구와 다툰 적이 있지만 나아지고 있어요.', '다른 친구이 놀렸다고 해요.'], '다른 학생의 가명·실명은 가림');
    assert.equal(result.parentTalk.closing, '김하늘과 이야기 나눠 주세요.');
    await assert.rejects(aiStudentReport({ ai: createAiClient({ apiKey: '', client }), ...input(), studentId: 'ghost' }), (e) => e.status === 400);
    await assert.rejects(aiStudentReport({ ai: null, ...input() }), (e) => e.status === 503);
  });
});
