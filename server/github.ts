export const GITHUB_REPOS = new Set([
  "KodaAllison/koder",
  "KodaAllison/crook-community",
  "KodaAllison/holitrackr",
  "KodaAllison/portfolio-website",
]);

export type PullRef = { repo: string; number: number; key: string };
export type PullStatus = {
  state: "open" | "closed" | "merged";
  ci: "passing" | "failing" | "pending" | "unknown";
  mergeable: "mergeable" | "conflicting" | "unknown";
};

export function parsePullRef(value: unknown): PullRef | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$/);
  if (!match || !GITHUB_REPOS.has(match[1])) return null;
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number)) return null;
  return { repo: match[1], number, key: `${match[1]}#${number}` };
}

type Fetch = typeof fetch;
type CacheEntry = { value: PullStatus; fetchedAt: number };
type Options = {
  fetch?: Fetch;
  now?: () => number;
  maxEntries?: number;
  freshMs?: number;
  staleMs?: number;
  concurrency?: number;
  timeoutMs?: number;
  apiBase?: string;
};

function ciState(checks: unknown, combined: unknown): PullStatus["ci"] {
  const runs = Array.isArray((checks as { check_runs?: unknown[] })?.check_runs)
    ? (checks as { check_runs: Array<{ status?: unknown; conclusion?: unknown }> }).check_runs
    : [];
  const statuses = Array.isArray((combined as { statuses?: unknown[] })?.statuses)
    ? (combined as { statuses: Array<{ state?: unknown }> }).statuses
    : [];
  const failing = runs.some((r) => r.status === "completed" &&
    ["failure", "cancelled", "timed_out", "action_required", "startup_failure"].includes(String(r.conclusion))) ||
    statuses.some((s) => ["failure", "error"].includes(String(s.state)));
  if (failing) return "failing";
  const pending = runs.some((r) => r.status !== "completed") || statuses.some((s) => s.state === "pending");
  if (pending) return "pending";
  const passing = runs.some((r) => r.status === "completed" && ["success", "neutral", "skipped"].includes(String(r.conclusion))) ||
    statuses.some((s) => s.state === "success");
  return passing ? "passing" : "unknown";
}

export function createGithubResolver(token: string, options: Options = {}) {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const max = options.maxEntries ?? 100;
  const freshMs = options.freshMs ?? 60_000;
  const staleMs = options.staleMs ?? 300_000;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/$/, "");
  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<PullStatus | null>>();
  let active = 0;
  const waiting: Array<() => void> = [];

  async function slot() {
    if (active < (options.concurrency ?? 4)) { active++; return; }
    await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
  }
  function release() { active--; waiting.shift()?.(); }
  function remember(key: string, value: PullStatus) {
    cache.delete(key);
    cache.set(key, { value, fetchedAt: now() });
    while (cache.size > max) cache.delete(cache.keys().next().value!);
  }
  async function github(path: string) {
    await slot();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetcher(`${apiBase}${path}`, {
          signal: controller.signal,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "koder-pr-status",
          },
        });
        if (response.ok) return await response.json();
        const retry = response.headers.get("Retry-After");
        const reset = response.headers.get("X-RateLimit-Reset");
        const wait = retry ? Number(retry) * 1000 : reset ? Number(reset) * 1000 - now() : 0;
        if (attempt === 0 && (response.status === 403 || response.status === 429) && wait > 0 && wait <= 2_000) {
          await new Promise((resolve) => setTimeout(resolve, wait));
          continue;
        }
        throw new Error(`GitHub request failed (${response.status})`);
      }
      throw new Error("GitHub request failed");
    } finally { clearTimeout(timer); release(); }
  }
  async function load(ref: PullRef): Promise<PullStatus> {
    const pull = await github(`/repos/${ref.repo}/pulls/${ref.number}`) as Record<string, unknown>;
    const state: PullStatus["state"] = pull.merged === true ? "merged" : pull.state === "closed" ? "closed" : "open";
    const mergeable: PullStatus["mergeable"] = pull.mergeable === true ? "mergeable" : pull.mergeable === false ? "conflicting" : "unknown";
    const sha = (pull.head as { sha?: unknown } | null)?.sha;
    if (typeof sha !== "string" || !/^[0-9a-f]{40}$/i.test(sha)) return { state, ci: "unknown", mergeable };
    const [checks, combined] = await Promise.allSettled([
      github(`/repos/${ref.repo}/commits/${sha}/check-runs?per_page=100`),
      github(`/repos/${ref.repo}/commits/${sha}/status`),
    ]);
    return {
      state,
      mergeable,
      ci: ciState(checks.status === "fulfilled" ? checks.value : null, combined.status === "fulfilled" ? combined.value : null),
    };
  }
  async function resolveOne(ref: PullRef): Promise<PullStatus | null> {
    const hit = cache.get(ref.key);
    if (hit && now() - hit.fetchedAt < freshMs) { cache.delete(ref.key); cache.set(ref.key, hit); return hit.value; }
    const running = inflight.get(ref.key);
    if (running) return running;
    const promise = load(ref).then((value) => (remember(ref.key, value), value)).catch(() => {
      if (hit && now() - hit.fetchedAt < staleMs) return hit.value;
      return null;
    }).finally(() => inflight.delete(ref.key));
    inflight.set(ref.key, promise);
    return promise;
  }
  return {
    async resolve(values: unknown[]): Promise<Record<string, PullStatus>> {
      const refs = new Map<string, PullRef>();
      for (const value of values) { const ref = parsePullRef(value); if (ref) refs.set(ref.key, ref); }
      const entries = await Promise.all([...refs.values()].map(async (ref) => [ref.key, await resolveOne(ref)] as const));
      return Object.fromEntries(entries.filter((entry): entry is readonly [string, PullStatus] => entry[1] !== null));
    },
  };
}
