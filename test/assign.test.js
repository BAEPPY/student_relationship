import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assignRoles, repairAssignment, scoreApplication, mulberry32 } from '../server/assign.js';
import { DEFAULT_ROLES } from '../server/roles.js';

const S = (...names) => names.map((name, i) => ({ id: `s${i + 1}`, name }));
const R = (...defs) => defs.map(([id, name, slots, description = '']) => ({ id, name, slots, description }));
const choice = (roleId, reason = '이 역할을 꼭 해 보고 싶어요.', extra = {}) => ({ roleId, reason, helpClass: '', helpSelf: '', ...extra });
const app = (...choices) => ({ choices });
const LONG = '친구들의 좋은 점을 매일 찾아서 칭찬 노트에 예쁘게 적어 주고 싶어요. 친구들이 칭찬을 들으면 기분이 좋아지고 우리 반 분위기도 밝아질 것 같아요.';
const MID = '칭찬하는 걸 좋아해서 꼭 해 보고 싶어요. 친구들을 잘 봐요.';
const SHORT = '재미있을 것 같아요.';

/** 공통 규칙 검사: 역할 키 전부 존재, 정원 안 넘김, 금지 역할 없음, 한 학생 한 역할, 미배정 목록 일치, 설명 전원 존재 */
function checkInvariants(result, { students, roles, excluded = {} }) {
  const seen = new Set();
  for (const r of roles) {
    assert.ok(Array.isArray(result.assignments[r.id]), `역할 ${r.id} 키가 있어야 해요`);
    assert.ok(result.assignments[r.id].length <= r.slots, `${r.name} 정원(${r.slots}) 초과: ${result.assignments[r.id].length}`);
    for (const sid of result.assignments[r.id]) {
      assert.ok(!seen.has(sid), `${sid} 가 두 역할에 있어요`);
      seen.add(sid);
      assert.ok(students.some((s) => s.id === sid), `없는 학생 ${sid}`);
      assert.ok(!(excluded[sid] || []).includes(r.id), `${sid} 는 지난달 역할 ${r.id} 에 들어가면 안 돼요`);
    }
  }
  assert.equal(Object.keys(result.assignments).length, roles.length);
  const unassigned = students.map((s) => s.id).filter((id) => !seen.has(id));
  assert.deepEqual(result.unassigned, unassigned);
  for (const s of students) assert.equal(typeof result.explanations[s.id], 'string');
  assert.ok(Array.isArray(result.warnings));
  assert.equal(result.stats.unassigned, unassigned.length);
}

const roleOf = (result, sid) => Object.keys(result.assignments).find((rid) => result.assignments[rid].includes(sid)) || null;

describe('scoreApplication', () => {
  test('지망 순위·정성·도움·역할 이해 점수', () => {
    const role = { id: 'broom', name: '빗자루의 마법사', description: '친구들이 쓴 빗자루와 쓰레받기를 예쁘게 정리해요.' };
    assert.equal(scoreApplication(0, choice('broom', SHORT), role).score, 100);
    assert.equal(scoreApplication(1, choice('broom', SHORT), role).score, 60);
    assert.equal(scoreApplication(2, choice('broom', SHORT), role).score, 30);
    assert.equal(scoreApplication(5, choice('broom', SHORT), role).score, 0);
    const mid = scoreApplication(0, choice('broom', '청소하는 것을 좋아해서 매일매일 열심히 하고 싶습니다 정말로요'), role);
    assert.equal(mid.lengthBonus, 10);
    assert.equal(mid.score, 110);
    const long = scoreApplication(0, choice('broom', '빗자루를 가지런히 정리하는 걸 잘해요. ' + LONG, { helpClass: '교실이 깨끗해져요', helpSelf: '정리 습관이 생겨요' }), role);
    assert.equal(long.lengthBonus, 20);
    assert.equal(long.helpBonus, 10);
    assert.equal(long.understanding, true);
    assert.equal(long.score, 135);
    const noWord = scoreApplication(0, choice('broom', '그냥 재미있을 것 같아서 하고 싶어요 정말로 열심히 할게요'), role);
    assert.equal(noWord.understanding, false);
    assert.equal(scoreApplication(0, choice('broom', SHORT, { helpSelf: '꼼꼼해져요' }), role).score, 105);
  });
});

