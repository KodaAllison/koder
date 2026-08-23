# Koder

Personal Kanban PWA. Static, no build step. `index.html` + `css/styles.css` + ES modules
under `js/` (`app.js` entry → `store.js` pure logic, `state.js` persistence, `sync.js`
server sync, `board.js`/`sidebar.js`/`modal.js` UI, `pwa.js` SW glue, `render.js` repaint
seam), data from `js/projects.json`. Service worker in `sw.js` — adding a JS module means
adding it to `SHELL_ASSETS`. Don't touch `CACHE_NAME`: it's stamped from a content
hash by `node scripts/stamp-sw.mjs`, run on `main` before deploy and never on a
feature branch (see "Deploying" in README.md).

Tests: `node --test` from the repo root (covers the pure logic in `js/store.js` — keep store.js free
of DOM/localStorage so this stays true). Server changes also run `deno task check` and `deno task test`
from `server/`. JS uses `// @ts-check` + JSDoc types.

## koder-ticket skill

The koder-ticket skill is mastered here (`.claude/skills/koder-ticket/SKILL.md`;
the CLI's source of truth is `scripts/koder-ticket.sh`) and synced to
`~/.claude/skills/` and the sibling repos so cloud/mobile sessions can use the
board. After editing either file, run `scripts/sync-skill.sh` and commit the
changed copies in each repo. Never edit a synced copy in place.

## Working preferences

- **Don't spin up headless browsers / screenshot tooling to validate my work.** No
  headless Chrome, Puppeteer, Playwright, or CDP scripting to "verify" UI changes — Koda
  checks the result manually in a real browser. Make the change, sanity-check the code, and
  hand it back. (Syntax checks like `node --check` are fine.)
- Serve locally with `npx serve` when a local server is genuinely needed — not
  `python http.server`.
