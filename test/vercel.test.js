import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// 루트 app.js 는 Vercel 이 사용하는 서버리스 진입점입니다. 일반 Node http 서버에 붙여서 검증합니다.
const { default: app } = await import('../app.js');

test('서버리스 진입점: 페이지와 API 가 동작하고 DB 미연결 경고가 표시된다', async () => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const home = await fetch(`${url}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);
    assert.match(await home.text(), /교실 만들기/);

    for (const p of ['/t/abc', '/t/abc/print', '/s/abc']) {
      const r = await fetch(url + p);
      assert.equal(r.status, 200, p);
      assert.match(await r.text(), /<!doctype html>/i);
    }

    const health = await (await fetch(`${url}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.storage, 'memory');
    assert.match(health.notice, /저장되지 않아요/);

    const demo = await (await fetch(`${url}/api/rooms/demo`, { method: 'POST' })).json();
    const view = await (await fetch(`${url}/api/teacher/${demo.adminToken}`)).json();
    assert.equal(view.students.length, 12);
    assert.match(view.notice, /저장되지 않아요/);

    const css = await fetch(`${url}/css/style.css`);
    assert.equal(css.status, 200);

    const nf = await fetch(`${url}/no-such-page`);
    assert.equal(nf.status, 404);
    assert.match(await nf.text(), /페이지를 찾을 수 없어요/);
  } finally {
    server.close();
  }
});
