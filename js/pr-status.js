// @ts-check
import { apiEnabled, apiRequest } from './sync.js';
import { prStatusMessage, statusesFromHttp } from './pr-status-view.js';
export { chipDescriptors } from './pr-status-view.js';
/** @typedef {{state:'open'|'closed'|'merged',ci:'passing'|'failing'|'pending'|'unknown',mergeable:'mergeable'|'conflicting'|'unknown'}} PullStatus */
/** @type {Record<string, PullStatus>} */ let statuses = {};
/** @type {Promise<void>|null} */ let inFlight = null;
let lastFetch = 0;
/** @param {unknown} pr */
export function statusFor(pr) { return typeof pr === 'string' ? statuses[pr] : undefined; }
/** @param {() => void} onChange @param {boolean} [force] @param {(message:string|null) => void} [onStatus] */
export function refreshPrStatuses(onChange, force = false, onStatus = () => {}) {
  if (!apiEnabled()) return Promise.resolve();
  if (inFlight) return inFlight;
  if (!force && Date.now() - lastFetch < 15_000) return Promise.resolve();
  lastFetch = Date.now();
  inFlight = apiRequest('GET', '/pr-status').then(async response => {
    statuses = statusesFromHttp(response.ok, response.ok ? await response.json() : null);
    onStatus(prStatusMessage(response.status));
    onChange();
  }).catch(() => {}).finally(() => { inFlight = null; });
  return inFlight;
}
