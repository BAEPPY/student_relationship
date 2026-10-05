// 1인 1역(학급 역할) API 흐름 테스트: 역할 목록 → 성향 설문 → 지원서 → 지난달 현황 → 자동 배정 → 공개 → 다음 달 제외
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { FileStore } from '../server/store.js';
import { PgStore } from '../server/pgstore.js';
import { FakePool } from './fake-pg.js';
import { DEFAULT_ROLES } from '../server/roles.js';
import { makeHwpx, makeHwp } from './helpers/docgen.js';

const STORES = [
  ['FileStore', async () => new FileStore(null)],
  ['PgStore', async () => new PgStore(new FakePool()).init()],
];

const NAMES = ['김하늘', '이도윤', '박서연', '최지우'];
const THIS_MONTH = '2026년 10월';
const LAST_MONTH = '2026년 9월';
const NEXT_MONTH = '2026년 11월';
const REASON = '빗자루와 쓰레받기를 가지런히 정리하는 걸 좋아해서 매일 꼼꼼하게 할 수 있어요.';
const REASON2 = '친구들의 좋은 점을 찾아서 칭찬 노트에 예쁘게 적어 주고 싶어요.';

const slotSum = (roles) => roles.reduce((n, r) => n + r.slots, 0);
/** 배정표에서 학생이 들어 있는 역할 id (없으면 null) */
const roleOf = (assignments, sid) => Object.keys(assignments || {}).find((rid) => (assignments[rid] || []).includes(sid)) || null;

