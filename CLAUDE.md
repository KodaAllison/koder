# Koder

Personal Kanban PWA. Static, no build step: `index.html` + `css/styles.css` + `js/app.js`,
data from `js/projects.json`. Service worker in `sw.js`.

## Working preferences

- **Don't spin up headless browsers / screenshot tooling to validate my work.** No
  headless Chrome, Puppeteer, Playwright, or CDP scripting to "verify" UI changes — Koda
  checks the result manually in a real browser. Make the change, sanity-check the code, and
  hand it back. (Syntax checks like `node --check` are fine.)
- Serve locally with `npx serve` when a local server is genuinely needed — not
  `python http.server`.
