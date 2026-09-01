import assert from "node:assert/strict";
import { nextWebhookRevision } from "./workflow.ts";

const TOKEN = "webhook-test-token";
const SECRET = "webhook-test-secret";
let deliverySequence = 1;

function freshDelivery(): string {
  return `00000000-0000-4000-8000-${
    (deliverySequence++).toString(16).padStart(12, "0")
  }`;
}

type Card = {
  id: string;
  title: string;
  note: string;
  priority: string;
  created: number;
  project: string | null;
  pr?: string;
  prRev?: number;
};

type Doc = {
  rev: number;
  updatedAt: string | null;
  board: {
    projects: Record<string, Card[]>;
    life: Record<string, Card[]>;
    lifeMeta: Record<string, unknown>;
  };
};

async function signature(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );
  return `sha256=${
    Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
  }`;
}

async function waitForServer(baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/state`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
        signal: AbortSignal.timeout(200),
      });
      if (response.ok) return;
    } catch {
      // The listener is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("server did not start");
}

async function getState(baseUrl: string, path = "/state"): Promise<Doc> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(response.status, 200);
  return await response.json() as Doc;
}

async function seedBoard(
  baseUrl: string,
  projects: Record<string, Card[]>,
): Promise<Doc> {
  // Tests deliberately reset through the public sync seam. Delete old IDs in
  // one revision first so server-owned workflow metadata cannot bleed between
  // otherwise independent scenarios or be forged by the next PUT.
  let current = await getState(baseUrl);
  let response = await fetch(`${baseUrl}/state`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      baseRev: current.rev,
      board: { projects: {}, life: {}, lifeMeta: {} },
    }),
  });
  assert.equal(response.status, 200);
  current = await getState(baseUrl);
  response = await fetch(`${baseUrl}/state`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      baseRev: current.rev,
      board: { projects, life: {}, lifeMeta: {} },
    }),
  });
  assert.equal(response.status, 200);
  return await getState(baseUrl);
}

async function putBoard(baseUrl: string, board: Doc["board"]): Promise<Doc> {
  const current = await getState(baseUrl);
  const response = await fetch(`${baseUrl}/state`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ baseRev: current.rev, board }),
  });
  assert.equal(response.status, 200);
  return await getState(baseUrl);
}

async function postWebhook(
  baseUrl: string,
  payload: unknown,
  options: {
    signature?:
      | "valid"
      | "invalid"
      | "uppercaseHex"
      | "uppercasePrefix"
      | "short"
      | "missing";
    event?: string;
    bearer?: boolean;
    delivery?: string | null;
  } = {},
): Promise<Response> {
  const normalized = structuredClone(payload) as Record<string, unknown>;
  const repository = normalized?.repository as
    | Record<string, unknown>
    | undefined;
  const pullRequest = normalized?.pull_request as
    | Record<string, unknown>
    | undefined;
  if (
    typeof repository?.full_name === "string" && pullRequest &&
    !("head" in pullRequest)
  ) {
    pullRequest.head = { repo: { full_name: repository.full_name } };
  }
  const body = JSON.stringify(normalized);
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-GitHub-Event": options.event ?? "pull_request",
  });
  const delivery = options.delivery === undefined
    ? freshDelivery()
    : options.delivery;
  if (delivery !== null) headers.set("X-GitHub-Delivery", delivery);
  if (options.signature !== "missing") {
    const signed = await signature(body);
    const digest = signed.slice("sha256=".length);
    headers.set(
      "X-Hub-Signature-256",
      options.signature === "invalid"
        ? `sha256=${"0".repeat(64)}`
        : options.signature === "uppercaseHex"
        ? `sha256=${digest.toUpperCase()}`
        : options.signature === "uppercasePrefix"
        ? `SHA256=${digest}`
        : options.signature === "short"
        ? `sha256=${digest.slice(0, 63)}`
        : signed,
    );
  }
  if (options.bearer) headers.set("Authorization", `Bearer ${TOKEN}`);
  return await fetch(`${baseUrl}/webhooks/github`, {
    method: "POST",
    headers,
    body,
  });
}

async function postRawWebhook(
  baseUrl: string,
  body: BodyInit,
  delivery = freshDelivery(),
): Promise<Response> {
  return await fetch(`${baseUrl}/webhooks/github`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Delivery": delivery,
      "X-GitHub-Event": "pull_request",
      "X-Hub-Signature-256": `sha256=${"0".repeat(64)}`,
    },
    body,
  });
}

async function writeAll(conn: Deno.Conn, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    offset += await conn.write(bytes.subarray(offset));
  }
}

async function postChunkedOversizedWebhook(baseUrl: string): Promise<number> {
  const url = new URL(baseUrl);
  const conn = await Deno.connect({
    hostname: url.hostname,
    port: Number(url.port),
  });
  const encoder = new TextEncoder();
  try {
    await writeAll(
      conn,
      encoder.encode([
        "POST /webhooks/github HTTP/1.1",
        `Host: ${url.host}`,
        "Content-Type: application/json",
        `X-GitHub-Delivery: ${freshDelivery()}`,
        "X-GitHub-Event: pull_request",
        `X-Hub-Signature-256: sha256=${"0".repeat(64)}`,
        "Transfer-Encoding: chunked",
        "Connection: close",
        "",
        "",
      ].join("\r\n")),
    );
    try {
      for (const chunk of [new Uint8Array(200_000), new Uint8Array(100_000)]) {
        await writeAll(
          conn,
          encoder.encode(`${chunk.length.toString(16)}\r\n`),
        );
        await writeAll(conn, chunk);
        await writeAll(conn, encoder.encode("\r\n"));
      }
      await writeAll(conn, encoder.encode("0\r\n\r\n"));
    } catch {
      // The server may close its receive side as soon as it emits the 413.
    }

    const response = new Uint8Array(4096);
    const size = await conn.read(response);
    assert.notEqual(size, null);
    const statusLine =
      new TextDecoder().decode(response.subarray(0, size ?? 0)).split(
        "\r\n",
        1,
      )[0];
    return Number(statusLine.split(" ")[1]);
  } finally {
    conn.close();
  }
}

function card(
  id = "t_ticket_1a2b",
  project = "koder",
  extra: Partial<Card> = {},
): Card {
  return {
    id,
    title: "Webhook ticket",
    note: "",
    priority: "med",
    created: 1,
    project,
    ...extra,
  };
}

Deno.test({
  name: "GitHub PR webhook",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    const probe = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const port = (probe.addr as Deno.NetAddr).port;
    probe.close();
    const kvDir = await Deno.makeTempDir({ prefix: "koder-webhook-test-" });
    const mainUrl = new URL("./main.ts", import.meta.url);
    const mainPath = Deno.build.os === "windows"
      ? decodeURIComponent(mainUrl.pathname.slice(1))
      : decodeURIComponent(mainUrl.pathname);
    const server = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--unstable-kv",
        "--allow-env",
        "--allow-net",
        "--allow-read",
        "--allow-write",
        mainPath,
      ],
      cwd: kvDir,
      env: {
        KODER_TOKEN: TOKEN,
        KODER_WEBHOOK_SECRET: SECRET,
        KODER_KV_PATH: `${kvDir}/board.sqlite3`,
        PORT: String(port),
      },
      stdout: "null",
      stderr: "null",
    }).spawn();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await waitForServer(baseUrl);

      await t.step(
        "missing and invalid HMACs are rejected with no bearer fallback",
        async () => {
          const before = await seedBoard(baseUrl, { doing: [card()] });
          const payload = {
            action: "opened",
            repository: { full_name: "KodaAllison/koder" },
            pull_request: {
              number: 14,
              title: "KODER-1A2B Auto-move cards from PR events",
              body: null,
              merged: false,
            },
          };
          const missing = await postWebhook(baseUrl, payload, {
            signature: "missing",
            bearer: true,
          });
          const invalid = await postWebhook(baseUrl, payload, {
            signature: "invalid",
            bearer: true,
          });

          assert.equal(missing.status, 401);
          assert.equal(invalid.status, 401);
          assert.equal((await getState(baseUrl)).rev, before.rev);
        },
      );

      await t.step("a valid GitHub delivery ID is mandatory", async () => {
        const before = await seedBoard(baseUrl, { doing: [card()] });
        const payload = {
          action: "opened",
          repository: { full_name: "KodaAllison/koder" },
          pull_request: {
            number: 14,
            title: "KODER-1A2B missing delivery",
            body: null,
            merged: false,
          },
        };
        const missing = await postWebhook(baseUrl, payload, { delivery: null });
        const malformed = await postWebhook(baseUrl, payload, {
          delivery: "not-a-guid",
        });

        assert.equal(missing.status, 400);
        assert.equal(malformed.status, 400);
        assert.equal((await getState(baseUrl)).rev, before.rev);
      });

      await t.step(
        "signature grammar accepts lowercase sha256 hex only",
        async () => {
          const before = await seedBoard(baseUrl, { doing: [card()] });
          const payload = {
            action: "opened",
            repository: { full_name: "KodaAllison/koder" },
            pull_request: {
              number: 14,
              title: "KODER-1A2B uppercase signature",
              body: null,
              merged: false,
            },
          };

          for (
            const signature of [
              "uppercaseHex",
              "uppercasePrefix",
              "short",
            ] as const
          ) {
            assert.equal(
              (await postWebhook(baseUrl, payload, { signature })).status,
              401,
              signature,
            );
          }
          assert.equal((await getState(baseUrl)).rev, before.rev);
        },
      );

      await t.step(
        "oversized fixed and streamed bodies are rejected with 413",
        async () => {
          const fixed = await postRawWebhook(baseUrl, "x".repeat(300_000));
          assert.equal(fixed.status, 413);

          assert.equal(await postChunkedOversizedWebhook(baseUrl), 413);
        },
      );

      await t.step(
        "only the four active repositories are trusted",
        async () => {
          for (
            const repo of [
              "KodaAllison/koder",
              "KodaAllison/crook-community",
              "KodaAllison/holitrackr",
              "KodaAllison/portfolio-website",
            ]
          ) {
            await seedBoard(baseUrl, { todo: [card()] });
            const response = await postWebhook(baseUrl, {
              action: "opened",
              repository: { full_name: repo },
              pull_request: {
                number: 7,
                title: "KODER-1A2B trusted repository",
                body: null,
                merged: false,
              },
            });
            assert.equal(response.status, 200, repo);
            const state = await getState(baseUrl);
            assert.equal(state.board.projects.review[0].pr, `${repo}#7`);
          }

          const before = await seedBoard(baseUrl, { todo: [card()] });
          const response = await postWebhook(baseUrl, {
            action: "opened",
            repository: { full_name: "KodaAllison/inactive-repo" },
            pull_request: {
              number: 7,
              title: "KODER-1A2B untrusted repository",
              body: null,
              merged: false,
            },
          });
          assert.equal(response.status, 202);
          assert.equal((await getState(baseUrl)).rev, before.rev);
        },
      );

      await t.step(
        "repository identity requires exact canonical casing and deduplicates variants",
        async () => {
          const before = await seedBoard(baseUrl, { doing: [card()] });
          const delivery = freshDelivery();
          const variant = {
            action: "opened",
            repository: { full_name: "kodaallison/koder" },
            pull_request: {
              number: 8,
              title: "KODER-1A2B casing must be canonical",
              body: null,
              merged: false,
              head: { repo: { full_name: "kodaallison/koder" } },
            },
          };
          assert.equal(
            (await postWebhook(baseUrl, variant, { delivery })).status,
            202,
          );
          assert.deepEqual((await getState(baseUrl)).board, before.board);

          const canonical = structuredClone(variant);
          canonical.repository.full_name = "KodaAllison/koder";
          canonical.pull_request.head.repo.full_name = "KodaAllison/koder";
          const replay = await postWebhook(baseUrl, canonical, { delivery });
          assert.equal(
            (await replay.json() as { redelivered?: boolean }).redelivered,
            true,
          );
          assert.deepEqual((await getState(baseUrl)).board, before.board);
        },
      );

      await t.step(
        "full-board PUT cannot forge, strip, or replace workflow metadata",
        async () => {
          const forged = card("t_ticket_1a2b", "koder", {
            pr: "KodaAllison/koder#40",
            prRev: 1,
          });
          let state = await seedBoard(baseUrl, { doing: [forged] });
          assert.equal(state.board.projects.doing[0].pr, undefined);
          assert.equal(state.board.projects.doing[0].prRev, undefined);

          const opened = await postWebhook(baseUrl, {
            action: "opened",
            repository: { full_name: "KodaAllison/koder" },
            pull_request: {
              number: 41,
              title: "KODER-1A2B establish server metadata",
              body: null,
              merged: false,
            },
          });
          assert.equal(opened.status, 200);
          state = await getState(baseUrl);
          assert.equal(state.board.projects.review[0].prRev, 1);

          const stripped = structuredClone(state.board);
          delete stripped.projects.review[0].pr;
          delete stripped.projects.review[0].prRev;
          stripped.projects.review[0].title = "browser edit without metadata";
          state = await putBoard(baseUrl, stripped);
          assert.equal(state.board.projects.review[0].pr, "KodaAllison/koder#41");
          assert.equal(state.board.projects.review[0].prRev, 1);

          const forgedEqual = structuredClone(state.board);
          forgedEqual.projects.review[0].pr = "KodaAllison/koder#999";
          forgedEqual.projects.review[0].prRev = 1;
          state = await putBoard(baseUrl, forgedEqual);
          assert.equal(state.board.projects.review[0].pr, "KodaAllison/koder#41");
          assert.equal(state.board.projects.review[0].prRev, 1);
        },
      );

      await t.step(
        "webhook markers increment safely and recover from legacy values",
        () => {
          assert.equal(nextWebhookRevision(0), 1);
          assert.equal(nextWebhookRevision(41), 42);
          assert.equal(nextWebhookRevision(Number.MAX_SAFE_INTEGER), 1);
          assert.equal(nextWebhookRevision(Number.MAX_SAFE_INTEGER + 1), 1);
          assert.equal(nextWebhookRevision(-1), 1);
          assert.equal(nextWebhookRevision("41"), 1);
        },
      );

      await t.step(
        "fork pull requests cannot mutate and their delivery is deduplicated",
        async () => {
          const before = await seedBoard(baseUrl, { doing: [card()] });
          const delivery = freshDelivery();
          const payload = {
            action: "opened",
            repository: { full_name: "KodaAllison/koder" },
            pull_request: {
              number: 22,
              title: "KODER-1A2B outsider branch",
              body: null,
              merged: false,
              head: { repo: { full_name: "outsider/koder" } },
            },
          };
          const first = await postWebhook(baseUrl, payload, { delivery });
          assert.equal(first.status, 202);
          assert.equal((await getState(baseUrl)).rev, before.rev);

          const replay = await postWebhook(baseUrl, {
            ...payload,
            pull_request: {
              ...payload.pull_request,
              head: { repo: { full_name: "KodaAllison/koder" } },
            },
          }, { delivery });
          assert.equal(
            (await replay.json() as { redelivered?: boolean }).redelivered,
            true,
          );
          assert.deepEqual((await getState(baseUrl)).board, before.board);
        },
      );

      await t.step("untrusted events and actions are ignored", async () => {
        const before = await seedBoard(baseUrl, { todo: [card()] });
        const payload = {
          action: "synchronize",
          repository: { full_name: "KodaAllison/koder" },
          pull_request: {
            number: 7,
            title: "KODER-1A2B ignored event",
            body: null,
            merged: false,
          },
        };
        assert.equal((await postWebhook(baseUrl, payload)).status, 202);
        assert.equal(
          (await postWebhook(baseUrl, payload, { event: "issues" })).status,
          202,
        );
        assert.equal((await getState(baseUrl)).rev, before.rev);
      });

      await t.step(
        "every authenticated no-op delivery is permanently deduplicated",
        async () => {
          const mutatingPayload = {
            action: "opened",
            repository: { full_name: "KodaAllison/koder" },
            pull_request: {
              number: 14,
              title: "KODER-1A2B mutate if delivery was not recorded",
              body: null,
              merged: false,
            },
          };
          const cases: Array<{
            name: string;
            projects: Record<string, Card[]>;
            payload: unknown;
            options: { event?: string };
            status: number;
            replay?: unknown;
          }> = [
            {
              name: "unsupported event",
              projects: { doing: [card()] },
              payload: mutatingPayload,
              options: { event: "issues" },
              status: 202,
            },
            {
              name: "unsupported action",
              projects: { doing: [card()] },
              payload: { ...mutatingPayload, action: "synchronize" },
              options: {},
              status: 202,
            },
            {
              name: "disallowed repository",
              projects: { doing: [card()] },
              payload: {
                ...mutatingPayload,
                repository: { full_name: "KodaAllison/inactive-repo" },
              },
              options: {},
              status: 202,
            },
            {
              name: "no matching ref",
              projects: { doing: [card()] },
              payload: {
                ...mutatingPayload,
                pull_request: {
                  ...mutatingPayload.pull_request,
                  title: "KODER-FFFF no match",
                },
              },
              options: {},
              status: 202,
            },
            {
              name: "ambiguous refs",
              projects: { doing: [card(), card("t_ticket_3c4d")] },
              payload: {
                ...mutatingPayload,
                pull_request: {
                  ...mutatingPayload.pull_request,
                  title: "KODER-1A2B and KODER-3C4D",
                },
              },
              options: {},
              status: 409,
            },
            {
              name: "closed without merge",
              projects: { doing: [card()] },
              payload: {
                ...mutatingPayload,
                action: "closed",
                pull_request: {
                  ...mutatingPayload.pull_request,
                  merged: false,
                },
              },
              options: {},
              status: 202,
            },
            {
              name: "unchanged transition",
              projects: {
                review: [
                  card("t_ticket_1a2b", "koder", {
                    pr: "KodaAllison/koder#14",
                  }),
                ],
              },
              payload: mutatingPayload,
              options: {},
              status: 200,
              replay: {
                ...mutatingPayload,
                action: "closed",
                pull_request: { ...mutatingPayload.pull_request, merged: true },
              },
            },
          ];

          for (const scenario of cases) {
            let before = await seedBoard(baseUrl, scenario.projects);
            if (scenario.name === "unchanged transition") {
              assert.equal(
                (await postWebhook(baseUrl, mutatingPayload)).status,
                200,
              );
              before = await getState(baseUrl);
            }
            const delivery = freshDelivery();
            const first = await postWebhook(baseUrl, scenario.payload, {
              ...scenario.options,
              delivery,
            });
            assert.equal(first.status, scenario.status, scenario.name);
            assert.equal(
              (await getState(baseUrl)).rev,
              before.rev,
              scenario.name,
            );

            const replay = await postWebhook(
              baseUrl,
              scenario.replay ?? mutatingPayload,
              { delivery },
            );
            assert.equal(replay.status, 200, `${scenario.name} replay`);
            const replayBody = await replay.json() as { redelivered?: boolean };
            assert.equal(
              replayBody.redelivered,
              true,
              `${scenario.name} replay`,
            );
            const after = await getState(baseUrl);
            assert.equal(after.rev, before.rev, `${scenario.name} replay`);
            assert.deepEqual(
              after.board,
              before.board,
              `${scenario.name} replay`,
            );
          }
        },
      );

      await t.step(
        "opened moves a visible-ref ticket to review and stores the PR",
        async () => {
          await seedBoard(baseUrl, { doing: [card()] });
          const response = await postWebhook(baseUrl, {
            action: "opened",
            repository: { full_name: "KodaAllison/koder" },
            pull_request: {
              number: 14,
              title: "KODER-1A2B Auto-move cards from PR events",
              body: "Implements the webhook.",
              merged: false,
            },
          });

          assert.equal(response.status, 200);
          const state = await getState(baseUrl);
          assert.equal(state.board.projects.doing.length, 0);
          assert.equal(state.board.projects.review[0].id, "t_ticket_1a2b");
          assert.equal(
            state.board.projects.review[0].pr,
            "KodaAllison/koder#14",
          );
        },
      );

      await t.step(
        "reopened finds a ref in the body and moves the ticket to review",
        async () => {
          await seedBoard(baseUrl, { todo: [card()] });
          const response = await postWebhook(baseUrl, {
            action: "reopened",
            repository: { full_name: "KodaAllison/koder" },
            pull_request: {
              number: 15,
              title: "Reopen webhook work",
              body: "Ticket: KODER-1A2B",
              merged: false,
            },
          });

          assert.equal(response.status, 200);
          const state = await getState(baseUrl);
          assert.equal(state.board.projects.todo.length, 0);
          assert.equal(state.board.projects.review[0].id, "t_ticket_1a2b");
          assert.equal(
            state.board.projects.review[0].pr,
            "KodaAllison/koder#15",
          );
        },
      );

      await t.step("closed and merged moves the ticket to done", async () => {
        await seedBoard(baseUrl, { review: [card()] });
        const response = await postWebhook(baseUrl, {
          action: "closed",
          repository: { full_name: "KodaAllison/koder" },
          pull_request: {
            number: 16,
            title: "Finish KODER-1A2B",
            body: null,
            merged: true,
          },
        });

        assert.equal(response.status, 200);
        const state = await getState(baseUrl);
        assert.equal(state.board.projects.review.length, 0);
        assert.equal(state.board.projects.done[0].id, "t_ticket_1a2b");
        assert.equal(state.board.projects.done[0].pr, "KodaAllison/koder#16");
        assert.equal(state.board.projects.done[0].prRev, 1);
      });

      await t.step(
        "done is terminal for delayed or replacement open events",
        async () => {
          await seedBoard(baseUrl, {
            review: [card()],
          });
          const merged = await postWebhook(baseUrl, {
            action: "closed",
            repository: { full_name: "KodaAllison/koder" },
            pull_request: {
              number: 20,
              title: "Merge KODER-1A2B",
              body: null,
              merged: true,
            },
          });
          assert.equal(merged.status, 200);
          const afterMerged = await getState(baseUrl);

          for (const number of [20, 21]) {
            const delivery = freshDelivery();
            const delayed = await postWebhook(baseUrl, {
              action: number === 20 ? "opened" : "reopened",
              repository: { full_name: "KodaAllison/koder" },
              pull_request: {
                number,
                title: "KODER-1A2B must stay done",
                body: null,
                merged: false,
              },
            }, { delivery });
            assert.equal(delayed.status, 202);
            assert.deepEqual(
              (await getState(baseUrl)).board,
              afterMerged.board,
            );

            const replay = await postWebhook(baseUrl, {
              action: "closed",
              repository: { full_name: "KodaAllison/koder" },
              pull_request: {
                number: 21,
                title: "KODER-1A2B replay must not mutate",
                body: null,
                merged: true,
              },
            }, { delivery });
            assert.equal(
              (await replay.json() as { redelivered?: boolean }).redelivered,
              true,
            );
            assert.equal((await getState(baseUrl)).rev, afterMerged.rev);
          }
        },
      );

      await t.step(
        "only a newer same-repo PR can replace an active PR association",
        async () => {
          await seedBoard(baseUrl, { review: [card()] });
          assert.equal((await postWebhook(baseUrl, {
            action: "opened",
            repository: { full_name: "KodaAllison/koder" },
            pull_request: {
              number: 30,
              title: "Current KODER-1A2B",
              body: null,
              merged: false,
            },
          })).status, 200);
          const before = await getState(baseUrl);
          const stale = await postWebhook(baseUrl, {
            action: "opened",
            repository: { full_name: "KodaAllison/koder" },
            pull_request: {
              number: 29,
              title: "Old KODER-1A2B",
              body: null,
              merged: false,
            },
          });
          assert.equal(stale.status, 202);
          assert.equal((await getState(baseUrl)).rev, before.rev);

          const crossRepo = await postWebhook(baseUrl, {
            action: "opened",
            repository: { full_name: "KodaAllison/holitrackr" },
            pull_request: {
              number: 99,
              title: "Cross-repo KODER-1A2B",
              body: null,
              merged: false,
            },
          });
          assert.equal(crossRepo.status, 202);
          assert.equal((await getState(baseUrl)).rev, before.rev);

          const replacement = await postWebhook(baseUrl, {
            action: "opened",
            repository: { full_name: "KodaAllison/koder" },
            pull_request: {
              number: 31,
              title: "Replacement KODER-1A2B",
              body: null,
              merged: false,
            },
          });
          assert.equal(replacement.status, 200);
          const after = await getState(baseUrl);
          assert.equal(after.rev, before.rev + 1);
          assert.equal(
            after.board.projects.review[0].pr,
            "KodaAllison/koder#31",
          );
        },
      );

      await t.step(
        "closed without merge is a board-revision no-op",
        async () => {
          const before = await seedBoard(baseUrl, { review: [card()] });
          const response = await postWebhook(baseUrl, {
            action: "closed",
            repository: { full_name: "KodaAllison/koder" },
            pull_request: {
              number: 17,
              title: "Abandon KODER-1A2B",
              body: null,
              merged: false,
            },
          });

          assert.equal(response.status, 202);
          const after = await getState(baseUrl);
          assert.equal(after.rev, before.rev);
          assert.deepEqual(after.board, before.board);
        },
      );

      await t.step(
        "an ambiguous visible ref is refused without changing the board",
        async () => {
          const before = await seedBoard(baseUrl, {
            todo: [card("t_first_abcd"), card("t_second_abcd")],
          });
          const response = await postWebhook(baseUrl, {
            action: "opened",
            repository: { full_name: "KodaAllison/koder" },
            pull_request: {
              number: 18,
              title: "KODER-ABCD ambiguous ticket",
              body: null,
              merged: false,
            },
          });

          assert.equal(response.status, 409);
          const after = await getState(baseUrl);
          assert.equal(after.rev, before.rev);
          assert.deepEqual(after.board, before.board);
        },
      );

      await t.step(
        "DELETE removes one resolved ticket and records a recoverable revision",
        async () => {
          await seedBoard(baseUrl, {
            doing: [card(), card("t_keep_beef")],
          });
          const workflow = await postWebhook(baseUrl, {
            action: "opened",
            repository: { full_name: "KodaAllison/koder" },
            pull_request: {
              number: 20,
              title: "Preserve KODER-BEEF while deleting another ticket",
              body: null,
              merged: false,
            },
          });
          assert.equal(workflow.status, 200);
          const before = await getState(baseUrl);
          const response = await fetch(`${baseUrl}/tickets/KODER-1A2B`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${TOKEN}` },
          });

          assert.equal(response.status, 200);
          const result = await response.json() as {
            card: Card;
            ref: string;
            column: string;
            rev: number;
            board: Doc["board"];
          };
          assert.equal(result.card.id, "t_ticket_1a2b");
          assert.equal(result.ref, "KODER-1A2B");
          assert.equal(result.column, "doing");
          assert.equal(result.rev, before.rev + 1);

          const after = await getState(baseUrl);
          assert.equal(after.rev, result.rev);
          assert.deepEqual(result.board, after.board);
          assert.deepEqual(after.board.projects.doing, []);
          assert.equal(after.board.projects.review[0].id, "t_keep_beef");
          assert.equal(after.board.projects.review[0].pr, "KodaAllison/koder#20");
          assert.equal(after.board.projects.review[0].prRev, 1);
          assert.deepEqual(
            (await getState(baseUrl, `/state?rev=${before.rev}`)).board,
            before.board,
          );
          assert.deepEqual(
            await getState(baseUrl, `/state?rev=${result.rev}`),
            after,
          );

          const retry = await fetch(`${baseUrl}/tickets/t_ticket_1a2b`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${TOKEN}` },
          });
          assert.equal(retry.status, 404);
          assert.equal((await getState(baseUrl)).rev, result.rev);

          const restored = await fetch(`${baseUrl}/state/restore`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ rev: before.rev }),
          });
          assert.equal(restored.status, 200);
          const restoredState = await getState(baseUrl);
          assert.equal(restoredState.rev, result.rev + 1);
          assert.equal(restoredState.board.projects.doing[0].id, "t_ticket_1a2b");
          assert.equal(restoredState.board.projects.review[0].pr, "KodaAllison/koder#20");
        },
      );

      await t.step(
        "DELETE refuses missing and ambiguous refs without a revision change",
        async () => {
          const before = await seedBoard(baseUrl, {
            todo: [card("t_first_abcd"), card("t_second_abcd")],
          });
          const missing = await fetch(`${baseUrl}/tickets/KODER-DEAD`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${TOKEN}` },
          });
          const ambiguous = await fetch(`${baseUrl}/tickets/KODER-ABCD`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${TOKEN}` },
          });

          assert.equal(missing.status, 404);
          assert.equal(ambiguous.status, 409);
          assert.deepEqual(
            (await ambiguous.json() as { ids: string[] }).ids,
            ["t_first_abcd", "t_second_abcd"],
          );
          const after = await getState(baseUrl);
          assert.equal(after.rev, before.rev);
          assert.deepEqual(after.board, before.board);
        },
      );

      await t.step(
        "redelivery is idempotent and the changed revision is snapshotted",
        async () => {
          await seedBoard(baseUrl, { doing: [card()] });
          const openedDelivery = freshDelivery();
          const mergedDelivery = freshDelivery();
          const opened = {
            action: "opened",
            repository: { full_name: "KodaAllison/koder" },
            pull_request: {
              number: 19,
              title: "Deliver KODER-1A2B twice",
              body: null,
              merged: false,
            },
          };
          const first = await postWebhook(baseUrl, opened, {
            delivery: openedDelivery,
          });
          assert.equal(first.status, 200);
          const firstBody = await first.json() as {
            updated: boolean;
            rev: number;
          };
          assert.equal(firstBody.updated, true);
          const afterOpened = await getState(baseUrl);
          assert.deepEqual(
            await getState(baseUrl, `/state?rev=${firstBody.rev}`),
            afterOpened,
          );

          const merged = await postWebhook(baseUrl, {
            ...opened,
            action: "closed",
            pull_request: { ...opened.pull_request, merged: true },
          }, { delivery: mergedDelivery });
          assert.equal(merged.status, 200);
          const mergedBody = await merged.json() as {
            updated: boolean;
            rev: number;
          };
          assert.equal(mergedBody.updated, true);

          const second = await postWebhook(baseUrl, opened, {
            delivery: openedDelivery,
          });
          assert.equal(second.status, 200);
          const secondBody = await second.json() as {
            updated: boolean;
            redelivered: boolean;
            rev: number;
          };
          assert.equal(secondBody.updated, false);
          assert.equal(secondBody.redelivered, true);
          assert.equal(secondBody.rev, mergedBody.rev);

          const current = await getState(baseUrl);
          assert.equal(current.rev, mergedBody.rev);
          assert.equal(current.board.projects.done[0].id, "t_ticket_1a2b");
          assert.equal(current.board.projects.done[0].prRev, 2);
          assert.deepEqual(
            await getState(baseUrl, `/state?rev=${mergedBody.rev}`),
            current,
          );
        },
      );
    } finally {
      server.kill("SIGTERM");
      await server.status;
      await Deno.remove(kvDir, { recursive: true });
    }
  },
});
