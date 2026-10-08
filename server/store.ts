/* The storage seam: everything main.ts needs from wherever the board lives.
 *
 * main.ts owns HTTP — routing, auth, body parsing, status codes, CORS, GitHub
 * resolution — and talks only to a `Store`. A Store owns persistence and the
 * concurrency control around it: it reads the board, applies a write as one
 * atomic step, and bumps the HEAD rev by exactly 1 per successful write. Today
 * the only backend is KvStore (kv-store.ts, one Deno KV value); the interface
 * is shaped so a relational backend can implement each method as a single
 * transaction (see docs/specs/storage-expansion.md).
 *
 * Backend-agnostic by construction: nothing here mentions KV entries or
 * versionstamps. Optimistic concurrency is expressed through `rev` alone —
 * PUT /state names the baseRev it read, and server-initiated read-modify-writes
 * (POST/PATCH/DELETE tickets, restore, webhook) are the store's own business:
 * it retries or locks as its backend needs, and gives up with
 * StoreContentionError if it can't land the write.
 *
 * Domain rules every backend must apply identically — ref resolution, the
 * webhook's transition policy, pr/prRev preservation on a full-board PUT, and
 * on restore (surviving cards keep their CURRENT pr/prRev; cards deleted since
 * the snapshot keep the snapshot's) —
 * live here as pure functions over a Board, so two backends can't drift on
 * what a write means. */

/* The SAME derivation the board renders with — js/ref.js is dependency-free
 * plain ESM precisely so this import works and the two can't drift on what a
 * ref means. Deno does not type-check imported .js (no checkJs in deno.json),
 * so the JSDoc types there are advisory here. */
import { ticketRef } from "../js/ref.js";
import { nextWebhookRevision } from "./workflow.ts";

// The four card fields a caller may edit in place (PATCH /tickets/:id). The
// fifth settable field, `column`, is the board key the card sits under, not a
// field on the card — see TicketFields in main.ts.
export type TicketEdits = {
  title?: string;
  note?: string;
  priority?: string;
  project?: string | null;
};

export type Card = {
  id: string;
  title: string;
  note: string;
  priority: string;
  created: number;
  project: string | null;
  pr?: string;
  prRev?: number;
};
export type Board = {
  projects: Record<string, Card[]>;
  life: Record<string, Card[]>;
  lifeMeta: Record<string, unknown>;
};
export type Doc = {
  rev: number; // the HEAD revision — see the "Terminology" note in main.ts
  updatedAt: string | null;
  board: Board;
};
// The head pointer on its own: what a cheap poll or an ETag needs.
export type Head = { rev: number; updatedAt: string | null };
// A card as it looks once off the board: the client tags it with the board it
// came from and when it left, so an archive read is legible on its own.
export type ArchivedCard = Card & { board?: string; archivedAt?: number };

export function emptyDoc(): Doc {
  return { rev: 0, updatedAt: null, board: { projects: {}, life: {}, lifeMeta: {} } };
}

/* A write the store has no room for. Thrown by every board write (and so
 * checked in exactly one place per backend, before anything is written); the
 * request handler turns it into a 507, or 413 for PUT /state. `limit` is the
 * backend's own capacity, so the message is always about the store actually
 * in use. */
export class StoreFullError extends Error {
  constructor(readonly size: number, readonly limit: number) {
    super(
      `board store full: ${size} of ${limit} bytes` +
        " — archive done tickets to free space",
    );
  }
}

/* A server-initiated read-modify-write that kept losing to concurrent writers
 * and gave up. The request handler answers 503 "write contention, retry". */
export class StoreContentionError extends Error {
  constructor() {
    super("write contention, retry");
  }
}

/* A caller-supplied id/ref that names no ticket (404) or more than one (409).
 * `error` is the response body as resolveTicketId builds it. */
export type Unresolved = { kind: "unresolved"; status: number; error: Record<string, unknown> };

