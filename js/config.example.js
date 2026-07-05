/* Sync-server config. Copy this file to js/config.local.js (gitignored) and
 * fill in your Deno Deploy URL + token (see server/README.md). Without a
 * config.local.js the app runs in pure-localStorage mode — no server calls.
 *
 * NOTE: anything in config.local.js ships to the browser, so this token is
 * only as secret as the origin serving it. Fine for a personal board;
 * rotate it (Deno Deploy env settings) if it ever leaks. */
window.KODER_API = {
  base: 'https://your-app.deno.dev',
  token: 'change-me',
};
