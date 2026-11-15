// 새 학기 첫 조사 (round.kind === 'intro'): 아는 친구 · 예전 사이 · 어떻게 아는 사이
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { FileStore } from '../server/store.js';
import { listKnown, knownSummary, removeStudentFromKnown, roundHasResponses, cleanHow, KNOW_HOW } from '../server/intro.js';
import { buildAnalysisPrompt } from '../server/ai.js';
import { captureAnalysisContext } from '../server/analysis-context.js';

let server; let base;
const call = async (path, method = 'GET', body) => {
  const res = await fetch(base + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* JSON 아님 (CSV 등) */ }
  return { status: res.status, json, text };
};
const BAD = '작년에 같은 모둠이었는데 자꾸 내 물건을 숨겨서 많이 다퉜어요.';

before(async () => {
  const app = createApp({ store: new FileStore(null) });
  server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

async function introRoom(names = ['가람', '나래', '다온', '라온', '마루']) {
  const created = await call('/api/rooms', 'POST', { name: '새 학기 반', students: names, kind: 'intro' });
  assert.equal(created.status, 201, created.text);
  const t = created.json.adminToken;
  const view = (await call(`/api/teacher/${t}`)).json;
  return { t, view, students: view.students };
}

describe('새 학기 첫 조사', () => {
  test('교실을 새 학기 첫 조사로 만들면 꼭 표시해야 하는 수가 없고 선택지가 내려온다', async () => {
    const { view, students } = await introRoom();
    assert.equal(view.round.kind, 'intro');
    assert.equal(view.rounds[0].kind, 'intro');
    assert.deepEqual(view.known, []);
    assert.equal(view.knownSummary.total, 0);
    assert.deepEqual(view.knowCatalog.map((h) => h.id), KNOW_HOW.map((h) => h.id));
    const me = (await call(`/api/student/${students[0].token}`)).json;
    assert.equal(me.round.kind, 'intro');
    assert.equal(me.room.minGood, 0);
    assert.equal(me.room.minBad, 0);
    assert.ok(me.knowCatalog.length >= 5);
    // 평소 교실은 그대로
    const plain = await call('/api/rooms', 'POST', { name: '평소 반', students: ['가', '나', '다', '라', '마'] });
    const pv = (await call(`/api/teacher/${plain.json.adminToken}`)).json;
    assert.equal(pv.round.kind, 'regular');
    assert.equal(pv.knownSummary, null);
    assert.equal((await call(`/api/student/${pv.students[0].token}`)).json.room.minGood, 3);
  });

  test('아는 친구를 예전 사이와 함께 제출하면 좋은 · 안 좋은 사이는 관계로, 전체는 아는 사이로 남는다', async () => {
    const { t, students } = await introRoom();
    const [a, b, c, d, e] = students;
    const url = `/api/student/${a.token}/relations`;
    // 안 좋은 사이는 20자 이상
    let res = await call(url, 'PUT', { relations: { [d.id]: { type: 'bad', how: ['lastyear'], reason: '싸웠어요' } } });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /예전에 안 좋은 사이였던 이유를 20자 이상/);
    res = await call(url, 'PUT', { relations: { [b.id]: { type: 'love' } } });
    assert.equal(res.status, 400);
    res = await call(url, 'PUT', { relations: { [b.id]: { type: 'know', how: ['nope'] } } });
    assert.equal(res.status, 400);
    res = await call(url, 'PUT', { relations: { ghost: { type: 'know' } } });
    assert.equal(res.status, 400);

    res = await call(url, 'PUT', { relations: {
      [b.id]: { type: 'good', how: ['lastyear', 'academy'], reason: '  단짝이었어요 ', tags: ['fun'] },
      [c.id]: { type: 'know', how: ['neighbor'], reason: '놀이터에서 가끔 봐요' },
      [d.id]: { type: 'bad', how: ['lastyear'], reason: BAD },
    } });
    assert.equal(res.status, 200, res.text);
    // 학생 화면: 한 줄로 합쳐서
    assert.equal(res.json.relations[b.id].type, 'good');
    assert.deepEqual(res.json.relations[b.id].how, ['lastyear', 'academy']);
    assert.deepEqual(res.json.relations[b.id].tags, []);   // 새 학기 첫 조사에서는 좋은 사이 선택지를 쓰지 않아요
    assert.equal(res.json.relations[b.id].reason, '단짝이었어요');
    assert.equal(res.json.relations[c.id].type, 'know');
    assert.equal(res.json.relations[c.id].reason, '놀이터에서 가끔 봐요');
    assert.deepEqual(res.json.relations[c.id].how, ['neighbor']);
    assert.equal(res.json.relations[d.id].type, 'bad');
    assert.equal(res.json.relations[e.id], undefined);
    assert.ok(res.json.submittedAt);

    const view = (await call(`/api/teacher/${t}`)).json;
    // 관계도 · 관심 점수는 좋은 · 안 좋은 사이만
    assert.deepEqual(view.relations.map((r) => `${r.to}:${r.type}`).sort(), [`${b.id}:good`, `${d.id}:bad`].sort());
    assert.equal(view.known.length, 3);
    const byTo = Object.fromEntries(view.known.map((k) => [k.to, k]));
    assert.equal(byTo[b.id].quality, 'good');
    assert.deepEqual(byTo[b.id].howLabels, ['작년에 같은 반', '학원 · 방과후']);
    assert.equal(byTo[c.id].quality, 'know');
    assert.equal(byTo[c.id].note, '놀이터에서 가끔 봐요');
    assert.equal(byTo[d.id].quality, 'bad');
    assert.equal(view.knownSummary.students[a.id].knows, 3);
    assert.equal(view.knownSummary.students[b.id].knownBy, 1);
    assert.equal(view.knownSummary.total, 3);
    assert.deepEqual(view.knownSummary.how.map((h) => [h.id, h.count]), [['lastyear', 2], ['academy', 1], ['neighbor', 1]]);

    // 같은 내용을 다시 내면 수정 시각이 그대로
    const before = view.known.map((k) => k.updatedAt).join();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await call(url, 'PUT', { relations: { [b.id]: { type: 'good', how: ['lastyear', 'academy'], reason: '단짝이었어요' }, [c.id]: { type: 'know', how: ['neighbor'], reason: '놀이터에서 가끔 봐요' }, [d.id]: { type: 'bad', how: ['lastyear'], reason: BAD } } });
    const again = (await call(`/api/teacher/${t}`)).json;
    assert.equal(again.known.map((k) => k.updatedAt).join(), before);
    // 좋은 사이 → 그냥 아는 사이로 바꾸면 관계에서 빠진다
    await call(url, 'PUT', { relations: { [b.id]: { type: 'know', how: [], reason: '' } } });
    const changed = (await call(`/api/teacher/${t}`)).json;
    assert.equal(changed.relations.length, 0);
    assert.deepEqual(changed.known.map((k) => [k.to, k.quality]), [[b.id, 'know']]);
  });

  test('아는 친구가 없어도 제출할 수 있고, 요약에 따로 모인다', async () => {
    const { t, students } = await introRoom();
    const [a, b, c] = students;
    assert.equal((await call(`/api/student/${a.token}/relations`, 'PUT', { relations: {} })).status, 200);
    assert.equal((await call(`/api/student/${b.token}/relations`, 'PUT', { relations: { [c.id]: { type: 'know' } } })).status, 200);
    assert.equal((await call(`/api/student/${c.token}/relations`, 'PUT', { relations: { [b.id]: { type: 'good', how: ['kinder'] } } })).status, 200);
    const view = (await call(`/api/teacher/${t}`)).json;
    assert.deepEqual(view.knownSummary.knowsNobody, [a.id]);
    assert.deepEqual(view.knownSummary.knownByNobody.sort(), [a.id, students[3].id, students[4].id].sort());
    assert.equal(view.knownSummary.mutualPairs, 1);
    assert.equal(view.knownSummary.submittedCount, 3);
    assert.equal(view.students.find((s) => s.id === a.id).submitted, true);
  });

  test('평소 회차에서는 "그냥 아는 사이"를 받지 않는다', async () => {
    const created = await call('/api/rooms', 'POST', { name: '평소 반', students: ['가', '나', '다'], minGood: 0, minBad: 0 });
    const view = (await call(`/api/teacher/${created.json.adminToken}`)).json;
    const [a, b] = view.students;
    const res = await call(`/api/student/${a.token}/relations`, 'PUT', { relations: { [b.id]: { type: 'know', how: ['lastyear'] } } });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /좋은 사이 또는 안 좋은 사이/);
    // how 를 같이 보내도 평소 회차에는 저장하지 않는다
    assert.equal((await call(`/api/student/${a.token}/relations`, 'PUT', { relations: { [b.id]: { type: 'good', how: ['lastyear'], tags: [], reason: '' } } })).status, 200);
    const after = (await call(`/api/teacher/${created.json.adminToken}`)).json;
    assert.deepEqual(after.known, []);
    assert.equal((await call(`/api/student/${a.token}`)).json.relations[b.id].how, undefined);
  });

  test('새 회차를 새 학기 첫 조사로 시작하고, 응답이 없을 때만 종류를 바꿀 수 있다', async () => {
    const created = await call('/api/rooms', 'POST', { name: '종류 반', students: ['가', '나', '다'], minGood: 0, minBad: 0 });
    const t = created.json.adminToken;
    let res = await call(`/api/teacher/${t}/rounds`, 'POST', { name: '2031년 3월', kind: 'intro' });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.round.kind, 'intro');
    assert.deepEqual(res.json.rounds.map((r) => r.kind), ['regular', 'intro']);
    const roundId = res.json.round.id;
    // 응답이 없으면 평소 조사로 바꿨다가 되돌릴 수 있다
    res = await call(`/api/teacher/${t}/rounds/${roundId}`, 'PATCH', { kind: 'regular' });
    assert.equal(res.json.round.kind, 'regular');
    res = await call(`/api/teacher/${t}/rounds/${roundId}`, 'PATCH', { kind: 'intro' });
    assert.equal(res.json.round.kind, 'intro');
    const [a, b] = res.json.students;
    await call(`/api/student/${a.token}/relations`, 'PUT', { relations: { [b.id]: { type: 'know', how: ['before'] } } });
    res = await call(`/api/teacher/${t}/rounds/${roundId}`, 'PATCH', { kind: 'regular' });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /조사 종류를 바꿀 수 없어요/);
    // 같은 종류로 다시 보내는 것 · 이름 바꾸기는 그대로 된다
    res = await call(`/api/teacher/${t}/rounds/${roundId}`, 'PATCH', { kind: 'intro', name: '2031년 3월 첫 조사' });
    assert.equal(res.status, 200);
    assert.equal(res.json.round.name, '2031년 3월 첫 조사');
    // 다음 회차는 평소 조사로
    res = await call(`/api/teacher/${t}/rounds`, 'POST', { name: '2031년 4월' });
    assert.equal(res.json.round.kind, 'regular');
    assert.equal(res.json.knownSummary, null);
    // 지난(새 학기) 회차를 골라 보면 아는 사이가 보인다
    const past = (await call(`/api/teacher/${t}?round=${roundId}`)).json;
    assert.equal(past.round.kind, 'intro');
    assert.equal(past.known.length, 1);
  });

  test('학생을 지우거나 응답을 초기화하면 아는 사이 표시도 정리된다', async () => {
    const { t, students } = await introRoom();
    const [a, b, c] = students;
    await call(`/api/student/${a.token}/relations`, 'PUT', { relations: { [b.id]: { type: 'know' }, [c.id]: { type: 'good' } } });
    await call(`/api/student/${b.token}/relations`, 'PUT', { relations: { [a.id]: { type: 'know' }, [c.id]: { type: 'know' } } });
    let view = (await call(`/api/teacher/${t}/students/${c.id}`, 'DELETE')).json;
    assert.deepEqual(view.known.map((k) => `${k.from}>${k.to}`).sort(), [`${a.id}>${b.id}`, `${b.id}>${a.id}`].sort());
    view = (await call(`/api/teacher/${t}/students/${a.id}/reset`, 'POST', {})).json;
    assert.deepEqual(view.known.map((k) => `${k.from}>${k.to}`), [`${b.id}>${a.id}`]);
    assert.equal(view.students.find((s) => s.id === a.id).submitted, false);
  });

  test('임시 저장에도 그냥 아는 사이와 어떻게 아는 사이가 남는다', async () => {
    const { students } = await introRoom();
    const [a, b] = students;
    const me = (await call(`/api/student/${a.token}`)).json;
    const res = await call(`/api/student/${a.token}/draft`, 'PUT', { roundId: me.round.id, revision: 0, step: 'relations', sections: { relations: { [b.id]: { type: 'know', tags: [], reason: '학원', how: ['academy'] } } } });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.draft.sections.relations[b.id], { type: 'know', tags: [], reason: '학원', how: ['academy'] });
    const badHow = await call(`/api/student/${a.token}/draft`, 'PUT', { roundId: me.round.id, revision: res.json.draft.revision, step: 'relations', sections: { relations: { [b.id]: { type: 'know', tags: [], reason: '', how: ['zzz'] } } } });
    assert.equal(badHow.status, 400);
  });

  test('내보내기(JSON · CSV) · 보고서 · 복원에 들어간다', async () => {
    const { t, students } = await introRoom();
    const [a, b, c, d] = students;
    await call(`/api/student/${a.token}/relations`, 'PUT', { relations: { [b.id]: { type: 'good', how: ['lastyear'], reason: '단짝' }, [c.id]: { type: 'know', how: ['academy'], reason: '수영 같이 다녀요' }, [d.id]: { type: 'bad', how: ['before'], reason: BAD } } });
    await call(`/api/student/${b.token}/relations`, 'PUT', { relations: {} });
    const exported = (await call(`/api/teacher/${t}/export.json`)).json;
    assert.equal(exported.rounds[0].kind, 'intro');
    assert.equal(exported.rounds[0].known.length, 3);
    assert.equal(exported.backup.room.rounds[0].kind, 'intro');
    const csv = (await call(`/api/teacher/${t}/export.csv`)).text;
    assert.match(csv, /"가람","나래","예전에 좋은 사이","작년에 같은 반","단짝"/);
    assert.match(csv, /"가람","다온","그냥 아는 사이","학원 · 방과후","수영 같이 다녀요"/);
    assert.match(csv, /"가람","라온","예전에 안 좋은 사이","예전에 같은 반"/);

    const report = (await call(`/api/teacher/${t}/report.json`)).json;
    const text = report.blocks.map((x) => x.text || (x.items || []).join('\n') || '').join('\n');
    assert.match(text, /새 학기 첫 조사/);
    assert.ok(report.blocks.some((x) => x.type === 'heading' && x.text === '아는 사이 (새 학기 첫 조사)'));
    assert.match(text, /아는 친구가 없다고 답한 학생 1명: 나래/);
    const sr = (await call(`/api/teacher/${t}/students/${a.id}/report.json`)).json;
    const srText = sr.blocks.map((x) => x.text || (x.items || []).join('\n') || '').join('\n');
    assert.match(srText, /내가 안다고 한 친구 \(3\)/);
    assert.match(srText, /다온 — 그냥 아는 사이 \(학원 · 방과후\) “수영 같이 다녀요”/);
    assert.match(srText, /라온 — 예전에 안 좋은 사이 \(예전에 같은 반\)/);

    // 복원해도 조사 종류와 아는 사이가 그대로
    const restored = await call('/api/rooms/import', 'POST', { backup: exported.backup });
    assert.equal(restored.status, 201, restored.text);
    const again = (await call(`/api/teacher/${restored.json.adminToken}/export.json`)).json;
    assert.deepEqual(again.backup.room.rounds, exported.backup.room.rounds);
    assert.deepEqual(again.rounds[0].known, exported.rounds[0].known);
    // 고친 파일: 명단 밖 학생 · 모르는 항목은 버린다
    const odd = structuredClone(exported.backup);
    odd.room.rounds[0].known[a.id].ghost = { how: ['lastyear'] };
    odd.room.rounds[0].known[a.id][c.id].how = ['academy', 'zzz'];
    const ok = await call('/api/rooms/import', 'POST', { backup: odd });
    assert.equal(ok.status, 201, ok.text);
    const fixed = (await call(`/api/teacher/${ok.json.adminToken}`)).json;
    assert.equal(fixed.known.length, 3);
    assert.deepEqual(fixed.known.find((k) => k.to === c.id).how, ['academy']);
  });
});

