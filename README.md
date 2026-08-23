# Koder — a personal kanban PWA with an agent-friendly backend

A kanban board (Projects / Life tabs) built as a Progressive Web App with **zero
dependencies and no build step** — every PWA and sync mechanism is hand-written
and commented so you can read exactly how it works. The board syncs to a tiny
free server, and AI agents can file tickets onto it from any terminal.

```
you (browser)  ──sync──▶  Deno Deploy API + KV  ◀──POST /tickets──  agents / CLI
     ▲                        (source of truth)
localStorage cache
(instant paint, offline)
```

## Quick start

Service workers require **https or localhost** (not `file://`), so serve the
folder with any static server:

```bash
npx serve .
```

Open the printed URL (usually http://localhost:3000). That's it — with no sync
config the app runs purely on localStorage.

To enable sync, copy `js/config.example.js` to `js/config.local.js`
(gitignored) and fill in your server URL + token — see
[server/README.md](server/README.md) for deploying the server in ~5 minutes.

## Repo tour

| Path | What it is |
|---|---|
| `index.html` | The app shell — one page, no templates |
| `js/app.js` | Entry point — wires the modules below together |
| `js/store.js` | Pure board logic (columns, migrations, merge) — node-testable |
| `js/state.js` | App state + localStorage persistence |
| `js/sync.js` | Server sync: debounced push, focus/interval pull, 409 merge |
| `js/board.js` | Kanban rendering + drag & drop |
| `js/sidebar.js` | Life dashboard sidebar (focus / dates / stickies) |
| `js/modal.js` | Ticket create/edit modal |
| `js/pwa.js` | SW registration, update toast, install button, offline badge |
| `js/render.js` | Repaint indirection (keeps the module graph acyclic) |
| `css/styles.css` | All styling |
| `tests/` | `node --test` (from the repo root) — covers `js/store.js` + the SW guards |
| `sw.js` | Service worker — offline caching + update flow |
| `manifest.webmanifest` | Makes the app installable |
| `js/projects.json` | Generated folder list; optional `repo`/`url` fields are hand-set |
| `js/config.example.js` | Template for `config.local.js` — copy and fill in |
| `js/config.local.js` | Your sync server URL + token (gitignored) |
| `server/main.ts` | The whole backend: 3 endpoints, Deno KV |
| `scripts/gen-projects.sh` | Regenerates `projects.json` from folders in `Code/` |
| `scripts/stamp-sw.mjs` | Stamps `sw.js`'s `CACHE_NAME` from a hash of the shell |
| `scripts/koder-ticket.sh` | CLI: add a ticket from any terminal |
| `skills/koder-ticket/` | Claude Code skill so agents can use the CLI |

## How it works

**One state object, one render function.** `state` holds the whole board;
`render()` rebuilds the DOM from it. Every interaction is
`mutate state → save() → render()`. Each folder under `Code/` *is* a project
(run `./scripts/gen-projects.sh` after adding/removing one).

**Project links are the editable exception in `projects.json`.** Add or update
optional `repo` and `url` fields on an existing project entry by hand. The
generator rebuilds folder-derived fields, preserves those two fields for
projects that still exist, and drops entries for removed folders.

**Offline-first, server-canonical.** `save()` writes localStorage synchronously
(instant, works offline) and schedules a debounced push to the server, which
holds the canonical copy as one `{ rev, board }` document in Deno KV. The app
pulls on tab focus and every 30s.

**Conflicts: optimistic concurrency.** Every push states the revision it was
based on (`baseRev`); the server rejects stale writes with a 409. The client
then merges — local edits win card-by-card, but server cards it has never seen
(agent-added tickets) are kept — and retries. A persisted dirty flag plus a
`pagehide` beacon means edits made right before closing the tab aren't lost.

**Agents add tickets without knowing the board.** `POST /tickets` does the
read-modify-write server-side and assigns the id, so a one-line shell command
is enough:

```bash
./scripts/koder-ticket.sh "Fix login bug" --project holitrackr --column todo --priority high
```

Install the skill so Claude Code sessions in *any* repo can do this when you
say "add a ticket to my board":

```bash
mkdir -p ~/.claude/skills && cp -r skills/koder-ticket ~/.claude/skills/
```

## The PWA pieces (and where to read them)

1. **Web App Manifest** — `manifest.webmanifest`. App name, icons,
   `display: standalone` so it opens without browser chrome when installed.
2. **Service Worker** — `sw.js`. Pre-caches the app shell on install, serves it
   cache-first (offline boot); `projects.json` and `config.local.js` are
   network-first because they change out-of-band; `/state`, `/tickets`, and
   `/revisions` are never cached at all — same-origin API calls always hit the
   network so a ticket added elsewhere shows up without a hard reload. Read
   the lifecycle comments: install → activate → fetch.
3. **Registration + install UX** — `js/pwa.js`. Version-update "Reload"
   toast, custom Install button via `beforeinstallprompt`. The SW is disabled
   on localhost so development never fights stale caches.

## Things to try

- **Install it**: Chrome/Edge show an "Install app" button in the header.
- **Go offline**: DevTools → Network → "Offline", reload — shell from the SW
  cache, tickets from localStorage.
- **Ship an update**: change something visible, run `node scripts/stamp-sw.mjs`,
  reload twice — you'll get the update toast.
- **Race yourself**: add a ticket via the CLI while dragging cards in the tab —
  watch the 409/merge path reconcile both (Network tab shows it).

## Deploying

Before pushing the frontend, on `main`:

```bash
node scripts/stamp-sw.mjs      # rewrites sw.js's CACHE_NAME from the shell's content hash
node scripts/stamp-sw.mjs --check   # exits 1 if you forgot
```

`CACHE_NAME` keys the service worker's cache, so a stale one means phones keep
serving the old shell after a deploy. It used to be a hand-bumped `-vN` that was
easy to forget; now it's a hash of the actual `SHELL_ASSETS` bytes, so it changes
exactly when the cached files do. Same idiom as `gen-projects.sh` — a regen
script you run, not a build step.

**Don't stamp on a feature branch.** `SHELL_ASSETS` covers `index.html`,
`styles.css` and every `js/` module, so any UI branch changes the hash — if each
branch stamped, they'd all conflict on that one line and the fix would be to
re-run the script anyway. Stamp once on `main` after merging. For the same
reason `node --test` doesn't assert freshness; `--check` above is the guard.

## Development notes

- Local server for the API: `cd server && KODER_TOKEN=dev deno task dev`, then
  point `js/config.local.js` at `http://localhost:8000`.
- The sync token ships to the browser (static site — nothing client-side is
  secret). Treat it as low-stakes: unguessable, rotatable, CORS-lockable via
  `KODER_ORIGIN`. See the security note in `server/README.md`.
- Commit checklist: `js/config.local.js` and `scripts/.koder.env` must never
  appear in `git status` (they're gitignored).

## Stretch goals (roughly in order of learning value)

- Migrate ticket storage from localStorage to **IndexedDB** (async, larger
  quota, accessible from the service worker)
- **Background Sync** — queue pushes in the SW so they survive tab closes
  better than the `pagehide` beacon
- **Push notifications** for ticket due dates (server exists now — needs
  Notification permission + a trigger)
- **Share Target** — let other apps "share to" the board to create tickets
- Real per-user auth, if the board ever goes multi-user
