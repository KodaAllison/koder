// @ts-check
import { apiEnabled, apiRequest } from './sync.js';
import { parseStatusResponse } from './pr-status-view.js';
export { chipDescriptors } from './pr-status-view.js';
/** @typedef {{state:'open'|'closed'|'merged',ci:'passing'|'failing'|'pending'|'unknown',mergeable:'mergeable'|'conflicting'|'unknown'}} PullStatus */
/** @type {Record<string, PullStatus>} */ let statuses = {};
/** @type {Promise<void>|null} */ let inFlight = null;
let lastFetch = 0;
/** @param {unknown} pr */
export function statusFor(pr) { return typeof pr === 'string' ? statuses[pr] : undefined; }
/** @param {() => void} onChange @param {boolean} [force] */
export function refreshPrStatuses(onChange, force = false) {
  if (!apiEnabled()) return Promise.resolve();
  if (inFlight) return inFlight;
  if (!force && Date.now() - lastFetch < 15_000) return Promise.resolve();
  lastFetch = Date.now();
  inFlight = apiRequest('GET', '/pr-status').then(async response => {
    if (!response.ok) return;
    statuses = parseStatusResponse(await response.json());
    onChange();
  }).catch(() => {}).finally(() => { inFlight = null; });
  return inFlight;
}
