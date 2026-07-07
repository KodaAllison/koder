// @ts-check
/* ==================== Server sync (optional) ====================
 * If js/config.local.js defines window.KODER_API = { base, token }, the board
 * syncs with a small Deno Deploy server (see server/). The server copy is
 * canonical; localStorage stays as the offline cache / instant first paint.
 * Without config the app runs exactly as before: pure localStorage.
 *
 * Model: last-write-wins guarded by a monotonic `rev`.
 *  - Local changes mark the board dirty and schedule a debounced full-board
 *    PUT carrying the rev we last synced (baseRev).
 *  - The server 409s a stale baseRev. We then merge down anything added
 *    remotely (agent tickets via POST /tickets) and retry on the fresh rev,
 *    so an open tab can't clobber a ticket an agent just created.
 *  - The dirty flag persists in localStorage, so edits made right before the
 *    tab closed get pushed on next boot instead of being reverted by pull.
 *
 * UI hooks (render / editorBusy / onStatus) are injected via initSync() so
 * this module never imports the render layer. */

import { normalize, allCardIds, mergeBoards, boardHasContent } from './store.js';
import { STORE_KEY, state, setState, writeCache, onSave } from './state.js';

export const SYNC = {
  rev: parseInt(localStorage.getItem(STORE_KEY + ':rev') || '0', 10),
  dirty: localStorage.getItem(STORE_KEY + ':dirty') === '1',
  pushing: false,
  pushTimer: /** @type {any} */ (null),
  pullTimer: /** @type {any} */ (null),
};

/* Injected by initSync(). Defaults are no-ops so nothing here explodes if a
 * sync function is somehow reached before init. */
let hooks = {
  render: () => {},
  editorBusy: () => false,
  /** @param {string|null} msg */
  onStatus: (msg) => {},
};

export function apiEnabled() {
  const cfg = /** @type {any} */ (window).KODER_API;
  return !!(cfg && cfg.base && cfg.token);
}

