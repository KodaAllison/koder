# Koder Kanban — a PWA learning project

A personal kanban board (Projects / Life tabs) built as a Progressive Web App with zero dependencies and no build step. Every PWA mechanism is hand-written and commented so you can see exactly how it works.

## Run it

Service workers require **https or localhost** (they won't work over `file://`), so serve the folder with any static server:

```bash
# pick one:
npx serve .
python3 -m http.server 8000
```

Then open http://localhost:8000 (or whatever port it prints).

## The three PWA pieces (and where to read them)

1. **Web App Manifest** — `manifest.webmanifest`, linked from `index.html`. Declares the app name, icons, colors, and `display: standalone` so it opens without browser chrome when installed.
2. **Service Worker** — `sw.js`. A background proxy that pre-caches the app shell on install and serves it cache-first, so the app loads offline. Read the lifecycle comments: install → activate → fetch.
3. **Registration + install UX** — top of `js/app.js`. Registers the SW, handles the version-update "Reload" toast, and wires the custom Install button via `beforeinstallprompt`.

## Things to try

- **Install it**: in Chrome/Edge you'll see an "Install app" button in the header (or the install icon in the address bar). Installed, it runs in its own window.
- **Go offline**: DevTools → Network → "Offline", then reload. The app still works — shell from the SW cache, tickets from localStorage.
- **Ship an update**: change something visible, bump `CACHE_NAME` in `sw.js` to `kanban-shell-v2`, reload twice — you'll get the "New version available" toast.
- **Audit it**: DevTools → Lighthouse → PWA category. Also explore DevTools → Application tab: Manifest, Service Workers, Cache Storage.

## Sync server + agent CLI (optional)

The board can sync to a free Deno Deploy server (`server/`) that becomes the
source of truth: localStorage stays as the offline cache, every change is
pushed up, and the app pulls on focus + every 30s. This also lets agents add
tickets from a terminal:

```bash
./scripts/koder-ticket.sh "Fix login bug" --project holitrackr --priority high --column todo
```

Setup: deploy `server/main.ts` to Deno Deploy, then copy `js/config.example.js`
to `js/config.local.js` (gitignored) with the URL + token. No config file →
the app runs in pure-localStorage mode exactly as before. Full deploy steps,
API docs, and the raw `curl` equivalent live in `server/README.md`.

## Stretch goals (roughly in order of learning value)

- Migrate ticket storage from localStorage to **IndexedDB** (async, larger quota, accessible from the service worker)
- **stale-while-revalidate** caching strategy instead of cache-first
- **Background Sync** — queue changes offline, sync when back online (needs a backend)
- **Push notifications** for ticket due dates (needs a backend + Notification permission)
- **Share Target** — let other apps "share to" your board to create tickets
