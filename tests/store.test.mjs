/* Tests for the pure board logic in js/store.js and js/ref.js.
 * Run with:  node --test   (from the repo root)
 * No browser, no build step — store.js is dependency-free by design. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARDS, boardFor, colsFor, cardMatchesView, isSingleProjectView, safeProjectLink,
  normalize, migrateLifeColumns, migrateLifeToDashboard, sortByPriority,
  allCardIds, lifeMetaIds, mergeBoards, boardHasContent, uid,
  openCards, doneCards, removeDoneCards, boardSize,
  DONE_COLUMN, BOARD_SIZE_LIMIT, BOARD_SIZE_WARN,
} from '../js/store.js';
import {
  projectPrefix, ticketRef, prefixCollisions, LIFE_PREFIX, UNASSIGNED_PREFIX,
} from '../js/ref.js';
import { readFileSync } from 'node:fs';

function card(id, extra = {}) {
  return { id, title: `card ${id}`, note: '', priority: 'med', created: 1, project: null, ...extra };
}

/* ---------- normalize ---------- */

test('normalize fills every board and column on an empty object', () => {
  const s = normalize({});
  for (const boardId of Object.keys(BOARDS)) {
    for (const col of BOARDS[boardId]) {
      assert.deepEqual(s[boardId][col.id], []);
    }
  }
  assert.deepEqual(s.lifeMeta, { focus: [], dates: [], notes: '', stickies: [] });
});

test('normalize defaults missing project field to null (pre-project cards)', () => {
  const s = normalize({ projects: { backlog: [{ id: 'a', title: 't', priority: 'med', created: 1 }] } });
  assert.equal(s.projects.backlog[0].project, null);
});

test('normalize whitelists priority (untrusted server data feeds a class attr)', () => {
  const s = normalize({
    projects: { backlog: [card('a', { priority: '"><script>' }), card('b', { priority: 'high' })] },
  });
  assert.equal(s.projects.backlog[0].priority, 'med');
  assert.equal(s.projects.backlog[1].priority, 'high');
});

test('migrateLifeColumns migrates the oldest dev-style shape to the five-column shape', () => {
  const s = { life: { backlog: [card('x')], todo: [card('y')], doing: [], done: [card('z')] } };
  migrateLifeColumns(s);
  assert.equal(s.life.someday[0].id, 'x');
  assert.equal(s.life.thisweek[0].id, 'y');
  assert.equal(s.life.done[0].id, 'z');
  assert.deepEqual(s.life.waiting, []);
});

test('migrateLifeColumns is a no-op on the five-column shape', () => {
  const life = { someday: [card('x')], thisweek: [], doing: [], waiting: [], done: [] };
  const s = { life: structuredClone(life) };
  migrateLifeColumns(s);
  assert.deepEqual(s.life, life);
});

test('migrateLifeToDashboard folds someday/thisweek/waiting into todo', () => {
  const s = {
    life: {
      someday: [card('a')], thisweek: [card('b')],
      doing: [card('c')], waiting: [card('d')], done: [card('e')],
    },
  };
  migrateLifeToDashboard(s);
  assert.deepEqual(s.life.todo.map(c => c.id), ['b', 'a', 'd']);
  assert.deepEqual(s.life.doing.map(c => c.id), ['c']);
  assert.deepEqual(s.life.done.map(c => c.id), ['e']);
  assert.ok(!('someday' in s.life) && !('thisweek' in s.life) && !('waiting' in s.life));
});

test('migrateLifeToDashboard is a no-op on the three-column shape', () => {
  const life = { todo: [card('x')], doing: [], done: [] };
  const s = { life: structuredClone(life) };
  migrateLifeToDashboard(s);
  assert.deepEqual(s.life, life);
});

test('normalize chains both migrations: oldest dev-style shape -> current three-column shape', () => {
  const s = normalize({
    life: { backlog: [card('x')], todo: [card('y')], doing: [], done: [card('z')] },
  });
  assert.deepEqual(s.life.todo.map(c => c.id).sort(), ['x', 'y']);
  assert.deepEqual(s.life.done.map(c => c.id), ['z']);
  assert.ok(!('someday' in s.life) && !('thisweek' in s.life) && !('waiting' in s.life));
});