for (const [label, makeStore] of STORES) describe(`1인 1역 API (${label})`, () => {
  let server;
  let url;
  before(async () => {
    const store = await makeStore();
    const app = createApp({ store, baseUrl: 'https://example.test' });
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    url = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  async function call(path, method = 'GET', body) {
    const res = await fetch(url + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  }

  function expectError(r, status, re) {
    assert.equal(r.status, status, `${status} 를 기대했지만 ${r.status}: ${r.text}`);
    assert.equal(typeof r.json?.error, 'string');
    if (re) assert.match(r.json.error, re);
  }

  /** 교실을 만들고 첫 회차 이름을 '2026년 10월' 로 맞춥니다. roles=true 면 기본 역할도 불러옵니다. */
  async function setupRoom({ roles = true, name = '역할반' } = {}) {
    const created = await call('/api/rooms', 'POST', { name, students: NAMES.join('\n'), minGood: 0, minBad: 0 });
    assert.equal(created.status, 201);
    const t = created.json.adminToken;
    let view = await call(`/api/teacher/${t}`);
    assert.equal(view.status, 200);
    const roundId = view.json.round.id;
    view = await call(`/api/teacher/${t}/rounds/${roundId}`, 'PATCH', { name: THIS_MONTH });
    assert.equal(view.status, 200);
    assert.equal(view.json.round.name, THIS_MONTH);
    if (roles) {
      view = await call(`/api/teacher/${t}/roles/default`, 'POST');
      assert.equal(view.status, 200);
    }
    const students = view.json.students;
    assert.equal(students.length, NAMES.length);
    return { t, roundId, students, view: view.json };
  }

  const student = (token) => call(`/api/student/${token}`);
  const teacher = (t, roundId) => call(`/api/teacher/${t}${roundId ? `?round=${roundId}` : ''}`);

  test('역할 목록: 검증, 기본 역할 15개(26자리), 다시 저장해도 id 유지', async () => {
    const { t, students } = await setupRoom({ roles: false });
    const [s1] = students;
    let view = await teacher(t);
    assert.deepEqual(view.json.roles, []);
    assert.deepEqual(view.json.roleHistory, []);
    assert.equal(view.json.roleAssignment, null);
    assert.equal(view.json.aiAnalysis, null);
    assert.equal(view.json.traits.length, 21);
    assert.equal(view.json.selectionCriteria.length, 4);
    assert.equal((await student(s1.token)).json.room.rolesEnabled, false);

    // 검증
    expectError(await call(`/api/teacher/${t}/roles`, 'PUT', { roles: [{ name: '   ', slots: 1 }] }), 400, /이름이 없는 역할/);
    expectError(await call(`/api/teacher/${t}/roles`, 'PUT', { roles: [{ name: '칭찬 수집가', slots: 0 }] }), 400, /인원은 1~10/);
    expectError(await call(`/api/teacher/${t}/roles`, 'PUT', { roles: [{ name: '칭찬 수집가', slots: 11 }] }), 400, /인원은 1~10/);
    expectError(await call(`/api/teacher/${t}/roles`, 'PUT', { roles: [{ name: '칭찬 수집가', slots: 'abc' }] }), 400, /인원/);
    expectError(await call(`/api/teacher/${t}/roles`, 'PUT', { roles: [{ name: '칭찬 수집가', slots: 1 }, { name: '칭찬  수집가', slots: 2 }] }), 400, /같은 이름의 역할/);
    expectError(await call(`/api/teacher/${t}/roles`, 'PUT', { roles: 'nope' }), 400, /역할 목록/);
    expectError(await call(`/api/teacher/${t}/roles`, 'PUT', {}), 400);
    assert.deepEqual((await teacher(t)).json.roles, [], '검증에 실패하면 아무것도 저장되지 않아요');

    // 기본 역할
    view = await call(`/api/teacher/${t}/roles/default`, 'POST');
    assert.equal(view.status, 200);
    assert.equal(view.json.roles.length, 15);
    assert.equal(slotSum(view.json.roles), 26);
    assert.deepEqual(view.json.roles.map((r) => r.id), DEFAULT_ROLES.map((r) => r.id));
    assert.deepEqual(view.json.roles.map((r) => r.name), DEFAULT_ROLES.map((r) => r.name));
    for (const r of view.json.roles) {
      assert.equal(typeof r.id, 'string');
      assert.ok(r.name && typeof r.subtitle === 'string' && typeof r.description === 'string');
      assert.ok(Number.isInteger(r.slots) && r.slots >= 1);
    }
    assert.deepEqual(Object.keys(view.json.applicantCounts).sort(), DEFAULT_ROLES.map((r) => r.id).sort());
    assert.ok(Object.values(view.json.applicantCounts).every((c) => c.first === 0 && c.second === 0 && c.third === 0 && c.total === 0));

    // 학생 화면에도 역할이 보임 (지원서 화면이 열림)
    const me = await student(s1.token);
    assert.equal(me.json.room.rolesEnabled, true);
    assert.equal(me.json.roles.length, 15);
    assert.deepEqual(Object.keys(me.json.roles[0]).sort(), ['description', 'id', 'name', 'slots', 'subtitle']);
    assert.deepEqual(me.json.excludedRoleIds, []);
    assert.equal(me.json.previousRoleMonth, null);
    assert.equal(me.json.assignedRole, null);

    // 고쳐서 다시 저장: id 는 그대로, 새 역할은 새 id, 모양은 정리됨
    const edited = view.json.roles.map((r) => (r.id === 'broom' ? { ...r, slots: 3, name: '  빗자루의   마법사 ' } : r));
    edited.push({ name: '새 역할', subtitle: '', slots: 2, description: '새로 만든 역할이에요.' });
    view = await call(`/api/teacher/${t}/roles`, 'PUT', { roles: edited });
    assert.equal(view.status, 200);
    assert.equal(view.json.roles.length, 16);
    assert.deepEqual(view.json.roles.slice(0, 15).map((r) => r.id), DEFAULT_ROLES.map((r) => r.id));
    const broom = view.json.roles.find((r) => r.id === 'broom');
    assert.equal(broom.slots, 3);
    assert.equal(broom.name, '빗자루의 마법사');
    const added = view.json.roles[15];
    assert.equal(added.name, '새 역할');
    assert.match(added.id, /^[A-Za-z0-9_-]{1,24}$/);
    assert.ok(!DEFAULT_ROLES.some((r) => r.id === added.id));
    assert.equal(slotSum(view.json.roles), 29);

    // 기본 역할 다시 불러오면 원래대로
    view = await call(`/api/teacher/${t}/roles/default`, 'POST');
    assert.equal(view.json.roles.length, 15);
    assert.equal(slotSum(view.json.roles), 26);

    // 선생님 역할 페이지
    const page = await call(`/t/${t}/roles`);
    assert.equal(page.status, 200);
    assert.match(page.text, /<!doctype html>/i);
  });

  test('성향 설문: 저장·표시, 짝 희망 3개 제한, 모르는 항목, 친구 이름 금지, 마감·옛 회차 거부', async () => {
    const { t, roundId, students } = await setupRoom();
    const [s1, s2] = students;
    const profile = { traits: ['quiet', 'tidy', 'listens'], partnerTraits: ['listens', 'friendly'], partnerText: '잘 들어주고 조용한 친구면 좋겠어요', roundId };

    let r = await call(`/api/student/${s1.token}/profile`, 'PUT', profile);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.profile.traits, profile.traits);
    assert.deepEqual(r.json.profile.partnerTraits, profile.partnerTraits);
    assert.equal(r.json.profile.partnerText, profile.partnerText);
    assert.ok(r.json.profile.updatedAt);
    assert.equal(r.json.me.id, s1.id);

    // 학생 화면과 선생님 화면에 그대로 보임
    const me = await student(s1.token);
    assert.deepEqual(me.json.profile.traits, profile.traits);
    assert.equal(me.json.profile.partnerText, profile.partnerText);
    assert.equal((await student(s2.token)).json.profile, null, '다른 학생의 설문은 비어 있음');
    let view = await teacher(t);
    assert.deepEqual(view.json.profiles[s1.id].traits, profile.traits);
    assert.deepEqual(view.json.profiles[s1.id].partnerTraits, profile.partnerTraits);
    assert.equal(view.json.profiles[s1.id].partnerText, profile.partnerText);
    assert.equal(view.json.profiles[s2.id], undefined);

    // 중복 항목은 하나로, 빈 설문도 저장됨
    r = await call(`/api/student/${s2.token}/profile`, 'PUT', { traits: ['quiet', 'quiet'], partnerTraits: [], partnerText: '', roundId });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.profile.traits, ['quiet']);
    assert.deepEqual(r.json.profile.partnerTraits, []);
    assert.equal(r.json.profile.partnerText, '');

    // 검증
    expectError(await call(`/api/student/${s1.token}/profile`, 'PUT', { ...profile, partnerTraits: ['listens', 'friendly', 'tidy', 'quiet'] }), 400, /3개까지/);
    expectError(await call(`/api/student/${s1.token}/profile`, 'PUT', { ...profile, traits: ['quiet', 'nope'] }), 400, /성향 항목/);
    expectError(await call(`/api/student/${s1.token}/profile`, 'PUT', { ...profile, partnerTraits: ['ghost'] }), 400, /짝 희망 항목/);
    expectError(await call(`/api/student/${s1.token}/profile`, 'PUT', { ...profile, partnerText: 'ㅇ'.repeat(301) }), 400, /300자/);
    // 특정 친구 이름은 적을 수 없음 (성명, 성을 뺀 이름 모두)
    r = await call(`/api/student/${s1.token}/profile`, 'PUT', { ...profile, partnerText: '이도윤이랑 앉고 싶어요' });
    expectError(r, 400, /특정 친구의 이름/);
    assert.ok(r.json.error.includes('이도윤'), r.json.error);
    r = await call(`/api/student/${s2.token}/profile`, 'PUT', { ...profile, partnerText: '하늘이랑 짝이 되고 싶어요' });
    expectError(r, 400, /특정 친구의 이름/);
    assert.ok(r.json.error.includes('김하늘'), r.json.error);
    // 내 이름은 친구 이름이 아니므로 괜찮음
    r = await call(`/api/student/${s1.token}/profile`, 'PUT', { ...profile, partnerText: '김하늘은 조용한 짝이 좋아요' });
    assert.equal(r.status, 200, r.text);

    // 옛 회차 → 409, 마감 → 403
    expectError(await call(`/api/student/${s1.token}/profile`, 'PUT', { ...profile, roundId: 'stale-round' }), 409, /새로고침/);
    assert.equal((await call(`/api/teacher/${t}`, 'PATCH', { locked: true })).json.room.locked, true);
    expectError(await call(`/api/student/${s1.token}/profile`, 'PUT', profile), 403, /마감/);
    await call(`/api/teacher/${t}`, 'PATCH', { locked: false });
    assert.equal((await call(`/api/student/${s1.token}/profile`, 'PUT', profile)).status, 200);

    // 실패한 요청은 저장된 내용을 바꾸지 않음
    view = await teacher(t);
    assert.equal(view.json.profiles[s1.id].partnerText, profile.partnerText);
  });

  test('지원서: 역할이 없으면 거부, 검증, 지난달 역할 제외, 지원 현황 집계', async () => {
    const { t, roundId, students } = await setupRoom({ roles: false });
    const [s1, s2, s3] = students;
    const app1 = { choices: [{ roleId: 'broom', reason: REASON, helpClass: '교실이 깨끗해져요', helpSelf: '정리 습관이 생겨요' }, { roleId: 'praise', reason: REASON2, helpClass: '', helpSelf: '' }], roundId };

    expectError(await call(`/api/student/${s1.token}/application`, 'PUT', app1), 400, /역할을 정하지 않았어요/);
    assert.equal((await call(`/api/teacher/${t}/roles/default`, 'POST')).status, 200);

    // 검증
    expectError(await call(`/api/student/${s1.token}/application`, 'PUT', { choices: [{ roleId: 'broom', reason: '재밌어요' }], roundId }), 400, /10자 이상/);
    expectError(await call(`/api/student/${s1.token}/application`, 'PUT', { choices: [{ roleId: 'broom', reason: REASON }, { roleId: 'broom', reason: REASON }], roundId }), 400, /두 번 들어 있어요/);
    expectError(await call(`/api/student/${s1.token}/application`, 'PUT', { choices: [{ roleId: 'ghost', reason: REASON }], roundId }), 400, /없는 역할/);
    expectError(await call(`/api/student/${s1.token}/application`, 'PUT', { choices: [], roundId }), 400, /1지망/);
    expectError(await call(`/api/student/${s1.token}/application`, 'PUT', { roundId }), 400, /1지망/);
    expectError(await call(`/api/student/${s1.token}/application`, 'PUT', { choices: [{ roleId: 'broom', reason: 'ㅇ'.repeat(601) }], roundId }), 400, /600자/);
    assert.equal((await student(s1.token)).json.application, null);

    // 정상 저장 (1지망 + 2지망)
    let r = await call(`/api/student/${s1.token}/application`, 'PUT', app1);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.application.choices.length, 2);
    assert.deepEqual(r.json.application.choices[0], app1.choices[0]);
    assert.deepEqual(r.json.application.choices[1], app1.choices[1]);
    assert.ok(r.json.application.updatedAt);
    assert.deepEqual((await student(s1.token)).json.application.choices.map((c) => c.roleId), ['broom', 'praise']);
    assert.equal((await student(s2.token)).json.application, null);

    // 선생님 화면: 지원서와 지망별 집계
    let view = await teacher(t);
    assert.equal(view.json.applications[s1.id].choices[0].roleId, 'broom');
    assert.deepEqual(view.json.applicantCounts.broom, { first: 1, second: 0, third: 0, total: 1 });
    assert.deepEqual(view.json.applicantCounts.praise, { first: 0, second: 1, third: 0, total: 1 });
    assert.deepEqual(view.json.applicantCounts.recorder, { first: 0, second: 0, third: 0, total: 0 });

    // 4지망 이상은 버림, 1지망만 내도 됨
    r = await call(`/api/student/${s2.token}/application`, 'PUT', { choices: [{ roleId: 'broom', reason: REASON }, { roleId: 'praise', reason: REASON }, { roleId: 'recorder', reason: REASON }, { roleId: 'checker', reason: REASON }], roundId });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.application.choices.map((c) => c.roleId), ['broom', 'praise', 'recorder']);
    r = await call(`/api/student/${s3.token}/application`, 'PUT', { choices: [{ roleId: 'announcer', reason: REASON }], roundId });
    assert.equal(r.status, 200);
    assert.equal(r.json.application.choices.length, 1);
    view = await teacher(t);
    assert.deepEqual(view.json.applicantCounts.broom, { first: 2, second: 0, third: 0, total: 2 });
    assert.deepEqual(view.json.applicantCounts.praise, { first: 0, second: 2, third: 0, total: 2 });
    assert.deepEqual(view.json.applicantCounts.recorder, { first: 0, second: 0, third: 1, total: 1 });
    assert.deepEqual(view.json.applicantCounts.announcer, { first: 1, second: 0, third: 0, total: 1 });

    // 옛 회차 → 409, 마감 → 403
    expectError(await call(`/api/student/${s1.token}/application`, 'PUT', { ...app1, roundId: 'stale-round' }), 409, /새로고침/);
    await call(`/api/teacher/${t}`, 'PATCH', { locked: true });
    expectError(await call(`/api/student/${s1.token}/application`, 'PUT', app1), 403, /마감/);
    await call(`/api/teacher/${t}`, 'PATCH', { locked: false });

    // 지난달 역할 제외: 9월 기록에 s1=빗자루, s2=칭찬 → 10월 회차에서 그 역할은 지원 불가
    r = await call(`/api/teacher/${t}/roles/history`, 'PUT', { month: LAST_MONTH, assignments: { broom: [s1.id], praise: [s2.id] }, source: 'import' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.previousRoles.month, LAST_MONTH);
    assert.deepEqual(r.json.previousRoles.byStudent, { [s1.id]: ['broom'], [s2.id]: ['praise'] });
    const me = await student(s1.token);
    assert.deepEqual(me.json.excludedRoleIds, ['broom']);
    assert.equal(me.json.previousRoleMonth, LAST_MONTH);
    assert.deepEqual((await student(s3.token)).json.excludedRoleIds, []);

    r = await call(`/api/student/${s1.token}/application`, 'PUT', app1);
    expectError(r, 400, /지난달/);
    assert.ok(r.json.error.includes('빗자루의 마법사'), r.json.error);
    expectError(await call(`/api/student/${s1.token}/application`, 'PUT', { choices: [{ roleId: 'praise', reason: REASON }, { roleId: 'broom', reason: REASON }], roundId }), 400, /지난달/);
    expectError(await call(`/api/student/${s2.token}/application`, 'PUT', { choices: [{ roleId: 'praise', reason: REASON }], roundId }), 400, /지난달/);
    // 지난달 역할만 아니면 됨 (s1 은 칭찬 수집가 지원 가능)
    r = await call(`/api/student/${s1.token}/application`, 'PUT', { choices: [{ roleId: 'praise', reason: REASON2 }], roundId });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.application.choices.map((c) => c.roleId), ['praise']);
    // 이미 저장된 옛 지원서(s2 의 1지망 빗자루)는 그대로 남고 집계에도 보임
    view = await teacher(t);
    assert.equal(view.json.applications[s2.id].choices[0].roleId, 'broom');
    assert.deepEqual(view.json.applicantCounts.praise, { first: 1, second: 1, third: 0, total: 2 });
  });

  test('지난달 현황: 텍스트 미리보기(저장 안 함), 저장·수정, 가장 가까운 지난달 조회, 삭제', async () => {
    const { t, roundId, students } = await setupRoom({ roles: false });
    const [s1, s2, s3, s4] = students;
    const text = [
      '4 최지우',                       // 아직 어느 역할인지 모름
      '역할명 번호 이름',               // 머리글은 무시
      '빗자루의 마법사: 1 김하늘 2 이도윤',
      '칭찬 수집가 (3 박서연)',
      '오늘의 기록관: 3 박서연',        // 같은 학생이 다시 나오면 나중 역할로 옮김
      '모르는 사람 홍길동',             // 반 명단에 없음
      '',
    ].join('\n');

    expectError(await call(`/api/teacher/${t}/roles/history/parse`, 'POST', { text }), 400, /역할 목록/);
    assert.equal((await call(`/api/teacher/${t}/roles/default`, 'POST')).status, 200);

    let r = await call(`/api/teacher/${t}/roles/history/parse`, 'POST', { text });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.assignments.broom, [s1.id, s2.id]);
    assert.deepEqual(r.json.assignments.recorder, [s3.id]);
    assert.deepEqual(r.json.assignments.praise, []);
    assert.equal(roleOf(r.json.assignments, s4.id), null);
    assert.deepEqual(r.json.unmatched, [
      { line: '4 최지우', reason: '어느 역할인지 알 수 없어요' },
      { line: '모르는 사람 홍길동', reason: '반 명단에서 이름을 찾지 못했어요' },
    ]);
    expectError(await call(`/api/teacher/${t}/roles/history/parse`, 'POST', { text: 'ㅇ'.repeat(20001) }), 400, /너무 길어요/);
    assert.deepEqual((await teacher(t)).json.roleHistory, [], '미리보기는 저장하지 않음');

    // 저장 검증
    expectError(await call(`/api/teacher/${t}/roles/history`, 'PUT', { month: '', assignments: {} }), 400, /달 이름/);
    expectError(await call(`/api/teacher/${t}/roles/history`, 'PUT', { month: LAST_MONTH, assignments: { ghost: [s1.id] } }), 400, /없는 역할/);
    expectError(await call(`/api/teacher/${t}/roles/history`, 'PUT', { month: LAST_MONTH, assignments: { broom: ['nope'] } }), 400, /없는 학생/);
    expectError(await call(`/api/teacher/${t}/roles/history`, 'PUT', { month: LAST_MONTH, assignments: { broom: [s1.id], praise: [s1.id] } }), 400, /두 역할/);
    assert.deepEqual((await teacher(t)).json.roleHistory, []);

    // 저장: 빈 역할은 빠지고, 같은 달은 덮어씀
    r = await call(`/api/teacher/${t}/roles/history`, 'PUT', { month: LAST_MONTH, assignments: r.json.assignments, source: 'import' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.roleHistory.length, 1);
    assert.equal(r.json.roleHistory[0].month, LAST_MONTH);
    assert.equal(r.json.roleHistory[0].source, 'import');
    assert.ok(r.json.roleHistory[0].updatedAt);
    assert.deepEqual(r.json.roleHistory[0].assignments, { broom: [s1.id, s2.id], recorder: [s3.id] });
    assert.equal(r.json.previousRoles.month, LAST_MONTH);
    assert.deepEqual(r.json.previousRoles.byStudent, { [s1.id]: ['broom'], [s2.id]: ['broom'], [s3.id]: ['recorder'] });
    r = await call(`/api/teacher/${t}/roles/history`, 'PUT', { month: LAST_MONTH, assignments: { broom: [s1.id], praise: [s2.id] } });
    assert.equal(r.json.roleHistory.length, 1);
    assert.deepEqual(r.json.roleHistory[0].assignments, { broom: [s1.id], praise: [s2.id] });
    assert.equal(r.json.roleHistory[0].source, 'import', 'source 를 안 주면 import');

    // 더 오래된 달이 있어도 이번 회차(10월)의 지난달은 가장 가까운 9월
    r = await call(`/api/teacher/${t}/roles/history`, 'PUT', { month: '2026년 8월', assignments: { checker: [s1.id] } });
    assert.equal(r.json.roleHistory.length, 2);
    assert.equal(r.json.previousRoles.month, LAST_MONTH);
    assert.deepEqual(r.json.previousRoles.byStudent[s1.id], ['broom']);
    const byRound = await teacher(t, roundId);
    assert.equal(byRound.json.previousRoles.month, LAST_MONTH);
    const me = await student(s1.token);
    assert.deepEqual(me.json.excludedRoleIds, ['broom']);
    assert.equal(me.json.previousRoleMonth, LAST_MONTH);

    // 삭제 (달 이름은 URL 인코딩)
    r = await call(`/api/teacher/${t}/roles/history/${encodeURIComponent(LAST_MONTH)}`, 'DELETE');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.roleHistory.map((h) => h.month), ['2026년 8월']);
    assert.equal(r.json.previousRoles.month, '2026년 8월');
    assert.deepEqual(r.json.previousRoles.byStudent, { [s1.id]: ['checker'] });
    assert.deepEqual((await student(s1.token)).json.excludedRoleIds, ['checker']);
    r = await call(`/api/teacher/${t}/roles/history/${encodeURIComponent('2026년 8월')}`, 'DELETE');
    assert.deepEqual(r.json.roleHistory, []);
    assert.equal(r.json.previousRoles.month, null);
    assert.deepEqual(r.json.previousRoles.byStudent, {});
    assert.deepEqual((await student(s1.token)).json.excludedRoleIds, []);
    assert.equal((await call(`/api/teacher/${t}/roles/history/${encodeURIComponent('없는 달')}`, 'DELETE')).status, 200, '없는 달을 지워도 오류 없음');
  });

  test('자동 배정(규칙) → 초안 → 수정·공개 → 학생 화면 → 다음 달에는 같은 역할 제외', async () => {
    const { t, roundId, students } = await setupRoom();
    const [s1, s2, s3, s4] = students;
    assert.equal((await call(`/api/student/${s1.token}/application`, 'PUT', { choices: [{ roleId: 'broom', reason: REASON, helpClass: '교실이 깨끗해져요', helpSelf: '꼼꼼해져요' }], roundId })).status, 200);
    assert.equal((await call(`/api/student/${s2.token}/application`, 'PUT', { choices: [{ roleId: 'praise', reason: REASON2 }], roundId })).status, 200);

    // 역할이 없으면 배정 불가
    const noRoles = await setupRoom({ roles: false, name: '역할없는반' });
    expectError(await call(`/api/teacher/${noRoles.t}/roles/assign`, 'POST', { method: 'rules' }), 400, /역할 목록/);

    // 규칙 배정 초안
    let r = await call(`/api/teacher/${t}/roles/assign`, 'POST', { method: 'rules', roundId, seed: 1 });
    assert.equal(r.status, 200, r.text);
    const ra = r.json.roleAssignment;
    assert.equal(ra.method, 'rules');
    assert.equal(ra.published, false);
    assert.equal(ra.publishedAt, null);
    assert.ok(ra.createdAt);
    assert.equal(ra.notes, '');
    assert.deepEqual(ra.unassigned, []);
    assert.ok(Array.isArray(ra.warnings));
    assert.deepEqual(Object.keys(ra.assignments).sort(), DEFAULT_ROLES.map((x) => x.id).sort(), '역할 키는 항상 전부 있음');
    const placed = Object.values(ra.assignments).flat();
    assert.deepEqual([...placed].sort(), students.map((s) => s.id).sort(), '자리가 넉넉하면 모든 학생이 한 번씩 배정됨');
    for (const [rid, list] of Object.entries(ra.assignments)) assert.ok(list.length <= DEFAULT_ROLES.find((x) => x.id === rid).slots, `${rid} 정원 초과`);
    for (const s of students) assert.ok(typeof ra.explanations[s.id] === 'string' && ra.explanations[s.id].length > 0, `${s.name} 설명 없음`);
    assert.equal(roleOf(ra.assignments, s1.id), 'broom');
    assert.equal(roleOf(ra.assignments, s2.id), 'praise');
    assert.match(ra.explanations[s1.id], /^1지망 ✓/);
    assert.match(ra.explanations[s3.id], /지원서가 없어/);
    assert.equal(ra.stats.students, 4);
    assert.equal(ra.stats.slots, 26);
    assert.equal(ra.stats.firstChoice, 2);
    assert.equal(ra.stats.noApplication, 2);
    assert.equal(ra.stats.unassigned, 0);
    assert.ok(ra.warnings.some((w) => w.includes('지원서가 없는 학생 2명')), ra.warnings.join('\n'));
    // 같은 seed 면 같은 결과, 다른 회차 번호는 404
    r = await call(`/api/teacher/${t}/roles/assign`, 'POST', { method: 'rules', roundId, seed: 1 });
    assert.deepEqual(r.json.roleAssignment.assignments, ra.assignments);
    const draftCreatedAt = r.json.roleAssignment.createdAt; // 다시 돌리면 새 초안 (createdAt 갱신)
    assert.equal((await call(`/api/teacher/${t}/roles/assign`, 'POST', { method: 'rules', roundId: 'nope' })).status, 404);

    // 공개 전에는 학생에게 보이지 않음
    assert.equal((await student(s1.token)).json.assignedRole, null);
    assert.deepEqual((await teacher(t)).json.roleHistory, []);

    // 수정 저장 검증
    expectError(await call(`/api/teacher/${t}/roles/assignment`, 'PUT', { assignments: { ghost: [s1.id] }, published: false, roundId }), 400, /없는 역할/);
    expectError(await call(`/api/teacher/${t}/roles/assignment`, 'PUT', { assignments: { broom: ['nope'] }, published: false, roundId }), 400, /없는 학생/);
    expectError(await call(`/api/teacher/${t}/roles/assignment`, 'PUT', { assignments: { broom: [s1.id], praise: [s1.id] }, published: false, roundId }), 400, /두 역할/);
    expectError(await call(`/api/teacher/${t}/roles/assignment`, 'PUT', { assignments: { broom: [s1.id, s1.id] }, published: false, roundId }), 400, /두 역할/);
    // 정원 초과 (아나운서는 1명)
    expectError(await call(`/api/teacher/${t}/roles/assignment`, 'PUT', { assignments: { announcer: [s1.id, s2.id] }, published: false, roundId }), 400, /인원\(1명\)을 넘었어요/);
    assert.equal((await call(`/api/teacher/${t}/roles/assignment`, 'PUT', { assignments: ra.assignments, published: true, roundId: 'nope' })).status, 404);
    let view = await teacher(t, roundId);
    assert.deepEqual(view.json.roleAssignment.assignments, ra.assignments, '실패한 저장은 초안을 바꾸지 않음');
    assert.equal(view.json.roleAssignment.published, false);

    // 설명을 고쳐서 공개
    r = await call(`/api/teacher/${t}/roles/assignment`, 'PUT', { assignments: ra.assignments, explanations: { ...ra.explanations, [s1.id]: '빗자루 정리를 정말 잘해서 맡게 되었어요.' }, published: true, roundId });
    assert.equal(r.status, 200, r.text);
    let pub = r.json.roleAssignment;
    assert.equal(pub.published, true);
    assert.ok(pub.publishedAt);
    assert.ok(pub.updatedAt);
    assert.equal(pub.method, 'rules');
    assert.equal(pub.createdAt, draftCreatedAt, '수정·공개해도 초안의 createdAt 은 그대로');
    assert.deepEqual(pub.assignments, ra.assignments);
    assert.equal(pub.explanations[s1.id], '빗자루 정리를 정말 잘해서 맡게 되었어요.');
    assert.equal(pub.explanations[s2.id], ra.explanations[s2.id]);
    assert.deepEqual(pub.unassigned, []);
    // 공개하면 그 달 기록이 생김
    assert.equal(r.json.roleHistory.length, 1);
    assert.equal(r.json.roleHistory[0].month, THIS_MONTH);
    assert.equal(r.json.roleHistory[0].source, 'published');
    assert.deepEqual(r.json.roleHistory[0].assignments.broom, [s1.id]);
    assert.equal(r.json.previousRoles.month, null, '이번 달 기록은 이번 회차의 지난달이 아님');

    // 학생 화면에 자기 역할만 보임
    let me = await student(s1.token);
    assert.equal(me.json.assignedRole.id, 'broom');
    assert.equal(me.json.assignedRole.name, '빗자루의 마법사');
    assert.ok(me.json.assignedRole.description);
    assert.equal((await student(s2.token)).json.assignedRole.id, 'praise');
    assert.equal((await student(s3.token)).json.assignedRole.id, roleOf(ra.assignments, s3.id));
    assert.deepEqual(me.json.excludedRoleIds, [], '이번 달 배정은 이번 달 지원서를 막지 않음');

    // 공개 취소 → 다시 안 보임, 다시 공개 → 보임
    r = await call(`/api/teacher/${t}/roles/assignment`, 'PUT', { assignments: ra.assignments, published: false, roundId });
    assert.equal(r.json.roleAssignment.published, false);
    assert.equal(r.json.roleAssignment.publishedAt, null);
    assert.equal(r.json.roleAssignment.explanations[s1.id], '빗자루 정리를 정말 잘해서 맡게 되었어요.', '설명을 안 보내면 이전 설명 유지');
    assert.equal((await student(s1.token)).json.assignedRole, null);
    r = await call(`/api/teacher/${t}/roles/assignment`, 'PUT', { assignments: ra.assignments, published: true, roundId });
    assert.equal(r.json.roleAssignment.published, true);
    assert.equal((await student(s1.token)).json.assignedRole.id, 'broom');

    // 직접 고친 배정(일부 미배정) 공개
    const manual = { broom: [s1.id], praise: [s2.id], door: [s3.id] };
    r = await call(`/api/teacher/${t}/roles/assignment`, 'PUT', { assignments: manual, published: true, roundId });
    assert.equal(r.status, 200, r.text);
    pub = r.json.roleAssignment;
    assert.deepEqual(pub.assignments, manual);
    assert.deepEqual(pub.unassigned, [s4.id]);
    assert.equal(pub.method, 'rules', '초안의 방법은 그대로');
    assert.equal(r.json.roleHistory.length, 1, '같은 달 기록은 덮어씀');
    assert.deepEqual(r.json.roleHistory[0].assignments, manual);
    assert.equal((await student(s3.token)).json.assignedRole.id, 'door');
    assert.equal((await student(s4.token)).json.assignedRole, null);
    view = await teacher(t);
    assert.equal(view.json.roleAssignment.published, true);

    // 다음 달 회차: 이번 달 배정이 지난달 역할이 되어 제외됨
    r = await call(`/api/teacher/${t}/rounds`, 'POST', { name: NEXT_MONTH });
    assert.equal(r.status, 201);
    const round2 = r.json.round.id;
    assert.equal(r.json.previousRoles.month, THIS_MONTH);
    assert.deepEqual(r.json.previousRoles.byStudent, { [s1.id]: ['broom'], [s2.id]: ['praise'], [s3.id]: ['door'] });
    assert.equal(r.json.roleAssignment, null, '새 회차에는 배정이 없음');
    assert.deepEqual(r.json.applications, {});
    me = await student(s1.token);
    assert.equal(me.json.round.id, round2);
    assert.deepEqual(me.json.excludedRoleIds, ['broom']);
    assert.equal(me.json.previousRoleMonth, THIS_MONTH);
    assert.equal(me.json.assignedRole, null);
    assert.equal(me.json.application, null);
    assert.deepEqual((await student(s4.token)).json.excludedRoleIds, []);
    expectError(await call(`/api/student/${s1.token}/application`, 'PUT', { choices: [{ roleId: 'broom', reason: REASON }], roundId: round2 }), 400, /지난달/);
    assert.equal((await call(`/api/student/${s1.token}/application`, 'PUT', { choices: [{ roleId: 'broom', reason: REASON }], roundId })).status, 409, '옛 회차로는 제출 불가');
    assert.equal((await call(`/api/student/${s1.token}/application`, 'PUT', { choices: [{ roleId: 'checker', reason: REASON }], roundId: round2 })).status, 200);

    // 새 회차 규칙 배정은 지난달 역할을 피함
    r = await call(`/api/teacher/${t}/roles/assign`, 'POST', { method: 'rules', roundId: round2, seed: 7 });
    assert.equal(r.status, 200, r.text);
    const ra2 = r.json.roleAssignment;
    assert.notEqual(roleOf(ra2.assignments, s1.id), 'broom');
    assert.notEqual(roleOf(ra2.assignments, s2.id), 'praise');
    assert.notEqual(roleOf(ra2.assignments, s3.id), 'door');
    assert.equal(roleOf(ra2.assignments, s1.id), 'checker');
    assert.equal(ra2.published, false);
    // 지난 회차 배정은 그대로 남아 있음
    const old = await teacher(t, roundId);
    assert.equal(old.json.roleAssignment.published, true);
    assert.deepEqual(old.json.roleAssignment.assignments, manual);
  });

  test('AI 배정·분석은 ANTHROPIC_API_KEY 가 없으면 400 으로 안내', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const { t, roundId } = await setupRoom();
      const view = await teacher(t);
      assert.equal(view.json.ai.enabled, false);
      assert.equal(typeof view.json.ai.model, 'string');
      expectError(await call(`/api/teacher/${t}/roles/assign`, 'POST', { method: 'ai', roundId }), 400, /ANTHROPIC_API_KEY/);
      expectError(await call(`/api/teacher/${t}/ai/analyze`, 'POST', { roundId }), 400, /ANTHROPIC_API_KEY/);
      const after1 = await teacher(t);
      assert.equal(after1.json.roleAssignment, null, '실패한 AI 배정은 초안을 만들지 않음');
      assert.equal(after1.json.aiAnalysis, null);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  test('학생을 삭제하면 성향·지원서·배정·기록에서 빠진다', async () => {
    const { t, roundId, students } = await setupRoom();
    const [s1, s2] = students;
    assert.equal((await call(`/api/student/${s1.token}/profile`, 'PUT', { traits: ['tidy'], partnerTraits: [], partnerText: '', roundId })).status, 200);
    assert.equal((await call(`/api/student/${s1.token}/application`, 'PUT', { choices: [{ roleId: 'broom', reason: REASON }], roundId })).status, 200);
    assert.equal((await call(`/api/student/${s2.token}/application`, 'PUT', { choices: [{ roleId: 'praise', reason: REASON2 }], roundId })).status, 200);
    assert.equal((await call(`/api/teacher/${t}/roles/history`, 'PUT', { month: LAST_MONTH, assignments: { checker: [s1.id, s2.id] } })).status, 200);
    let r = await call(`/api/teacher/${t}/roles/assign`, 'POST', { method: 'rules', roundId });
    assert.equal(r.status, 200);
    assert.equal(roleOf(r.json.roleAssignment.assignments, s1.id), 'broom');
    r = await call(`/api/teacher/${t}/roles/assignment`, 'PUT', { assignments: r.json.roleAssignment.assignments, published: true, roundId });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.applicantCounts.broom, { first: 1, second: 0, third: 0, total: 1 });

    r = await call(`/api/teacher/${t}/students/${s1.id}`, 'DELETE');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.students.length, 3);
    assert.equal(r.json.profiles[s1.id], undefined);
    assert.equal(r.json.applications[s1.id], undefined);
    assert.equal(r.json.applications[s2.id].choices[0].roleId, 'praise', '다른 학생의 지원서는 그대로');
    assert.equal(roleOf(r.json.roleAssignment.assignments, s1.id), null);
    assert.equal(roleOf(r.json.roleAssignment.assignments, s2.id), 'praise');
    assert.deepEqual(r.json.roleAssignment.assignments.broom, []);
    assert.deepEqual(r.json.applicantCounts.broom, { first: 0, second: 0, third: 0, total: 0 });
    for (const h of r.json.roleHistory) for (const list of Object.values(h.assignments)) assert.ok(!list.includes(s1.id), `${h.month} 기록에 삭제한 학생이 남아 있음`);
    assert.deepEqual(r.json.roleHistory.find((h) => h.month === LAST_MONTH).assignments.checker, [s2.id]);
    assert.deepEqual(r.json.previousRoles.byStudent, { [s2.id]: ['checker'] });
    assert.equal((await student(s1.token)).status, 404);
    assert.equal((await student(s2.token)).json.assignedRole.id, 'praise');
  });

  test('공개 뒤 회차 이름을 바꾸고 다시 공개해도 기록은 하나이고, 다음 달 제외 규칙은 최신 배정을 따른다', async () => {
    const { t, roundId, students } = await setupRoom();
    const [a, b] = students;
    let r = await call(`/api/teacher/${t}/roles/assignment`, 'PUT', { assignments: { broom: [a.id], praise: [b.id] }, published: true, roundId });
    assert.equal(r.status, 200);
    r = await call(`/api/teacher/${t}/rounds/${roundId}`, 'PATCH', { name: `${THIS_MONTH} (2학기)` });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.roleHistory.map((h) => h.month), [`${THIS_MONTH} (2학기)`], '이름을 바꾸면 기록의 달 이름도 따라감');
    r = await call(`/api/teacher/${t}/roles/assignment`, 'PUT', { assignments: { broom: [b.id], praise: [a.id] }, published: true, roundId });
    assert.equal(r.status, 200);
    assert.equal(r.json.roleHistory.length, 1, '같은 회차를 다시 공개해도 기록은 하나');
    assert.equal(r.json.roleHistory[0].roundId, roundId);
    r = await call(`/api/teacher/${t}/rounds`, 'POST', { name: NEXT_MONTH });
    assert.equal(r.status, 201, r.text);
    assert.deepEqual(r.json.previousRoles.byStudent, { [b.id]: ['broom'], [a.id]: ['praise'] });
    const me = await student(a.token);
    assert.deepEqual(me.json.excludedRoleIds, ['praise']);
    expectError(await call(`/api/student/${a.token}/application`, 'PUT', { choices: [{ roleId: 'praise', reason: REASON }], roundId: r.json.round.id }), 400, /지난달/);
    assert.equal((await call(`/api/student/${a.token}/application`, 'PUT', { choices: [{ roleId: 'broom', reason: REASON }], roundId: r.json.round.id })).status, 200);
  });

  test('지난달 찾기: 뒤 달의 기록을 지난달로 쓰지 않고, 같은 달 기록이 여럿이면 최근 것을 쓴다', async () => {
    const { t, roundId, students } = await setupRoom();
    const [a, b] = students;
    // 10월 회차에 11월 기록만 있으면 지난달 없음
    assert.equal((await call(`/api/teacher/${t}/roles/history`, 'PUT', { month: NEXT_MONTH, assignments: { broom: [a.id] } })).status, 200);
    let view = await teacher(t, roundId);
    assert.equal(view.json.previousRoles.month, null);
    assert.deepEqual((await student(a.token)).json.excludedRoleIds, []);
    // 9월 기록 두 개(같은 달)면 더 최근에 저장한 것을 사용
    assert.equal((await call(`/api/teacher/${t}/roles/history`, 'PUT', { month: `${LAST_MONTH} 1차`, assignments: { broom: [a.id] } })).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await call(`/api/teacher/${t}/roles/history`, 'PUT', { month: `${LAST_MONTH} 2차`, assignments: { praise: [a.id], broom: [b.id] } })).status, 200);
    view = await teacher(t, roundId);
    assert.equal(view.json.previousRoles.month, `${LAST_MONTH} 2차`);
    assert.deepEqual(view.json.previousRoles.byStudent, { [a.id]: ['praise'], [b.id]: ['broom'] });
    // 달 이름에 % 가 있어도 삭제됨
    assert.equal((await call(`/api/teacher/${t}/roles/history`, 'PUT', { month: '100% 특별', assignments: { broom: [a.id] } })).status, 200);
    const del = await call(`/api/teacher/${t}/roles/history/${encodeURIComponent('100% 특별')}`, 'DELETE');
    assert.equal(del.status, 200, del.text);
    assert.ok(!del.json.roleHistory.some((h) => h.month === '100% 특별'));
  });

  test('역할 목록에서 역할을 지우면 그 역할의 배정은 미배정이 되고 경고가 남는다', async () => {
    const { t, roundId, students, view } = await setupRoom();
    const [a, b] = students;
    let r = await call(`/api/teacher/${t}/roles/assignment`, 'PUT', { assignments: { broom: [a.id], praise: [b.id] }, published: true, roundId });
    assert.equal(r.status, 200);
    const roles = view.roles.filter((x) => x.id !== 'broom').map((x) => (x.id === 'praise' ? { ...x, slots: 1 } : x));
    r = await call(`/api/teacher/${t}/roles`, 'PUT', { roles });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.roleAssignment.assignments.broom, undefined);
    assert.ok(r.json.roleAssignment.unassigned.includes(a.id));
    assert.ok(r.json.roleAssignment.warnings.some((w) => /역할 목록이 바뀌어 1명\(김하늘\)/.test(w)), r.json.roleAssignment.warnings.join(' | '));
    assert.equal(r.json.roleAssignment.published, true);
    assert.equal(r.json.roleHistory[0].assignments.broom, undefined, '공개 기록에서도 지워진 역할이 빠짐');
    assert.equal((await student(a.token)).json.assignedRole, null);
    assert.equal((await student(b.token)).json.assignedRole.id, 'praise');
    // 예약어 id 는 새 id 로 바뀜
    r = await call(`/api/teacher/${t}/roles`, 'PUT', { roles: [...roles, { id: '__proto__', name: '이상한 역할', slots: 1 }] });
    assert.equal(r.status, 200, r.text);
    const weird = r.json.roles.find((x) => x.name === '이상한 역할');
    assert.ok(weird && weird.id !== '__proto__');
  });

  test('파일 올리기: 한글 파일의 표를 읽어 지난달 현황 미리보기와 역할 목록을 만든다', async () => {
    const { t, students } = await setupRoom();
    const [a, b, c] = students;
    async function upload(path, buf, name) {
      const res = await fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name) }, body: buf });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, json, text };
    }
    // 지난달 현황 (hwpx)
    const history = makeHwpx([{ type: 'p', text: '9월 현황' }, { type: 'table', rows: [['역할명', '번호', '8~9월의 역할'], [['빗자루의 마법사', '해리포터'], '1', `8 ${a.name} 24 ${b.name}`], [['오늘의 아나운서'], '2', `20 ${c.name}`]] }]);
    let r = await upload(`/api/teacher/${t}/roles/history/upload`, history, '9월 현황.hwpx');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.format, 'hwpx');
    assert.equal(r.json.tables, 1);
    assert.match(r.json.text, /빗자루의 마법사 해리포터 \| 1 \| 8 /);
    assert.deepEqual(r.json.assignments.broom, [a.id, b.id]);
    assert.deepEqual(r.json.assignments.announcer, [c.id]);
    assert.equal((await teacher(t)).json.roleHistory.length, 0, '미리보기는 저장하지 않음');
    // 같은 내용의 hwp(5.0) 파일
    r = await upload(`/api/teacher/${t}/roles/history/upload`, makeHwp([{ type: 'table', rows: [['역할명', '학생'], [['칭찬 수집가'], `9 ${a.name}`]] }]), '현황.hwp');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.format, 'hwp');
    assert.deepEqual(r.json.assignments.praise, [a.id]);
    // 역할 목록 (hwpx 표) → 편집기용 미리보기만 (저장 안 함)
    const roleDoc = makeHwpx([{ type: 'table', rows: [['역할명', '해야할 일'], [['칠판 지우기', '(2명)'], '수업이 끝나면 칠판을 깨끗이 지워요.'], [['도서관 사서', '선생님', '(2명)'], '우리 반 책을 정리해요.']] }]);
    r = await upload(`/api/teacher/${t}/roles/upload`, roleDoc, '역할.hwpx');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.source, 'table');
    assert.deepEqual(r.json.roles.map((x) => [x.name, x.slots]), [['칠판 지우기', 2], ['도서관 사서 선생님', 2]], '기본 역할과 같은 이름은 이어 붙임');
    assert.equal((await teacher(t)).json.roles.length, 15, '역할 목록은 바뀌지 않음');
    // 잘못된 파일·큰 파일
    r = await upload(`/api/teacher/${t}/roles/upload`, Buffer.from('%PDF-1.4'), 'a.pdf');
    expectError(r, 400, /PDF/);
    r = await upload(`/api/teacher/${t}/roles/history/upload`, Buffer.alloc(0), 'empty.txt');
    expectError(r, 400, /비어/);
    r = await upload(`/api/teacher/${t}/roles/upload`, Buffer.alloc(6 * 1024 * 1024 + 1, 0x20), 'big.txt');
    assert.equal(r.status, 413);
    assert.match(r.json.error, /너무 커요/);
    // 역할이 없는 교실에서는 현황 올리기 거부
    const other = await setupRoom({ roles: false, name: '빈반' });
    r = await upload(`/api/teacher/${other.t}/roles/history/upload`, history, 'x.hwpx');
    expectError(r, 400, /역할 목록/);
    assert.equal((await upload('/api/teacher/nope/roles/upload', history, 'x.hwpx')).status, 404);
  });

  test('JSON 내보내기에 역할 목록·달별 기록·회차별 설문·지원서·배정이 들어간다', async () => {
    const { t, roundId, students } = await setupRoom();
    const [s1] = students;
    assert.equal((await call(`/api/student/${s1.token}/profile`, 'PUT', { traits: ['quiet'], partnerTraits: ['listens'], partnerText: '', roundId })).status, 200);
    assert.equal((await call(`/api/student/${s1.token}/application`, 'PUT', { choices: [{ roleId: 'broom', reason: REASON }], roundId })).status, 200);
    assert.equal((await call(`/api/teacher/${t}/roles/history`, 'PUT', { month: LAST_MONTH, assignments: { praise: [s1.id] } })).status, 200);
    assert.equal((await call(`/api/teacher/${t}/roles/assign`, 'POST', { method: 'rules', roundId })).status, 200);

    const r = await call(`/api/teacher/${t}/export.json`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /attachment/);
    assert.equal(r.json.roles.length, 15);
    assert.equal(slotSum(r.json.roles), 26);
    assert.equal(r.json.roleHistory.length, 1);
    assert.equal(r.json.roleHistory[0].month, LAST_MONTH);
    assert.deepEqual(r.json.roleHistory[0].assignments, { praise: [s1.id] });
    assert.ok(r.json.students.every((s) => s.token === undefined && s.url === undefined));
    const round = r.json.rounds.find((x) => x.id === roundId);
    assert.ok(round);
    assert.deepEqual(round.profiles[s1.id].traits, ['quiet']);
    assert.equal(round.applications[s1.id].choices[0].roleId, 'broom');
    assert.equal(round.roleAssignment.method, 'rules');
    assert.equal(round.roleAssignment.published, false);
    assert.equal(roleOf(round.roleAssignment.assignments, s1.id), 'broom');
    assert.equal(round.aiAnalysis, null);
  });
});

