/* Direct tests for KvStore, limited to what the HTTP contract suite
 * (webhook.deno.ts) doesn't already drive: revision listing and pruning,
 * archive append/dedupe/chunking, and a plain ticket create. Everything else
 * is covered over HTTP, where it also runs against any future backend. */

import assert from "node:assert/strict";
import { KvStore } from "./kv-store.ts";
import { restoreWorkflowMetadata } from "./store.ts";
import type { ArchivedCard, Card } from "./store.ts";

function card(id: string, extra: Partial<ArchivedCard> = {}): ArchivedCard {
  return { id, title: `Ticket ${id}`, note: "", priority: "med", created: 1, project: "koder", ...extra };
}

async function withStore(fn: (store: KvStore) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "koder-kv-store-test-" });
  const store = await KvStore.open(`${dir}/board.sqlite3`);
  try {
    await fn(store);
  } finally {
    store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("KvStore", async (t) => {
  await t.step("createTicket appends to the column and bumps the head", () =>
    withStore(async (store) => {
      assert.deepEqual(await store.getHead(), { rev: 0, updatedAt: null });
      const first: Card = card("t_one_0001");
      const second: Card = card("t_two_0002");
      assert.deepEqual(await store.createTicket(first, "todo"), { rev: 1 });
      assert.deepEqual(await store.createTicket(second, "todo"), { rev: 2 });
      const doc = await store.readBoard();
      assert.equal(doc.rev, 2);
      assert.deepEqual(doc.board.projects.todo.map((c) => c.id), ["t_one_0001", "t_two_0002"]);
      assert.equal((await store.getHead()).updatedAt, doc.updatedAt);
    }));

  await t.step("listRevisions keeps the last 20, newest first, and boardAt matches", () =>
    withStore(async (store) => {
      assert.deepEqual(await store.listRevisions(), []);
      for (let i = 0; i < 23; i++) await store.createTicket(card(`t_rev_${i}`), "todo");
      const revisions = await store.listRevisions();
      assert.equal(store.limits.keptRevisions, 20);
      assert.deepEqual(revisions.map((r) => r.rev), Array.from({ length: 20 }, (_, i) => 23 - i));
      assert.equal(await store.boardAt(3), null);
      const kept = await store.boardAt(4);
      assert.equal(kept?.rev, 4);
      assert.equal(kept?.board.projects.todo.length, 4);
      assert.equal(revisions.find((r) => r.rev === 4)?.updatedAt, kept?.updatedAt);
    }));

  await t.step("restoreWorkflowMetadata covers every board, any column, and orphans", () => {
    const linked = (id: string, pr: string, prRev: number): Card => ({ ...card(id), pr, prRev });
    const snapshot = {
      projects: { todo: [card("t_a_000a")], done: [linked("t_gone_000d", "o/r#1", 1)] },
      life: { week: [card("t_life_000b", { title: "old" }), card("t_lifeplain_000c")] },
      lifeMeta: {},
    };
    const current = {
      projects: { review: [linked("t_a_000a", "o/r#5", 3)] },
      life: { today: [linked("t_life_000b", "o/r#9", 2)] },
      lifeMeta: {},
    };
    const out = restoreWorkflowMetadata(snapshot, current);
    assert.deepEqual([out.projects.todo[0].pr, out.projects.todo[0].prRev], ["o/r#5", 3]);
    assert.equal(out.life.week[0].title, "old");
    assert.deepEqual([out.life.week[0].pr, out.life.week[0].prRev], ["o/r#9", 2]);
    assert.equal("pr" in out.life.week[1], false);
    // Deleted since the snapshot: keeps the snapshot's own values.
    assert.deepEqual([out.projects.done[0].pr, out.projects.done[0].prRev], ["o/r#1", 1]);
    // Inputs are not mutated.
    assert.equal("pr" in snapshot.projects.todo[0], false);
  });

  await t.step("archive is idempotent by id and reads back in append order", () =>
    withStore(async (store) => {
      assert.deepEqual(await store.readArchive(), { chunks: 0, cards: [] });
      assert.deepEqual(await store.archive([card("t_a_000a"), card("t_b_000b")]), {
        kind: "archived",
        archived: 2,
        duplicates: 0,
        chunk: 0,
      });
      assert.deepEqual(await store.archive([card("t_b_000b"), card("t_c_000c")]), {
        kind: "archived",
        archived: 1,
        duplicates: 1,
        chunk: 0,
      });
      assert.deepEqual(await store.archive([card("t_a_000a")]), {
        kind: "duplicates",
        duplicates: 1,
        chunks: 1,
      });
      const { chunks, cards } = await store.readArchive();
      assert.equal(chunks, 1);
      assert.deepEqual(cards.map((c) => c.id), ["t_a_000a", "t_b_000b", "t_c_000c"]);
      // The archive never touches the board.
      assert.equal((await store.getHead()).rev, 0);
    }));

  await t.step("archive seals a chunk before it outgrows its budget", () =>
    withStore(async (store) => {
      const big = (id: string) => card(id, { note: "a".repeat(30_000) });
      assert.equal((await store.archive([big("t_big_0001")])).kind, "archived");
      const second = await store.archive([big("t_big_0002")]);
      assert.deepEqual(second, { kind: "archived", archived: 1, duplicates: 0, chunk: 1 });
      const { chunks, cards } = await store.readArchive();
      assert.equal(chunks, 2);
      assert.deepEqual(cards.map((c) => c.id), ["t_big_0001", "t_big_0002"]);
    }));

  await t.step("an archive batch too big for one value is refused, not written", () =>
    withStore(async (store) => {
      const result = await store.archive([card("t_huge_0001", { note: "—".repeat(40_000) })]);
      assert.equal(result.kind, "tooLarge");
      if (result.kind === "tooLarge") {
        assert.equal(result.limit, store.limits.boardBytes);
        assert.ok(result.size > result.limit);
      }
      assert.deepEqual(await store.readArchive(), { chunks: 0, cards: [] });
    }));
});