describe('assignRoles', () => {
  test('자리가 넉넉하면 1지망대로 배정', () => {
    const students = S('김하늘', '이도윤', '박서연');
    const roles = R(['x', '칭찬 수집가', 2], ['y', '빗자루의 마법사', 1]);
    const result = assignRoles({ students, roles, applications: { s1: app(choice('x')), s2: app(choice('y')), s3: app(choice('x')) }, seed: 3 });
    checkInvariants(result, { students, roles });
    assert.deepEqual(result.assignments, { x: ['s1', 's3'], y: ['s2'] });
    assert.equal(result.stats.firstChoice, 3);
    assert.match(result.explanations.s1, /^1지망 ✓/);
    assert.deepEqual(result.warnings, []);
  });

  test('지원자가 몰린 역할은 더 정성껏 쓴 학생에게, 나머지는 2지망 (설명 포함)', () => {
    const students = S('김하늘', '이도윤', '박서연');
    const roles = R(['x', '칭찬 수집가', 2, '친구들의 하루를 관찰하며 칭찬할 일을 칭찬 노트에 적어요.'], ['y', '오늘의 기록관', 1]);
    const applications = {
      s1: app(choice('x', LONG, { helpClass: '우리 반이 밝아져요', helpSelf: '관찰력이 좋아져요' })),
      s2: app(choice('x', MID)),
      s3: app(choice('x', SHORT), choice('y', '기록하는 걸 좋아해요 정말로요')),
    };
    const result = assignRoles({ students, roles, applications, seed: 11 });
    checkInvariants(result, { students, roles });
    assert.deepEqual(result.assignments, { x: ['s1', 's2'], y: ['s3'] });
    assert.match(result.explanations.s1, /^1지망 ✓ · 이유를 정성껏 적음\(\d+자\) · 우리 반·나에게 도움 되는 점 모두 적음/);
    assert.match(result.explanations.s2, /^1지망 ✓ · 이유를 충실히 적음\(\d+자\)/);
    assert.equal(result.explanations.s3, '2지망 배정 (1지망 ‘칭찬 수집가’는 더 정성껏 쓴 친구들로 찼어요)');
    assert.equal(result.stats.secondChoice, 1);
  });

  test('지난달 역할은 1지망이어도 절대 배정하지 않고 설명에 적음', () => {
    const students = S('김하늘', '이도윤');
    const roles = R(['x', '빗자루의 마법사', 1], ['y', '칭찬 수집가', 1], ['z', '사물함과 복도의 수호자', 1]);
    const excluded = { s1: ['x'] };
    const result = assignRoles({ students, roles, applications: { s1: app(choice('x', LONG), choice('y')), s2: app(choice('z')) }, excluded, seed: 5 });
    checkInvariants(result, { students, roles, excluded });
    assert.equal(roleOf(result, 's1'), 'y');
    assert.equal(result.explanations.s1, '지난달 역할이라 ‘빗자루의 마법사’는 제외하고 2지망 배정');

    // 지망이 전부 지난달 역할이면 빈자리로
    const only = assignRoles({ students, roles, applications: { s1: app(choice('x', LONG)), s2: app(choice('y')) }, excluded, seed: 5 });
    checkInvariants(only, { students, roles, excluded });
    assert.notEqual(roleOf(only, 's1'), 'x');
    assert.match(only.explanations.s1, /지난달 역할/);
    assert.match(only.explanations.s1, /빈자리/);
  });

  test('안 좋은 사이·떨어뜨릴 쌍은 가능하면 다른 2인 역할로 나눔', () => {
    const students = S('김하늘', '이도윤', '박서연', '최지우');
    const roles = R(['x', '체육 부장님', 2], ['y', '우유배달 왔소', 2]);
    const applications = {
      s1: app(choice('x'), choice('y')),
      s2: app(choice('x'), choice('y')),
      s3: app(choice('y'), choice('x')),
      s4: app(choice('y'), choice('x')),
    };
    for (const input of [
      { relations: [{ from: 's1', to: 's2', type: 'bad' }], apartPairs: [] },
      { relations: [{ from: 's2', to: 's1', type: 'bad' }], apartPairs: [] },
      { relations: [], apartPairs: [['s1', 's2']] },
    ]) {
      for (const seed of [1, 2, 3, 4, 5]) {
        const result = assignRoles({ students, roles, applications, ...input, seed });
        checkInvariants(result, { students, roles });
        assert.notEqual(roleOf(result, 's1'), roleOf(result, 's2'), `seed ${seed}: 둘이 같은 역할에 있으면 안 돼요`);
        assert.deepEqual(result.unassigned, []);
        assert.ok(!result.warnings.some((w) => w.includes('함께 배정')));
      }
    }
    // 피할 수 없으면 경고로 알려 줌
    const forced = assignRoles({ students: S('김하늘', '이도윤'), roles: R(['x', '체육 부장님', 2]), applications: {}, relations: [{ from: 's1', to: 's2', type: 'bad' }], seed: 1 });
    assert.ok(forced.warnings.some((w) => w.includes('함께 배정')), forced.warnings.join('\n'));
  });

  test('지원서가 없는 학생은 지원자가 적은 역할의 빈자리에', () => {
    const students = S('김하늘', '이도윤', '박서연', '최지우', '정민준');
    const roles = R(['x', '칭찬 수집가', 2], ['y', '사물함과 복도의 수호자', 1], ['z', '오늘의 아나운서', 1], ['w', 'Door Master', 1]);
    const applications = { s1: app(choice('x')), s2: app(choice('x')), s3: app(choice('z')) };
    const result = assignRoles({ students, roles, applications, seed: 9 });
    checkInvariants(result, { students, roles });
    assert.deepEqual(result.assignments.x, ['s1', 's2']);
    assert.deepEqual(result.assignments.z, ['s3']);
    assert.deepEqual(new Set([roleOf(result, 's4'), roleOf(result, 's5')]), new Set(['y', 'w']));
    assert.match(result.explanations.s4, /^지원서가 없어 빈자리인 ‘(사물함과 복도의 수호자|Door Master)’에 배정$/);
    assert.equal(result.stats.noApplication, 2);
    assert.equal(result.stats.fallback, 2);
    assert.ok(result.warnings.some((w) => w.includes('지원서가 없는 학생 2명')));

    // 지망이 모두 찬 지원자도 빈자리로
    const full = assignRoles({ students: S('김하늘', '이도윤', '박서연'), roles: R(['x', '칭찬 수집가', 1], ['y', '꼼꼼이', 1], ['z', '사물함과 복도의 수호자', 1]), applications: { s1: app(choice('x', LONG)), s2: app(choice('x', MID), choice('y', MID)), s3: app(choice('x'), choice('y')) }, seed: 2 });
    assert.equal(roleOf(full, 's3'), 'z');
    assert.equal(full.explanations.s3, '지망한 역할이 모두 차서 빈자리인 ‘사물함과 복도의 수호자’에 배정');
  });

  test('자리보다 학생이 많으면 미배정과 경고', () => {
    const students = S('김하늘', '이도윤', '박서연');
    const roles = R(['x', '칭찬 수집가', 2]);
    const result = assignRoles({ students, roles, applications: { s1: app(choice('x', LONG)), s2: app(choice('x')) }, seed: 1 });
    checkInvariants(result, { students, roles });
    assert.deepEqual(result.unassigned, ['s3']);
    assert.equal(result.stats.unassigned, 1);
    assert.ok(result.warnings.includes('자리(2)보다 학생(3)이 많아 1명이 배정되지 않았어요.'), result.warnings.join('\n'));
    assert.match(result.explanations.s3, /배정되지 않았어요/);

    // 자리가 남으면 빈자리 목록을 알려 줌
    const spare = assignRoles({ students: S('김하늘'), roles: R(['x', '칭찬 수집가', 2], ['y', '꼼꼼이', 1]), applications: { s1: app(choice('y')) }, seed: 1 });
    assert.ok(spare.warnings.some((w) => w.startsWith('학생(1)보다 자리(3)가 많아 빈자리가 있어요: 칭찬 수집가 2')), spare.warnings.join('\n'));
  });

  test('같은 seed 면 같은 결과, 역할 키는 항상 전부 있음', () => {
    const rng = mulberry32(2026);
    const students = S(...Array.from({ length: 14 }, (_, i) => `학생${i + 1}`));
    const roles = R(['a', '빗자루의 마법사', 2], ['b', '칭찬 수집가', 2], ['c', '오늘의 기록관', 2], ['d', '꼼꼼이', 2], ['e', '오늘의 아나운서', 1], ['f', '우유배달 왔소', 2], ['g', '사물함과 복도의 수호자', 1], ['h', 'Door Master', 1]);
    const applications = {};
    for (const s of students.slice(0, 12)) {
      const picks = [...roles].sort(() => rng() - 0.5).slice(0, 3);
      applications[s.id] = app(...picks.map((r, i) => choice(r.id, i === 0 ? MID : SHORT)));
    }
    const relations = [{ from: 's1', to: 's2', type: 'bad' }, { from: 's5', to: 's9', type: 'bad' }];
    const excluded = { s3: ['a'], s4: ['b'] };
    const input = { students, roles, applications, relations, apartPairs: [['s6', 's7']], excluded };
    const one = assignRoles({ ...input, seed: 42 });
    const two = assignRoles({ ...input, seed: 42 });
    assert.deepEqual(one, two);
    checkInvariants(one, { students, roles, excluded });
    assert.deepEqual(Object.keys(one.assignments), roles.map((r) => r.id));
    for (const seed of [0, 1, 7, 99, 123456]) checkInvariants(assignRoles({ ...input, seed }), { students, roles, excluded });
    // 빈 입력도 안전
    const empty = assignRoles({ students: [], roles, applications: {}, seed: 1 });
    assert.deepEqual(empty.unassigned, []);
    assert.deepEqual(Object.keys(empty.assignments), roles.map((r) => r.id));
  });

  test('없는 역할을 적은 지망은 무시', () => {
    const students = S('김하늘');
    const roles = R(['x', '칭찬 수집가', 1]);
    const result = assignRoles({ students, roles, applications: { s1: app(choice('ghost', LONG), choice('x')) }, seed: 1 });
    checkInvariants(result, { students, roles });
    assert.equal(roleOf(result, 's1'), 'x');
    assert.match(result.explanations.s1, /^2지망 배정/);
  });
});

