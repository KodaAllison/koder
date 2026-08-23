import assert from "node:assert/strict";

const TOKEN = "webhook-test-token";
const SECRET = "webhook-test-secret";

type Card = {
  id: string;
  title: string;
  note: string;
  priority: string;
  created: number;
  project: string | null;
  pr?: string;
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
  const current = await getState(baseUrl);
  const response = await fetch(`${baseUrl}/state`, {
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

async function postWebhook(
  baseUrl: string,
  payload: unknown,
  options: {
    signature?: "valid" | "invalid" | "missing";
    event?: string;
    bearer?: boolean;
    delivery?: string;
  } = {},
): Promise<Response> {
  const body = JSON.stringify(payload);
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-GitHub-Event": options.event ?? "pull_request",
  });
  if (options.delivery) headers.set("X-GitHub-Delivery", options.delivery);
  if (options.signature !== "missing") {
    headers.set(
      "X-Hub-Signature-256",
      options.signature === "invalid"
        ? `sha256=${"0".repeat(64)}`
        : await signature(body),
    );
  }
  if (options.bearer) headers.set("Authorization", `Bearer ${TOKEN}`);
  return await fetch(`${baseUrl}/webhooks/github`, {
    method: "POST",
    headers,
    body,
  });
}

function card(id = "t_ticket_1a2b", project = "koder"): Card {
  return {
    id,
    title: "Webhook ticket",
    note: "",
    priority: "med",
    created: 1,
    project,
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
          await seedBoard(baseUrl, { done: [card()] });
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
          assert.equal(state.board.projects.done.length, 0);
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
      });

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
        "redelivery is idempotent and the changed revision is snapshotted",
        async () => {
          await seedBoard(baseUrl, { doing: [card()] });
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
            delivery: "delivery-opened-19",
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
          }, { delivery: "delivery-merged-19" });
          assert.equal(merged.status, 200);
          const mergedBody = await merged.json() as {
            updated: boolean;
            rev: number;
          };
          assert.equal(mergedBody.updated, true);

          const second = await postWebhook(baseUrl, opened, {
            delivery: "delivery-opened-19",
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
