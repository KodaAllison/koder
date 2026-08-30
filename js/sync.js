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

import { normalize, allCardIds, lifeMetaIds, mergeBoards, boardHasContent,
         boardSize, removeProjectTicket, reconcileDeletedTicket,
         BOARD_SIZE_LIMIT, BOARD_SIZE_WARN } from './store.js';
import { STORE_KEY, state, setState, writeCache, onSave } from './state.js';

/* ---- API config resolution ----
 * Two sources, checked in order:
 *  1. js/config.local.js (gitignored classic script) sets window.KODER_API
 *     directly — the local-dev override, loaded before any module runs.
 *  2. A token pasted into the header's "Connect sync" flow, persisted in
 *     localStorage. The API base is this same origin — frontend and API are
 *     one Deno app — so only the token needs storing.
 * The server never serves the token: handing it to whoever GETs a URL would
 * make the bearer auth pointless (see server/main.ts). Each device gets the
 * token pasted once instead. */
const TOKEN_KEY = STORE_KEY + ':apiToken';
{
  const w = /** @type {any} */ (window);
  const token = localStorage.getItem(TOKEN_KEY);
  if (!w.KODER_API && token) w.KODER_API = { base: location.origin, token };
}

/* Validate a pasted token against this origin's API; persist it on success.
 * The caller reloads so the app boots through the normal sync path. A wrong
 * token, or a host with no API behind it (npx serve), returns false. */
/** @param {string} token @returns {Promise<boolean>} */
export async function connectSync(token) {
  token = token.trim();
  if (!token) return false;
  try {
    const res = await fetch('/state', { headers: { 'Authorization': 'Bearer ' + token } });
    if (!res.ok) return false;
  } catch (e) { return false; }
  localStorage.setItem(TOKEN_KEY, token);
  return true;
}

export const SYNC = {
  rev: parseInt(localStorage.getItem(STORE_KEY + ':rev') || '0', 10),
  dirty: localStorage.getItem(STORE_KEY + ':dirty') === '1',
  pushing: false,
  pushTimer: /** @type {any} */ (null),
  pullTimer: /** @type {any} */ (null),
};
let localMutationVersion = 0;

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

/* The authenticated request helper. Exported because js/archive.js posts to
 * /archive through the same base+token config. */