describe('repairAssignment', () => {
  test('정원 초과·지난달 역할·중복·없는 항목을 고치고 빈자리를 채움', () => {
    const students = S('김하늘', '이도윤', '박서연', '최지우', '정민준');
    const roles = R(['x', '꼼꼼이', 2], ['y', '칭찬 수집가', 1], ['z', '빗자루의 마법사', 1], ['w', '사물함과 복도의 수호자', 1]);
    const excluded = { s5: ['z'] };
    const applications = {
      s1: app(choice('x', LONG)),
      s2: app(choice('x', MID)),
      s3: app(choice('y', MID), choice('x', SHORT), choice('w', SHORT)),
    };
    const aiExplanations = { s1: 'AI: 꼼꼼한 성격이에요', s2: 'AI: 책임감이 있어요', s3: 'AI: 적당해요', s5: 'AI: 청소를 좋아해요' };
    const result = repairAssignment({
      assignments: { x: ['s1', 's2', 's3'], y: ['s3'], z: ['s5'], ghostRole: ['s4'], w: ['ghostStudent'] },
      explanations: aiExplanations,
      students, roles, applications, excluded, relations: [], apartPairs: [],
    });
    checkInvariants(result, { students, roles, excluded });
    assert.deepEqual(result.assignments, { x: ['s1', 's2'], y: ['s3'], z: ['s4'], w: ['s5'] });
    assert.deepEqual(result.unassigned, []);
    // 손대지 않은 학생의 설명은 유지, 바뀐 학생은 새 설명
    assert.equal(result.explanations.s1, 'AI: 꼼꼼한 성격이에요');
    assert.equal(result.explanations.s2, 'AI: 책임감이 있어요');
    assert.match(result.explanations.s3, /^1지망 ✓/);
    assert.equal(result.explanations.s4, '지원서가 없어 빈자리인 ‘빗자루의 마법사’에 배정');
    assert.equal(result.explanations.s5, '지원서가 없어 빈자리인 ‘사물함과 복도의 수호자’에 배정');
    const text = result.warnings.join('\n');
    assert.ok(result.warnings.includes('AI 결과에서 ‘꼼꼼이’ 정원 초과 1명을 다른 역할로 옮겼어요.'), text);
    assert.match(text, /‘박서연’이 두 역할에 들어 있어 첫 번째 역할\(‘꼼꼼이’\)만 남겼어요/);
    assert.match(text, /‘정민준’이 지난달 역할 ‘빗자루의 마법사’에 다시 들어 있어/);
    assert.match(text, /없는 역할\(‘ghostRole’\)/);
    assert.match(text, /반 명단에 없는 학생 1명/);
    assert.match(text, /빠진 학생 1명\(최지우\)/);
  });

  test('이미 올바른 배정은 그대로 두고 경고도 없음', () => {
    const students = S('김하늘', '이도윤');
    const roles = R(['x', '꼼꼼이', 1], ['y', '칭찬 수집가', 1]);
    const result = repairAssignment({ assignments: { x: ['s2'], y: ['s1'] }, explanations: { s1: '설명1', s2: '설명2' }, students, roles, applications: { s1: app(choice('x')) } });
    checkInvariants(result, { students, roles });
    assert.deepEqual(result.assignments, { x: ['s2'], y: ['s1'] });
    assert.deepEqual(result.explanations, { s1: '설명1', s2: '설명2' });
    assert.deepEqual(result.warnings, []);
  });

  test('자리가 모자라면 미배정으로 남기고 경고', () => {
    const students = S('김하늘', '이도윤', '박서연');
    const roles = R(['x', '꼼꼼이', 2]);
    const result = repairAssignment({ assignments: { x: ['s1', 's2', 's3'] }, explanations: {}, students, roles, applications: { s3: app(choice('x', LONG)) } });
    checkInvariants(result, { students, roles });
    assert.equal(result.assignments.x.length, 2);
    assert.ok(result.assignments.x.includes('s3'), '지망 점수가 높은 학생을 남겨요');
    assert.equal(result.unassigned.length, 1);
    assert.ok(result.warnings.includes('자리(2)보다 학생(3)이 많아 1명이 배정되지 않았어요.'), result.warnings.join('\n'));
  });
});

