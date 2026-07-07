// @ts-check
/* Pure board logic — no DOM, no localStorage, no network.
 * Everything in here is deterministic given its inputs, which is what lets
 * tests/store.test.mjs run it under plain `node --test`. If a function needs
 * a browser API, it belongs in state.js / sync.js / the UI modules instead. */

/**
 * @typedef {'low'|'med'|'high'} Priority
 *
 * @typedef {Object} Card
 * @property {string} id
 * @property {string} title
 * @property {string} [note]
 * @property {Priority} priority
 * @property {number} created           epoch ms
 * @property {string|null} [project]    projects board only; absent on life cards
 *
 * @typedef {Record<string, Card[]>} ColumnMap   column id → cards
 *
 * @typedef {Object} FocusItem
 * @property {string} id
 * @property {string} text
 * @property {boolean} done
 *
 * @typedef {Object} DateItem
 * @property {string} id
 * @property {string} title
 * @property {string} date              yyyy-mm-dd
 *
 * @typedef {Object} Sticky
 * @property {string} id
 * @property {string} text
 * @property {string} color
 *
 * @typedef {Object} LifeMeta
 * @property {FocusItem[]} focus
 * @property {DateItem[]} dates
 * @property {string} notes             legacy scratchpad, migrated into stickies
 * @property {Sticky[]} stickies
 *
 * @typedef {Object} BoardState
 * @property {ColumnMap} projects
 * @property {ColumnMap} life
 * @property {LifeMeta} lifeMeta
 *
 * @typedef {Object} Project
 * @property {string} id
 * @property {string} name
 * @property {string} color
 * @property {string} text
 */

/* The board has two column sets. "projects" is a SINGLE shared board that
 * holds every project's tickets (each card carries a `project` id); the tab
 * bar filters this one board by project. "life" is a separate board whose
 * stages match how personal to-dos move — a dev backlog/sprint pipeline
 * doesn't fit life tasks (nothing "ships"). */
export const BOARDS = {
  projects: [
    { id: 'backlog', name: 'Backlog' },
    { id: 'todo',    name: 'To Do' },
    { id: 'doing',   name: 'In Progress' },
    { id: 'review',  name: 'For Review' },
    { id: 'done',    name: 'Done' },
  ],
  life: [
    { id: 'todo',  name: 'To Do' },
    { id: 'doing', name: 'Doing' },
    { id: 'done',  name: 'Done' },
  ],
};

/** @type {(keyof typeof BOARDS)[]} */
export const BOARD_IDS = /** @type {any} */ (Object.keys(BOARDS));

/** @param {keyof typeof BOARDS} boardId */
export function colsFor(boardId) { return BOARDS[boardId]; }

/* The active "view" (activeTab) is one of: 'all', a project id, 'unassigned',
 * 'unlinked', or 'life'. Everything except 'life' renders the projects board,
 * filtered to the cards that match. */
/** @param {string} view @returns {keyof typeof BOARDS} */
export function boardFor(view) { return view === 'life' ? 'life' : 'projects'; }

/**
 * @param {Card} card
 * @param {string} view
 * @param {Set<string>} projectIdSet   ids of currently-known projects
 */
export function cardMatchesView(card, view, projectIdSet) {
  if (view === 'all') return true;
  if (view === 'unassigned') return card.project == null;
  if (view === 'unlinked') return card.project != null && !projectIdSet.has(card.project);
  return card.project === view;
}

export function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

export const PRIORITIES = /** @type {Priority[]} */ (['low', 'med', 'high']);

const PRIORITY_RANK = { low: 2, med: 1, high: 0 };

/* Display-only ordering — returns a new array, never mutates `cards` or the
 * underlying stored column array. Sort is stable, so cards of equal priority
 * keep their existing (storage) order. */
/** @param {Card[]} cards @returns {Card[]} */
export function sortByPriority(cards) {
  return [...cards].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
}

/* One-time migration: earliest versions gave every tab the same dev-style
 * columns (backlog/todo/doing/done). Life now uses different column ids,
 * so move any existing life cards across instead of silently dropping them.
 * Detection keys off `backlog` alone (not `todo`) since `todo` is a legitimate
 * column id in later life shapes too. */
/** @param {any} s */
export function migrateLifeColumns(s) {
  if (!s.life) return;
  const hasOldShape = 'backlog' in s.life;
  const hasNewShape = 'someday' in s.life && 'thisweek' in s.life;
  if (hasOldShape && !hasNewShape) {
    s.life = {
      someday:  s.life.backlog || [],
      thisweek: s.life.todo || [],
      doing:    s.life.doing || [],
      waiting:  [],
      done:     s.life.done || [],
    };
  }
}

