/* KvStore — the Store (store.ts) backed by Deno KV.
 *
 * One KV entry, ["board"], holds the whole doc:
 *
 *   { rev: number, updatedAt: string|null, board: { projects, life, lifeMeta } }
 *
 * `board` is exactly the shape the client stores under kanban-hub-v1.
 *
 * Concurrency: every write goes through kv.atomic().check() against the
 * ["board"] entry it read, so two racing writers can't both land on the same
 * rev. PUT /state reports a lost race as a conflict (the client merges and
 * retries); the server's own read-modify-writes retry up to 5 times and then
 * throw StoreContentionError.
 *
 * History / undo: every write also snapshots the new doc under ["board", rev]
 * and prunes the one KEEP_REVISIONS behind, so the last N boards survive a bad
 * push. Restore rolls the chosen snapshot forward as a fresh rev (rev never
 * rewinds), so open tabs pull it back like any other change.
 *
 * Archive: the board is ONE KV value, so it can only ever hold 64KB as stored
 * (see STORE_VALUE_MAX — a write past that is a StoreFullError), and Done is
 * the only column that only ever grows. The archive is where done cards go to
 * stop counting against that budget — a separate, append-only, chunked set of
 * keys under ["archive", n], each sealed well short of the 64KB value cap.
 * Nothing else reads it; it exists so finishing work can't eventually wedge
 * sync (see js/archive.js).
 *
 * Webhook deliveries: ["github-delivery", id] = true, kept forever, and always
 * written in the same atomic commit that checks the ["board"] entry the
 * delivery's outcome was decided against. */

import { serialize } from "node:v8";
import {
  applyWebhookEvent,
  type ArchivedCard,
  type ArchiveResult,
  type Actor,
  type Board,
  type Card,
  type Doc,
  emptyDoc,
  type Head,
  preserveWorkflowMetadata,
  restoreWorkflowMetadata,
  type PutResult,
  resolveTicketId,
  type Store,
  StoreContentionError,
  StoreFullError,
  type StoreLimits,
  type TicketEdits,
  type Unresolved,
  type WebhookEvent,
  type WebhookResult,
} from "./store.ts";

const KEY = ["board"];
const GITHUB_DELIVERY_KEY = ["github-delivery"];

// How many past revisions to keep as restore points. Snapshots live under
// ["board", rev]; a prefix list on KEY returns exactly these (the current
// pointer ["board"] equals the prefix and is excluded). Each is a full board
// copy — cheap, and every write prunes the one this far behind.
const KEEP_REVISIONS = 20;

// Archived cards live under ["archive", n], separate from the board so they
// stop counting against its budget.
const ARCHIVE_KEY = ["archive"];
// Seal a chunk once appending would take it past this many stored bytes
// (measured like the board — see STORE_VALUE_MAX). The gap to KV's 64KB value
// cap is deliberate: one append carries at most a whole board's worth of cards,
// which is under the cap by construction, so a chunk that starts empty still
// lands under it.
const ARCHIVE_CHUNK_MAX = 50_000;

/* The board store's real capacity. The whole Doc is ONE Deno KV value, and KV
 * caps a value at 65,536 bytes of its V8 structured-clone serialization — not
 * of JSON. V8 writes a string as one byte per char only if every char is
 * Latin-1; a single em dash or arrow makes the whole string two bytes per
 * char. Ticket notes are full of those, so a board that is ~48KB as JSON can
 * already be 64KB as stored. node:v8 serialize() is the same encoding KV uses
 * (byte-for-byte, header included), so measuring with it checks against the
 * cap KV will actually enforce. */
const STORE_VALUE_MAX = 65_536;

type DeliveryGuard = {
  key: Deno.KvKey;
  entry: Deno.KvEntryMaybe<boolean>;
};

export class KvStore implements Store {
  // requestBytes: a PUT body longer than 4x the stored cap can't fit once
  // parsed, so PUT /state refuses it without parsing.
  readonly limits: StoreLimits = {
    boardBytes: STORE_VALUE_MAX,
    requestBytes: 4 * STORE_VALUE_MAX,
    keptRevisions: KEEP_REVISIONS,
  };

  constructor(private readonly kv: Deno.Kv) {}

  // `path` is a local/test database file (KODER_KV_PATH); unset on Deno Deploy.
  static async open(path?: string): Promise<KvStore> {
    return new KvStore(await Deno.openKv(path));
  }

