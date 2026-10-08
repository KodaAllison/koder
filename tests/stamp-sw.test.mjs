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
import { parseShellAssets, readCacheName, computeCacheName, hashableBytes } from '../scripts/stamp-sw.mjs';

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

/* Line endings. With core.autocrlf=true a Windows checkout has CRLF text files
 * while main's blobs (and a Linux/CI checkout, and the deploy) are LF, so the
 * name must not depend on which one is on disk. These use in-memory fixtures
 * via computeCacheName's readAsset seam, so they don't depend on the checkout. */
const EOL_FIXTURE = "const SHELL_ASSETS = [\n  './',\n  './js/app.js',\n  './icons/icon.png',\n];";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x0d, 0x0a, 0xff]);
const LF_TEXT = {
  './': Buffer.from('<!doctype html>\n<title>k</title>\n'),
  './js/app.js': Buffer.from("// @ts-check\nimport './store.js';\n"),
};

/** @param {Record<string, Buffer>} files */
const reader = (files) => (/** @type {string} */ entry) => files[entry] ?? PNG;
/** @param {Buffer} buf */
const toCrlf = (buf) => Buffer.from(buf.toString('latin1').replace(/\n/g, '\r\n'), 'latin1');

test('computeCacheName is the same for LF and CRLF checkouts of text assets', () => {
  const crlf = Object.fromEntries(Object.entries(LF_TEXT).map(([k, v]) => [k, toCrlf(v)]));
  assert.ok(crlf['./js/app.js'].includes('\r\n')); // fixture really is CRLF
  assert.equal(computeCacheName(EOL_FIXTURE, reader(crlf)), computeCacheName(EOL_FIXTURE, reader(LF_TEXT)));
});

test('computeCacheName is the same for a file with mixed line endings', () => {
  // gen-projects.sh output on a Windows checkout can end up part CRLF, part LF.
  const mixed = { ...LF_TEXT, './js/app.js': Buffer.from("// @ts-check\r\nimport './store.js';\n") };
  assert.equal(computeCacheName(EOL_FIXTURE, reader(mixed)), computeCacheName(EOL_FIXTURE, reader(LF_TEXT)));
});

test('computeCacheName still notices real text edits', () => {
  const edited = { ...LF_TEXT, './js/app.js': Buffer.from("// @ts-check\nimport './sync.js';\n") };
  assert.notEqual(computeCacheName(EOL_FIXTURE, reader(edited)), computeCacheName(EOL_FIXTURE, reader(LF_TEXT)));
});

test('hashableBytes leaves binary assets byte-for-byte alone', () => {
  // A PNG header contains \r\n; normalizing it would corrupt the content hash.
  assert.ok(hashableBytes('./icons/icon.png', PNG).equals(PNG));
  assert.ok(hashableBytes('./icons/ICON.PNG', PNG).equals(PNG));
  assert.ok(!hashableBytes('./js/app.js', PNG).equals(PNG)); // ...which text would strip
});

test('computeCacheName hashes binary assets raw, so \r\n vs \n there is a change', () => {
  const lfPng = Buffer.from(PNG.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  const withPng = (/** @type {Buffer} */ png) => (/** @type {string} */ e) => LF_TEXT[e] ?? png;
  assert.notEqual(computeCacheName(EOL_FIXTURE, withPng(PNG)), computeCacheName(EOL_FIXTURE, withPng(lfPng)));
});