export type PutResult =
  // baseRev wasn't the head: the caller re-GETs, merges and retries.
  | { kind: "stale"; rev: number }
  // baseRev was the head when read, but another writer landed first.
  | { kind: "conflict" }
  | { kind: "ok"; rev: number; updatedAt: string };

export type ArchiveResult =
  // Every card was already archived — an idempotent no-op, not an error.
  | { kind: "duplicates"; duplicates: number; chunks: number }
  | { kind: "archived"; archived: number; duplicates: number; chunk: number }
  // The batch alone can't fit the archive's unit of storage; send fewer cards.
  | { kind: "tooLarge"; size: number; limit: number };

/* One trusted pull-request event, already authenticated and parsed by
 * main.ts: move the ticket `text` names to `target`, recording `pr` on it. */
export type WebhookEvent = {
  deliveryId: string; // lowercased X-GitHub-Delivery
  pr: string; // "owner/repo#123"
  target: "review" | "done";
  text: string; // PR title + "\n" + body, searched for exactly one ticket ref
};

/* What a webhook event does to a board. Everything but "moved" leaves the
 * board as it was; the delivery is recorded in every case. */
export type WebhookOutcome =
  | { kind: "ignored"; ignored: string; ref?: string }
  | { kind: "refused"; status: number; error: Record<string, unknown> }
  | { kind: "unchanged"; ref: string; column: string }
  | { kind: "moved"; ref: string; column: string };

export type WebhookResult =
  // `rev` is the head the outcome was decided against (or produced, if moved).
  | WebhookOutcome & { rev: number }
  // This delivery ID was already recorded; nothing was read or changed.
  | { kind: "redelivered"; rev: number };

export type StoreLimits = {
  // The most one stored board can hold, in the backend's own measure.
  boardBytes: number;
  // How many past revisions boardAt/restore can still reach.
  keptRevisions: number;
};

export interface Store {
  readonly limits: StoreLimits;

  /* ---- Reads ---- */
  // The current head; rev 0 / updatedAt null before the first write.
  getHead(): Promise<Head>;
  // The current doc (or an empty rev-0 doc on first run).
  readBoard(): Promise<Doc>;
  // The kept snapshot of a past revision, or null if it was pruned / never was.
  boardAt(rev: number): Promise<Doc | null>;
  // The kept restore points, newest first.
  listRevisions(): Promise<Head[]>;
  // Every archived card in archive order (oldest append first), plus how many
  // storage chunks hold them — reported by GET /archive.
  readArchive(): Promise<{ chunks: number; cards: ArchivedCard[] }>;
  // Whether a webhook delivery ID has already been recorded.
  hasDelivery(deliveryId: string): Promise<boolean>;

  /* ---- Board writes. Each is one atomic step that bumps rev by exactly 1,
   * snapshots the result, and throws StoreFullError if the new board can't
   * fit. Server-initiated read-modify-writes throw StoreContentionError if
   * they can't land. ---- */
  // Full-board replace, conditional on baseRev. Server-owned pr/prRev are kept
  // from the current board, never taken from `board`.
  applyBoardPut(baseRev: number, board: Board): Promise<PutResult>;
  // Append a new card to a projects-board column.
  createTicket(card: Card, column: string): Promise<{ rev: number }>;
  // Edit a ticket (by id or ref) in place and/or move it to `column`.
  patchTicket(
    given: string,
    change: { column?: string; edits: TicketEdits },
  ): Promise<{ kind: "ok"; card: Card; column: string; rev: number } | Unresolved>;
  // Hard-delete a ticket (by id or ref); `board` is the committed result.
  deleteTicket(
    given: string,
  ): Promise<{ kind: "ok"; card: Card; column: string; rev: number; board: Board } | Unresolved>;
  // Re-land a kept snapshot as a new head rev; null if it was pruned. Must apply
  // restoreWorkflowMetadata: surviving cards keep their CURRENT pr/prRev, and
  // cards deleted since the snapshot come back with the snapshot's own.
  restore(rev: number): Promise<{ rev: number; updatedAt: string } | null>;

