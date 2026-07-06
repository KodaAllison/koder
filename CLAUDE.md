# Koder

Personal Kanban PWA. Static, no build step. `index.html` + `css/styles.css` + ES modules
under `js/` (`app.js` entry → `store.js` pure logic, `state.js` persistence, `sync.js`
server sync, `board.js`/`sidebar.js`/`modal.js` UI, `pwa.js` SW glue, `render.js` repaint
seam), data from `js/projects.json`. Service worker in `sw.js` — adding a JS module means
adding it to `SHELL_ASSETS` and bumping `CACHE_NAME`.

Tests: `node --test` from the repo root (covers the pure logic in `js/store.js` — keep store.js free
of DOM/localStorage so this stays true). JS uses `// @ts-check` + JSDoc types.

## Working preferences

- **Don't spin up headless browsers / screenshot tooling to validate my work.** No
  headless Chrome, Puppeteer, Playwright, or CDP scripting to "verify" UI changes — Koda
  checks the result manually in a real browser. Make the change, sanity-check the code, and
  hand it back. (Syntax checks like `node --check` are fine.)
- Serve locally with `npx serve` when a local server is genuinely needed — not
  `python http.server`.
