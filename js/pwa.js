// @ts-check
/* PWA glue: service worker registration, update flow, install prompt, and
 * online/offline detection. This is the page-side half of the service worker
 * story (sw.js is the other half). Side-effect module — imports nothing from
 * the app and exports nothing. */

/* ==================== Service worker registration ====================
 * Registration is async and safe to call on every load — the browser no-ops
 * if the same SW is already registered.
 *
 * NOTE: service workers require a "secure context": https:// or localhost.
 * If you open index.html via file://, registration will fail.
 *
 * DEV: the SW is cache-first, which serves stale CSS/JS while you're editing.
 * So we skip it entirely on localhost/127.0.0.1 (and tear down any SW left over
 * from earlier testing) — local reloads are then plain, uncached, and instant.
 * The PWA/offline behaviour still runs on the real deployed origin. */
const IS_LOCAL = ['localhost', '127.0.0.1', '[::1]', ''].includes(location.hostname);
if ('serviceWorker' in navigator && IS_LOCAL) {
  navigator.serviceWorker.getRegistrations().then((regs) => {
    regs.forEach((r) => r.unregister());
    if (regs.length) caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
  });
} else if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      console.log('[PWA] service worker registered, scope:', reg.scope);

      /* ---- Update flow ----
       * When you deploy a changed sw.js, the browser installs it in the
       * background but keeps the OLD one active until all tabs close.
       * We detect the new one sitting in "waiting" and offer a reload. */
      /** @param {ServiceWorker} waitingSW */
      function promptForUpdate(waitingSW) {
        const toast = /** @type {HTMLElement} */ (document.getElementById('updateToast'));
        toast.hidden = false;
        /** @type {HTMLElement} */ (document.getElementById('reloadBtn')).onclick = () => {
          // Tell the waiting SW to take over (it calls skipWaiting()).
          waitingSW.postMessage({ type: 'SKIP_WAITING' });
        };
      }

      if (reg.waiting) promptForUpdate(reg.waiting); // update already waiting
      reg.addEventListener('updatefound', () => {
        const newSW = reg.installing;
        if (!newSW) return;
        newSW.addEventListener('statechange', () => {
          // "installed" + an existing controller = an update, not first install
          if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
            promptForUpdate(newSW);
          }
        });
      });

      // When the new SW activates, reload so the page runs the new assets.
      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing) return;
        refreshing = true;
        location.reload();
      });
    } catch (err) {
      console.warn('[PWA] service worker registration failed:', err);
    }
  });
}

/* ==================== Custom install button ====================
 * Chromium browsers fire `beforeinstallprompt` when the app meets
 * installability criteria (manifest + SW + https). We stash the event
 * and trigger it from our own button for a nicer UX.
 * (Safari/Firefox don't fire this — users install via browser menus.) */
/** @type {any} */
let deferredInstallPrompt = null;
const installBtn = /** @type {HTMLButtonElement} */ (document.getElementById('installBtn'));

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // stop the mini-infobar; we'll prompt on our terms
  deferredInstallPrompt = e;
  installBtn.hidden = false;
});

installBtn.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  const { outcome } = await deferredInstallPrompt.userChoice;
  console.log('[PWA] install prompt outcome:', outcome);
  deferredInstallPrompt = null;
  installBtn.hidden = true;
});

window.addEventListener('appinstalled', () => {
  console.log('[PWA] app installed 🎉');
  installBtn.hidden = true;
});

/* ==================== Online/offline indicator ====================
 * The app works offline (shell from SW cache, data from localStorage);
 * this badge just makes that state visible. */
const offlineBadge = /** @type {HTMLElement} */ (document.getElementById('offlineBadge'));
function updateOnlineStatus() { offlineBadge.hidden = navigator.onLine; }
window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
updateOnlineStatus();