test('sortByPriority orders high > med > low, is stable within a tier, and does not mutate', () => {
  const cards = [
    card('a', { priority: 'low' }), card('b', { priority: 'high' }),
    card('c', { priority: 'high' }), card('d', { priority: 'med' }),
  ];
  const sorted = sortByPriority(cards);
  assert.deepEqual(sorted.map(c => c.id), ['b', 'c', 'd', 'a']);
  assert.deepEqual(cards.map(c => c.id), ['a', 'b', 'c', 'd']);
});

test('normalize migrates the legacy notes string into a first sticky', () => {
  const s = normalize({ lifeMeta: { notes: 'keep me' } });
  assert.equal(s.lifeMeta.stickies.length, 1);
  assert.equal(s.lifeMeta.stickies[0].text, 'keep me');
  assert.equal(s.lifeMeta.notes, '');
});

test('normalize leaves existing stickies alone', () => {
  const stickies = [{ id: 'n1', text: 'hi', color: 'pink' }];
  const s = normalize({ lifeMeta: { stickies: structuredClone(stickies), notes: 'ignored' } });
  assert.deepEqual(s.lifeMeta.stickies, stickies);
});

/* ---------- views ---------- */

test('boardFor: only the life view uses the life board', () => {
  assert.equal(boardFor('life'), 'life');
  for (const view of ['all', 'unassigned', 'unlinked', 'some-project']) {
    assert.equal(boardFor(view), 'projects');
  }
  assert.equal(colsFor('life').length, 3);
  assert.equal(colsFor('projects').length, 5);
});

test('cardMatchesView covers all/unassigned/unlinked/project', () => {
  const known = new Set(['koder']);
  const assigned = card('a', { project: 'koder' });
  const unassigned = card('b', { project: null });
  const orphan = card('c', { project: 'deleted-proj' });

  for (const c of [assigned, unassigned, orphan]) assert.ok(cardMatchesView(c, 'all', known));
  assert.ok(cardMatchesView(unassigned, 'unassigned', known));
  assert.ok(!cardMatchesView(assigned, 'unassigned', known));
  assert.ok(cardMatchesView(orphan, 'unlinked', known));
  assert.ok(!cardMatchesView(assigned, 'unlinked', known));
  assert.ok(cardMatchesView(assigned, 'koder', known));
  assert.ok(!cardMatchesView(orphan, 'koder', known));
});

test('isSingleProjectView rejects reserved tabs before project lookup', () => {
  for (const view of ['all', 'unassigned', 'unlinked', 'life']) {
    assert.equal(isSingleProjectView(view), false, view);
  }
  assert.equal(isSingleProjectView('koder'), true);
});

test('safeProjectLink accepts only absolute HTTP and HTTPS URLs', () => {
  assert.equal(safeProjectLink('https://example.com/repo'), 'https://example.com/repo');
  assert.equal(safeProjectLink('http://example.com/site'), 'http://example.com/site');
  for (const value of ['javascript:alert(1)', 'data:text/html,bad', 'file:///tmp/repo', '/relative', 'not a URL', null]) {
    assert.equal(safeProjectLink(value), null, String(value));
  }
});

/* ---------- merge (the code where bugs mean data loss) ---------- */

test('mergeBoards keeps agent-added server cards', () => {
  const local = normalize({ projects: { backlog: [card('mine')] } });
  const server = normalize({ projects: { backlog: [card('mine'), card('agent')] } });
  const added = mergeBoards(local, server, new Set(['mine']));
  assert.equal(added, 1);
  assert.deepEqual(local.projects.backlog.map(c => c.id), ['mine', 'agent']);
});

test('mergeBoards lets a local deletion win over a known server card', () => {
  // 'gone' was synced before (known id) and deleted locally — must NOT resurrect.
  const local = normalize({ projects: { backlog: [card('mine')] } });
  const server = normalize({ projects: { backlog: [card('mine'), card('gone')] } });
  const added = mergeBoards(local, server, new Set(['mine', 'gone']));
  assert.equal(added, 0);
  assert.deepEqual(local.projects.backlog.map(c => c.id), ['mine']);
});

test('mergeBoards does not duplicate a card that moved columns locally', () => {
  // Card exists locally in another column: local position wins.
  const local = normalize({ projects: { doing: [card('a')] } });
  const server = normalize({ projects: { backlog: [card('a')] } });
  mergeBoards(local, server, new Set(['a']));
  assert.deepEqual(local.projects.doing.map(c => c.id), ['a']);
  assert.deepEqual(local.projects.backlog, []);
});

