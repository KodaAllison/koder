// @ts-check
/* Entry point. The app is split into focused modules:
 *
 *   store.js   — pure board logic (BOARDS, normalize, merge); node-testable
 *   state.js   — mutable app state + localStorage persistence
 *   sync.js    — optional server sync (rev-guarded last-write-wins)
 *   board.js   — kanban rendering + drag & drop (owns render())
 *   sidebar.js — Life dashboard sidebar
 *   modal.js   — ticket create/edit modal
 *   pwa.js     — service worker registration, install prompt, offline badge
 *   render.js  — repaint indirection so the graph stays acyclic
 *
 * This file just wires them together: load projects, first paint, start sync. */

import './pwa.js';
import './connect.js';
import { loadProjects } from './state.js';
import { initSync } from './sync.js';
import { render } from './board.js';
import { editorBusy } from './modal.js';

/* Sync-error badge: HTTP failures (413 board-too-large, 401 bad token, …)
 * would otherwise leave the board silently diverging from the server. */
const syncBadge = /** @type {HTMLElement} */ (document.getElementById('syncBadge'));
/** @param {string|null} msg */
function showSyncStatus(msg) {
  syncBadge.hidden = !msg;
  syncBadge.textContent = msg || '';
}

/* Boot: load the project list, paint from the local cache, then sync.
 * (state is loaded from localStorage synchronously on state.js import.) */
async function init() {
  await loadProjects();
  render();                       // instant first paint from the cache
  await initSync({ render, editorBusy, onStatus: showSyncStatus });
}
init();