describe('intro 모듈 · AI 입력 (직접 호출)', () => {
  const room = () => ({
    id: 'room', name: '반', students: [{ id: 'a', name: '김하늘' }, { id: 'b', name: '이도윤' }, { id: 'c', name: '박서연' }],
    rounds: [], teacherNotes: { students: {}, rules: [] },
  });
  const round = () => ({
    id: 'r1', name: '2031년 3월', kind: 'intro', startedAt: '2031-03-03T00:00:00.000Z', closedAt: null,
    relations: { a: { b: { type: 'good', tags: [], reason: '단짝', updatedAt: '2031-03-03T01:00:00.000Z' } } },
    submissions: { a: { submittedAt: '2031-03-03T01:00:00.000Z' }, c: { submittedAt: '2031-03-03T02:00:00.000Z' } },
    known: { a: { b: { how: ['lastyear'], updatedAt: '2031-03-03T01:00:00.000Z' }, c: { how: ['academy', 'zzz'], note: '수영', updatedAt: '2031-03-03T01:00:00.000Z' }, ghost: { how: [] } }, c: {} },
  });

  test('listKnown · knownSummary · removeStudentFromKnown · roundHasResponses · cleanHow', () => {
    const list = listKnown(room(), round());
    assert.deepEqual(list.map((k) => [k.from, k.to, k.quality, k.how, k.note]), [['a', 'b', 'good', ['lastyear'], '단짝'], ['a', 'c', 'know', ['academy'], '수영']]);
    const summary = knownSummary(room(), round());
    assert.deepEqual(summary.students, { a: { knows: 2, knownBy: 0, mutual: 0 }, b: { knows: 0, knownBy: 1, mutual: 0 }, c: { knows: 0, knownBy: 1, mutual: 0 } });
    assert.deepEqual(summary.knowsNobody, ['c']);
    assert.deepEqual(summary.knownByNobody, ['a']);
    const r = round();
    removeStudentFromKnown(r, 'c');
    assert.deepEqual(Object.keys(r.known.a).sort(), ['b', 'ghost']);
    assert.equal(r.known.c, undefined);
    assert.equal(roundHasResponses(round()), true);
    assert.equal(roundHasResponses({ relations: { a: {} }, submissions: {}, known: {} }), false);
    assert.deepEqual(cleanHow(['lastyear', 'lastyear', 'family']), ['lastyear', 'family']);
    assert.deepEqual(cleanHow(undefined), []);
    assert.equal(cleanHow(['nope']), null);
    assert.equal(cleanHow('lastyear'), null);
  });

  test('AI 관계 분석 입력: 새 학기 첫 조사 안내와 아는 사이가 가명으로 들어가고, 평소 회차는 그대로다', () => {
    const rm = room(); const rd = round();
    const base = { students: rm.students, relations: [{ from: 'a', to: 'b', type: 'good', tags: [], tagLabels: [], reason: '단짝' }], pairs: [], teacherNotes: rm.teacherNotes, roundName: rd.name, submittedIds: ['a', 'c'] };
    const intro = buildAnalysisPrompt({ ...base, intro: true, known: listKnown(rm, rd) }).user;
    assert.match(intro, /새 학기 첫 조사/);
    assert.match(intro, /작년이나 그 전의 사이/);
    assert.match(intro, /S1 → S3: 그냥 아는 사이 \(학원 · 방과후\) 한마디: "수영"/);
    assert.match(intro, /S1 → S2: 예전에 좋은 사이 \(작년에 같은 반\)/);
    for (const name of ['김하늘', '이도윤', '박서연']) assert.ok(!intro.includes(name));
    const plain = buildAnalysisPrompt(base).user;
    assert.ok(!plain.includes('새 학기 첫 조사') && !plain.includes('아는 사이'));
  });

  test('분석 입력 지문: 새 학기 첫 조사는 아는 사이가 바뀌면 달라지고, 평소 회차는 known 을 보지 않는다', () => {
    const rm = room();
    const a = captureAnalysisContext(rm, round(), { now: '2031-03-04T00:00:00.000Z' });
    const changed = round();
    changed.known.a.c.how = ['neighbor'];
    const b = captureAnalysisContext(rm, changed, { now: '2031-03-04T00:00:00.000Z' });
    assert.notEqual(a.fingerprint, b.fingerprint);
    assert.ok(a.evidence.some((e) => e.kind === 'known' && e.from === 'a' && e.to === 'c'));
    const regular = round(); delete regular.kind;
    const regular2 = round(); delete regular2.kind; regular2.known.a.c.how = ['neighbor'];
    assert.equal(captureAnalysisContext(rm, regular, { now: '2031-03-04T00:00:00.000Z' }).fingerprint, captureAnalysisContext(rm, regular2, { now: '2031-03-04T00:00:00.000Z' }).fingerprint);
  });
});
