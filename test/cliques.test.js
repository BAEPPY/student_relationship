// 친한 무리 찾기 (server/cliques.js): 좋은 사이로 뭉친 학생 묶기 · 무리 사이의 안 좋은 사이
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectGroups } from '../server/cliques.js';
import { createApp } from '../server/app.js';
import { FileStore } from '../server/store.js';

const students = (ids) => ids.map((id) => ({ id, name: id.toUpperCase() }));
const rel = (pairs) => {
  const out = {};
  for (const [from, to, type] of pairs) (out[from] ||= {})[to] = { type, tags: [], reason: '' };
  return out;
};
const mutual = (a, b) => [[a, b, 'good'], [b, a, 'good']];

test('서로 좋은 사이로 뭉친 두 무리를 찾고, 무리 사이의 안 좋은 사이를 센다', () => {
  const room = {
    students: students(['a', 'b', 'c', 'd', 'e', 'f', 'x']),
    relations: rel([
      ...mutual('a', 'b'), ...mutual('b', 'c'), ...mutual('a', 'c'),
      ...mutual('d', 'e'), ...mutual('e', 'f'), ...mutual('d', 'f'),
      ['c', 'd', 'good'],            // 두 무리를 잇는 한쪽 표시 하나
      ['a', 'f', 'bad'], ['e', 'b', 'bad'],
    ]),
  };
  const out = detectGroups(room);
  assert.deepEqual(out.groups.map((g) => g.members), [['a', 'b', 'c'], ['d', 'e', 'f']]);
  assert.deepEqual(out.groups.map((g) => [g.id, g.mutual, g.internalBad]), [[1, 3, 0], [2, 3, 0]]);
  assert.deepEqual(out.ungrouped, ['x']);
  assert.deepEqual(out.groupOf, { a: 1, b: 1, c: 1, d: 2, e: 2, f: 2 });
  assert.equal(out.between.length, 1);
  assert.deepEqual({ a: out.between[0].a, b: out.between[0].b, bad: out.between[0].bad }, { a: 1, b: 2, bad: 2 });
  assert.deepEqual(out.between[0].pairs.map((p) => `${p.from}>${p.to}`).sort(), ['a>f', 'e>b']);
});

test('한쪽이라도 안 좋은 사이로 표시하면 좋은 사이 표시가 있어도 잇지 않는다', () => {
  const out = detectGroups({ students: students(['a', 'b']), relations: rel([['a', 'b', 'good'], ['b', 'a', 'bad']]) });
  assert.deepEqual(out.groups, []);
  assert.deepEqual(out.ungrouped, ['a', 'b']);
  assert.deepEqual(out.between, []);
});

test('관계가 없거나 학생이 없으면 무리도 없다', () => {
  assert.deepEqual(detectGroups({ students: [], relations: {} }), { groups: [], ungrouped: [], between: [], groupOf: {} });
  const out = detectGroups({ students: students(['a', 'b', 'c']), relations: {} });
  assert.deepEqual(out.groups, []);
  assert.deepEqual(out.ungrouped, ['a', 'b', 'c']);
});

test('큰 무리부터 번호를 붙이고, 같은 무리 안의 안 좋은 사이도 센다', () => {
  const room = {
    students: students(['p', 'q', 'a', 'b', 'c', 'd']),
    relations: rel([
      ...mutual('p', 'q'),
      ...mutual('a', 'b'), ...mutual('b', 'c'), ...mutual('c', 'd'), ...mutual('a', 'd'),
      ['a', 'c', 'bad'],             // 같은 무리 안의 안 좋은 사이 (a-c 는 이어지지 않지만 b·d 로 한 무리)
    ]),
  };
  const out = detectGroups(room);
  assert.deepEqual(out.groups.map((g) => g.members), [['a', 'b', 'c', 'd'], ['p', 'q']]);
  assert.equal(out.groups[0].internalBad, 1);
  assert.equal(out.groups[0].mutual, 4);
  assert.deepEqual(out.between, []);
});

