/* Kanban board app logic + the PWA glue code.
 * The kanban parts are plain DOM code; the PWA-specific bits are marked
 * with "PWA:" comments — registration, update flow, install prompt,
 * and online/offline detection. */

'use strict';

/* ==================== PWA: service worker registration ====================
 * This is the page-side half of the service worker story (sw.js is the
 * other half). Registration is async and safe to call on every load —
 * the browser no-ops if the same SW is already registered.
 *
 * NOTE: service workers require a "secure context": https:// or localhost.
 * If you open index.html via file://, registration will fail. */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      console.log('[PWA] service worker registered, scope:', reg.scope);

      /* ---- Update flow ----
       * When you deploy a changed sw.js, the browser installs it in the
       * background but keeps the OLD one active until all tabs close.
       * We detect the new one sitting in "waiting" and offer a reload. */
      function promptForUpdate(waitingSW) {
        const toast = document.getElementById('updateToast');
        toast.hidden = false;
        document.getElementById('reloadBtn').onclick = () => {
          // Tell the waiting SW to take over (it calls skipWaiting()).
          waitingSW.postMessage({ type: 'SKIP_WAITING' });
        };
      }

      if (reg.waiting) promptForUpdate(reg.waiting); // update already waiting
      reg.addEventListener('updatefound', () => {
        const newSW = reg.installing;
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

/* ==================== PWA: custom install button ====================
 * Chromium browsers fire `beforeinstallprompt` when the app meets
 * installability criteria (manifest + SW + https). We stash the event
 * and trigger it from our own button for a nicer UX.
 * (Safari/Firefox don't fire this — users install via browser menus.) */
let deferredInstallPrompt = null;
const installBtn = document.getElementById('installBtn');

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

/* ==================== PWA: online/offline indicator ====================
 * The app works offline (shell from SW cache, data from localStorage);
 * this badge just makes that state visible. */
const offlineBadge = document.getElementById('offlineBadge');
function updateOnlineStatus() { offlineBadge.hidden = navigator.onLine; }
window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
updateOnlineStatus();

/* ==================== Kanban board ==================== */

/* Each tab has its own column set — a dev backlog/sprint pipeline doesn't
 * fit life tasks (nothing "ships"), so Life gets stages that match how
 * personal to-dos actually move: undecided -> committed -> active ->
 * blocked-on-someone -> done. */
const TABS = [
  {
    id: 'projects', name: 'Projects',
    cols: [
      { id: 'backlog', name: 'Backlog' },
      { id: 'todo',    name: 'To Do' },
      { id: 'doing',   name: 'In Progress' },
      { id: 'done',    name: 'Done' },
    ],
  },
  {
    id: 'life', name: 'Life',
    cols: [
      { id: 'someday',  name: 'Someday' },
      { id: 'thisweek', name: 'This Week' },
      { id: 'doing',    name: 'Doing' },
      { id: 'waiting',  name: 'Waiting' },
      { id: 'done',     name: 'Done' },
    ],
  },
];
function colsFor(tabId) { return TABS.find(t => t.id === tabId).cols; }

/* Data lives in localStorage: simple, synchronous, survives restarts.
 * PWA stretch goal: migrate to IndexedDB (async, bigger quota, works in
 * service workers too — needed for background sync later). */
const STORE_KEY = 'kanban-hub-v1';

let state = load();
let activeTab = localStorage.getItem(STORE_KEY + ':tab') || 'projects';
let editing = null;

/* One-time migration: earlier versions gave every tab the same dev-style
 * columns (backlog/todo/doing/done). Life now uses different column ids,
 * so move any existing life cards across instead of silently dropping them. */
function migrateLifeColumns(s) {
  if (!s.life) return;
  const hasOldShape = 'backlog' in s.life || 'todo' in s.life;
  const hasNewShape = 'someday' in s.life && 'thisweek' in s.life;
  if (hasOldShape && !hasNewShape) {
    s.life = {
      someday:  s.life.backlog || [],
      thisweek: s.life.todo || [],
      doing:    s.life.doing || [],
      waiting:  [],
      done:     s.life.done || [],
    };
  }
}

function load() {
  let s = null;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) s = JSON.parse(raw);
  } catch (e) { /* corrupted data → start fresh */ }
  if (!s) s = {};
  migrateLifeColumns(s);
  // Fill in any missing tabs/columns (covers first run and future column additions).
  TABS.forEach(t => {
    if (!s[t.id]) s[t.id] = {};
    t.cols.forEach(c => { if (!s[t.id][c.id]) s[t.id][c.id] = []; });
  });
  return s;
}
function save() { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function fmtDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const PRI_LABEL = { low: 'Low', med: 'Med', high: 'High' };

/* ---------- rendering ---------- */
function renderTabs() {
  const el = document.getElementById('tabs');
  el.innerHTML = '';
  TABS.forEach(t => {
    const total = t.cols.reduce((n, c) => n + (state[t.id][c.id] || []).length, 0);
    const b = document.createElement('button');
    b.className = 'tab' + (t.id === activeTab ? ' active' : '');
    b.textContent = total ? `${t.name} (${total})` : t.name;
    b.onclick = () => { activeTab = t.id; localStorage.setItem(STORE_KEY + ':tab', t.id); render(); };
    el.appendChild(b);
  });
}

function renderBoard() {
  const board = document.getElementById('board');
  board.innerHTML = '';
  const cols = colsFor(activeTab);
  board.style.setProperty('--board-cols', cols.length);
  cols.forEach(col => {
    const cards = state[activeTab][col.id] || [];
    const colEl = document.createElement('div');
    colEl.className = 'col';
    colEl.dataset.col = col.id;

    const head = document.createElement('div');
    head.className = 'col-head';
    head.innerHTML = `<span class="col-title">${col.name}</span><span class="count">${cards.length}</span>`;
    colEl.appendChild(head);

    cards.forEach(card => colEl.appendChild(renderCard(card, col.id)));

    if (!cards.length) {
      const hint = document.createElement('div');
      hint.className = 'empty-hint';
      hint.textContent = 'Drop tickets here';
      colEl.appendChild(hint);
    }

    const add = document.createElement('button');
    add.className = 'add-btn';
    add.textContent = '+ Add ticket';
    add.onclick = () => openModal(null, col.id);
    colEl.appendChild(add);

    colEl.addEventListener('dragover', e => { e.preventDefault(); colEl.classList.add('drag-over'); });
    colEl.addEventListener('dragleave', () => colEl.classList.remove('drag-over'));
    colEl.addEventListener('drop', e => {
      e.preventDefault();
      colEl.classList.remove('drag-over');
      const data = e.dataTransfer.getData('text/plain');
      if (!data) return;
      const { colId, cardId } = JSON.parse(data);
      moveCard(colId, cardId, col.id);
    });

    board.appendChild(colEl);
  });
}

function renderCard(card, colId) {
  const el = document.createElement('div');
  el.className = 'card';
  el.draggable = true;
  el.innerHTML =
    `<div class="card-title"></div>` +
    (card.note ? `<div class="card-note"></div>` : '') +
    `<div class="card-meta">
       <span class="chip ${card.priority}">${PRI_LABEL[card.priority] || 'Med'}</span>
       <span class="card-date">${fmtDate(card.created)}</span>
     </div>`;
  el.querySelector('.card-title').textContent = card.title;
  if (card.note) el.querySelector('.card-note').textContent = card.note;

  el.addEventListener('dragstart', e => {
    e.dataTransfer.setData('text/plain', JSON.stringify({ colId, cardId: card.id }));
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  el.addEventListener('click', () => openModal(card, colId));
  return el;
}

function render() { renderTabs(); renderBoard(); }

/* ---------- data ops ---------- */
function moveCard(fromCol, cardId, toCol) {
  const src = state[activeTab][fromCol];
  const i = src.findIndex(c => c.id === cardId);
  if (i === -1) return;
  const [card] = src.splice(i, 1);
  state[activeTab][toCol].push(card);
  save(); render();
}

/* ---------- modal ---------- */
const overlay = document.getElementById('overlay');
const fTitle = document.getElementById('fTitle');
const fNote = document.getElementById('fNote');
const fPriority = document.getElementById('fPriority');
const fCol = document.getElementById('fCol');
const btnDelete = document.getElementById('btnDelete');

function openModal(card, colId) {
  editing = { card, colId };
  fCol.innerHTML = colsFor(activeTab).map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  document.getElementById('modalTitle').textContent = card ? 'Edit ticket' : 'New ticket';
  fTitle.value = card ? card.title : '';
  fNote.value = card ? (card.note || '') : '';
  fPriority.value = card ? card.priority : 'med';
  fCol.value = colId;
  btnDelete.hidden = !card;
  overlay.classList.add('open');
  fTitle.focus();
}
function closeModal() { overlay.classList.remove('open'); editing = null; }

document.getElementById('btnCancel').onclick = closeModal;
overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
  if (e.key === 'Enter' && overlay.classList.contains('open') && e.target === fTitle) saveModal();
});

function saveModal() {
  const title = fTitle.value.trim();
  if (!title) { fTitle.focus(); return; }
  const targetCol = fCol.value;

  if (editing.card) {
    const c = editing.card;
    c.title = title;
    c.note = fNote.value.trim();
    c.priority = fPriority.value;
    if (targetCol !== editing.colId) {
      const src = state[activeTab][editing.colId];
      const i = src.findIndex(x => x.id === c.id);
      if (i !== -1) { src.splice(i, 1); state[activeTab][targetCol].push(c); }
    }
  } else {
    state[activeTab][targetCol].push({
      id: uid(), title, note: fNote.value.trim(),
      priority: fPriority.value, created: Date.now(),
    });
  }
  save(); closeModal(); render();
}
document.getElementById('btnSave').onclick = saveModal;

btnDelete.onclick = () => {
  if (!editing || !editing.card) return;
  const src = state[activeTab][editing.colId];
  const i = src.findIndex(x => x.id === editing.card.id);
  if (i !== -1) src.splice(i, 1);
  save(); closeModal(); render();
};

render();