  /* ---- Archive: append-only, idempotent by card id ---- */
  archive(cards: ArchivedCard[]): Promise<ArchiveResult>;

  /* ---- Webhook. A delivery ID, once recorded, is never forgotten, and is
   * recorded atomically with the board state its outcome was decided
   * against — so a redelivery can never mutate the board twice. ---- */
  // Record a delivery whose outcome doesn't depend on the board (unsupported
  // event, untrusted repo, bad payload…). Throws StoreContentionError.
  recordDelivery(deliveryId: string): Promise<{ kind: "recorded" } | { kind: "redelivered"; rev: number }>;
  // Decide the event against the current board with applyWebhookEvent and
  // commit the outcome and the delivery record together.
  commitWebhookMove(event: WebhookEvent): Promise<WebhookResult>;
}

/* Resolve a caller-supplied identifier to a card id, accepting either form:
 * the raw id (t_msa8scco_632be) or the ref the board shows (KODER-632B).
 *
 * Exact id match wins outright. Ids are unique and authoritative — they're the
 * merge key — so checking them first keeps every existing caller working
 * unchanged and means a ref can never shadow a real id.
 *
 * A ref is a truncation, so it CAN match more than one ticket. That's refused
 * rather than resolved arbitrarily: silently patching one of two tickets that
 * share a ref is the one failure mode worse than not patching at all. */
export function resolveTicketId(
  board: Board,
  given: string,
): { id: string } | { error: Record<string, unknown>; status: number } {
  const allCards = Object.values(board.projects ?? {}).flatMap((cards) => cards ?? []);
  const byId = allCards.find((c) => c.id === given);
  if (byId) return { id: byId.id };

  const wanted = given.trim().toUpperCase();
  const matches = allCards.filter((c) => ticketRef(c).toUpperCase() === wanted);
  if (matches.length === 1) return { id: matches[0].id };
  if (matches.length > 1) {
    return {
      status: 409,
      error: {
        error: `ref "${given}" matches ${matches.length} tickets — use the id instead`,
        ids: matches.map((c) => c.id),
      },
    };
  }
  return { status: 404, error: { error: `no ticket with id or ref "${given}"` } };
}

const hasOwn = (value: object, key: PropertyKey) =>
  Object.prototype.hasOwnProperty.call(value, key);

/* pr/prRev are workflow state, not browser-editable card fields. A full-board
 * sync may move or edit a card, but it must carry the current server values
 * exactly. New cards (and legacy cards without workflow state) cannot acquire
 * either field from an untrusted PUT. */
export function preserveWorkflowMetadata(incoming: Board, current: Board): Board {
  return carryWorkflowMetadata(incoming, current, false);
}

/* Restore's variant: the snapshot's card text comes back, but each card that
 * still exists keeps its CURRENT pr/prRev (matched by id across both boards
 * and every column), so restoring never unlinks a PR or rewinds prRev. The
 * one difference from the PUT rule is a card deleted since the snapshot: it has
 * no current value, so it keeps the snapshot's own pr/prRev. Those were
 * written by the webhook (every stored board has passed
 * preserveWorkflowMetadata), so keeping them forges nothing, whereas
 * stripping them would drop a real link and let a later webhook restart prRev
 * below a value a client may still hold. */
export function restoreWorkflowMetadata(snapshot: Board, current: Board): Board {
  return carryWorkflowMetadata(snapshot, current, true);
}