test('같은 입력이면 항상 같은 결과이고, 명단에 없는 학생의 표시는 무시한다', () => {
  const room = {
    students: students(['a', 'b', 'c', 'd']),
    relations: rel([...mutual('a', 'b'), ...mutual('c', 'd'), ['ghost', 'a', 'bad'], ['a', 'ghost', 'good'], ['a', 'c', 'bad']]),
  };
  const first = detectGroups(room);
  assert.deepEqual(detectGroups(room), first);
  assert.deepEqual(first.groups.map((g) => g.members), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(first.between.map((b) => b.bad), [1]);
});

test('선생님 화면 응답과 학급 보고서에 친한 무리가 들어간다', async () => {
  const app = createApp({ store: new FileStore(null) });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, options = {}) => {
    const res = await fetch(base + path, { ...options, headers: { 'content-type': 'application/json' }, body: options.body ? JSON.stringify(options.body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  try {
    const created = await call('/api/rooms', { method: 'POST', body: { name: '무리 반', students: ['가람', '나래', '다온', '라온', '마루'], minGood: 0, minBad: 0 } });
    assert.equal(created.status, 201);
    const admin = created.body.adminToken;
    let view = (await call(`/api/teacher/${admin}`)).body;
    assert.deepEqual(view.cliques.groups, []);
    assert.equal(view.cliques.ungrouped.length, 5);
    const [ga, na, da, ra, ma] = view.students;
    const put = (s, relations) => call(`/api/student/${s.token}/relations`, { method: 'PUT', body: { relations } });
    const good = (to) => ({ [to.id]: { type: 'good', tags: [], reason: '' } });
    const bad = (to) => ({ [to.id]: { type: 'bad', tags: [], reason: '쉬는 시간마다 자꾸 놀려서 속상했던 적이 여러 번 있어요' } });
    for (const [s, relations] of [[ga, { ...good(na), ...bad(da) }], [na, good(ga)], [da, good(ra)], [ra, good(da)]]) {
      const res = await put(s, relations);
      assert.equal(res.status, 200, JSON.stringify(res.body));
    }
    view = (await call(`/api/teacher/${admin}`)).body;
    assert.deepEqual(view.cliques.groups.map((g) => g.members), [[ga.id, na.id], [da.id, ra.id]]);
    assert.deepEqual(view.cliques.ungrouped, [ma.id]);
    assert.deepEqual(view.cliques.between.map((b) => [b.a, b.b, b.bad]), [[1, 2, 1]]);

    const report = (await call(`/api/teacher/${admin}/report.json`)).body;
    const at = report.blocks.findIndex((b) => b.type === 'heading' && b.text === '친한 무리');
    assert.ok(at > 0, '친한 무리 소제목');
    const table = report.blocks.slice(at).find((b) => b.type === 'table');
    assert.equal(table.rows.length, 2);
    assert.equal(table.rows[0][2], '가람, 나래');
    const lines = report.blocks.slice(at).find((b) => b.type === 'list').items;
    assert.ok(lines.some((l) => l.includes('무리 1 ↔ 무리 2') && l.includes('가람 → 다온')));
    assert.ok(lines.some((l) => l.includes('마루')));

    const sr = (await call(`/api/teacher/${admin}/students/${ga.id}/report.json`)).body;
    const text = sr.blocks.filter((b) => b.type === 'paragraph').map((b) => b.text).join('\n');
    assert.match(text, /나래 학생과 같은 무리예요 \(무리 1 · 2명/);
    assert.match(text, /무리 2와\(과\) 1건/);
    const lone = (await call(`/api/teacher/${admin}/students/${ma.id}/report.json`)).body;
    assert.match(lone.blocks.filter((b) => b.type === 'paragraph').map((b) => b.text).join('\n'), /어느 무리에도 들지 않았어요/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
