/* Guards against a module going uncached: sw.js's SHELL_ASSETS must list
 * every module under js/, or a fresh install works online (runtime caching
 * papers over the gap) but breaks the moment the app goes offline.
 * Run with:  node --test   (from the repo root) */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';

test('every js/*.js module is listed in sw.js SHELL_ASSETS', () => {
  const sw = readFileSync(path.join(root, 'sw.js'), 'utf8');
  // config.local.js/config.example.js are excluded by design: config.local.js
  // is gitignored and served network-first (see sw.js's fetch handler), and
  // config.example.js is a template never loaded by the app.
  const modules = readdirSync(path.join(root, 'js'))
    .filter(f => f.endsWith('.js') && !f.startsWith('config'));
  assert.ok(modules.length > 0, 'expected at least one module under js/');
  for (const mod of modules) {
    assert.match(sw, new RegExp(`\\./js/${mod}\\b`), `sw.js SHELL_ASSETS is missing ./js/${mod}`);
  }
});
