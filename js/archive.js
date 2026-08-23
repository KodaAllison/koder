// @ts-check
/* Archiving finished cards.
 *
 * The whole board is ONE value on the sync server, and Deno KV caps a value at
 * 64KB (the server rejects a PUT body over 60_000). Done is the only column
 * that only ever grows, so it is what eventually walks the board into that
 * wall — and the failure mode is bad: every push 413s, the board stays dirty
 * forever, and all you get is a badge.
 *
 * So: lift done cards off the board into the server's append-only archive
 * (POST /archive, chunked across its own KV keys) and drop them locally. The
 * order matters — the server acknowledges the cards BEFORE they leave the
 * board, so a failed request loses nothing and a retry is safe (the server
 * skips ids it already holds).
 *
 * Archiving needs the server by definition: with no sync configured there's no
 * archive to put anything in, and deleting the only copy isn't archiving. The
 * button is hidden in that case — see canArchive(). */

import { boardFor, removeDoneCards } from './store.js';
import { state, activeTab, save } from './state.js';
import { apiEnabled, apiRequest, syncStatus } from './sync.js';
import { render } from './render.js';

/* Whether the Done column should offer an Archive button at all. */
export function canArchive() { return apiEnabled(); }

/** @param {number} n */
function label(n) { return n === 1 ? '1 done ticket' : `${n} done tickets`; }

/** Archive the given done cards: confirm, hand them to the server, then take
 * them off the board. `cards` is whatever the Done column is currently showing
 * — so on a project tab it archives that project's done work, not everyone's.
 * @param {import('./store.js').Card[]} cards */
export async function archiveDone(cards) {
  if (!cards.length) return;
  const boardId = boardFor(activeTab);
  if (!confirm(
    `Archive ${label(cards.length)}?\n\n` +
    'They come off the board and into the server archive, which keeps the ' +
    'board small enough to keep syncing. Archived tickets stay readable at ' +
    'GET /archive, but they do not come back to the board.'
  )) return;

  // Tag each card with where it came from and when it left, so an archive read
  // makes sense without the board next to it.
  const archivedAt = Date.now();
  const payload = cards.map(c => ({ ...c, board: boardId, archivedAt }));

  let res;
  try {
    res = await apiRequest('POST', '/archive', { cards: payload });
  } catch (e) {
    // Offline: nothing was sent, nothing was removed. Retrying later is safe.
    syncStatus('Archive failed — no connection');
    return;
  }
  if (!res.ok) {
    syncStatus(`Archive failed (HTTP ${res.status})`);
    return;
  }

  removeDoneCards(state, boardId, new Set(cards.map(c => c.id)));
  syncStatus(null);
  save();      // marks dirty + schedules the push that shrinks the server board
  render();
}
