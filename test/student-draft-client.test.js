import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDraftController, draftStorageKey, DRAFT_TTL_MS } from '../public/js/student-drafts.js';

function memoryStorage() {
  const entries = new Map();
  return { get length() { return entries.size; }, key: (i) => [...entries.keys()][i],
    getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value), removeItem: (key) => entries.delete(key) };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));
const empty = (revision = 0) => ({ revision, updatedAt: null, step: null, sections: {}, mutationId: null });
const profile = (text) => ({ step: 'profile', sections: { profile: { traits: [], partnerTraits: [], partnerText: text, body: {} } } });
const saved = (body) => ({ draft: { revision: body.revision + 1, updatedAt: '2026-10-08T03:00:00.000Z', step: body.step,
  sections: structuredClone(body.sections), mutationId: body.mutationId } });

function setup(overrides = {}) {
  const storage = overrides.storage || memoryStorage();
  const calls = [];
  const timers = new Map();
  let nextTimer = 0;
  let nextMutation = 0;
  const controller = createDraftController({ token: 'student-one', roundId: 'round-one', serverDraft: empty(), storage,
    now: () => 100000, makeMutationId: () => `test-write-${++nextMutation}-${Math.random()}`,
    setTimer: (fn) => { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimer: (id) => timers.delete(id),
    send: async (body, options) => { calls.push({ body: structuredClone(body), options }); return saved(body); }, ...overrides });
  return { controller, storage, calls, timers, async tick() { const work = [...timers.values()]; timers.clear(); work.forEach((fn) => fn()); await turn(); } };
}

test('each edit is recoverable before debounce; only the latest complete snapshot is sent', async () => {
  const { controller, storage, calls, timers, tick } = setup();
  controller.update(profile('첫 글'));
  controller.update(profile('마지막 글자까지'));
  assert.equal(calls.length, 0);
  assert.equal(timers.size, 1);
  assert.equal(JSON.parse(storage.getItem(controller.key)).sections.profile.partnerText, '마지막 글자까지');
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.sections.profile.partnerText, '마지막 글자까지');
  assert.equal(controller.getState().status, 'saved');
  assert.equal(storage.getItem(controller.key), null);
});

test('reopening restores an unsent same-revision device backup and a separate device gets server drafts', async () => {
  const first = setup();
  first.controller.update(profile('아직 제출하지 않은 글'));
  first.controller.dispose();
  const resumed = setup({ storage: first.storage });
  assert.equal(resumed.controller.getState().restored, true);
  assert.equal(resumed.controller.getState().sections.profile.partnerText, '아직 제출하지 않은 글');
  await resumed.controller.flush();
  const otherDevice = setup({ serverDraft: saved(resumed.calls[0].body).draft });
  assert.equal(otherDevice.controller.getState().sections.profile.partnerText, '아직 제출하지 않은 글');
  assert.equal(otherDevice.controller.getState().pending, false);
});

test('edits made during a save queue behind it and use the acknowledged revision', async () => {
  const firstReply = deferred();
  const calls = [];
  const { controller } = setup({ send: (body) => { calls.push(structuredClone(body)); return calls.length === 1 ? firstReply.promise : Promise.resolve(saved(body)); } });
  controller.update(profile('A'));
  const saving = controller.flush();
  await turn();
  controller.update(profile('B'));
  controller.update(profile('C'));
  assert.equal(controller.flush(), saving);
  assert.equal(calls.length, 1);
  firstReply.resolve(saved(calls[0]));
  assert.equal(await saving, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].revision, 1);
  assert.equal(calls[1].sections.profile.partnerText, 'C');
  assert.equal(controller.getState().sections.profile.partnerText, 'C');
});

test('network failure keeps a local-only status, preserves text, and can be manually retried', async () => {
  let offline = true;
  const { controller, storage } = setup({ send: async (body) => { if (offline) throw new TypeError('offline'); return saved(body); } });
  controller.update(profile('연결이 없어도 남겨요'));
  assert.equal(await controller.flush(), false);
  assert.equal(controller.getState().status, 'local');
  assert.equal(controller.getState().safeToLeave, true);
  assert.ok(storage.getItem(controller.key));
  offline = false;
  assert.equal(await controller.flush(), true);
  assert.equal(controller.getState().status, 'saved');
});