function carryWorkflowMetadata(incoming: Board, current: Board, keepOrphans: boolean): Board {
  const board = structuredClone(incoming);
  const currentCards = new Map<string, Card>();
  for (const boardId of ["projects", "life"] as const) {
    for (const cards of Object.values(current[boardId] ?? {})) {
      for (const card of cards ?? []) currentCards.set(card.id, card);
    }
  }
  for (const boardId of ["projects", "life"] as const) {
    for (const cards of Object.values(board[boardId] ?? {})) {
      for (const card of cards ?? []) {
        const authoritative = currentCards.get(card.id);
        if (!authoritative && keepOrphans) continue;
        delete card.pr;
        delete card.prRev;
        if (authoritative && hasOwn(authoritative, "pr")) card.pr = authoritative.pr;
        if (authoritative && hasOwn(authoritative, "prRev")) card.prRev = authoritative.prRev;
      }
    }
  }
  return board;
}

function resolveVisibleTicket(
  board: Board,
  text: string,
): { id: string; ref: string } | { error: Record<string, unknown>; status: number } | null {
  const candidates = new Set(
    Array.from(text.matchAll(/\b[A-Z0-9]+-[A-Z0-9]{4}\b/gi), (match) => match[0].toUpperCase()),
  );
  const matches = new Map<string, string>();
  for (const candidate of candidates) {
    const resolved = resolveTicketId(board, candidate);
    if ("error" in resolved) {
      if (resolved.status === 409) return resolved;
      continue;
    }
    matches.set(resolved.id, candidate);
  }
  if (matches.size === 0) return null;
  if (matches.size > 1) {
    return {
      status: 409,
      error: {
        error: "PR title/body references more than one ticket",
        refs: [...matches.values()],
      },
    };
  }
  const [[id, ref]] = matches;
  return { id, ref };
}

function isNewerSameRepoPr(current: string, incoming: string): boolean {
  const currentMatch = current.match(/^(.+)#([1-9][0-9]*)$/);
  const incomingMatch = incoming.match(/^(.+)#([1-9][0-9]*)$/);
  if (!currentMatch || !incomingMatch || currentMatch[1] !== incomingMatch[1]) return false;
  return Number(incomingMatch[2]) > Number(currentMatch[2]);
}

/* The webhook's transition policy, applied to a board the caller owns (a
 * fresh copy it is about to commit). Done is terminal; a card's PR may only be
 * replaced by a higher-numbered PR in the same repo; an accepted transition
 * stores the PR and bumps prRev. Only a "moved" outcome mutates `board`. */
export function applyWebhookEvent(board: Board, event: WebhookEvent): WebhookOutcome {
  const { pr, target } = event;
  const resolved = resolveVisibleTicket(board, event.text);
  if (!resolved) return { kind: "ignored", ignored: "no ticket ref" };
  if ("error" in resolved) return { kind: "refused", status: resolved.status, error: resolved.error };

  let card: Card | null = null;
  let from: string | null = null;
  let fromCards: Card[] | null = null;
  let cardIndex = -1;
  for (const [column, cards] of Object.entries(board.projects ?? {})) {
    const index = (cards ?? []).findIndex((candidate) => candidate.id === resolved.id);
    if (index !== -1) {
      from = column;
      fromCards = cards;
      cardIndex = index;
      card = cards[index];
      break;
    }
  }
  if (!card || from === null || !fromCards || cardIndex < 0) {
    return { kind: "ignored", ignored: "ticket no longer exists" };
  }
  if (from === "done" && target === "review") {
    return { kind: "ignored", ignored: "done is terminal for webhook events", ref: resolved.ref };
  }
  if (card.pr && card.pr !== pr && !isNewerSameRepoPr(card.pr, pr)) {
    return { kind: "ignored", ignored: "stale or cross-repository PR association", ref: resolved.ref };
  }
  if (from === target && card.pr === pr) {
    return { kind: "unchanged", ref: resolved.ref, column: from };
  }
  card.pr = pr;
  card.prRev = nextWebhookRevision(card.prRev);
  if (from !== target) {
    fromCards.splice(cardIndex, 1);
    (board.projects[target] ??= []).push(card);
  }
  return { kind: "moved", ref: resolved.ref, column: target };
}