  close(): void {
    this.kv.close();
  }

  /* Commit a new doc as one atomic step: advance the current pointer, snapshot
   * the doc under ["board", rev], and prune the snapshot KEEP_REVISIONS behind.
   * `check(entry)` guards against a concurrent writer landing on the same rev.
   * All writers (PUT, POST, PATCH, DELETE, restore, webhook) go through here so a
   * snapshot can never diverge from the rev that produced it — and so every one
   * of them gets the store-size check. Throws StoreFullError if the doc can't
   * fit in one KV value. */
  private async commitDoc(entry: Deno.KvEntryMaybe<Doc>, doc: Doc, delivery?: DeliveryGuard) {
    const size = serialize(doc).byteLength;
    if (size > STORE_VALUE_MAX) throw new StoreFullError(size, STORE_VALUE_MAX);
    try {
      const atomic = this.kv.atomic().check(entry);
      if (delivery) atomic.check(delivery.entry);
      atomic.set(KEY, doc)
        .set([...KEY, doc.rev], doc)
        .delete([...KEY, doc.rev - KEEP_REVISIONS]);
      if (delivery) {
        atomic.set(delivery.key, true);
      }
      return await atomic.commit();
    } catch (err) {
      // Belt and braces: if the backend ever measures differently from the check
      // above, its own "Value too large" still becomes a clear store-full error
      // rather than a bare 500.
      if (err instanceof Error && /value too large/i.test(err.message)) {
        throw new StoreFullError(size, STORE_VALUE_MAX);
      }
      throw err;
    }
  }

  private commitDelivery(entry: Deno.KvEntryMaybe<Doc>, delivery: DeliveryGuard) {
    return this.kv.atomic()
      .check(entry)
      .check(delivery.entry)
      .set(delivery.key, true)
      .commit();
  }

  /* Every archive chunk, oldest first. Callers read the whole set: it's how a
   * POST dedupes by id across chunks, and the volume is a personal board's
   * finished tickets, not a data warehouse. */
  private async readArchiveChunks(): Promise<{ index: number; cards: ArchivedCard[] }[]> {
    const chunks: { index: number; cards: ArchivedCard[] }[] = [];
    for await (const e of this.kv.list<ArchivedCard[]>({ prefix: ARCHIVE_KEY })) {
      const index = Number(e.key[e.key.length - 1]);
      if (Number.isInteger(index) && Array.isArray(e.value)) chunks.push({ index, cards: e.value });
    }
    chunks.sort((a, b) => a.index - b.index);
    return chunks;
  }

  async getHead(): Promise<Head> {
    const { rev, updatedAt } = await this.readBoard();
    return { rev, updatedAt };
  }

  async readBoard(): Promise<Doc> {
    const entry = await this.kv.get<Doc>(KEY);
    return entry.value ?? emptyDoc();
  }

  async boardAt(rev: number): Promise<Doc | null> {
    const snap = await this.kv.get<Doc>([...KEY, rev]);
    return snap.value;
  }

  async listRevisions(): Promise<Head[]> {
    const revisions: Head[] = [];
    for await (const e of this.kv.list<Doc>({ prefix: KEY })) {
      if (e.value) revisions.push({ rev: e.value.rev, updatedAt: e.value.updatedAt });
    }
    revisions.sort((a, b) => b.rev - a.rev);
    return revisions;
  }

  async readArchive(): Promise<{ chunks: number; cards: ArchivedCard[] }> {
    const chunks = await this.readArchiveChunks();
    return { chunks: chunks.length, cards: chunks.flatMap((c) => c.cards) };
  }

  async hasDelivery(deliveryId: string): Promise<boolean> {
    return Boolean((await this.kv.get<boolean>([...GITHUB_DELIVERY_KEY, deliveryId])).value);
  }

  // `actor` is part of the Store interface and ignored here: KV has no changes
  // log to attribute a write in.
  async applyBoardPut(baseRev: number, board: Board, _actor: Actor): Promise<PutResult> {
    const entry = await this.kv.get<Doc>(KEY);
    const cur = entry.value ?? emptyDoc();
    if (baseRev !== cur.rev) return { kind: "stale", rev: cur.rev };
    const doc: Doc = {
      rev: cur.rev + 1,
      updatedAt: new Date().toISOString(),
      board: preserveWorkflowMetadata(board, cur.board),
    };
    const res = await this.commitDoc(entry, doc);
    if (!res.ok) return { kind: "conflict" };
    return { kind: "ok", rev: doc.rev, updatedAt: doc.updatedAt! };
  }

