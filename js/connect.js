// @ts-check
/* Connect-sync UI: the header button + #syncOverlay that let a fresh device
 * link itself by pasting the API token once. sync.js persists the token and
 * resolves window.KODER_API from it on the next boot; this module is just the
 * page-side glue that collects and validates the token. Side-effect module —
 * exports nothing, mirrors pwa.js. When sync is already configured (a dev
 * machine with config.local.js, or a device that's already connected) the
 * button stays hidden and none of this is reachable. */

import { connectSync, apiEnabled } from './sync.js';

const connectBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('connectBtn'));
const syncOverlay = /** @type {HTMLElement|null} */ (document.getElementById('syncOverlay'));
const fSyncToken = /** @type {HTMLInputElement|null} */ (document.getElementById('fSyncToken'));
const syncError = /** @type {HTMLElement|null} */ (document.getElementById('syncError'));
const btnSyncCancel = /** @type {HTMLButtonElement|null} */ (document.getElementById('btnSyncCancel'));
const btnSyncConnect = /** @type {HTMLButtonElement|null} */ (document.getElementById('btnSyncConnect'));

/* Only offer the flow when there's no token yet. */
if (connectBtn && !apiEnabled()) connectBtn.hidden = false;

function openSync() {
  if (!syncOverlay) return;
  syncOverlay.classList.add('open');
  if (syncError) syncError.hidden = true;
  if (fSyncToken) { fSyncToken.value = ''; fSyncToken.focus(); }
}

function closeSync() {
  if (syncOverlay) syncOverlay.classList.remove('open');
}

async function connect() {
  if (!fSyncToken || !btnSyncConnect) return;
  const token = fSyncToken.value.trim();
  if (!token) { fSyncToken.focus(); return; }
  btnSyncConnect.disabled = true;
  const ok = await connectSync(token);
  if (ok) {
    // Boot through the normal sync path with the token now persisted.
    location.reload();
    return;
  }
  if (syncError) syncError.hidden = false;
  btnSyncConnect.disabled = false;
  fSyncToken.focus();
}

if (connectBtn) connectBtn.addEventListener('click', openSync);
if (btnSyncCancel) btnSyncCancel.addEventListener('click', closeSync);
if (btnSyncConnect) btnSyncConnect.addEventListener('click', connect);
if (syncOverlay) {
  syncOverlay.addEventListener('click', (e) => { if (e.target === syncOverlay) closeSync(); });
}
document.addEventListener('keydown', (e) => {
  if (!syncOverlay || !syncOverlay.classList.contains('open')) return;
  if (e.key === 'Escape') closeSync();
  if (e.key === 'Enter' && e.target === fSyncToken) connect();
});
