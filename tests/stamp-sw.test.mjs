/* Unit tests for scripts/stamp-sw.mjs — the CACHE_NAME stamper.
 *
 * Deliberately NOT asserted here: that sw.js's committed CACHE_NAME is currently
 * up to date. Stamping happens on main before deploy, never on a feature branch
 * (see README), so any branch that touches a shell asset is legitimately "stale"
 * while it's in flight — asserting freshness would paint the suite red for the
 * entire life of every UI branch. `node scripts/stamp-sw.mjs --check` is the
 * guard for that, and it runs at deploy time.
 *
 * What is worth pinning down is the script's own logic: it parses sw.js, and it
 * must produce a name that changes when (and only when) the cached bytes do.
 * Run with:  node --test   (from the repo root) */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShellAssets, readCacheName, computeCacheName } from '../scripts/stamp-sw.mjs';

/* Real asset paths, so computeCacheName can actually read them off disk, but a
 * hand-written source so these tests don't move every time sw.js does. */
const FIXTURE = `
const CACHE_NAME = 'kanban-shell-abc123';

const SHELL_ASSETS = [
  './',
  './index.html',
  './css/styles.css',
];
`;

test('parseShellAssets pulls the entries out of sw.js source', () => {
  assert.deepEqual(parseShellAssets(FIXTURE), ['./', './index.html', './css/styles.css']);
});

test('parseShellAssets throws rather than silently hashing nothing', () => {
  assert.throws(() => parseShellAssets('const CACHE_NAME = "x";'), /SHELL_ASSETS/);
});

test('readCacheName finds the current constant', () => {
  assert.equal(readCacheName(FIXTURE), 'kanban-shell-abc123');
});

test('readCacheName throws when the constant is missing', () => {
  assert.throws(() => readCacheName('const SHELL_ASSETS = [];'), /CACHE_NAME/);
});

test('computeCacheName is deterministic for unchanged content', () => {
  assert.equal(computeCacheName(FIXTURE), computeCacheName(FIXTURE));
});

test('computeCacheName has the kanban-shell-<hex> shape', () => {
  assert.match(computeCacheName(FIXTURE), /^kanban-shell-[0-9a-f]{12}$/);
});

test('computeCacheName ignores the old CACHE_NAME it is replacing', () => {
  // Otherwise stamping would never reach a fixed point: the name would feed
  // back into its own hash and change on every run.
  const restamped = FIXTURE.replace('kanban-shell-abc123', 'kanban-shell-deadbeef0000');
  assert.equal(computeCacheName(restamped), computeCacheName(FIXTURE));
});

test('computeCacheName changes when the asset list changes', () => {
  const fewer = FIXTURE.replace("  './css/styles.css',\n", '');
  assert.notEqual(computeCacheName(fewer), computeCacheName(FIXTURE));
});

test('computeCacheName distinguishes different asset content', () => {
  // Same number of entries, different files — so the difference can only come
  // from the bytes being hashed, not from the shape of the list.
  const a = "const SHELL_ASSETS = [\n  './index.html',\n];";
  const b = "const SHELL_ASSETS = [\n  './css/styles.css',\n];";
  assert.notEqual(computeCacheName(a), computeCacheName(b));
});
