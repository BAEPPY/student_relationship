// 학급 종합 보고서 테스트: 문서 모델(JSON) 과 한글(HWPX) · 워드(DOCX) 내보내기를 우리 파서로 다시 읽어 확인합니다.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { FileStore } from '../server/store.js';
import { extractDocument, documentToText } from '../server/docfiles.js';
import { reportDocument } from '../server/report.js';

// AI 분석을 흉내 내는 가짜 클라이언트 (실제 API 호출 없음)
const fakeClient = {
  beta: {
    messages: {
      create: async (params) => {
        const isAnalysis = Boolean(params.output_config?.format?.schema?.properties?.pairs);
        const body = isAnalysis
          ? { summary: 'S1과 S2는 가깝고, S3은 조용한 편이에요.', pairs: [{ a: 'S1', b: 'S2', riskLevel: 'medium', conflictType: '장난', analysis: 'S1이 S2에게 장난을 자주 쳐요.', advice: '자리를 떨어뜨려 주세요.' }], students: [{ id: 'S3', summary: 'S3은 차분해요.', strengths: '정리정돈', watch: '먼저 말 걸기', roleFit: [{ roleId: 'library', reason: '책을 좋아해요' }] }] }
          : { assignments: [], explanations: [], notes: '' };
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(body) }] };
      },
    },
  },
};

const types = (doc) => doc.blocks.map((b) => b.type);
const headings = (doc) => doc.blocks.filter((b) => b.type === 'heading' && b.level === 2).map((b) => b.text);
const tableByCaption = (doc, re) => doc.blocks.find((b) => b.type === 'table' && re.test(b.caption || ''));
const cellText = (c) => (c && typeof c === 'object' ? c.text : String(c ?? ''));

