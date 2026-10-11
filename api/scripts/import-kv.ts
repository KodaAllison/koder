/* Load the Deno KV dump (api/scripts/export-kv.deno.ts) into an EMPTY Postgres
 * and verify it: the import step of docs/runbooks/cutover-to-node.md (KODER-E214).
 *
 *   NEON_DATABASE_URL=postgres://... node api/scripts/import-kv.ts <dump.json>
 *   NEON_DATABASE_URL=postgres://... node api/scripts/import-kv.ts <dump.json> --verify-only
 *
 * Runs the schema migrations first (as the server does at startup), refuses a
 * database that already holds data, imports in one transaction, then verifies
 * what the server would serve against the dump. Exit code 0 means imported (or
 * verified) and identical; 1 means a refusal, an error or a difference; 2 is a
 * usage error. The connection string is never printed. */

import { readFile } from "node:fs/promises";
import { DumpError, validateDump } from "../src/kv-dump.ts";
import { importDump, NotEmptyError, verifyImport } from "../src/kv-import.ts";
import { scrubSecret, openSql } from "../src/pg-store.ts";

const args = process.argv.slice(2);
const verifyOnly = args.includes("--verify-only");
const files = args.filter((a) => !a.startsWith("--"));
const unknown = args.filter((a) => a.startsWith("--") && a !== "--verify-only");
const url = process.env.NEON_DATABASE_URL ?? "";

if (files.length !== 1 || unknown.length || !url) {
  console.error(
    "usage: NEON_DATABASE_URL=postgres://... node api/scripts/import-kv.ts <dump.json> [--verify-only]" +
      (url ? "" : "\nNEON_DATABASE_URL is not set"),
  );
  process.exit(2);
}

let exitCode = 0;
let sql: Awaited<ReturnType<typeof openSql>> | undefined;
try {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(files[0], "utf8"));
  } catch (err) {
    throw new Error(`cannot read ${files[0]}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const dump = validateDump(parsed);
  console.log(
    `dump: rev ${dump.doc.rev}, ${dump.archive.reduce((n, c) => n + c.cards.length, 0)} archived cards in ` +
      `${dump.archive.length} chunks, ${dump.deliveries.length} deliveries (exported ${dump.exportedAt})`,
  );

  sql = await openSql(url, { max: 1 });
  if (!verifyOnly) {
    const summary = await importDump(sql, dump);
    console.log(
      `imported: rev ${summary.rev}, ${summary.cards} cards, ${summary.lifeItems} lifeMeta items, ` +
        `${summary.archived} archived, ${summary.deliveries} deliveries (one transaction)`,
    );
  }

  const result = await verifyImport(sql, dump);
  for (const note of result.notes) console.log(`note (documented difference): ${note}`);
  if (result.ok) {
    console.log("verify: OK, the database matches the dump");
  } else {
    console.error(`verify: ${result.differences.length} DIFFERENCE(S), do not continue the cutover:`);
    for (const d of result.differences) console.error(`  - ${d}`);
    exitCode = 1;
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    err instanceof NotEmptyError || err instanceof DumpError ? message : `import-kv: ${scrubSecret(message, url)}`,
  );
  exitCode = 1;
} finally {
  await sql?.end({ timeout: 5 }).catch(() => {});
}
process.exit(exitCode);
