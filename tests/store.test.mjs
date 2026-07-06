/* Tests for the pure board logic in js/store.js.
 * Run with:  node --test   (from the repo root)
 * No browser, no build step — store.js is dependency-free by design. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARDS, boardFor, colsFor, cardMatchesView,
  normalize, migrateLifeColumns, allCardIds, mergeBoards, uid,
} from '../js/store.js';

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

test('normalize migrates old life columns without dropping cards', () => {
  const s = normalize({
    life: { backlog: [card('x')], todo: [card('y')], doing: [], done: [card('z')] },
  });
  assert.equal(s.life.someday[0].id, 'x');
  assert.equal(s.life.thisweek[0].id, 'y');
  assert.equal(s.life.done[0].id, 'z');
  assert.deepEqual(s.life.waiting, []);
  assert.ok(!('backlog' in s.life) || Array.isArray(s.life.someday));
});

test('migrateLifeColumns is a no-op on the new shape', () => {
  const life = { someday: [card('x')], thisweek: [], doing: [], waiting: [], done: [] };
  const s = { life: structuredClone(life) };
  migrateLifeColumns(s);
  assert.deepEqual(s.life, life);
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
  assert.equal(colsFor('life').length, 5);
  assert.equal(colsFor('projects').length, 4);
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

test('mergeBoards merges into both boards, creating unknown columns if needed', () => {
  const local = normalize({});
  const server = normalize({});
  server.life.someday.push(card('lifecard'));
  server.projects.custom = [card('oddcol')]; // column the client doesn't know
  const added = mergeBoards(local, server, new Set());
  assert.equal(added, 2);
  assert.equal(local.life.someday[0].id, 'lifecard');
  assert.equal(local.projects.custom[0].id, 'oddcol');
});

/* ---------- misc ---------- */

test('allCardIds spans both boards', () => {
  const s = normalize({
    projects: { backlog: [card('p1')] },
    life: { someday: [card('l1')] },
  });
  assert.deepEqual([...allCardIds(s)].sort(), ['l1', 'p1']);
});

test('uid produces unique-ish ids', () => {
  const ids = new Set(Array.from({ length: 1000 }, uid));
  assert.equal(ids.size, 1000);
});