// ---------- AI 흐름 (가짜 Claude 클라이언트 주입) ----------
describe('1인 1역 AI 흐름 (가짜 클라이언트)', () => {
  const NAMES2 = ['김하늘', '이도윤', '박서연'];
  const calls = [];
  let behaviour = 'ok'; // 'ok' | 'unauthorized'
  const fakeClient = {
    beta: {
      messages: {
        create: async (params) => {
          calls.push(params);
          if (behaviour === 'unauthorized') { const e = new Error('invalid x-api-key'); e.status = 401; throw e; }
          const isAnalysis = Boolean(params.output_config?.format?.schema?.properties?.pairs);
          const body = isAnalysis
            ? { summary: 'S1과 S2는 가깝고, S3은 조용한 편이에요.', pairs: [{ a: 'S1', b: 'S2', riskLevel: 'medium', conflictType: '장난', analysis: 'S1이 S2에게 장난을 자주 쳐요.', advice: '자리를 떨어뜨려 주세요.' }, { a: 'S9', b: 'S1', riskLevel: 'high', conflictType: '?', analysis: '', advice: '' }], students: [{ id: 'S3', summary: 'S3은 차분해요.', strengths: '정리정돈', watch: '먼저 말 걸기', roleFit: [{ roleId: 'library', reason: '책을 좋아해요' }, { roleId: 'nope', reason: 'x' }] }] }
            : { assignments: [{ roleId: 'announcer', students: ['S1', 'S2'] }, { roleId: 'library', students: ['S3'] }, { roleId: 'ghost', students: ['S1'] }], explanations: [{ student: 'S1', text: 'S1은 아나운서 지원 이유를 성의 있게 적었어요.' }, { student: 'S3', text: '책 정리를 좋아해요.' }], notes: '아나운서에 지원자가 몰렸어요.' };
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(body) }] };
        },
      },
    },
  };
  let server;
  let url;
  before(async () => {
    const app = createApp({ store: new FileStore(null), baseUrl: 'https://example.test', aiClient: fakeClient });
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    url = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());
  async function call(path, method = 'GET', body) {
    const res = await fetch(url + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text };
  }

  test('AI 분석·배정: 가명으로 보내고 실명으로 돌려받으며, 정원 초과·없는 역할은 고쳐진다', async () => {
    const created = await call('/api/rooms', 'POST', { name: 'AI반', students: NAMES2.join('\n'), minGood: 0, minBad: 0 });
    const t = created.json.adminToken;
    let view = await call(`/api/teacher/${t}/roles/default`, 'POST');
    assert.equal(view.json.ai.enabled, true);
    const [s1, s2, s3] = view.json.students;
    const roundId = view.json.round.id;
    // 자유 서술에 친구 이름이 들어가도 API 요청에는 실명이 없어야 함
    await call(`/api/student/${s1.token}/application`, 'PUT', { roundId, choices: [{ roleId: 'announcer', reason: '아침마다 소식을 전하는 게 재미있어요. 이도윤이랑 같이 하고 싶어요.', helpClass: '', helpSelf: '' }] });
    await call(`/api/teacher/${t}/notes`, 'PUT', { students: { [s1.id]: { front: false, memo: '김하늘은 박서연과 자주 다툼' } }, rules: [{ type: 'apart', a: s1.id, b: s3.id }] });

    calls.length = 0;
    view = await call(`/api/teacher/${t}/ai/analyze`, 'POST', { roundId });
    assert.equal(view.status, 200, view.text);
    assert.equal(calls.length, 1);
    const dump = JSON.stringify(calls[0]);
    for (const n of [...NAMES2, '하늘', '도윤', '서연', s1.id, s2.id, s3.id]) assert.ok(!dump.includes(n), `실명/번호가 요청에 들어감: ${n}`);
    assert.equal(calls[0].output_config.format.type, 'json_schema');
    assert.equal(calls[0].fallbacks, 'default');
    const a = view.json.aiAnalysis;
    assert.equal(a.summary, '김하늘과 이도윤는 가깝고, 박서연은 조용한 편이에요.', '가명이 실명으로 돌아옴');
    assert.equal(a.pairs.length, 1, '모르는 가명(S9) 쌍은 버림');
    assert.deepEqual([a.pairs[0].a, a.pairs[0].b, a.pairs[0].riskLevel], [s1.id, s2.id, 'medium']);
    assert.equal(a.pairs[0].analysis, '김하늘이 이도윤에게 장난을 자주 쳐요.');
    assert.equal(a.students.length, 1);
    assert.equal(a.students[0].id, s3.id);
    assert.deepEqual(a.students[0].roleFit.map((f) => f.roleId), ['library'], '없는 역할 id 는 버림');
    assert.equal(typeof a.createdAt, 'string');
    assert.equal(typeof a.model, 'string');

    calls.length = 0;
    view = await call(`/api/teacher/${t}/roles/assign`, 'POST', { method: 'ai', roundId });
    assert.equal(view.status, 200, view.text);
    assert.equal(calls.length, 1);
    const ra = view.json.roleAssignment;
    assert.equal(ra.method, 'ai');
    assert.equal(ra.published, false);
    assert.equal(ra.notes, '아나운서에 지원자가 몰렸어요.');
    assert.equal(ra.assignments.announcer.length, 1, '아나운서(1명) 정원 초과는 고쳐짐');
    assert.equal(ra.assignments.announcer[0], s1.id, '1지망 지원자가 남음');
    assert.deepEqual(ra.assignments.library, [s3.id]);
    assert.equal(ra.assignments.ghost, undefined);
    assert.equal(ra.unassigned.length, 0, '밀려난 학생은 빈자리로 옮겨짐');
    assert.ok(Object.values(ra.assignments).flat().includes(s2.id));
    assert.match(ra.explanations[s1.id], /김하늘은 아나운서/);
    assert.ok(ra.warnings.some((w) => /정원 초과/.test(w)), ra.warnings.join(' | '));
    // 학생 화면: 공개 전에는 보이지 않음
    const me = await call(`/api/student/${s1.token}`);
    assert.equal(me.json.assignedRole, null);

    // 학생을 지우면 AI 분석 결과와 배정 설명에서도 빠진다
    view = await call(`/api/teacher/${t}/students/${s2.id}`, 'DELETE');
    assert.equal(view.status, 200);
    const a2 = view.json.aiAnalysis;
    assert.equal(a2.pairs.length, 0, '삭제한 학생이 들어간 쌍은 빠짐');
    assert.ok(!a2.summary.includes('이도윤'));
    assert.match(a2.summary, /\(삭제된 학생\)/);
    assert.ok(!Object.values(view.json.roleAssignment.explanations).some((x) => /이도윤/.test(x)));
    assert.equal(view.json.roleAssignment.explanations[s2.id], undefined);
    assert.ok(!view.json.roleAssignment.unassigned.includes(s2.id));
    assert.equal(view.json.roleAssignment.truncated, false);
    assert.equal(a2.truncated, false);
  });

  test('AI 키가 틀리면 안내 문구가 그대로 전달된다 (502)', async () => {
    const created = await call('/api/rooms', 'POST', { name: 'AI반2', students: NAMES2.join('\n'), minGood: 0, minBad: 0 });
    const t = created.json.adminToken;
    await call(`/api/teacher/${t}/roles/default`, 'POST');
    behaviour = 'unauthorized';
    try {
      const r = await call(`/api/teacher/${t}/ai/analyze`, 'POST', {});
      assert.equal(r.status, 502, r.text);
      assert.match(r.json.error, /ANTHROPIC_API_KEY/);
      assert.ok(!/invalid x-api-key/.test(r.json.error));
      const view = await call(`/api/teacher/${t}`);
      assert.equal(view.json.aiAnalysis, null);
    } finally {
      behaviour = 'ok';
    }
  });
});
