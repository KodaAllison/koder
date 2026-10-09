/* The PWA's static files, served from the repo root so one process is both
 * the API and the board a phone loads over HTTPS (same origin, no CORS).
 *
 * server/main.ts hands every non-API GET to Deno's serveDir over the whole
 * repo root. This keeps serveDir's observable behaviour for the files the PWA
 * actually loads (index for "/", 301s that normalise the path or add/strip a
 * trailing slash, dotfiles hidden, a weak ETag and Last-Modified with 304s,
 * a plain-text 404) but serves ONLY the PWA: index.html, sw.js,
 * manifest.webmanifest and the css/, js/ and icons/ trees. The server code,
 * docs, scripts, tests and .git are public on GitHub anyway, but there is no
 * reason for the board's origin to hand them out.
 *
 * Traversal: the path is percent-decoded and normalised before the allowlist
 * sees it, so ".." can't climb out of an allowed directory; a backslash or NUL
 * (a separator, or a terminator, to Windows path APIs but not to the URL) is
 * refused outright; and the resolved file must still sit under ROOT. */

import { readFile, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { extname, join, posix, relative, isAbsolute } from "node:path";

const PWA_FILES = new Set(["/index.html", "/manifest.webmanifest", "/sw.js"]);
const PWA_DIRS = ["/css", "/js", "/icons"];

// The types serveDir (via @std/media-types) gives the files the PWA ships.
// An extension not listed gets no Content-Type, as serveDir does.
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=UTF-8",
  ".js": "text/javascript; charset=UTF-8",
  ".mjs": "text/javascript; charset=UTF-8",
  ".css": "text/css; charset=UTF-8",
  ".json": "application/json; charset=UTF-8",
  ".webmanifest": "application/manifest+json; charset=UTF-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/vnd.microsoft.icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=UTF-8",
};

function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}

// A relative Location: valid per RFC 9110, and right whatever scheme or host
// a proxy in front of us was reached on.
function redirect(url: URL, pathname: string): Response {
  const target = new URL(url.href);
  target.pathname = pathname;
  return new Response(null, { status: 301, headers: { Location: target.pathname + target.search } });
}

function allowed(path: string): boolean {
  if (path === "" || PWA_FILES.has(path)) return true;
  return PWA_DIRS.some((dir) => path === dir || path.startsWith(dir + "/"));
}

// Any path the filesystem can't stat is simply not there: ENOENT, but also
// the EINVAL/ENAMETOOLONG a Windows path API gives for a name like "a:b".
async function statOrNull(fsPath: string): Promise<Stats | null> {
  try {
    return await stat(fsPath);
  } catch {
    return null;
  }
}

async function serveFile(req: Request, fsPath: string, info: Stats): Promise<Response> {
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const headers: Record<string, string> = {
    ETag: etag,
    "Last-Modified": info.mtime.toUTCString(),
  };
  const type = CONTENT_TYPES[extname(fsPath).toLowerCase()];
  if (type) headers["Content-Type"] = type;

  const inm = req.headers.get("If-None-Match");
  const ims = req.headers.get("If-Modified-Since");
  const etagMatches = inm !== null &&
    inm.split(",").some((t) => {
      t = t.trim();
      return t === "*" || t.replace(/^W\//, "") === etag.replace(/^W\//, "");
    });
  const notModifiedSince = inm === null && ims !== null &&
    info.mtimeMs < new Date(ims).getTime() + 1000;
  if (etagMatches || notModifiedSince) return new Response(null, { status: 304, headers });

  const body = await readFile(fsPath);
  headers["Content-Length"] = String(body.byteLength);
  return new Response(body, { status: 200, headers });
}

/* `root` is the repo root (absolute). Only GETs reach here. */
export async function serveStatic(req: Request, root: string): Promise<Response> {
  const url = new URL(req.url);
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return notFound();
  }
  if (decoded.includes("\\") || decoded.includes("\0")) return notFound();

  const normalized = posix.normalize(decoded);
  // Like serveDir: "/a//b" or "/a/../b" redirects to the canonical path.
  if (normalized !== decoded) return redirect(url, normalized);

  const path = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  // Dotfiles and dot-directories are never served (serveDir's default).
  if (/\/\./.test(path)) return notFound();
  if (!allowed(path)) return notFound();

  const fsPath = join(root, ...path.split("/").filter(Boolean));
  const rel = relative(root, fsPath);
  if (rel.startsWith("..") || isAbsolute(rel)) return notFound();

  const info = await statOrNull(fsPath);
  if (!info) return notFound();
  if (info.isFile() && url.pathname.endsWith("/")) {
    return redirect(url, url.pathname.slice(0, -1));
  }
  if (info.isDirectory() && !url.pathname.endsWith("/")) {
    return redirect(url, url.pathname + "/");
  }
  if (info.isFile()) return await serveFile(req, fsPath, info);
  if (info.isDirectory()) {
    const indexPath = join(fsPath, "index.html");
    const index = await statOrNull(indexPath);
    if (index?.isFile()) return await serveFile(req, indexPath, index);
  }
  return notFound();
}
