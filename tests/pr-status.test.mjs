import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chipDescriptors, parseStatusResponse, statusesFromHttp } from '../js/pr-status-view.js';

test('status response parser rejects malformed entries', () => {
  assert.deepEqual(parseStatusResponse(null), {});
  assert.deepEqual(parseStatusResponse({ bad: { state: 'open', ci: 'passing', mergeable: 'mergeable' } }), {});
  assert.deepEqual(parseStatusResponse({
    'KodaAllison/koder#22': { state: 'merged', ci: 'passing', mergeable: 'unknown' },
  }), { 'KodaAllison/koder#22': { state: 'merged', ci: 'passing', mergeable: 'unknown' } });
});

test('HTTP errors clear prior statuses while successful responses are parsed', () => {
  const prior = { 'KodaAllison/koder#22': { state: 'open', ci: 'pending', mergeable: 'unknown' } };
  assert.deepEqual(statusesFromHttp(false, prior), {});
  assert.deepEqual(statusesFromHttp(true, prior), prior);
});

test('chips show state plus exceptional CI and conflicts without passing noise', () => {
  assert.deepEqual(chipDescriptors({ state: 'open', ci: 'passing', mergeable: 'mergeable' }), [
    { label: 'Open', kind: 'open' },
  ]);
  assert.deepEqual(chipDescriptors({ state: 'closed', ci: 'failing', mergeable: 'conflicting' }), [
    { label: 'Closed', kind: 'closed' }, { label: 'CI failing', kind: 'failing' },
    { label: 'Conflict', kind: 'conflicting' },
  ]);
});