describe('학급 종합 보고서 API', () => {
  let server;
  let url;
  let t;
  let roundId;
  let students;
  const store = new FileStore(null);   // aiSeating 처럼 API 없이 바로 넣을 자료는 저장소에 직접 씀
  before(async () => {
    const app = createApp({ store, baseUrl: 'https://example.test', aiClient: fakeClient });
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    url = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  async function call(path, method = 'GET', body) {
    const res = await fetch(url + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const buf = Buffer.from(await res.arrayBuffer());
    let json = null;
    try { json = JSON.parse(buf.toString('utf8')); } catch { /* not json */ }
    return { status: res.status, json, buf, text: buf.toString('utf8'), headers: res.headers };
  }

  test('체험 교실: 관계도 · 갈등 · 회차별 변화 섹션이 들어가고, 자리·역할·AI 는 없으면 빠진다', async () => {
    const created = await call('/api/rooms/demo', 'POST');
    assert.equal(created.status, 201);
    t = created.json.adminToken;
    const view = await call(`/api/teacher/${t}`);
    roundId = view.json.round.id;
    students = view.json.students;

    const r = await call(`/api/teacher/${t}/report.json`);
    assert.equal(r.status, 200, r.text);
    const doc = r.json;
    assert.match(doc.title, /^예시 교실 \(체험용\) .+ 학급 종합 보고서$/);
    assert.match(doc.subtitle, /만든 날짜 \d{4}\.\d{2}\.\d{2} · 응답 11\/12명/);
    assert.deepEqual(doc.round, { id: roundId, name: view.json.round.name });
    assert.equal(doc.rounds.length, 3, '회차 목록도 함께');
    assert.deepEqual(headings(doc), ['1. 한눈에 보기', '2. 학생별 관계', '3. 갈등 가능성 분석', '4. 회차별 변화'], '자리·역할·AI 는 아직 없으니 번호가 이어짐');
    const stats = doc.blocks.find((b) => b.type === 'stats');
    assert.deepEqual(stats.items.map((i) => i.label), ['제출', '좋은 사이', '안 좋은 사이', '주의가 필요한 관계', '고립 위험']);
    assert.equal(stats.items[0].value, '11 / 12명');
    const pending = doc.blocks.find((b) => b.type === 'paragraph' && /아직 제출하지 않은 학생 1명/.test(b.text));
    assert.ok(pending, '미제출 학생 안내');
    assert.ok(pending.text.includes(students[11].name));
    // 학생별 관계 표: 12줄, 번호·이름·제출
    const rel = doc.blocks.find((b) => b.type === 'table' && b.columns[0].label === '번호');
    assert.equal(rel.rows.length, 12);
    assert.deepEqual(rel.rows.map((row) => cellText(row[1])), students.map((s) => s.name));
    assert.equal(cellText(rel.rows[11][2]), '미제출');
    assert.equal(cellText(rel.rows[0][2]), '제출');
    // 갈등 표: 가능성 높은 순, 20쌍까지
    const conflict = tableByCaption(doc, /주의가 필요한 관계/);
    assert.ok(conflict);
    assert.ok(conflict.rows.length > 0 && conflict.rows.length <= 20);
    const probs = conflict.rows.map((row) => Number.parseInt(cellText(row[1]), 10));
    assert.deepEqual(probs, [...probs].sort((a, b) => b - a));
    // 회차별 변화: 3회차 추세 + 비교 목록
    const trend = tableByCaption(doc, /회차별 추세/);
    assert.equal(trend.rows.length, 3);
    const compare = doc.blocks.find((b) => b.type === 'list' && b.items.some((i) => /새로 생긴 갈등/.test(i)));
    assert.ok(compare);
    assert.ok(compare.items.some((i) => /계속되는 갈등/.test(i)) && compare.items.some((i) => /해소된 갈등/.test(i)));
    assert.equal(doc.blocks.at(-1).type, 'paragraph');
    assert.equal(doc.blocks.at(-1).style, 'note');
    assert.match(doc.blocks.at(-1).text, /개인정보/);
    assert.ok(!types(doc).includes('seatmap'));
  });

  test('자리 · 메모 · 1인 1역 · AI 분석을 더하면 섹션이 늘어난다 (reasons=1 이면 배정 이유 표)', async () => {
    const [a, b, c] = students;
    let r = await call(`/api/teacher/${t}/seating`, 'PUT', { layout: { blocks: [{ cols: 2, rows: 2 }, { cols: 1, rows: 1 }] }, seats: { 'b0-r0-c0': a.id, 'b0-r1-c1': b.id, 'b1-r0-c0': c.id } });
    assert.equal(r.status, 200, r.text);
    r = await call(`/api/teacher/${t}/notes`, 'PUT', { notes: { [a.id]: { front: true, memo: '칠판 글씨가 잘 안 보임' } }, rules: [{ type: 'apart', a: a.id, b: b.id, note: '자주 다툼' }] });
    assert.equal(r.status, 200, r.text);
    r = await call(`/api/teacher/${t}/roles/default`, 'POST');
    assert.equal(r.status, 200, r.text);
    const roles = r.json.roles;
    r = await call(`/api/teacher/${t}/roles/assignment`, 'PUT', { roundId, assignments: { [roles[0].id]: [a.id, b.id], [roles[1].id]: [c.id] }, explanations: { [a.id]: '이유를 정성껏 적음', [c.id]: '빈자리에 배정' } });
    assert.equal(r.status, 200, r.text);
    r = await call(`/api/teacher/${t}/ai/analyze`, 'POST', { roundId });
    assert.equal(r.status, 200, r.text);

    r = await call(`/api/teacher/${t}/report.json?round=${roundId}`);
    assert.equal(r.status, 200, r.text);
    let doc = r.json;
    assert.deepEqual(headings(doc), ['1. 한눈에 보기', '2. 학생별 관계', '3. 갈등 가능성 분석', '4. AI 분석', '5. 자리 배정', '6. 1인 1역', '7. 회차별 변화']);
    // AI
    const summary = doc.blocks.find((b) => b.type === 'paragraph' && /가깝고, .+ 조용한 편이에요\.$/.test(b.text));
    assert.ok(summary, 'AI 요약 문단');
    assert.doesNotMatch(summary.text, /\bS\d+\b/, '가명이 실명으로 바뀜');
    assert.ok(students.filter((s) => summary.text.includes(s.name)).length >= 3, summary.text);
    const aiPairs = tableByCaption(doc, /눈여겨볼 관계/);
    assert.equal(aiPairs.rows.length, 1);
    assert.match(cellText(aiPairs.rows[0][0]), /^.+ ↔ .+$/);
    assert.doesNotMatch(cellText(aiPairs.rows[0][0]), /\bS\d+\b/);
    assert.equal(cellText(aiPairs.rows[0][1]), '주의');
    const aiStudents = tableByCaption(doc, /학생별 AI 요약/);
    assert.equal(aiStudents.rows.length, 1);
    assert.ok(students.some((s) => s.name === cellText(aiStudents.rows[0][0])), '실명');
    assert.equal(cellText(aiStudents.rows[0][4]), roles.find((x) => x.id === 'library').name);
    // 자리표: 분단 2개, 학생 시점(칠판 위), 없는 자리는 빈 문자열
    const seatmap = doc.blocks.find((b) => b.type === 'seatmap');
    assert.equal(seatmap.podium, 'top');
    assert.deepEqual(seatmap.blocks.map((x) => [x.cols, x.rows]), [[2, 2], [1, 1]]);
    assert.deepEqual(seatmap.blocks[0].cells, [[a.name, ''], ['', b.name]]);
    assert.deepEqual(seatmap.blocks[1].cells, [[c.name]]);
    assert.ok(doc.blocks.some((b) => b.type === 'paragraph' && /자리가 없는 학생: /.test(b.text) && b.text.includes(students[3].name)));
    const memo = doc.blocks.find((b) => b.type === 'list' && b.items.some((i) => /앞자리 필요/.test(i)));
    assert.ok(memo.items.some((i) => i === `👓 앞자리 필요: ${a.name}`));
    assert.ok(memo.items.some((i) => i === `📝 ${a.name}: 칠판 글씨가 잘 안 보임`));
    assert.ok(memo.items.some((i) => i === `↔ 떨어뜨리기: ${a.name} · ${b.name} (자주 다툼)`));
    // 1인 1역 배정표: 역할마다 한 줄, 번호+이름, 빈자리
    const assign = tableByCaption(doc, /이번 달 배정표/);
    assert.equal(assign.rows.length, roles.length);
    assert.equal(cellText(assign.rows[0][3]), `1 ${a.name}   2 ${b.name}`);
    assert.match(cellText(assign.rows[1][3]), new RegExp(`^3 ${c.name}`));
    assert.ok(doc.blocks.some((b) => b.type === 'paragraph' && /아직 배정되지 않은 학생 9명/.test(b.text)));
    assert.equal(tableByCaption(doc, /배정 이유/), undefined, 'reasons 없으면 이유 표 없음');

    r = await call(`/api/teacher/${t}/report.json?round=${roundId}&reasons=1`);
    doc = r.json;
    const reasons = tableByCaption(doc, /학생별 배정 이유/);
    assert.equal(reasons.rows.length, 12);
    assert.deepEqual(reasons.rows[0].map(cellText), ['1', a.name, roles[0].name, '이유를 정성껏 적음']);
    assert.deepEqual(reasons.rows[3].map(cellText), ['4', students[3].name, '(미배정)', '']);
  });

  test('한글 · 워드 파일로 내려받고 우리 파서로 다시 읽힌다', async () => {
    for (const [kind, type] of [['hwpx', 'application/hwp+zip'], ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']]) {
      const r = await call(`/api/teacher/${t}/report.${kind}?round=${roundId}&reasons=1`);
      assert.equal(r.status, 200, `${kind}: ${r.text.slice(0, 200)}`);
      assert.equal(r.headers.get('content-type'), type);
      const cd = r.headers.get('content-disposition');
      assert.match(cd, new RegExp(`^attachment; filename="report_[0-9A-Za-z-]+\\.${kind}"; filename\\*=UTF-8''`));
      assert.ok(cd.includes(encodeURIComponent('종합보고서_')), cd);
      const doc = extractDocument(r.buf, `report.${kind}`);
      assert.equal(doc.format, kind);
      const text = documentToText(doc);
      for (const needle of ['학급 종합 보고서', '1. 한눈에 보기', '4. AI 분석', '5. 자리 배정', '6. 1인 1역', '7. 회차별 변화', '학생별 배정 이유', '1분단 (위가 칠판 쪽)', students[0].name, '개인정보']) {
        assert.ok(text.includes(needle), `${kind} 에 "${needle}" 없음`);
      }
      const tables = doc.blocks.filter((b) => b.type === 'table');
      // 한눈에 보기(통계) + 학생별 관계 + 갈등 + AI 2개 + 자리 2분단 + 배정표 + 이유 + 추세 = 10
      assert.equal(tables.length, 10, `${kind} 표 개수`);
      const flat = (cell) => (Array.isArray(cell) ? cell.join('\n') : String(cell ?? ''));
      const seat = tables.find((tb) => tb.rows.length === 2 && tb.rows[0].length === 2 && flat(tb.rows[0][0]).includes(students[0].name));
      assert.ok(seat, `${kind} 자리표`);
      assert.equal(flat(seat.rows[1][1]), students[1].name);
      assert.equal(flat(seat.rows[0][1]), '(빈 자리)');
    }
  });

  test('🎒 역할 자리와 🤖 AI 자리 배정 메모가 보고서 JSON 과 한글 · 워드 글에 들어간다', async () => {
    const [a, b, c, d] = students;
    const room = store.findRoomByAdminToken(t);
    const roles = room.roles;
    // 역할 자리: 2분단 자리는 roles[1](담당 c), 1분단 앞줄 오른쪽(바람 자리)은 roles[2](담당 없음), b9-r0-c0 은 배치 밖이라 보고서에서 무시
    let r = await call(`/api/teacher/${t}/seating`, 'PUT', {
      layout: { blocks: [{ cols: 2, rows: 2 }, { cols: 1, rows: 1 }] }, seats: { 'b0-r0-c0': a.id, 'b0-r1-c1': b.id, 'b1-r0-c0': c.id },
      zones: { 'b0-r0-c1': 'ac' }, climate: 'cool', roleSeats: { 'b1-r0-c0': roles[1].id, 'b0-r0-c1': roles[2].id, 'b9-r0-c0': roles[0].id },
    });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.seating.roleSeats, { 'b1-r0-c0': roles[1].id, 'b0-r0-c1': roles[2].id, 'b9-r0-c0': roles[0].id });
    // AI 자리 배정안은 저장소에 직접 (POST /ai/seating 이 저장하는 모양 그대로)
    store.updateRoom(room.id, (rm) => {
      rm.aiSeating = {
        roundId, roundName: '이번 회차', createdAt: '2026-10-06T01:00:00Z', model: 'claude-test-model', truncated: true,
        pairs: [{ a: c.id, b: d.id, probability: 35, reason: `${c.name}와 ${d.name}는 장난이 잦아요.` }, { a: a.id, b: b.id, probability: 72, reason: '서로 안 좋은 사이로 표시했어요.' }, { a: a.id, b: 'ghost', probability: 90, reason: '없는 학생' }],
        assignment: { 'b0-r0-c0': a.id }, explanations: { [a.id]: '앞줄에 앉혔어요.' }, notes: '떨어뜨리기 쌍은 다른 분단에 두었어요.', warnings: ['자리가 7개 부족해요.'],
      };
    });

    r = await call(`/api/teacher/${t}/report.json?round=${roundId}`);
    assert.equal(r.status, 200, r.text);
    const doc = r.json;
    assert.deepEqual(headings(doc), ['1. 한눈에 보기', '2. 학생별 관계', '3. 갈등 가능성 분석', '4. AI 분석', '5. 자리 배정', '6. 1인 1역', '7. 회차별 변화'], '섹션 번호는 그대로');
    // 자리표 블록: roles 가 cells 와 같은 모양, 배치 밖 역할 자리는 없음
    const seatmap = doc.blocks.find((x) => x.type === 'seatmap');
    assert.deepEqual(seatmap.blocks[0].roles, [['', roles[2].name], ['', '']]);
    assert.deepEqual(seatmap.blocks[1].roles, [[roles[1].name]]);
    assert.deepEqual(seatmap.blocks[0].zones, [['', 'ac'], ['', '']]);
    const intro = doc.blocks.find((x) => x.type === 'paragraph' && /저장한 자리표예요/.test(x.text));
    assert.match(intro.text, /🌀 표시는 냉난방기 바람 자리\(1개\)/);
    assert.match(intro.text, /🎒 표시는 1인 1역 담당 학생이 앉는 역할 자리\(2개\)예요/);
    // 메모 목록: 역할 자리 줄 (분단 → 줄 → 칸 순서, 담당 이름 또는 아직 없음)
    const memo = doc.blocks.find((x) => x.type === 'list' && x.items.some((i) => /역할 자리/.test(i)));
    assert.deepEqual(memo.items.filter((i) => /^🎒 역할 자리/.test(i)), [
      `🎒 역할 자리: ${roles[2].name} → 1분단 1번째 줄 2번째 자리 (담당: 아직 없음)`,
      `🎒 역할 자리: ${roles[1].name} → 2분단 1번째 줄 1번째 자리 (담당: ${c.name})`,
    ]);
    assert.ok(memo.items.some((i) => i === `👓 앞자리 필요: ${a.name}`), '기존 메모 줄도 그대로');
    // AI 자리 배정 메모: 자리 배정 섹션 끝(1인 1역 앞)의 소제목 + 안내 + 확인할 점 + 메모 + 예측 표(높은 순, 없는 학생 제외)
    const idx = (pred) => doc.blocks.findIndex(pred);
    const aiHead = idx((x) => x.type === 'heading' && x.level === 3 && x.text === 'AI 자리 배정 메모');
    assert.ok(aiHead > idx((x) => x.type === 'heading' && x.text === '5. 자리 배정'));
    assert.ok(aiHead > idx((x) => x.type === 'list' && x === memo), '메모 목록 뒤');
    assert.ok(aiHead < idx((x) => x.type === 'heading' && x.text === '6. 1인 1역'));
    const aiIntro = doc.blocks[aiHead + 1];
    assert.equal(aiIntro.style, 'muted');
    assert.match(aiIntro.text, /^2026-10-06에 AI가 만든 자리 배정안의 메모예요\(이번 회차 기준 · claude-test-model\)\./);
    assert.match(aiIntro.text, /일부가 생략됐어요/);
    assert.equal(doc.blocks[aiHead + 2].text, '확인할 점: 자리가 7개 부족해요.');
    assert.equal(doc.blocks[aiHead + 3].text, '떨어뜨리기 쌍은 다른 분단에 두었어요.');
    const aiTable = tableByCaption(doc, /AI 예측 갈등 가능성/);
    assert.equal(aiTable, doc.blocks[aiHead + 4]);
    assert.match(aiTable.caption, /높은 순, 2쌍\)$/);
    assert.deepEqual(aiTable.columns.map((x) => x.label), ['학생', '가능성', '이유']);
    assert.deepEqual(aiTable.rows.map((row) => row.map(cellText)), [
      [`${a.name} ↔ ${b.name}`, '72%', '서로 안 좋은 사이로 표시했어요.'],
      [`${c.name} ↔ ${d.name}`, '35%', `${c.name}와 ${d.name}는 장난이 잦아요.`],
    ]);
    // 다른 회차 보고서: 자리표와 역할 자리는 보이지만(담당은 그 회차 기준) AI 메모는 없음
    const other = doc.rounds.find((x) => x.id !== roundId);
    r = await call(`/api/teacher/${t}/report.json?round=${other.id}`);
    assert.equal(r.status, 200, r.text);
    assert.ok(!r.json.blocks.some((x) => x.type === 'heading' && x.text === 'AI 자리 배정 메모'));
    assert.equal(tableByCaption(r.json, /AI 예측 갈등 가능성/), undefined);
    const otherMemo = r.json.blocks.find((x) => x.type === 'list' && x.items.some((i) => /역할 자리/.test(i)));
    assert.ok(otherMemo.items.includes(`🎒 역할 자리: ${roles[1].name} → 2분단 1번째 줄 1번째 자리 (담당: 아직 없음)`), '그 회차에는 배정이 없으니 담당 없음');
    // 한글 · 워드: 역할 자리 줄, 자리표 칸 둘째 줄 "(역할명)", AI 메모 글
    for (const kind of ['hwpx', 'docx']) {
      r = await call(`/api/teacher/${t}/report.${kind}?round=${roundId}`);
      assert.equal(r.status, 200, `${kind}: ${r.text.slice(0, 200)}`);
      const file = extractDocument(r.buf, `report.${kind}`);
      const text = documentToText(file);
      for (const needle of ['AI 자리 배정 메모', '떨어뜨리기 쌍은 다른 분단에 두었어요.', '확인할 점: 자리가 7개 부족해요.', `역할 자리: ${roles[1].name} → 2분단 1번째 줄 1번째 자리 (담당: ${c.name})`, `${a.name} ↔ ${b.name} | 72% | 서로 안 좋은 사이로 표시했어요.`]) {
        assert.ok(text.includes(needle), `${kind} 에 "${needle}" 없음`);
      }
      const flat = (cell) => (Array.isArray(cell) ? cell.join('\n') : String(cell ?? ''));
      const tables = file.blocks.filter((x) => x.type === 'table');
      const block0 = tables.find((tb) => tb.rows.length === 2 && tb.rows[0].length === 2 && flat(tb.rows[0][0]).includes(a.name));
      assert.ok(block0, `${kind} 1분단 자리표`);
      assert.equal(flat(block0.rows[0][1]), `(빈 자리)\n(냉난방 바람)\n(${roles[2].name})`, '이름 · 바람 자리 · 역할 이름이 줄마다');
      assert.equal(flat(block0.rows[1][1]), b.name);
      const block1 = tables.find((tb) => tb.rows.length === 1 && tb.rows[0].length === 1 && flat(tb.rows[0][0]).includes(c.name));
      assert.ok(block1, `${kind} 2분단 자리표`);
      assert.equal(flat(block1.rows[0][0]), `${c.name}\n(${roles[1].name})`);
    }
  });

  test('없는 교실 · 없는 회차는 404', async () => {
    assert.equal((await call('/api/teacher/nope/report.json')).status, 404);
    assert.equal((await call(`/api/teacher/${t}/report.json?round=nope`)).status, 404);
    assert.equal((await call(`/api/teacher/${t}/report.hwpx?round=nope`)).status, 404);
    const html = await call(`/t/${t}/report`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type'), /text\/html/);
  });
});

describe('보고서 문서 모델 (직접 호출)', () => {
  test('학생이 없는 빈 교실도 깨지지 않는다', () => {
    const round = { id: 'r1', name: '2026년 10월', relations: {}, submissions: {} };
    const doc = reportDocument({ room: { name: '빈 반', students: [], rounds: [round], currentRoundId: 'r1' }, round, now: new Date('2026-10-05T03:00:00Z') });
    assert.equal(doc.title, '빈 반 2026년 10월 학급 종합 보고서');
    assert.match(doc.subtitle, /만든 날짜 2026\.10\.05 · 응답 0\/0명/);
    assert.deepEqual(headings(doc), ['1. 한눈에 보기', '2. 학생별 관계', '3. 갈등 가능성 분석']);
    assert.ok(doc.blocks.some((b) => b.type === 'paragraph' && /안 좋은 사이로 표시된 관계가 아직 없어요/.test(b.text)));
  });

  test('역할 자리는 배치 안 · 있는 역할만 세고, AI 자리 배정 메모는 자리표가 없어도 같은 회차면 들어간다', () => {
    const students = [{ id: 's1', name: '김하늘' }, { id: 's2', name: '이도윤' }];
    const round = { id: 'r1', name: '2026년 10월', relations: {}, submissions: {}, roleAssignment: { assignments: { broom: ['s1'] }, published: false } };
    const aiSeating = { roundId: 'r1', roundName: '2026년 10월', createdAt: '2026-10-05T00:00:00Z', model: null, truncated: false, pairs: [{ a: 's1', b: 's2', probability: 48.6, reason: '장난이 잦아요.' }], assignment: {}, explanations: {}, notes: '', warnings: [] };
    const room = {
      name: '빈 반', students, rounds: [round], currentRoundId: 'r1', roles: [{ id: 'broom', name: '빗자루의 마법사', slots: 1 }],
      seating: { layout: { blocks: [{ cols: 2, rows: 1 }] }, seats: {}, roleSeats: { 'b0-r0-c1': 'broom', 'b0-r5-c0': 'broom', 'b0-r0-c0': 'gone' } },
      aiSeating,
    };
    let doc = reportDocument({ room, round, now: new Date('2026-10-05T03:00:00Z') });
    const seatmap = doc.blocks.find((b) => b.type === 'seatmap');
    assert.deepEqual(seatmap.blocks[0].roles, [['', '빗자루의 마법사']], '배치 밖 자리와 지워진 역할은 무시');
    assert.ok(doc.blocks.some((b) => b.type === 'paragraph' && /역할 자리\(1개\)/.test(b.text)));
    const memo = doc.blocks.find((b) => b.type === 'list');
    assert.deepEqual(memo.items, ['🎒 역할 자리: 빗자루의 마법사 → 1분단 1번째 줄 2번째 자리 (담당: 김하늘)']);
    assert.ok(doc.blocks.some((b) => b.type === 'heading' && b.level === 3 && b.text === 'AI 자리 배정 메모'));
    const table = doc.blocks.find((b) => b.type === 'table' && /AI 예측 갈등 가능성/.test(b.caption));
    assert.deepEqual(table.rows[0].map(cellText), ['김하늘 ↔ 이도윤', '49%', '장난이 잦아요.']);
    assert.ok(!doc.blocks.some((b) => b.type === 'paragraph' && /생략됐어요|확인할 점/.test(b.text)), '잘림 · 경고가 없으면 그 문단도 없음');
    // 자리표가 없어도 같은 회차의 AI 배정안이면 "자리 배정" 섹션을 만들어 메모를 넣음
    doc = reportDocument({ room: { ...room, seating: null }, round, now: new Date('2026-10-05T03:00:00Z') });
    assert.deepEqual(headings(doc), ['1. 한눈에 보기', '2. 학생별 관계', '3. 갈등 가능성 분석', '4. 자리 배정', '5. 1인 1역']);
    assert.ok(doc.blocks.some((b) => b.type === 'paragraph' && /아직 저장한 자리표가 없어요/.test(b.text)));
    assert.ok(doc.blocks.some((b) => b.type === 'heading' && b.text === 'AI 자리 배정 메모'));
    // 다른 회차의 배정안이면 메모도, 자리 배정 섹션도 없음
    doc = reportDocument({ room: { ...room, seating: null, aiSeating: { ...aiSeating, roundId: 'r0' } }, round, now: new Date('2026-10-05T03:00:00Z') });
    assert.deepEqual(headings(doc), ['1. 한눈에 보기', '2. 학생별 관계', '3. 갈등 가능성 분석', '4. 1인 1역']);
    assert.ok(!doc.blocks.some((b) => b.type === 'heading' && b.text === 'AI 자리 배정 메모'));
  });
});