test('mergeBoards preserves a newly observed server webhook PR and column', () => {
  const local = normalize({ projects: { doing: [card('a', { title: 'local edit' })] } });
  const server = normalize({
    projects: { review: [card('a', { title: 'server title', pr: 'KodaAllison/koder#21' })] },
  });

  mergeBoards(local, server, new Set(['a']));

  assert.deepEqual(local.projects.doing, []);
  assert.equal(local.projects.review[0].pr, 'KodaAllison/koder#21');
  assert.equal(local.projects.review[0].title, 'server title');
});

test('mergeBoards preserves a changed server webhook PR and column', () => {
  const local = normalize({
    projects: { review: [card('a', { pr: 'KodaAllison/koder#20' })] },
  });
  const server = normalize({
    projects: { done: [card('a', { pr: 'KodaAllison/koder#21' })] },
  });

  mergeBoards(local, server, new Set(['a']));

  assert.deepEqual(local.projects.review, []);
  assert.equal(local.projects.done[0].pr, 'KodaAllison/koder#21');
});

test('mergeBoards resumes local-wins edits after observing the same webhook PR', () => {
  const local = normalize({
    projects: { doing: [card('a', { title: 'edited locally', pr: 'KodaAllison/koder#21' })] },
  });
  const server = normalize({
    projects: { review: [card('a', { title: 'stale server title', pr: 'KodaAllison/koder#21' })] },
  });

  mergeBoards(local, server, new Set(['a']));

  assert.equal(local.projects.doing[0].title, 'edited locally');
  assert.equal(local.projects.doing[0].pr, 'KodaAllison/koder#21');
  assert.deepEqual(local.projects.review, []);
});

test('mergeBoards merges into both boards, creating unknown columns if needed', () => {
  const local = normalize({});
  const server = normalize({});
  server.life.todo.push(card('lifecard'));
  server.projects.custom = [card('oddcol')]; // column the client doesn't know
  const added = mergeBoards(local, server, new Set());
  assert.equal(added, 2);
  assert.equal(local.life.todo[0].id, 'lifecard');
  assert.equal(local.projects.custom[0].id, 'oddcol');
});

test('mergeBoards keeps remotely-added lifeMeta items', () => {
  const local = normalize({ lifeMeta: { stickies: [{ id: 's1', text: 'mine', color: 'yellow' }] } });
  const server = normalize({
    lifeMeta: {
      focus: [{ id: 'f1', text: 'remote focus', done: false }],
      dates: [{ id: 'd1', title: 'remote date', date: '2026-08-01' }],
      stickies: [
        { id: 's1', text: 'mine', color: 'yellow' },
        { id: 's2', text: 'remote sticky', color: 'pink' },
      ],
    },
  });
  const added = mergeBoards(local, server, new Set(['s1']));
  assert.equal(added, 3);
  assert.deepEqual(local.lifeMeta.focus.map(i => i.id), ['f1']);
  assert.deepEqual(local.lifeMeta.dates.map(i => i.id), ['d1']);
  assert.deepEqual(local.lifeMeta.stickies.map(i => i.id), ['s1', 's2']);
});

test('mergeBoards lets a local lifeMeta deletion win over a known server item', () => {
  // 'gone' was synced before (known id) and deleted locally — must NOT resurrect.
  const local = normalize({});
  const server = normalize({ lifeMeta: { stickies: [{ id: 'gone', text: 'x', color: 'yellow' }] } });
  const added = mergeBoards(local, server, new Set(['gone']));
  assert.equal(added, 0);
  assert.deepEqual(local.lifeMeta.stickies, []);
});

test('mergeBoards lets a local lifeMeta edit win over the server copy', () => {
  const local = normalize({ lifeMeta: { focus: [{ id: 'f1', text: 'edited locally', done: true }] } });
  const server = normalize({ lifeMeta: { focus: [{ id: 'f1', text: 'stale server text', done: false }] } });
  mergeBoards(local, server, new Set(['f1']));
  assert.equal(local.lifeMeta.focus.length, 1);
  assert.equal(local.lifeMeta.focus[0].text, 'edited locally');
});

test('lifeMetaIds spans focus, dates, and stickies', () => {
  const s = normalize({
    lifeMeta: {
      focus: [{ id: 'f1', text: 'x', done: false }],
      dates: [{ id: 'd1', title: 'x', date: '2026-01-01' }],
      stickies: [{ id: 's1', text: 'x', color: 'yellow' }],
    },
  });
  assert.deepEqual([...lifeMetaIds(s)].sort(), ['d1', 'f1', 's1']);
});