test('storage failures never claim device recovery or safe navigation while the network also fails', async () => {
  const denied = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }, removeItem() {} };
  const { controller } = setup({ storage: denied, send: async () => { throw new Error('offline'); } });
  controller.update(profile('메모리만'));
  await controller.flush();
  assert.equal(controller.getState().status, 'unsaved');
  assert.equal(controller.getState().localSafe, false);
  assert.equal(controller.getState().safeToLeave, false);
});

test('teacher reset/final revision discards an older device draft instead of resurrecting it', () => {
  const before = setup();
  before.controller.update(profile('초기화 전'));
  before.controller.dispose();
  const after = setup({ storage: before.storage, serverDraft: empty(1) });
  assert.deepEqual(after.controller.getState().sections, {});
  assert.equal(after.controller.getState().pending, false);
  assert.equal(before.storage.getItem(after.controller.key), null);
});

test('expired backups are removed on access, and an old round is never copied into a new round', () => {
  const previous = setup();
  previous.controller.update(profile('이전 회차')); previous.controller.dispose();
  const next = setup({ storage: previous.storage, roundId: 'round-two' });
  assert.deepEqual(next.controller.getState().sections, {});
  assert.ok(previous.storage.getItem(draftStorageKey('student-one', 'round-one')));
  next.controller.dispose();
  const expired = setup({ storage: previous.storage, now: () => 100000 + DRAFT_TTL_MS + 1 });
  assert.deepEqual(expired.controller.getState().sections, {});
  assert.equal(previous.storage.length, 0);
});

test('a different tab revision blocks writes and keeps a recovery conflict across reloads', async () => {
  let count = 0;
  const remote = { ...profile('다른 탭'), revision: 4, mutationId: 'another-tab', updatedAt: '2026-10-08T03:00:00.000Z' };
  const { controller, storage } = setup({ send: async () => { count++; throw Object.assign(new Error('conflict'), { status: 409, code: 'DRAFT_CONFLICT', draft: remote }); } });
  controller.update(profile('이 탭의 글'));
  await controller.flush();
  assert.equal(controller.getState().conflict, 'revision');
  assert.equal(controller.getState().safeToLeave, false);
  controller.update(profile('이 탭의 새 글'));
  assert.equal(await controller.flush(), false);
  assert.equal(count, 1);
  controller.dispose();
  const reopened = setup({ storage, serverDraft: remote });
  assert.equal(reopened.controller.getState().conflict, 'revision');
  assert.equal(reopened.controller.getState().sections.profile.partnerText, '이 탭의 새 글');
  reopened.controller.adopt(remote);
  assert.equal(reopened.controller.getState().sections.profile.partnerText, '다른 탭');
  assert.equal(reopened.controller.getState().pending, false);
});

test('lid-close after server commit but before acknowledgement restores newer typing using the mutation id', async () => {
  let committed;
  const neverReply = deferred();
  const first = setup({ send: (body) => { committed = saved(body).draft; return neverReply.promise; } });
  first.controller.update(profile('A sent'));
  void first.controller.flush(); await turn();
  first.controller.update(profile('B typed after dispatch'));
  first.controller.dispose(); // the document vanished without receiving the successful response
  const resumed = setup({ storage: first.storage, serverDraft: committed });
  assert.equal(resumed.controller.getState().revision, 1);
  assert.equal(resumed.controller.getState().conflict, null);
  assert.equal(resumed.controller.getState().sections.profile.partnerText, 'B typed after dispatch');
  assert.equal(await resumed.controller.flush(), true);
  assert.equal(resumed.calls[0].body.revision, 1);
  neverReply.resolve({ draft: committed });
});

test('same-tab resume recognizes its lost acknowledgement without falsely reporting another-tab conflict', async () => {
  let committed;
  const { controller } = setup({ send: async (body) => { committed = saved(body).draft; throw new Error('response lost'); } });
  controller.update(profile('A sent'));
  await controller.flush();
  controller.update(profile('B still here'));
  controller.pause();
  controller.reconcile(committed);
  assert.equal(controller.getState().revision, 1);
  assert.equal(controller.getState().pending, true);
  assert.equal(controller.getState().conflict, null);
  assert.equal(controller.getState().sections.profile.partnerText, 'B still here');
});

