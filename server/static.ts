/* Koder static host — Deno Deploy.
 *
 * Serves the PWA's static files (the repo root: index.html, css/, js/, icons/,
 * sw.js, manifest) so the board is reachable over HTTPS — which a phone needs
 * for install + offline. The sync server (main.ts) is the API; this app is
 * just the frontend.
 *
 * The one dynamic bit is js/config.local.js. That file carries the sync token
 * and is gitignored, so instead of committing it we generate it here from env
 * vars. Point KODER_API_BASE/KODER_API_TOKEN at the sync server and the hosted
 * board syncs exactly as the local one does.
 *
 * Deploy: a SECOND Deno Deploy app, run as a *dynamic* app (not the static-site
 * preset), entrypoint server/static.ts.
 *   Env: KODER_API_BASE  = https://<sync-app>.<org>.deno.net   (the API origin)
 *        KODER_API_TOKEN = <same value as the sync server's KODER_TOKEN>
 * Then set KODER_ORIGIN on the sync app to THIS app's URL to lock its CORS.
 *
 * Local dev:  deno task static   (see deno.json) → http://localhost:8001
 */

import { serveDir } from "jsr:@std/http/file-server";
import { fromFileUrl } from "jsr:@std/path";

// This file lives in server/, so the repo root — where index.html sits — is one
// level up. Deriving it from the module URL keeps it correct regardless of cwd.
const ROOT = fromFileUrl(new URL("../", import.meta.url));

const API_BASE = Deno.env.get("KODER_API_BASE") ?? "";
const API_TOKEN = Deno.env.get("KODER_API_TOKEN") ?? "";

/* The generated stand-in for the gitignored js/config.local.js. With the env
 * unset it emits `null`, so the board falls back to pure-localStorage mode
 * (sync.js: apiEnabled() → false) instead of erroring. */
function configJs(): string {
  const cfg = API_BASE && API_TOKEN ? { base: API_BASE, token: API_TOKEN } : null;
  return `window.KODER_API = ${JSON.stringify(cfg)};\n`;
}

// Deno Deploy manages the listen port; locally, PORT lets `deno task static`
// run alongside the sync server (main.ts on 8000) without colliding.
const port = Number(Deno.env.get("PORT")) || undefined;

Deno.serve({ port }, (req: Request) => {
  const url = new URL(req.url);

  // Intercept the config script; everything else is a plain static file.
  if (url.pathname === "/js/config.local.js") {
    return new Response(configJs(), {
      headers: {
        "Content-Type": "text/javascript; charset=utf-8",
        // Token/URL can change without a redeploy of the shell — never cache it.
        "Cache-Control": "no-store",
      },
    });
  }

  return serveDir(req, { fsRoot: ROOT, quiet: true });
});
