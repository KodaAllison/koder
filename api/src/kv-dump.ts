/* The KV dump file: the one JSON document that carries the Deno KV board across
 * to Postgres (KODER-E214).
 *
 * Deno KV can only be read from Deno, so the cutover is two programs with this
 * file between them: scripts/export-kv.deno.ts (Deno, read-only) writes it,
 * scripts/import-kv.ts (Node) reads it. This module is the contract between the
 * two, and is deliberately pure (no imports, no Node or Deno APIs) so BOTH
 * runtimes import it: the exporter validates what it is about to write, and the
 * importer validates what it was given before it touches the database.
 *
 * The key layout mirrored here is server/kv-store.ts's: ["board"] holds the doc
 * {rev, updatedAt, board}; ["archive", n] holds an array of archived cards (n
 * counts up from 0); ["github-delivery", id] = true. The ["board", rev]
 * snapshots are not dumped: history starts at the cutover. */

export const DUMP_FORMAT = "koder-kv-dump";
export const DUMP_VERSION = 1;

type Json = Record<string, unknown>;

export type KvDump = {
  format: typeof DUMP_FORMAT;
  version: typeof DUMP_VERSION;
  exportedAt: string;
  // The ["board"] entry, exactly as stored.
  doc: { rev: number; updatedAt: string; board: Json };
  // Every ["archive", n] entry, in ascending n.
  archive: { n: number; cards: Json[] }[];
  // Every id of ["github-delivery", id].
  deliveries: string[];
};

export class DumpError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    const shown = problems.slice(0, 20);
    const more = problems.length > shown.length ? `\n  ... and ${problems.length - shown.length} more` : "";
    super(`not a valid ${DUMP_FORMAT} file:\n  ${shown.join("\n  ")}${more}`);
    this.name = "DumpError";
    this.problems = problems;
  }
}

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/* Check the shape of a parsed dump and hand it back typed; throw a DumpError
 * listing every problem otherwise. The board is held to what PUT /state's
 * isBoardShaped accepted (column values are arrays of objects with a string id
 * and title; a null or absent projects/life is an empty board), because that
 * is all KV could ever have stored. The importer calls this before it opens a
 * transaction. */
export function validateDump(input: unknown): KvDump {
  const problems: string[] = [];
  if (!isObject(input)) throw new DumpError(["the top level is not a JSON object"]);
  if (input.format !== DUMP_FORMAT) problems.push(`format is ${JSON.stringify(input.format)}, expected "${DUMP_FORMAT}"`);
  if (input.version !== DUMP_VERSION) problems.push(`version is ${JSON.stringify(input.version)}, expected ${DUMP_VERSION}`);
  if (typeof input.exportedAt !== "string") problems.push("exportedAt is not a string");

  const doc = input.doc;
  if (!isObject(doc)) {
    problems.push("doc is missing or not an object (the ['board'] entry)");
  } else {
    if (!Number.isSafeInteger(doc.rev) || (doc.rev as number) < 1) {
      problems.push(`doc.rev must be an integer >= 1, got ${JSON.stringify(doc.rev)} (an empty KV has nothing to import)`);
    }
    if (typeof doc.updatedAt !== "string" || Number.isNaN(Date.parse(doc.updatedAt))) {
      problems.push(`doc.updatedAt must be a date string, got ${JSON.stringify(doc.updatedAt)}`);
    }
    const board = doc.board;
    if (!isObject(board)) {
      problems.push("doc.board is missing or not an object");
    } else {
      for (const key of ["projects", "life"]) {
        const columns = board[key];
        if (columns == null) continue;
        if (typeof columns !== "object") {
          problems.push(`doc.board.${key} is neither an object nor null`);
          continue;
        }
        for (const [column, cards] of Object.entries(columns)) {
          if (!Array.isArray(cards)) {
            problems.push(`doc.board.${key}.${column} is not an array`);
            continue;
          }
          cards.forEach((card, i) => {
            if (!isObject(card) || typeof card.id !== "string" || typeof card.title !== "string") {
              problems.push(`doc.board.${key}.${column}[${i}] is not an object with a string id and title`);
            }
          });
        }
      }
      if (board.lifeMeta != null && typeof board.lifeMeta !== "object") {
        problems.push("doc.board.lifeMeta is neither an object nor null");
      }
    }
  }

  if (!Array.isArray(input.archive)) {
    problems.push("archive is not an array");
  } else {
    let previous = -1;
    input.archive.forEach((chunk, i) => {
      if (!isObject(chunk) || !Number.isSafeInteger(chunk.n) || (chunk.n as number) < 0 || !Array.isArray(chunk.cards)) {
        problems.push(`archive[${i}] is not {n: integer >= 0, cards: array}`);
        return;
      }
      if ((chunk.n as number) <= previous) problems.push(`archive[${i}].n (${chunk.n}) is not above the chunk before it`);
      previous = chunk.n as number;
      (chunk.cards as unknown[]).forEach((card, j) => {
        if (!isObject(card) || typeof card.id !== "string" || card.id === "") {
          problems.push(`archive[${i}].cards[${j}] is not an object with a string id`);
        }
      });
    });
  }

  if (!Array.isArray(input.deliveries)) {
    problems.push("deliveries is not an array");
  } else {
    input.deliveries.forEach((id, i) => {
      if (typeof id !== "string" || id === "") problems.push(`deliveries[${i}] is not a non-empty string`);
    });
  }

  if (problems.length) throw new DumpError(problems);
  return input as unknown as KvDump;
}
