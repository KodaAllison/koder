// @ts-check
/* stamp-sw: derive sw.js's CACHE_NAME from a content hash of the app shell.
 *
 * The service worker only installs a new version when sw.js is byte-different
 * (see sw.js's header comment). We used to bump `kanban-shell-vN` by hand, and
 * it was easy to forget — a stale CACHE_NAME means a phone keeps serving the
 * old shell from cache after a deploy. This stamps CACHE_NAME with a hash of
 * the actual SHELL_ASSETS bytes, so it changes exactly when the cached files
 * change and never when they don't. Text assets are hashed with LF line
 * endings, so the name doesn't depend on the checkout's core.autocrlf.
 *
 * The file list is read from sw.js's own SHELL_ASSETS — one source of truth,
 * so it can't drift from what the SW actually pre-caches.
 *
 * Run it on main before deploying, not on feature branches: CACHE_NAME is a
 * single line that every UI branch would otherwise rewrite, so per-branch
 * stamping means a merge conflict per branch. `node --test` deliberately does
 * not assert freshness for the same reason (see tests/stamp-sw.test.mjs).
 *
 * Usage (no build step, no deps — just Node):
 *   node scripts/stamp-sw.mjs          rewrite sw.js's CACHE_NAME in place
 *   node scripts/stamp-sw.mjs --check  exit 1 if CACHE_NAME is stale (pre-deploy)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const PREFIX = 'kanban-shell-';
const HASH_LEN = 12; // hex chars of sha256 — plenty to avoid accidental collisions

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const swPath = path.join(root, 'sw.js');

/** Pull the SHELL_ASSETS string entries out of sw.js source.
 * @param {string} swSource @returns {string[]} */
export function parseShellAssets(swSource) {
  const m = swSource.match(/const SHELL_ASSETS = \[([\s\S]*?)\];/);
  if (!m) throw new Error('stamp-sw: could not find SHELL_ASSETS array in sw.js');
  return [...m[1].matchAll(/'([^']+)'/g)].map((a) => a[1]);
}

/** Read the currently-stamped CACHE_NAME from sw.js source.
 * @param {string} swSource @returns {string} */
export function readCacheName(swSource) {
  const m = swSource.match(/const CACHE_NAME = '([^']+)';/);
  if (!m) throw new Error('stamp-sw: could not find CACHE_NAME in sw.js');
  return m[1];
}

/** Map a SHELL_ASSETS entry to a path on disk. './' is the app root → index.html.
 * @param {string} entry */
function assetToFile(entry) {
  const rel = entry === './' ? 'index.html' : entry.replace(/^\.\//, '');
  return path.join(root, rel);
}

/* Assets hashed as raw bytes. Everything else in SHELL_ASSETS is text, whose
 * line endings depend on the checkout (core.autocrlf=true gives CRLF on
 * Windows) rather than on what's committed and deployed. */
const BINARY_EXT = new Set(['.png', '.ico', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.woff', '.woff2']);

/** The bytes to hash for an asset: CRLF -> LF for text, untouched for binary,
 * so a Windows checkout and a Linux/CI checkout stamp the same name. Only
 * transforms the in-memory copy; the asset on disk is never written.
 * @param {string} entry @param {Buffer} bytes @returns {Buffer} */
export function hashableBytes(entry, bytes) {
  if (BINARY_EXT.has(path.extname(entry).toLowerCase())) return bytes;
  // latin1 maps bytes 1:1 to chars, so this round-trip only drops the \r of \r\n.
  return Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
}

/** Compute the content-derived CACHE_NAME for the shell currently on disk.
 * @param {string} [swSource]
 * @param {(entry: string) => Buffer} [readAsset] reads one SHELL_ASSETS entry;
 *   injectable so tests can hash in-memory fixtures
 * @returns {string} */
export function computeCacheName(
  swSource = readFileSync(swPath, 'utf8'),
  readAsset = (entry) => readFileSync(assetToFile(entry))
) {
  const hash = createHash('sha256');
  for (const entry of parseShellAssets(swSource)) {
    // Hash the entry name (so add/remove/reorder shifts the hash) then the
    // file bytes (so any content edit does). Buffers, so PNGs hash too.
    hash.update(entry + '\0');
    hash.update(hashableBytes(entry, readAsset(entry)));
    hash.update('\0');
  }
  return PREFIX + hash.digest('hex').slice(0, HASH_LEN);
}

function main() {
  const check = process.argv.includes('--check');
  const swSource = readFileSync(swPath, 'utf8');
  const current = readCacheName(swSource);
  const next = computeCacheName(swSource);

  if (current === next) {
    console.log(`sw.js CACHE_NAME up to date (${current})`);
    return;
  }
  if (check) {
    console.error(
      `sw.js CACHE_NAME is stale: ${current} -> should be ${next}\n` +
      `Run: node scripts/stamp-sw.mjs`
    );
    process.exit(1);
  }
  writeFileSync(
    swPath,
    swSource.replace(/const CACHE_NAME = '[^']+';/, `const CACHE_NAME = '${next}';`)
  );
  console.log(`sw.js CACHE_NAME stamped: ${current} -> ${next}`);
}

// Run only when invoked directly (node scripts/stamp-sw.mjs), not on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
