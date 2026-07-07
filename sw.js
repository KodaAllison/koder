/* ============ PWA piece #2: the Service Worker ============
 *
 * A service worker is a script the browser runs in the BACKGROUND,
 * separate from your page. It sits between your app and the network
 * like a programmable proxy: every fetch your page makes can be
 * intercepted here. That's what makes offline support possible.
 *
 * Key mental model — the SW lifecycle:
 *   1. install  → runs once per new SW version. Pre-cache the app shell here.
 *   2. activate → old version is gone; clean up outdated caches here.
 *   3. fetch    → fires for EVERY network request; decide cache vs network.
 *
 * Bump this version string whenever you change any cached file
 * A byte-different sw.js is what triggers the browser to install
 * the new version (the "update flow" you'll see in app.js).
 */
const CACHE_NAME = 'kanban-shell-v13';

/* The "app shell": the minimal static files needed to render the UI.
 * We cache these at install time so the app boots with zero network.
 * NB: app.js is an ES module — every module it imports must be listed here
 * too, or the app won't boot offline. */
const SHELL_ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/pwa.js',
  './js/store.js',
  './js/state.js',
  './js/sync.js',
  './js/render.js',
  './js/board.js',
  './js/sidebar.js',
  './js/modal.js',
  './js/projects.json',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

/* ---- 1. INSTALL: pre-cache the shell ----
 * event.waitUntil() tells the browser "I'm not done until this promise
 * resolves". If any file fails to cache, the whole install fails and
 * the old SW stays active — an all-or-nothing atomic update. */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  /* By default a new SW waits until every open tab of the app closes
   * before taking over ("waiting" state). We don't auto-skipWaiting here;
   * instead app.js shows a "Reload" toast and messages us (see below).
   * That way the user is never running half old / half new code. */
});

/* ---- 2. ACTIVATE: delete caches from older versions ----
 * When kanban-shell-v2 activates, this removes kanban-shell-v1. */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim()) // control open pages immediately
  );
});

/* ---- 3. FETCH: answer requests from cache ----
 * Strategy used here: CACHE-FIRST (great for a static app shell)
 *   → look in cache; if found, return it instantly (works offline)
 *   → otherwise hit the network and cache a copy for next time
 *
 * Other classic strategies worth knowing:
 *   network-first    → try network, fall back to cache (good for API data)
 *   stale-while-revalidate → serve cache instantly, refresh it in the
 *                      background (good balance for content that updates)
 */
self.addEventListener('fetch', (event) => {
  // Only handle GETs from our own origin; let everything else pass through.
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  /* projects.json is regenerated out-of-band (gen-projects.sh) and
   * config.local.js can change (new sync URL/token) without a shell deploy,
   * so serve both NETWORK-FIRST: fresh when online, cache fallback offline.
   * (The rest of the shell stays cache-first below. Note the cross-origin
   * sync API itself never reaches this handler — non-same-origin requests
   * bail out above, so API calls are never cached.) */
  if (url.pathname.endsWith('/projects.json') || url.pathname.endsWith('/config.local.js')) {
    event.respondWith(
      fetch(event.request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Cache successful responses for next time (runtime caching).
        if (response.ok) {
          const copy = response.clone(); // a response body can be read once
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      }).catch(() => {
        // Offline and not in cache: for page navigations, serve the shell.
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});

/* ---- Update flow: page → SW messaging ----
 * app.js sends {type:'SKIP_WAITING'} when the user clicks "Reload".
 * skipWaiting() promotes this waiting SW to active immediately. */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