/* One-time migration: the Life dashboard redesign collapses the 5-stage
 * pipeline (someday/thisweek/doing/waiting/done) into a 3-column kanban
 * (todo/doing/done). Someday/This Week/Waiting all fold into To Do — priority
 * is what differentiates them now, not a column. */
/** @param {any} s */
export function migrateLifeToDashboard(s) {
  if (!s.life) return;
  const hasOldShape = 'someday' in s.life || 'thisweek' in s.life || 'waiting' in s.life;
  if (hasOldShape) {
    s.life = {
      // Any pre-existing `todo` cards are folded in too (not just
      // thisweek/someday/waiting), so a stray todo array is never dropped.
      todo:  [...(s.life.todo || []), ...(s.life.thisweek || []), ...(s.life.someday || []), ...(s.life.waiting || [])],
      doing: s.life.doing || [],
      done:  s.life.done || [],
    };
  }
}

/* Repair/upgrade a board object into the exact shape the app expects.
 * Runs on the localStorage cache at boot AND on every board pulled from the
 * sync server, so both sources get identical defensive fills/migrations. */
/** @param {any} s @returns {BoardState} */
export function normalize(s) {
  migrateLifeColumns(s);
  migrateLifeToDashboard(s);
  // Fill in any missing boards/columns (covers first run and future column additions).
  BOARD_IDS.forEach(boardId => {
    if (!s[boardId]) s[boardId] = {};
    BOARDS[boardId].forEach(c => { if (!s[boardId][c.id]) s[boardId][c.id] = []; });
  });
  // One-time migration: project tickets from before the per-project feature
  // have no `project` field. Default them to null so they surface under the
  // "Unassigned" tab instead of vanishing.
  Object.values(s.projects).forEach(cards => {
    /** @type {Card[]} */ (cards).forEach(card => { if (!('project' in card)) card.project = null; });
  });
  // Security: priority feeds a class attribute inside renderCard's innerHTML,
  // so whitelist it. Titles/notes are safe (textContent), but any card field
  // that doesn't go through textContent must never be trusted — boards can
  // arrive from the sync server, not just our own UI.
  BOARD_IDS.forEach(boardId => {
    Object.values(s[boardId]).forEach(cards => /** @type {Card[]} */ (cards).forEach(card => {
      if (!PRIORITIES.includes(card.priority)) card.priority = 'med';
    }));
  });
  // Life dashboard sidebar data (Today's focus, important dates, notes).
  // Defensive fill so existing saved state upgrades cleanly.
  if (!s.lifeMeta || typeof s.lifeMeta !== 'object') s.lifeMeta = {};
  if (!Array.isArray(s.lifeMeta.focus)) s.lifeMeta.focus = [];
  if (!Array.isArray(s.lifeMeta.dates)) s.lifeMeta.dates = [];
  if (typeof s.lifeMeta.notes !== 'string') s.lifeMeta.notes = '';
  // Notes used to be one scratchpad string; they're now a wall of sticky notes.
  // Migrate the old text into the first sticky so nothing is lost.
  if (!Array.isArray(s.lifeMeta.stickies)) {
    s.lifeMeta.stickies = [];
    if (s.lifeMeta.notes.trim()) {
      s.lifeMeta.stickies.push({ id: uid(), text: s.lifeMeta.notes, color: 'yellow' });
      s.lifeMeta.notes = '';
    }
  }
  return s;
}

/** Every card id across both boards. @param {BoardState} s @returns {Set<string>} */
export function allCardIds(s) {
  const ids = new Set();
  BOARD_IDS.forEach(b =>
    Object.values(s[b] || {}).forEach(cards => cards.forEach(c => ids.add(c.id))));
  return ids;
}

/* Merge a fresher server board into dirty local state: local wins card-by-card,
 * but server cards we've never synced (i.e. agent-added) are kept. `knownIds`
 * is the id set recorded at the last sync point — it's how we tell "added
 * remotely" (unknown id → keep) from "deleted locally" (known id → the local
 * deletion wins). Mutates `local`; returns how many cards were adopted. */
/**
 * @param {BoardState} local      already-normalized local state (mutated)
 * @param {BoardState} server     already-normalized server board
 * @param {Set<string>} knownIds  card ids recorded at the last sync point
 * @returns {number}              count of remotely-added cards merged in
 */
export function mergeBoards(local, server, knownIds) {
  const localIds = allCardIds(local);
  let added = 0;
  BOARD_IDS.forEach(boardId => {
    Object.entries(server[boardId]).forEach(([colId, cards]) => {
      cards.forEach(card => {
        if (localIds.has(card.id) || knownIds.has(card.id)) return;
        if (!local[boardId][colId]) local[boardId][colId] = [];
        local[boardId][colId].push(card);
        added++;
      });
    });
  });
  return added;
}
