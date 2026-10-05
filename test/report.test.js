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
  before(async () => {
    const app = createApp({ store: new FileStore(null), baseUrl: 'https://example.test', aiClient: fakeClient });
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
});