  // Atomic append with a few retries in case a client PUT lands mid-flight.
  async createTicket(card: Card, column: string): Promise<{ rev: number }> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const entry = await this.kv.get<Doc>(KEY);
      const cur = structuredClone(entry.value ?? emptyDoc());
      cur.board.projects ??= {};
      (cur.board.projects[column] ??= []).push(card);
      const doc: Doc = {
        rev: cur.rev + 1,
        updatedAt: new Date().toISOString(),
        board: cur.board,
      };
      const res = await this.commitDoc(entry, doc);
      if (res.ok) return { rev: doc.rev };
    }
    throw new StoreContentionError();
  }

  async patchTicket(
    given: string,
    change: { column?: string; edits: TicketEdits },
  ): Promise<{ kind: "ok"; card: Card; column: string; rev: number } | Unresolved> {
    const { column, edits } = change;
    for (let attempt = 0; attempt < 5; attempt++) {
      const entry = await this.kv.get<Doc>(KEY);
      const cur = structuredClone(entry.value ?? emptyDoc());
      // Resolved inside the retry loop, against the board this attempt will
      // actually write: a ref could start matching a second ticket between
      // attempts, and that has to be caught rather than raced past.
      const resolved = resolveTicketId(cur.board, given);
      if ("error" in resolved) return { kind: "unresolved", ...resolved };
      const id = resolved.id;
      let card: Card | null = null;
      let from: string | null = null;
      for (const [col, cards] of Object.entries(cur.board.projects ?? {})) {
        const i = (cards ?? []).findIndex((c) => c.id === id);
        if (i !== -1) {
          from = col;
          // Only lift the card out when we're moving it — an edit with no
          // `column` must not reshuffle the column it already sits in.
          card = column === undefined ? cards[i] : cards.splice(i, 1)[0];
          break;
        }
      }
      if (!card || from === null) {
        return { kind: "unresolved", status: 404, error: { error: `no ticket with id or ref "${given}"` } };
      }
      Object.assign(card, edits);
      if (column !== undefined) {
        cur.board.projects ??= {};
        (cur.board.projects[column] ??= []).push(card);
      }
      const doc: Doc = {
        rev: cur.rev + 1,
        updatedAt: new Date().toISOString(),
        board: cur.board,
      };
      const res = await this.commitDoc(entry, doc);
      if (res.ok) return { kind: "ok", card, column: column ?? from, rev: doc.rev };
    }
    throw new StoreContentionError();
  }

  async deleteTicket(
    given: string,
  ): Promise<{ kind: "ok"; card: Card; column: string; rev: number; board: Board } | Unresolved> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const entry = await this.kv.get<Doc>(KEY);
      const cur = structuredClone(entry.value ?? emptyDoc());
      // Resolve on every attempt, just like PATCH, so a newly ambiguous ref
      // can never select an arbitrary ticket after write contention.
      const resolved = resolveTicketId(cur.board, given);
      if ("error" in resolved) return { kind: "unresolved", ...resolved };

      let card: Card | null = null;
      let column: string | null = null;
      for (const [col, cards] of Object.entries(cur.board.projects ?? {})) {
        const index = (cards ?? []).findIndex((candidate) => candidate.id === resolved.id);
        if (index !== -1) {
          card = cards.splice(index, 1)[0];
          column = col;
          break;
        }
      }
      if (!card || column === null) {
        return { kind: "unresolved", status: 404, error: { error: `no ticket with id or ref "${given}"` } };
      }
      const doc: Doc = {
        rev: cur.rev + 1,
        updatedAt: new Date().toISOString(),
        board: cur.board,
      };
      const res = await this.commitDoc(entry, doc);
      if (res.ok) return { kind: "ok", card, column, rev: doc.rev, board: doc.board };
    }
    throw new StoreContentionError();
  }

  /* Same atomic + retry shape as the ticket writers. `rev` names the snapshot
   * to restore FROM (history), which is a different thing from `doc.rev` below
   * (the new HEAD this restore produces). */
  async restore(rev: number): Promise<{ rev: number; updatedAt: string } | null> {
    const snap = await this.kv.get<Doc>([...KEY, rev]);
    if (!snap.value) return null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const entry = await this.kv.get<Doc>(KEY);
      const cur = entry.value ?? emptyDoc();
      const doc: Doc = {
        rev: cur.rev + 1,
        updatedAt: new Date().toISOString(),
        // Recomputed against `cur` on every retry: the card text is the
        // snapshot's, but surviving cards keep their CURRENT pr/prRev.
        board: restoreWorkflowMetadata(snap.value.board, cur.board),
      };
      const res = await this.commitDoc(entry, doc);
      if (res.ok) return { rev: doc.rev, updatedAt: doc.updatedAt! };
    }
    throw new StoreContentionError();
  }

  async archive(incoming: ArchivedCard[]): Promise<ArchiveResult> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const chunks = await this.readArchiveChunks();
      const seen = new Set(chunks.flatMap((c) => c.cards.map((card) => card.id)));
      const fresh = incoming.filter((c) => !seen.has(c.id));
      // Already archived in full — an idempotent no-op, not an error, so a
      // client retrying a request that actually landed still gets to move on.
      if (!fresh.length) {
        return { kind: "duplicates", duplicates: incoming.length, chunks: chunks.length };
      }

      const last = chunks[chunks.length - 1];
      // Start a fresh chunk when appending would overflow the current one.
      const sealed = !last ||
        serialize([...last.cards, ...fresh]).byteLength > ARCHIVE_CHUNK_MAX;
      const index = last ? (sealed ? last.index + 1 : last.index) : 0;

      const entry = await this.kv.get<ArchivedCard[]>([...ARCHIVE_KEY, index]);
      const next = [...(entry.value ?? []), ...fresh];
      // A board under the cap can't produce this, but the body is the
      // caller's, so refuse rather than let KV throw a bare 500.
      const nextSize = serialize(next).byteLength;
      if (nextSize > STORE_VALUE_MAX) {
        return { kind: "tooLarge", size: nextSize, limit: STORE_VALUE_MAX };
      }
      const res = await this.kv.atomic().check(entry)
        .set([...ARCHIVE_KEY, index], next).commit();
      if (res.ok) {
        return {
          kind: "archived",
          archived: fresh.length,
          duplicates: incoming.length - fresh.length,
          chunk: index,
        };
      }
    }
    throw new StoreContentionError();
  }

  async recordDelivery(
    deliveryId: string,
  ): Promise<{ kind: "recorded" } | { kind: "redelivered"; rev: number }> {
    const key = [...GITHUB_DELIVERY_KEY, deliveryId];
    for (let attempt = 0; attempt < 5; attempt++) {
      const entry = await this.kv.get<Doc>(KEY);
      const delivery: DeliveryGuard = { key, entry: await this.kv.get<boolean>(key) };
      if (delivery.entry.value) {
        return { kind: "redelivered", rev: (entry.value ?? emptyDoc()).rev };
      }
      if ((await this.commitDelivery(entry, delivery)).ok) return { kind: "recorded" };
    }
    throw new StoreContentionError();
  }

  /* Each attempt reads the board and the delivery record together, decides the
   * outcome against that board, and commits the delivery checked against the
   * same entry — with the new board too when the card actually moves. A
   * concurrent board write invalidates the decision, so the attempt retries. */
  async commitWebhookMove(event: WebhookEvent): Promise<WebhookResult> {
    const deliveryKey = [...GITHUB_DELIVERY_KEY, event.deliveryId];
    for (let attempt = 0; attempt < 5; attempt++) {
      const entry = await this.kv.get<Doc>(KEY);
      const delivery: DeliveryGuard = {
        key: deliveryKey,
        entry: await this.kv.get<boolean>(deliveryKey),
      };
      if (delivery.entry.value) {
        return { kind: "redelivered", rev: (entry.value ?? emptyDoc()).rev };
      }
      const cur = structuredClone(entry.value ?? emptyDoc());
      const outcome = applyWebhookEvent(cur.board, event);
      if (outcome.kind !== "moved") {
        if (!(await this.commitDelivery(entry, delivery)).ok) continue;
        return { ...outcome, rev: cur.rev };
      }
      const doc: Doc = {
        rev: cur.rev + 1,
        updatedAt: new Date().toISOString(),
        board: cur.board,
      };
      const result = await this.commitDoc(entry, doc, delivery);
      if (result.ok) return { ...outcome, rev: doc.rev };
    }
    throw new StoreContentionError();
  }
}