/** @param {string} method @param {string} path @param {unknown} [body] */
function api(method, path, body) {
  const { base, token } = /** @type {any} */ (window).KODER_API;
  return fetch(base.replace(/\/+$/, '') + path, {
    method,
    headers: {
      'Authorization': 'Bearer ' + token,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

export function markDirty() { SYNC.dirty = true; localStorage.setItem(STORE_KEY + ':dirty', '1'); }

/* Record a sync point: the rev plus the card ids the server knows about.
 * The id set is how a 409-merge tells "added remotely" (unknown id → keep)
 * from "deleted locally" (known id → the local deletion wins). */
function adoptRev(rev) {
  SYNC.rev = rev;
  SYNC.dirty = false;
  localStorage.setItem(STORE_KEY + ':rev', String(rev));
  localStorage.removeItem(STORE_KEY + ':dirty');
  localStorage.setItem(STORE_KEY + ':syncedIds', JSON.stringify([...allCardIds(state)]));
}

function knownIds() {
  let synced = [];
  try { synced = JSON.parse(localStorage.getItem(STORE_KEY + ':syncedIds') || '') || []; } catch (e) {}
  return new Set(synced);
}

/* Map a failed response to a user-facing status message. Network errors are
 * NOT surfaced here — the offline badge already covers "no connectivity",
 * and the persisted dirty flag means those retry safely. HTTP errors are
 * different: they'll never self-heal, so the user must be told. */
/** @param {Response} res */
function reportHttpError(res) {
  if (res.status === 413) hooks.onStatus('Sync failing: board too large for the server');
  else if (res.status === 401) hooks.onStatus('Sync failing: token rejected');
  else hooks.onStatus(`Sync failing (HTTP ${res.status})`);
}

/* Debounced: sticky notes and focus items call save() per keystroke; the
 * localStorage write stays immediate but the network push batches. */
export function schedulePush(delay = 800) {
  if (!apiEnabled()) return;
  clearTimeout(SYNC.pushTimer);
  SYNC.pushTimer = setTimeout(pushState, delay);
}

export async function pushState() {
  if (!apiEnabled()) return;
  if (SYNC.pushing) { schedulePush(); return; }
  SYNC.pushing = true;
  try {
    let res = await api('PUT', '/state', { baseRev: SYNC.rev, board: state });
    // A 409 means someone wrote since our baseRev — usually agent tickets via
    // POST /tickets, which can arrive in a burst that bumps rev several times.
    // Merge their additions and retry on the fresh rev, looping because another
    // write can land between our GET and our retry PUT so a single pass isn't
    // enough. Mirrors the server's own 5-attempt commit loop; each GET's
    // round-trip is the natural backoff, so no explicit sleep is needed.
    for (let attempt = 0; res.status === 409 && attempt < 5; attempt++) {
      const cur = await api('GET', '/state');
      // A failed re-GET means we didn't merge, so baseRev is unchanged and the
      // next PUT would just 409 again — bail and surface the GET's real error
      // below instead of masking it as an unresolved conflict.
      if (!cur.ok) { res = cur; break; }
      mergeRemote(await cur.json());
      res = await api('PUT', '/state', { baseRev: SYNC.rev, board: state });
    }
    if (res.ok) {
      const j = await res.json();
      adoptRev(j.rev);
      hooks.onStatus(null);
    } else {
      // Non-409 failure (or a 409 that survived the merge+retry): the board
      // stays dirty and would otherwise diverge silently — surface it.
      reportHttpError(res);
    }
  } catch (e) { /* offline — stay dirty; retried on online/focus/next boot */ }
  finally { SYNC.pushing = false; }
}

/* Merge a fresher server doc into dirty local state (see store.mergeBoards). */
function mergeRemote(doc) {
  const server = normalize(doc.board || {});
  mergeBoards(state, server, knownIds());
  SYNC.rev = doc.rev;
  localStorage.setItem(STORE_KEY + ':rev', String(doc.rev));
  writeCache();
  hooks.render();
}

export async function pullState() {
  if (!apiEnabled()) return;
  if (SYNC.dirty || SYNC.pushing) { schedulePush(0); return; } // our edits go first (409-merge picks up remote adds)
  if (hooks.editorBusy()) return;
  try {
    const res = await api('GET', '/state');
    if (!res.ok) { reportHttpError(res); return; }
    const doc = await res.json();
    if (!doc || typeof doc.rev !== 'number') return;
    hooks.onStatus(null);
    if (doc.rev === 0) {
      // Empty server + non-empty local board → first run: seed the server.
      if (boardHasContent(state)) {
        markDirty();
        schedulePush(0);
      }
      return;
    }
    if (doc.rev <= SYNC.rev) return; // nothing new
    // A device that used the app before sync was configured has content but
    // has never synced (rev 0, not dirty). Adopting the server board here
    // would silently erase data that never reached the server — push instead;
    // the 409-merge path unions the two boards.
    if (SYNC.rev === 0 && boardHasContent(state)) {
      markDirty();
      schedulePush(0);
      return;
    }
    setState(normalize(doc.board || {}));
    writeCache();
    adoptRev(doc.rev);
    hooks.render();
  } catch (e) { /* offline — keep the local cache */ }
}

export function schedulePull(delay = 300) {
  if (!apiEnabled()) return;
  clearTimeout(SYNC.pullTimer);
  SYNC.pullTimer = setTimeout(pullState, delay);
}

/* Wire the sync loop: called once from app.js after first paint.
 * Registers the save hook, flushes leftover dirty state, then keeps the tab
 * fresh via focus/visibility/interval refetches. */
/**
 * @param {{ render: () => void,
 *           editorBusy: () => boolean,
 *           onStatus: (msg: string|null) => void }} h
 */
export async function initSync(h) {
  hooks = h;
  onSave(() => { markDirty(); schedulePush(); });
  if (!apiEnabled()) return;

  if (SYNC.dirty) await pushState(); // flush edits left over from last session
  await pullState();

  // Keep in sync while the tab is open: refetch on focus/visibility plus a
  // light timer, so agent-added tickets appear without a manual reload.
  window.addEventListener('focus', () => schedulePull());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') schedulePull();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') pullState();
  }, 30000);
  window.addEventListener('online', () => { if (SYNC.dirty) schedulePush(0); });

  // Last-chance flush if the tab closes inside the push debounce window.
  // keepalive lets the request outlive the page; the persisted dirty flag
  // isn't cleared here, so if this beacon fails the next boot retries.
  window.addEventListener('pagehide', () => {
    if (!SYNC.dirty) return;
    try {
      const { base, token } = /** @type {any} */ (window).KODER_API;
      fetch(base.replace(/\/+$/, '') + '/state', {
        method: 'PUT',
        keepalive: true,
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseRev: SYNC.rev, board: state }),
      });
    } catch (e) { /* best effort */ }
  });
}
