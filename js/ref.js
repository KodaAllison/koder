// @ts-check
/* Ticket refs — the human-quotable name for a card.
 *
 * Its own module, not part of store.js, for one reason: the sync server
 * (server/main.ts, Deno/TS) needs the same derivation, and it can import this
 * file directly because the file is dependency-free and uses nothing beyond
 * standard JS. Folding it into store.js would drag the whole board model
 * across that boundary; copying it into main.ts would let the browser and the
 * server drift apart on what a ref means. One file, imported by both.
 *
 * Pure — no DOM, no localStorage, no network — so tests/store.test.mjs
 * exercises it under plain `node --test` like the rest of the board logic.
 */

/* Cards are identified internally by `id` — opaque, and never shown anywhere.
 * That's exactly right for the merge (see allCardIds in store.js) and useless to a
 * human: an agent that reports "t_msa7ti8f_08cda" has named something that
 * appears nowhere on the board, with no way to look it up. A ref like
 * KODER-8CDA names the same card in a form you can read off a screen.
 *
 * The ref is DERIVED, never stored, and `id` is untouched. `id` is the merge
 * key — mergeBoards decides card-by-card what a 409 keeps by comparing ids —
 * so minting a new identifier would make two devices disagree about which
 * card is which. Deriving also needs no coordination: a per-project counter
 * would have two offline devices both issue -05 to different tickets, and the
 * merge would then fold them into one card. And it costs no migration, since
 * every ticket already has an id to derive from. */

/* Cards with no project of their own: life-board cards (no `project` field at
 * all) and unassigned projects-board cards (`project` of null) are different
 * things, so they read differently rather than sharing one prefix. Both are
 * reserved — a project that derives one of these collides, and
 * prefixCollisions reports it. */
export const LIFE_PREFIX = 'LIFE';
export const UNASSIGNED_PREFIX = 'NOPROJ';

/* 3 chars of the first segment + 2 of the second. Plain 5-char truncation was
 * rejected because it collides on real pairs already on the board:
 * portfolio-new/portfolio-website both give PORTF, strava-insights/
 * strava-worker both give STRAV. Splitting on punctuation AND camelCase means
 * SwiftPlan reads as two segments (SWIPL) rather than one. A single-segment id
 * has no second segment to borrow from, so it falls back to its first 5.
 *
 * This is a pure function of one project id — it does NOT consult the rest of
 * the project list. That's deliberate: a ref gets quoted into commits and PR
 * bodies, so it has to stay stable, and a "shortest unique prefix" rule would
 * silently rewrite an existing project's refs the day a similar name appears.
 * The cost is that a future project CAN collide; prefixCollisions is the
 * guard, asserted by the test suite. */
/** @param {string} projectId @returns {string} */
export function projectPrefix(projectId) {
  const segments = String(projectId)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (!segments.length) return UNASSIGNED_PREFIX;
  const short = segments.length > 1
    ? segments[0].slice(0, 3) + segments[1].slice(0, 2)
    : segments[0].slice(0, 5);
  return short.toUpperCase();
}

/* The quotable name for a card: <PREFIX>-<last 4 of id, uppercased>. The tail
 * is the id's own random segment, so it distinguishes cards filed in the same
 * project without any counter. */
/** @param {{id: string, project?: string|null}} card   structural, so this file
 *        stays independent of store.js's Card typedef
 * @param {'projects'|'life'} [boardId]
 * @returns {string} */
export function ticketRef(card, boardId = 'projects') {
  const prefix = boardId === 'life' ? LIFE_PREFIX
    : card.project ? projectPrefix(card.project)
    : UNASSIGNED_PREFIX;
  return prefix + '-' + String(card.id).slice(-4).toUpperCase();
}

/* Every prefix that more than one project — or a project and a reserved
 * prefix — would answer to. An empty result is the healthy state and the test
 * suite asserts it against the real projects.json, so adding a colliding
 * project fails `node --test` instead of quietly handing two projects the
 * same refs. */
/** @param {string[]} projectIds @returns {Record<string, string[]>} */
export function prefixCollisions(projectIds) {
  /** @type {Record<string, string[]>} */
  const byPrefix = { [LIFE_PREFIX]: ['(reserved)'], [UNASSIGNED_PREFIX]: ['(reserved)'] };
  projectIds.forEach(id => { (byPrefix[projectPrefix(id)] ??= []).push(id); });
  return Object.fromEntries(Object.entries(byPrefix).filter(([, v]) => v.length > 1));
}
