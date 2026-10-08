// Student-only temporary work. No DOM dependency so recovery and request ordering can be tested.
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const draftStorageKey = (token, roundId) => `relmap.studentDraft.v1:${encodeURIComponent(token)}:${encodeURIComponent(roundId)}`;
const clone = (value) => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const snapshotOf = (value = {}) => ({ step: value.step || null, sections: clone(value.sections || {}) });

/** One request at a time, revision-checked writes, immediate device recovery on every edit. */
export function createDraftController({ token, roundId, serverDraft = {}, storage = null, send,
  onStatus = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  debounceMs = 600, ttlMs = DRAFT_TTL_MS,
  makeMutationId = () => globalThis.crypto?.randomUUID?.() || `${now()}-${Math.random().toString(36).slice(2)}` }) {
  const key = draftStorageKey(token, roundId);
  const writerId = makeMutationId();
  let revision = serverDraft.revision || 0;
  let serverUpdatedAt = serverDraft.updatedAt || null;
  let snapshot = snapshotOf(serverDraft);
  let pending = false;
  let localSafe = false;
  let storageAvailable = Boolean(storage);
  let restored = false;
  let conflict = null;
  let error = null;
  let timer = null;
  let request = null;
  let generation = 0;
  let paused = false;
  let disposed = false;
  let lastSent = null;

  function removeBackup(force = false) {
    try {
      const local = JSON.parse(storage?.getItem(key) || 'null');
      // A successful save in this tab must not erase a different tab's pending recovery copy.
      if (force || !local?.writerId || local.writerId === writerId) storage?.removeItem(key);
    } catch { /* server remains the authoritative copy */ }
    localSafe = false;
  }

  // Expiry is enforced when this student link is opened, including backups of older rounds.
  try {
    const prefix = `relmap.studentDraft.v1:${encodeURIComponent(token)}:`;
    for (let i = (storage?.length || 0) - 1; i >= 0; i--) {
      const candidate = storage.key(i);
      if (!candidate?.startsWith(prefix)) continue;
      try {
        const item = JSON.parse(storage.getItem(candidate));
        if (!Number.isFinite(item?.savedAt) || now() - item.savedAt > ttlMs) storage.removeItem(candidate);
      } catch { storage.removeItem(candidate); }
    }
    const local = JSON.parse(storage?.getItem(key) || 'null');
    if (local?.version === 1 && local.roundId === roundId && local.pending
      && Number.isFinite(local.savedAt) && now() - local.savedAt <= ttlMs && local.sections && typeof local.sections === 'object') {
      const acknowledged = serverDraft.mutationId && local.lastSent?.mutationId === serverDraft.mutationId
        && local.lastSent.revision + 1 === revision;
      if (local.revision === revision || acknowledged || serverDraft.mutationId) {
        snapshot = snapshotOf(local);
        pending = !same(snapshot, snapshotOf(serverDraft));
        localSafe = pending;
        restored = pending;
        lastSent = acknowledged ? null : local.lastSent || null;
        // A lost acknowledgement can be proven by its mutation id. Any other newer tab's work needs a choice.
        if (pending && (local.conflict || (local.revision !== revision && !acknowledged))) conflict = 'revision';
      } else removeBackup(true); // reset/final submission clears mutationId; never resurrect its earlier draft
    } else if (local) removeBackup(true); // newer server writes (including a reset) always win on reopen
  } catch { storageAvailable = false; }

  function getState() {
    const status = conflict ? 'conflict' : request ? 'saving' : pending
      ? (localSafe ? 'local' : 'unsaved') : (serverUpdatedAt ? 'saved' : 'idle');
    return { ...clone(snapshot), revision, serverUpdatedAt, pending, localSafe, storageAvailable,
      restored, status, conflict, error, safeToLeave: !conflict && (!pending || localSafe) };
  }
  function emit() { if (!disposed) onStatus(getState()); }
  function backup() {
    if (!pending) { removeBackup(); return; }
    try {
      if (!storage) throw new Error('storage unavailable');
      storage.setItem(key, JSON.stringify({ version: 1, roundId, revision, ...snapshot, pending: true, savedAt: now(), lastSent, conflict, writerId }));
      storageAvailable = true;
      localSafe = true;
    } catch { storageAvailable = false; localSafe = false; }
  }
  function cancelTimer() { if (timer !== null) clearTimer(timer); timer = null; }
  function schedule() {
    cancelTimer();
    if (!pending || paused || disposed || conflict) return;
    timer = setTimer(() => { timer = null; void flush(); }, debounceMs);
  }
  function update(value) {
    if (disposed) return;
    const next = snapshotOf(value);
    if (same(next, snapshot)) return;
    snapshot = next;
    generation++;
    pending = true;
    error = null;
    backup(); // synchronous: a lid-close before the debounce still has a recovery copy
    emit();
    schedule();
  }
  function flush({ keepalive = false } = {}) {
    cancelTimer();
    if (request) return request;
    if (disposed || conflict) return Promise.resolve(false);
    if (!pending) return Promise.resolve(true);
    // Create the promise before invoking send, including adapters that synchronously throw.
    request = Promise.resolve().then(async () => {
      while (pending && !disposed && !conflict) {
        const sentGeneration = generation;
        const mutationId = makeMutationId();
        const body = { roundId, revision, mutationId, ...clone(snapshot) };
        // Fetch keepalive has a shared 64 KiB budget. The synchronous local copy handles larger work.
        if (keepalive && new TextEncoder().encode(JSON.stringify(body)).length > 60000) return false;
        const previousSent = lastSent;
        lastSent = { mutationId, revision };
        backup(); // remember the write's identity before dispatch, even if its acknowledgement is lost
        try {
          const response = await send(body, { keepalive });
          if (disposed) return false;
          const saved = response?.draft;
          if (!saved || !Number.isInteger(saved.revision) || saved.revision <= revision) throw new Error('임시 저장 응답을 확인하지 못했어. 다시 저장해 줘.');
          revision = saved.revision;
          serverUpdatedAt = saved.updatedAt || null;
          lastSent = null;
          error = null;
          if (sentGeneration === generation) {
            snapshot = snapshotOf(saved);
            pending = false;
          } // a newer edit stays in memory and is sent next with the acknowledged revision
          backup();
        } catch (err) {
          error = err?.message || '서버에 연결하지 못했어.';
          if (err?.status === 409) {
            const acknowledged = err.draft;
            if (err.code === 'DRAFT_CONFLICT' && acknowledged?.mutationId && previousSent?.mutationId === acknowledged.mutationId
              && previousSent.revision + 1 === acknowledged.revision) {
              revision = acknowledged.revision;
              serverUpdatedAt = acknowledged.updatedAt || null;
              lastSent = null;
              error = null;
              backup();
              continue; // confirmed acknowledgement of our own earlier write, not a blind conflict retry
            }
            conflict = err.code === 'ROUND_CHANGED' ? 'round' : 'revision';
          }
          backup();
          return false; // retry only after another edit, online/resume, or an explicit save
        }
      }
      return !pending;
    }).finally(() => { request = null; emit(); });
    emit();
    return request;
  }

  function adopt(next) {
    cancelTimer();
    revision = next?.revision || 0;
    serverUpdatedAt = next?.updatedAt || null;
    snapshot = snapshotOf(next);
    pending = false;
    conflict = null;
    error = null;
    restored = false;
    lastSent = null;
    generation++;
    removeBackup();
    emit();
  }
  /** Call after pending requests have settled. A newer remote revision never silently overwrites edits. */
  function reconcile(next = {}) {
    if ((next.revision || 0) === revision) return false;
    if ((next.revision || 0) < revision) return false; // stale GET response
    if (pending && next.mutationId && lastSent?.mutationId === next.mutationId && lastSent.revision + 1 === next.revision) {
      revision = next.revision;
      serverUpdatedAt = next.updatedAt || null;
      lastSent = null;
      pending = !same(snapshot, snapshotOf(next));
      error = null;
      conflict = null;
      backup();
      emit();
      return false; // rebase newer local typing only after proving that our earlier request committed
    }
    if (pending) {
      conflict = 'revision';
      cancelTimer();
      emit();
      return false;
    }
    adopt(next);
    return true;
  }
  async function settle() { cancelTimer(); if (request) await request; }
  function pause() { paused = true; cancelTimer(); }
  function resume() { paused = false; schedule(); }
  function dispose() { disposed = true; cancelTimer(); }
  if (pending) backup();
  emit();
  schedule();
  return { key, getState, update, flush, reconcile, adopt, settle, pause, resume, dispose };
}
