// @ts-check
/** @typedef {{state:'open'|'closed'|'merged',ci:'passing'|'failing'|'pending'|'unknown',mergeable:'mergeable'|'conflicting'|'unknown'}} PullStatus */
/** @param {unknown} value @returns {Record<string, PullStatus>} */
export function parseStatusResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  /** @type {Record<string, PullStatus>} */ const parsed = {};
  for (const [key, item] of Object.entries(value)) {
    const status = /** @type {any} */ (item);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/.test(key) || !status ||
      !['open','closed','merged'].includes(status.state) || !['passing','failing','pending','unknown'].includes(status.ci) ||
      !['mergeable','conflicting','unknown'].includes(status.mergeable)) continue;
    parsed[key] = status;
  }
  return parsed;
}
/** HTTP failures are authoritative absence; transport failures never call this. */
/** @param {boolean} ok @param {unknown} value @returns {Record<string, PullStatus>} */
export function statusesFromHttp(ok, value) {
  return ok ? parseStatusResponse(value) : {};
}
/** @param {PullStatus|undefined} status @returns {Array<{label:string,kind:string}>} */
export function chipDescriptors(status) {
  if (!status) return [];
  /** @type {Array<{label:string,kind:string}>} */
  const chips = [{ label: status.state[0].toUpperCase() + status.state.slice(1), kind: status.state }];
  if (status.ci === 'failing') chips.push({ label: 'CI failing', kind: 'failing' });
  if (status.ci === 'pending') chips.push({ label: 'CI pending', kind: 'pending' });
  if (status.mergeable === 'conflicting') chips.push({ label: 'Conflict', kind: 'conflicting' });
  return chips;
}