/* boardHasContent guards sync's "adopt the server board" paths: a wrong false
 * here means a never-synced device's data gets overwritten on first pull. */
test('boardHasContent is false only on a truly empty board', () => {
  assert.equal(boardHasContent(normalize({})), false);
});

test('boardHasContent sees cards on either board and every lifeMeta array', () => {
  const withCard = normalize({ projects: { backlog: [card('a')] } });
  assert.equal(boardHasContent(withCard), true);
  const withLifeCard = normalize({ life: { todo: [card('l')] } });
  assert.equal(boardHasContent(withLifeCard), true);
  const withFocus = normalize({ lifeMeta: { focus: [{ id: 'f', text: 'x', done: false }] } });
  assert.equal(boardHasContent(withFocus), true);
  const withDate = normalize({ lifeMeta: { dates: [{ id: 'd', title: 'x', date: '2026-01-01' }] } });
  assert.equal(boardHasContent(withDate), true);
  const withSticky = normalize({ lifeMeta: { stickies: [{ id: 's', text: 'x', color: 'yellow' }] } });
  assert.equal(boardHasContent(withSticky), true);
});

/* ---------- misc ---------- */

test('allCardIds spans both boards', () => {
  const s = normalize({
    projects: { backlog: [card('p1')] },
    life: { todo: [card('l1')] },
  });
  assert.deepEqual([...allCardIds(s)].sort(), ['l1', 'p1']);
});

test('uid produces unique-ish ids', () => {
  const ids = new Set(Array.from({ length: 1000 }, uid));
  assert.equal(ids.size, 1000);
});

/* ---------- open vs done (tab counts) ---------- */

test('openCards spans every column except Done', () => {
  const s = normalize({
    projects: {
      backlog: [card('a')], todo: [card('b')], doing: [card('c')],
      review: [card('d')], done: [card('e'), card('f')],
    },
  });
  assert.deepEqual(openCards(s, 'projects').map(c => c.id), ['a', 'b', 'c', 'd']);
});

test('openCards counts nothing when every card is done', () => {
  const s = normalize({ projects: { done: [card('a'), card('b')] } });
  assert.equal(openCards(s, 'projects').length, 0);
  assert.equal(Object.values(s.projects).flat().length, 2);   // still on the board
});

test('openCards works on the life board and tolerates a missing board', () => {
  const s = normalize({ life: { todo: [card('a')], done: [card('b')] } });
  assert.deepEqual(openCards(s, 'life').map(c => c.id), ['a']);
  assert.deepEqual(openCards(/** @type {any} */ ({}), 'projects'), []);
});

test('doneCards returns the Done column, empty when there is none', () => {
  const s = normalize({ projects: { done: [card('a')] } });
  assert.deepEqual(doneCards(s, 'projects').map(c => c.id), ['a']);
  assert.deepEqual(doneCards(/** @type {any} */ ({}), 'projects'), []);
});

/* ---------- removeDoneCards (the archive flow's local half) ---------- */

test('removeDoneCards drops the named cards and reports how many went', () => {
  const s = normalize({ projects: { done: [card('a'), card('b'), card('c')] } });
  assert.equal(removeDoneCards(s, 'projects', new Set(['a', 'c'])), 2);
  assert.deepEqual(s.projects.done.map(c => c.id), ['b']);
});

test('removeDoneCards ignores ids that are not in Done', () => {
  const s = normalize({ projects: { todo: [card('a')], done: [card('b')] } });
  // 'a' was archived, then dragged out of Done before the server acked: it
  // stays on the board rather than vanishing (see the comment in store.js).
  assert.equal(removeDoneCards(s, 'projects', new Set(['a', 'b'])), 1);
  assert.deepEqual(s.projects.todo.map(c => c.id), ['a']);
  assert.deepEqual(s.projects.done, []);
});

test('removeDoneCards leaves the other board alone', () => {
  const s = normalize({ projects: { done: [card('a')] }, life: { done: [card('a')] } });
  removeDoneCards(s, 'projects', new Set(['a']));
  assert.deepEqual(s.projects.done, []);
  assert.deepEqual(s.life.done.map(c => c.id), ['a']);
});