/** @param {string} method @param {string} path @param {unknown} [body] */
export function apiRequest(method, path, body) {
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

/* The header badge, reached by other modules (archive.js) without them having
 * to know how app.js wired it up. */
/** @param {string|null} msg */
export function syncStatus(msg) { hooks.onStatus(msg); }

export function markDirty() {
  localMutationVersion++;
  SYNC.dirty = true;
  localStorage.setItem(STORE_KEY + ':dirty', '1');
}

/** Record a sync point: the rev plus the item ids the server knows about —
 * cards on both boards and lifeMeta items (focus/dates/stickies), which merge
 * the same way. The id set is how a 409-merge tells "added remotely" (unknown
 * id → keep) from "deleted locally" (known id → the local deletion wins).
 * @param {number} rev
 */
function adoptRev(rev) {
  SYNC.rev = rev;
  SYNC.dirty = false;
  localStorage.setItem(STORE_KEY + ':rev', String(rev));
  localStorage.removeItem(STORE_KEY + ':dirty');
  localStorage.setItem(STORE_KEY + ':syncedIds',
    JSON.stringify([...allCardIds(state), ...lifeMetaIds(state)]));
}

function knownIds() {
  let synced = [];
  try { synced = JSON.parse(localStorage.getItem(STORE_KEY + ':syncedIds') || '') || []; } catch (e) {}
  return new Set(synced);
}

/* Success-path status. Not simply "clear the badge": a board approaching the
 * server's 60_000 ceiling gets a heads-up here, while pushes still work, so
 * the first 413 isn't also the first warning. */
function statusOk() { hooks.onStatus(sizeWarning()); }

/** @returns {string|null} */
function sizeWarning() {
  const size = boardSize(state);
  if (size < BOARD_SIZE_WARN) return null;
  const pct = Math.round((size / BOARD_SIZE_LIMIT) * 100);
  return `Board at ${pct}% of the sync limit — archive done cards`;
}

/* Map a failed response to a user-facing status message. Network errors are
 * NOT surfaced here — the offline badge already covers "no connectivity",
 * and the persisted dirty flag means those retry safely. HTTP errors are
 * different: they'll never self-heal, so the user must be told. */
/** @param {Response} res */
function reportHttpError(res) {
  if (res.status === 413) hooks.onStatus('Board too large to sync — archive done cards');
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
  if (!apiEnabled()) return false;
  if (SYNC.pushing) { schedulePush(); return false; }
  SYNC.pushing = true;
  const mutationAtPush = localMutationVersion;
  try {
    let res = await apiRequest('PUT', '/state', { baseRev: SYNC.rev, board: state });
    // A 409 means someone wrote since our baseRev — usually agent tickets via
    // POST /tickets, which can arrive in a burst that bumps rev several times.
    // Merge their additions and retry on the fresh rev, looping because another
    // write can land between our GET and our retry PUT so a single pass isn't
    // enough. Mirrors the server's own 5-attempt commit loop; each GET's
    // round-trip is the natural backoff, so no explicit sleep is needed.
    for (let attempt = 0; res.status === 409 && attempt < 5; attempt++) {
      const cur = await apiRequest('GET', '/state');
      // A failed re-GET means we didn't merge, so baseRev is unchanged and the
      // next PUT would just 409 again — bail and surface the GET's real error
      // below instead of masking it as an unresolved conflict.
      if (!cur.ok) { res = cur; break; }
      mergeRemote(await cur.json());
      res = await apiRequest('PUT', '/state', { baseRev: SYNC.rev, board: state });
    }
    if (res.ok) {
      const j = await res.json();
      if (localMutationVersion !== mutationAtPush) {
        recordRev(j.rev);
        schedulePush(0);
        return false;
      }
      adoptRev(j.rev);
      statusOk();
      return true;
    } else {
      // Non-409 failure (or a 409 that survived the merge+retry): the board
      // stays dirty and would otherwise diverge silently — surface it.
      reportHttpError(res);
    }
  } catch (e) { /* offline — stay dirty; retried on online/focus/next boot */ }
  finally { SYNC.pushing = false; }
  return false;
}

/** @param {number} rev */
function recordRev(rev) {
  SYNC.rev = rev;
  localStorage.setItem(STORE_KEY + ':rev', String(rev));
}

/** Hard-delete one projects-board ticket without sending a whole-board PUT.
 * The successful response carries the exact committed board and revision, so
 * no follow-up GET can race local edits. A concurrent local mutation merges
 * that canonical board before advancing the PUT base revision.
 * @param {string} id @returns {Promise<boolean>}
 */
export async function deleteTicket(id) {
  if (!apiEnabled()) return false;
  if (SYNC.dirty && !await pushState()) return false;
  const mutationAtDelete = localMutationVersion;
  let removed;
  try {
    removed = await apiRequest('DELETE', `/tickets/${encodeURIComponent(id)}`);
    if (!removed.ok) { reportHttpError(removed); return false; }
  } catch (e) {
    hooks.onStatus('Delete failed — still offline?');
    return false;
  }

  const result = await removed.json().catch(() => null);
  if (
    !result || typeof result.rev !== 'number' || !result.board ||
    typeof result.board !== 'object'
  ) {
    removeProjectTicket(state, id);
    writeCache();
    // Keep the OLD base revision. A dirty retry must 409 and merge; a clean
    // board pulls. Either path reconciles safely without trusting a malformed
    // success response or putting stale state at the new server revision.
    if (SYNC.dirty) schedulePush(0);
    else schedulePull(0);
    hooks.onStatus('Ticket deleted; response incomplete, reconciling');
    return true;
  }

  const canonical = normalize(result.board);
  if (localMutationVersion === mutationAtDelete) {
    setState(canonical);
    writeCache();
    adoptRev(result.rev);
    statusOk();
  } else {
    reconcileDeletedTicket(state, canonical, id, knownIds());
    // Cache the merged board before advancing its base revision: a crash in
    // between leaves the older base and therefore forces a safe 409 merge.
    writeCache();
    recordRev(result.rev);
    schedulePush(0);
    hooks.onStatus('Ticket deleted; syncing newer local edits');
  }
  return true;
}

/** Merge a fresher server doc into dirty local state (see store.mergeBoards).
 * @param {{ board?: unknown, rev: number }} doc
 */
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
  const mutationAtPull = localMutationVersion;
  try {
    const res = await apiRequest('GET', '/state');
    if (!res.ok) { reportHttpError(res); return; }
    const doc = await res.json();
    if (!doc || typeof doc.rev !== 'number') return;
    if (SYNC.dirty || localMutationVersion !== mutationAtPull) {
      schedulePush(0);
      return;
    }
    statusOk();
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
    statusOk();   // re-check: the board we just adopted is the one that matters
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
  window.addEventListener('online', () => {
    if (SYNC.dirty) schedulePush(0);
    else schedulePull(0);
  });

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