test('a manual retry after a lost acknowledgement rebases only a proven earlier write', async () => {
  let committed, count = 0;
  const { controller } = setup({ send: async (body) => {
    count++;
    if (count === 1) { committed = saved(body).draft; throw new Error('lost response'); }
    if (count === 2) throw Object.assign(new Error('revision mismatch'), { status: 409, code: 'DRAFT_CONFLICT', draft: committed });
    return saved(body);
  } });
  controller.update(profile('A'));
  await controller.flush();
  controller.update(profile('B'));
  assert.equal(await controller.flush(), true);
  assert.equal(controller.getState().revision, 2);
  assert.equal(controller.getState().sections.profile.partnerText, 'B');
  assert.equal(count, 3);
});

test('final submission coordination drains autosave then adopts the server tombstone without recreating its section', async () => {
  const reply = deferred();
  let sent;
  const { controller, calls, timers, storage, tick } = setup({ send: (body) => { sent = body; calls.push(body); return reply.promise; } });
  const temporary = { step: 'relations', sections: { ...profile('다른 단계의 글').sections, relations: { b: { type: 'bad', tags: [], reason: '임시' } } } };
  controller.update(temporary);
  const saving = controller.flush(); await turn();
  controller.pause();
  const beforeFinal = controller.flush();
  assert.equal(beforeFinal, saving);
  reply.resolve(saved(sent)); await beforeFinal;
  controller.adopt({ ...empty(2), sections: profile('다른 단계의 글').sections });
  controller.resume(); await tick();
  assert.equal(calls.length, 1);
  assert.equal(timers.size, 0);
  assert.equal(controller.getState().sections.relations, undefined);
  assert.equal(controller.getState().sections.profile.partnerText, '다른 단계의 글');
  assert.equal(storage.getItem(controller.key), null);
});

test('keepalive carries small drafts and leaves oversized drafts safely on this device', async () => {
  const normal = setup();
  normal.controller.update(profile('한 글자')); await normal.controller.flush({ keepalive: true });
  assert.equal(normal.calls[0].options.keepalive, true);
  const large = setup();
  large.controller.update(profile('가'.repeat(25000)));
  assert.equal(await large.controller.flush({ keepalive: true }), false);
  assert.equal(large.calls.length, 0);
  assert.equal(large.controller.getState().localSafe, true);
});

test('successful acknowledgement in one tab does not remove another tab recovery copy', async () => {
  const storage = memoryStorage();
  const reply = deferred(); let sent;
  const a = setup({ storage, send: (body) => { sent = body; return reply.promise; } });
  a.controller.update(profile('A')); const saveA = a.controller.flush(); await turn();
  const b = setup({ storage }); b.controller.update(profile('B'));
  reply.resolve(saved(sent)); await saveA;
  assert.equal(JSON.parse(storage.getItem(a.controller.key)).sections.profile.partnerText, 'B');
});

test('an in-flight refresh cannot relabel an old-round final submission as the newly opened round', async () => {
  // Exercise the actual UI orchestration functions with controllable network promises.
  const source = await readFile(new URL('../public/js/student.js', import.meta.url), 'utf8');
  const orchestration = source.slice(source.indexOf('async function refreshStudent('), source.indexOf('// ---------- 한국어 조사'));
  const getReply = deferred(), flushReply = deferred();
  let resumes = 0; const sentFinal = [];
  const store = { pause() {}, settle: async () => {}, flush: () => flushReply.promise, resume() { resumes++; } };
  const api = async (url, options) => {
    if (!options) return getReply.promise;
    sentFinal.push(options.body);
    throw Object.assign(new Error('round changed'), { status: 409 });
  };
  const harness = new Function('api', 'store', `
    let draftStore=store, data={round:{id:'R1'},room:{locked:false}}, submitting=false,refreshPromise=null;
    const token='student',app={inert:false};
    function captureDraft(){} function updateDraftStatus(){} function toast(){} function render(){}
    function initializeStudent(next){data=next;} function applyDraftSections(){}
    ${orchestration}
    return {refreshStudent,submitSection,getRound:()=>data.round.id,isInert:()=>app.inert};
  `)(api, store);
  const refresh = harness.refreshStudent(); await turn();
  const submission = harness.submitSection('profile', { partnerText: 'R1 answer' });
  getReply.resolve({ round: { id: 'R2' }, room: { locked: false }, draft: empty() });
  await refresh;
  assert.equal(harness.getRound(), 'R1');
  assert.equal(resumes, 0);
  flushReply.resolve(true);
  await assert.rejects(submission, { status: 409 });
  assert.equal(sentFinal[0].roundId, 'R1');
  assert.equal(harness.isInert(), false);
});