/* ---------- size ceiling ---------- */

test('boardSize measures the serialized board, and the warn line sits below the limit', () => {
  const s = normalize({});
  assert.equal(boardSize(s), JSON.stringify(s).length);
  assert.ok(BOARD_SIZE_WARN < BOARD_SIZE_LIMIT);
  assert.ok(boardSize(s) < BOARD_SIZE_WARN);
});

test('boardSize grows with the board', () => {
  const empty = normalize({});
  const full = normalize({ projects: { done: [card('a', { note: 'x'.repeat(1000) })] } });
  assert.ok(boardSize(full) > boardSize(empty) + 1000);
});

test('archiving a fat Done column brings the board back under the warn line', () => {
  const done = [];
  for (let i = 0; i < 80; i++) done.push(card(`d${i}`, { note: 'x'.repeat(900) }));
  const s = normalize({ projects: { todo: [card('keep')], done } });
  assert.ok(boardSize(s) > BOARD_SIZE_LIMIT, 'setup: board should start over the limit');

  removeDoneCards(s, 'projects', new Set(doneCards(s, 'projects').map(c => c.id)));
  assert.ok(boardSize(s) < BOARD_SIZE_WARN);
  assert.deepEqual(openCards(s, 'projects').map(c => c.id), ['keep']);
});

test('DONE_COLUMN is a real column on both boards', () => {
  for (const boardId of Object.keys(BOARDS)) {
    assert.ok(BOARDS[boardId].some(c => c.id === DONE_COLUMN));
  }
});

/* ---------- ticket refs ---------- */

test('projectPrefix takes 3 of the first segment and 2 of the second', () => {
  assert.equal(projectPrefix('portfolio-website'), 'PORWE');
  assert.equal(projectPrefix('strava-worker'), 'STRWO');
  assert.equal(projectPrefix('crook-community'), 'CROCO');
});

test('projectPrefix separates the pairs plain truncation collides on', () => {
  // The reason this rule exists at all — first-5 gives PORTF/PORTF, STRAV/STRAV.
  assert.notEqual(projectPrefix('portfolio-new'), projectPrefix('portfolio-website'));
  assert.notEqual(projectPrefix('strava-insights'), projectPrefix('strava-worker'));
});

test('projectPrefix falls back to the first 5 chars of a single-segment id', () => {
  assert.equal(projectPrefix('koder'), 'KODER');
  assert.equal(projectPrefix('holitrackr'), 'HOLIT');
  assert.equal(projectPrefix('weatherapp'), 'WEATH');
});

test('projectPrefix splits camelCase, so SwiftPlan is two segments', () => {
  assert.equal(projectPrefix('SwiftPlan'), 'SWIPL');
});

test('projectPrefix is stable regardless of what other projects exist', () => {
  // A "shortest unique prefix" rule would rewrite this the day a similar name
  // appears; refs get quoted into commits, so they must not move.
  assert.equal(projectPrefix('portfolio-website'), 'PORWE');
  assert.equal(projectPrefix('portfolio-website'), projectPrefix('portfolio-website'));
});

test('ticketRef appends the uppercased last 4 of the id', () => {
  assert.equal(ticketRef(card('t_msa7ti8f_08cda', { project: 'koder' })), 'KODER-8CDA');
});

test('ticketRef distinguishes life cards from unassigned project cards', () => {
  assert.equal(ticketRef(card('mrdnx8ncddlos'), 'life'), LIFE_PREFIX + '-DLOS');
  assert.equal(ticketRef(card('t_mr884oi0_56da3', { project: null })), UNASSIGNED_PREFIX + '-6DA3');
});

test('prefixCollisions is empty for the real project list', () => {
  // The guard the derivation trades for stability: adding a colliding project
  // fails here rather than quietly giving two projects the same refs.
  const ids = JSON.parse(readFileSync(new URL('../js/projects.json', import.meta.url), 'utf8'))
    .projects.map(/** @param {{id: string}} p */ p => p.id);
  assert.deepEqual(prefixCollisions(ids), {});
});

test('prefixCollisions reports a genuine clash and a reserved-prefix clash', () => {
  assert.deepEqual(prefixCollisions(['portfolio-web', 'portfolio-website']),
    { PORWE: ['portfolio-web', 'portfolio-website'] });
  assert.deepEqual(prefixCollisions(['life']), { LIFE: ['(reserved)', 'life'] });
});
