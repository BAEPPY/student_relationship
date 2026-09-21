import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '../server/store.js';
import { PgStore, sslOptions } from '../server/pgstore.js';
import { FakePool } from './fake-pg.js';

const sampleRoom = () => ({
  id: 'room1',
  name: '반',
  adminToken: 'admin-token',
  students: [{ id: 's1', name: '가', token: 'tok1' }, { id: 's2', name: '나', token: 'tok2' }],
  relations: {},
  submissions: {},
});

test('FileStore: 파일에 저장하고 다시 읽는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relmap-'));
  const file = path.join(dir, 'rooms.json');
  const a = new FileStore(file);
  a.createRoom(sampleRoom());
  a.updateRoom('room1', (r) => { r.name = '바뀐 이름'; });
  const b = new FileStore(file);
  assert.equal(b.getRoom('room1').name, '바뀐 이름');
  assert.equal(b.findRoomByAdminToken('admin-token').id, 'room1');
  assert.equal(b.findStudentByToken('tok2').student.name, '나');
  b.deleteRoom('room1');
  assert.equal(new FileStore(file).getRoom('room1'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('FileStore: mutator 가 예외를 던지면 아무것도 바뀌지 않는다', () => {
  const s = new FileStore(null);
  s.createRoom(sampleRoom());
  assert.throws(() => s.updateRoom('room1', (r) => { r.name = '망가짐'; r.students.length = 0; throw new Error('boom'); }), /boom/);
  assert.equal(s.getRoom('room1').name, '반');
  assert.equal(s.getRoom('room1').students.length, 2);
  assert.equal(s.updateRoom('없는방', () => {}), null);
});

test('PgStore: 생성/조회/갱신/삭제와 롤백', async () => {
  const pool = new FakePool();
  const s = new PgStore(pool);
  await s.init();
  assert.ok(pool.log.some((q) => /CREATE TABLE IF NOT EXISTS rooms/.test(q)));
  await s.createRoom(sampleRoom());
  assert.equal((await s.getRoom('room1')).name, '반');
  assert.equal((await s.findRoomByAdminToken('admin-token')).id, 'room1');
  assert.equal(await s.findRoomByAdminToken('nope'), null);
  assert.equal((await s.findStudentByToken('tok1')).student.id, 's1');
  assert.equal(await s.findStudentByToken('nope'), null);

  const updated = await s.updateRoom('room1', (r) => { r.locked = true; });
  assert.equal(updated.locked, true);
  assert.equal((await s.getRoom('room1')).locked, true);
  assert.ok(pool.log.some((q) => /FOR UPDATE/.test(q)));

  await assert.rejects(() => s.updateRoom('room1', (r) => { r.name = '망가짐'; throw new Error('boom'); }), /boom/);
  assert.equal(pool.log.at(-1), 'ROLLBACK');
  assert.equal((await s.getRoom('room1')).name, '반');
  assert.equal(await s.updateRoom('없는방', () => {}), null);

  await s.deleteRoom('room1');
  assert.equal(await s.getRoom('room1'), null);
  await s.close();
  assert.equal(pool.ended, true);
});

test('sslOptions: 외부 호스트는 SSL, 내부/로컬은 SSL 없음', () => {
  assert.deepEqual(sslOptions('postgresql://u:p@ep-x.ap-southeast-1.aws.neon.tech/db?sslmode=require', {}), { rejectUnauthorized: true });
  assert.deepEqual(sslOptions('postgresql://u:p@db.example.com/db', { DATABASE_SSL_VERIFY: 'false' }), { rejectUnauthorized: false });
  assert.equal(sslOptions('postgres://u:p@dpg-abc-a/db', {}), false);
  assert.equal(sslOptions('postgres://u:p@localhost:5432/db', {}), false);
  assert.equal(sslOptions('postgres://u:p@db.example.com/db?sslmode=disable', {}), false);
  assert.equal(sslOptions('postgres://u:p@db.example.com/db', { DATABASE_SSL: 'false' }), false);
  assert.deepEqual(sslOptions('postgres://u:p@localhost/db', { DATABASE_SSL: 'true' }), { rejectUnauthorized: true });
});