describe('성능', () => {
  test('30명 × 기본 역할 15개가 500ms 안에 끝남', () => {
    const rng = mulberry32(7);
    const students = S(...Array.from({ length: 30 }, (_, i) => `학생${i + 1}`));
    const roles = DEFAULT_ROLES.map((r) => ({ id: r.id, name: r.name, slots: r.slots, description: r.description }));
    const applications = {};
    for (const s of students.slice(0, 27)) {
      const picks = [...roles].sort(() => rng() - 0.5).slice(0, 3);
      applications[s.id] = app(...picks.map((r, i) => choice(r.id, [LONG, MID, SHORT][i], i === 0 ? { helpClass: '도움', helpSelf: '발전' } : {})));
    }
    const relations = [];
    for (let i = 0; i < 20; i++) {
      const a = students[Math.floor(rng() * 30)].id;
      const b = students[Math.floor(rng() * 30)].id;
      if (a !== b) relations.push({ from: a, to: b, type: rng() < 0.5 ? 'bad' : 'good' });
    }
    const excluded = Object.fromEntries(students.slice(0, 26).map((s, i) => [s.id, [roles[i % roles.length].id]]));
    const input = { students, roles, applications, relations, apartPairs: [['s1', 's2'], ['s3', 's4']], excluded };

    const t0 = performance.now();
    const result = assignRoles({ ...input, seed: 1 });
    const elapsed = performance.now() - t0;
    checkInvariants(result, { students, roles, excluded });
    assert.ok(elapsed < 500, `${elapsed.toFixed(1)}ms 걸렸어요`);
    assert.equal(result.unassigned.length, 4); // 자리 26 < 학생 30
    assert.ok(result.warnings.includes('자리(26)보다 학생(30)이 많아 4명이 배정되지 않았어요.'), result.warnings.join('\n'));
    assert.equal(result.stats.firstChoice + result.stats.secondChoice + result.stats.thirdChoice + result.stats.fallback, 26);

    const t1 = performance.now();
    const repaired = repairAssignment({ ...input, assignments: result.assignments, explanations: result.explanations });
    assert.ok(performance.now() - t1 < 500);
    checkInvariants(repaired, { students, roles, excluded });
    assert.deepEqual(repaired.assignments, result.assignments);
  });
});
