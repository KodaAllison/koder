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

/* The board has two column sets. "projects" is a SINGLE shared board that
 * holds every project's tickets (each card carries a `project` id); the tab
 * bar filters this one board by project. "life" is a separate board whose
 * stages match how personal to-dos move — a dev backlog/sprint pipeline
 * doesn't fit life tasks (nothing "ships"). */
const BOARDS = {
  projects: [
    { id: 'backlog', name: 'Backlog' },
    { id: 'todo',    name: 'To Do' },
    { id: 'doing',   name: 'In Progress' },
    { id: 'done',    name: 'Done' },
  ],
  life: [
    { id: 'someday',  name: 'Someday' },
    { id: 'thisweek', name: 'This Week' },
    { id: 'doing',    name: 'Doing' },
    { id: 'waiting',  name: 'Waiting' },
    { id: 'done',     name: 'Done' },
  ],
};
function colsFor(boardId) { return BOARDS[boardId]; }

/* The active "view" (activeTab) is one of: 'all', a project id, 'unassigned',
 * 'unlinked', or 'life'. Everything except 'life' renders the projects board,
 * filtered to the cards that match. */
function boardFor(view) { return view === 'life' ? 'life' : 'projects'; }
function cardMatchesView(card, view) {
  if (view === 'all') return true;
  if (view === 'unassigned') return card.project == null;
  if (view === 'unlinked') return card.project != null && !projectIds().has(card.project);
  return card.project === view;
}

/* Projects are sourced from js/projects.json (generated by
 * scripts/gen-projects.ps1 from the folders in Code\). Loaded at boot. */
let PROJECTS = [];
function projectIds() { return new Set(PROJECTS.map(p => p.id)); }
function projectById(id) { return PROJECTS.find(p => p.id === id) || null; }

/* Data lives in localStorage: simple, synchronous, survives restarts.
 * PWA stretch goal: migrate to IndexedDB (async, bigger quota, works in
 * service workers too — needed for background sync later). */
const STORE_KEY = 'kanban-hub-v1';

let state = load();
let activeTab = localStorage.getItem(STORE_KEY + ':tab') || 'all';
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
  // Fill in any missing boards/columns (covers first run and future column additions).
  Object.keys(BOARDS).forEach(boardId => {
    if (!s[boardId]) s[boardId] = {};
    BOARDS[boardId].forEach(c => { if (!s[boardId][c.id]) s[boardId][c.id] = []; });
  });
  // One-time migration: project tickets from before the per-project feature
  // have no `project` field. Default them to null so they surface under the
  // "Unassigned" tab instead of vanishing.
  Object.values(s.projects).forEach(cards => {
    cards.forEach(card => { if (!('project' in card)) card.project = null; });
  });
  // Life dashboard sidebar data (Today's focus, important dates, notes).
  // Defensive fill so existing saved state upgrades cleanly.
  if (!s.lifeMeta || typeof s.lifeMeta !== 'object') s.lifeMeta = {};
  if (!Array.isArray(s.lifeMeta.focus)) s.lifeMeta.focus = [];
  if (!Array.isArray(s.lifeMeta.dates)) s.lifeMeta.dates = [];
  if (typeof s.lifeMeta.notes !== 'string') s.lifeMeta.notes = '';
  return s;
}
function save() { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }

/* Load the project list written by scripts/gen-projects.ps1. */
async function loadProjects() {
  try {
    const res = await fetch('js/projects.json', { cache: 'no-cache' });
    if (res.ok) {
      const j = await res.json();
      PROJECTS = Array.isArray(j.projects) ? j.projects : [];
    }
  } catch (e) { /* offline first-load or file:// — fall back below */ }
  // Fallback: if the list couldn't load, derive it from ids already present
  // on stored tickets so existing cards still get a tab + (plain) chip.
  if (!PROJECTS.length) {
    const ids = new Set();
    Object.values(state.projects || {}).forEach(cards =>
      cards.forEach(c => { if (c.project) ids.add(c.project); }));
    PROJECTS = [...ids].map(id => ({ id, name: id, color: '#eef1fe', text: '#3b4bb8' }));
  }
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function fmtDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const PRI_LABEL = { low: 'Low', med: 'Med', high: 'High' };

/* ---------- rendering ---------- */
function renderTabs() {
  const el = document.getElementById('tabs');
  el.innerHTML = '';

  const projCards = Object.values(state.projects).flat();
  const ids = projectIds();

  // Life (kept first for quick access) → All → each project → (Unassigned) → (Unlinked).
  const tabs = [
    { id: 'life', name: 'Life', count: Object.values(state.life).flat().length },
    { id: 'all', name: 'All', count: projCards.length },
  ];
  PROJECTS.forEach(p => {
    tabs.push({ id: p.id, name: p.name, count: projCards.filter(c => c.project === p.id).length });
  });
  const unassigned = projCards.filter(c => c.project == null).length;
  if (unassigned) tabs.push({ id: 'unassigned', name: 'Unassigned', count: unassigned });
  const unlinked = projCards.filter(c => c.project != null && !ids.has(c.project)).length;
  if (unlinked) tabs.push({ id: 'unlinked', name: 'Unlinked', count: unlinked });

  tabs.forEach(t => {
    const b = document.createElement('button');
    b.className = 'tab' + (t.id === activeTab ? ' active' : '');
    b.dataset.tab = t.id;
    b.textContent = t.count ? `${t.name} (${t.count})` : t.name;
    b.onclick = () => { activeTab = t.id; localStorage.setItem(STORE_KEY + ':tab', t.id); render(); };
    el.appendChild(b);
  });
}

function renderBoard() {
  const board = document.getElementById('board');
  board.innerHTML = '';
  const boardId = boardFor(activeTab);
  const cols = colsFor(boardId);
  // Show the project chip only where it's informative: the combined views.
  const showProject = boardId === 'projects' &&
    (activeTab === 'all' || activeTab === 'unassigned' || activeTab === 'unlinked');
  board.style.setProperty('--board-cols', cols.length);
  cols.forEach(col => {
    let cards = state[boardId][col.id] || [];
    if (boardId === 'projects') cards = cards.filter(c => cardMatchesView(c, activeTab));
    const colEl = document.createElement('div');
    colEl.className = 'col';
    colEl.dataset.col = col.id;

    const head = document.createElement('div');
    head.className = 'col-head';
    head.innerHTML = `<span class="col-title">${col.name}</span><span class="count">${cards.length}</span>`;
    colEl.appendChild(head);

    cards.forEach(card => colEl.appendChild(renderCard(card, col.id, showProject)));

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

function renderCard(card, colId, showProject) {
  const el = document.createElement('div');
  el.className = 'card';
  el.draggable = true;
  const proj = showProject ? projectById(card.project) : null;
  const projectChip = showProject
    ? `<span class="chip project${proj ? '' : ' unlinked'}"></span>`
    : '';
  el.innerHTML =
    `<div class="card-title"></div>` +
    (card.note ? `<div class="card-note"></div>` : '') +
    `<div class="card-meta">
       ${projectChip}
       <span class="chip ${card.priority}">${PRI_LABEL[card.priority] || 'Med'}</span>
       <span class="card-date">${fmtDate(card.created)}</span>
     </div>`;
  el.querySelector('.card-title').textContent = card.title;
  if (card.note) el.querySelector('.card-note').textContent = card.note;
  if (showProject) {
    const chip = el.querySelector('.chip.project');
    if (proj) {
      chip.textContent = proj.name;
      chip.style.background = proj.color;
      chip.style.color = proj.text;
    } else {
      chip.textContent = card.project == null ? 'Unassigned' : card.project;
    }
  }

  el.addEventListener('dragstart', e => {
    e.dataTransfer.setData('text/plain', JSON.stringify({ colId, cardId: card.id }));
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  el.addEventListener('click', () => openModal(card, colId));
  return el;
}

/* ---------- Life dashboard sidebar ----------
 * Rendered only on the Life tab. Three sections in a top→bottom priority
 * gradient: Today's Focus (the hero) → Next Up (dates) → Notes. Built with
 * textContent throughout so user text is never interpreted as HTML. */
const lifeSidebar = document.getElementById('lifeSidebar');
const FOCUS_CAP = 3;          // the disappearing "+ add" button IS the cap
let showAllDates = false;     // "view all" toggle, persists across re-renders
let addingFocus = false;      // inline add-form open flags
let addingDate = false;

function dayDiff(dateStr) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(dateStr + 'T00:00:00');
  return Math.round((d - today) / 86400000);
}
function countdownLabel(diff) {
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  if (diff > 1) return `in ${diff} days`;
  return `${-diff} days ago`;
}

/* A single-field inline add: reveals a text input, commits on Enter / blur,
 * cancels (empty) via Escape. The `done` guard stops the blur that fires when
 * render() tears the input down from double-committing. */
function makeTextAdd(placeholder, onCommit, onCancel) {
  const wrap = document.createElement('div');
  wrap.className = 'side-add';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = placeholder;
  input.maxLength = 140;
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (v) onCommit(v); else onCancel();
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { done = true; onCancel(); }
  });
  input.addEventListener('blur', commit);
  wrap.appendChild(input);
  setTimeout(() => input.focus(), 0);
  return wrap;
}

function makeDateAdd(meta) {
  const wrap = document.createElement('div');
  wrap.className = 'side-add';
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.placeholder = 'Occasion (e.g. Dentist)';
  titleInput.maxLength = 140;
  const dateInput = document.createElement('input');
  dateInput.type = 'date';
  const commit = () => {
    const t = titleInput.value.trim();
    const d = dateInput.value;
    if (!t || !d) return;                       // need both fields
    meta.dates.push({ id: uid(), title: t, date: d });
    addingDate = false; save(); render();
  };
  const cancel = () => { addingDate = false; render(); };
  [titleInput, dateInput].forEach(inp => inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') cancel();
  }));
  const addBtn = document.createElement('button');
  addBtn.className = 'add-btn';
  addBtn.textContent = 'Add date';
  addBtn.onclick = commit;
  wrap.append(titleInput, dateInput, addBtn);
  setTimeout(() => titleInput.focus(), 0);
  return wrap;
}

function sideTitle(text) {
  const el = document.createElement('div');
  el.className = 'side-title';
  el.textContent = text;
  return el;
}
function sideDelBtn(onClick) {
  const del = document.createElement('button');
  del.className = 'side-del';
  del.textContent = '×';
  del.title = 'Remove';
  del.onclick = onClick;
  return del;
}

function renderFocusSection(meta) {
  const sec = document.createElement('div');
  sec.className = 'side-sec today';
  sec.appendChild(sideTitle('Today'));

  meta.focus.forEach(item => {
    const row = document.createElement('div');
    row.className = 'focus-row' + (item.done ? ' done' : '');
    const toggle = () => { item.done = !item.done; save(); render(); };

    const check = document.createElement('span');
    check.className = 'focus-check';
    check.textContent = item.done ? '●' : '○';
    check.onclick = toggle;

    const text = document.createElement('span');
    text.className = 'focus-text';
    text.textContent = item.text;
    text.onclick = toggle;

    row.append(check, text, sideDelBtn(() => {
      meta.focus = meta.focus.filter(f => f.id !== item.id);
      save(); render();
    }));
    sec.appendChild(row);
  });

  // Hard cap: at FOCUS_CAP items the add affordance simply isn't offered.
  if (meta.focus.length < FOCUS_CAP) {
    if (addingFocus) {
      sec.appendChild(makeTextAdd('What matters today?',
        v => { meta.focus.push({ id: uid(), text: v, done: false }); addingFocus = false; save(); render(); },
        () => { addingFocus = false; render(); }));
    } else {
      const add = document.createElement('button');
      add.className = 'add-btn';
      add.textContent = '+ add focus';
      add.onclick = () => { addingFocus = true; render(); };
      sec.appendChild(add);
    }
  }
  return sec;
}

function renderDatesSection(meta) {
  const sec = document.createElement('div');
  sec.className = 'side-sec';
  sec.appendChild(sideTitle('Next Up'));

  // Upcoming nearest-first, then past most-recent-first.
  const withDiff = meta.dates.map(d => ({ ...d, diff: dayDiff(d.date) }));
  const upcoming = withDiff.filter(d => d.diff >= 0).sort((a, b) => a.diff - b.diff);
  const past = withDiff.filter(d => d.diff < 0).sort((a, b) => b.diff - a.diff);
  const ordered = [...upcoming, ...past];
  const shown = showAllDates ? ordered : ordered.slice(0, 2);

  shown.forEach(d => {
    const row = document.createElement('div');
    row.className = 'date-row' + (d.diff < 0 ? ' past' : '');
    const t = document.createElement('span');
    t.className = 'date-title';
    t.textContent = d.title;
    const c = document.createElement('span');
    c.className = 'date-count';
    c.textContent = countdownLabel(d.diff);
    row.append(t, c, sideDelBtn(() => {
      meta.dates = meta.dates.filter(x => x.id !== d.id);
      save(); render();
    }));
    sec.appendChild(row);
  });

  if (ordered.length > 2) {
    const link = document.createElement('button');
    link.className = 'side-link';
    link.textContent = showAllDates ? 'show less' : `view all (${ordered.length})`;
    link.onclick = () => { showAllDates = !showAllDates; render(); };
    sec.appendChild(link);
  }

  if (addingDate) {
    sec.appendChild(makeDateAdd(meta));
  } else {
    const add = document.createElement('button');
    add.className = 'add-btn';
    add.textContent = '+ add date';
    add.onclick = () => { addingDate = true; render(); };
    sec.appendChild(add);
  }
  return sec;
}

function renderNotesSection(meta) {
  const sec = document.createElement('div');
  sec.className = 'side-sec';
  sec.appendChild(sideTitle('Notes'));
  const ta = document.createElement('textarea');
  ta.className = 'side-notes';
  ta.placeholder = 'Park a thought…';
  ta.value = meta.notes;
  // Autosave WITHOUT re-rendering, or typing would lose focus each keystroke.
  ta.addEventListener('input', () => { meta.notes = ta.value; save(); });
  sec.appendChild(ta);
  return sec;
}

function renderSidebar() {
  lifeSidebar.hidden = activeTab !== 'life';
  if (lifeSidebar.hidden) { addingFocus = false; addingDate = false; return; }
  const meta = state.lifeMeta;
  lifeSidebar.innerHTML = '';
  lifeSidebar.append(
    renderFocusSection(meta),
    renderDatesSection(meta),
    renderNotesSection(meta),
  );
}

function render() {
  // Guard a persisted view that no longer exists (legacy 'projects', a
  // removed project folder, or an empty Unassigned/Unlinked group).
  const projCards = Object.values(state.projects).flat();
  const ids = projectIds();
  const valid =
    activeTab === 'all' || activeTab === 'life' ||
    (activeTab === 'unassigned' && projCards.some(c => c.project == null)) ||
    (activeTab === 'unlinked' && projCards.some(c => c.project != null && !ids.has(c.project))) ||
    ids.has(activeTab);
  if (!valid) activeTab = 'all';
  document.body.style.setProperty('--accent', accentForTab(activeTab));
  renderTabs(); renderBoard(); renderSidebar();
}

// The active tab drives the app-wide accent. Fixed hues for the non-project
// tabs; project tabs reuse their projects.json colour, brightened so the
// (light-optimised) hue reads well on the dark theme.
function accentForTab(view) {
  const fixed = { life: '#a78bfa', all: '#6d84ff', unassigned: '#f59e0b', unlinked: '#f87171' };
  if (fixed[view]) return fixed[view];
  const p = projectById(view);
  return p ? `color-mix(in srgb, ${p.text} 55%, white)` : '#6d84ff';
}

/* ---------- data ops ---------- */
function moveCard(fromCol, cardId, toCol) {
  const boardId = boardFor(activeTab);
  const src = state[boardId][fromCol];
  const i = src.findIndex(c => c.id === cardId);
  if (i === -1) return;
  const [card] = src.splice(i, 1);
  state[boardId][toCol].push(card);
  save(); render();
}

/* ---------- modal ---------- */
const overlay = document.getElementById('overlay');
const fTitle = document.getElementById('fTitle');
const fNote = document.getElementById('fNote');
const fPriority = document.getElementById('fPriority');
const fCol = document.getElementById('fCol');
const fProject = document.getElementById('fProject');
const projectField = document.getElementById('projectField');
const btnDelete = document.getElementById('btnDelete');

function openModal(card, colId) {
  editing = { card, colId };
  const boardId = boardFor(activeTab);
  fCol.innerHTML = colsFor(boardId).map(c => `<option value="${c.id}">${c.name}</option>`).join('');

  // Project selector — only relevant to the projects board (hidden for Life).
  const isProjects = boardId === 'projects';
  projectField.hidden = !isProjects;
  if (isProjects) {
    fProject.innerHTML = ['<option value="">— Unassigned —</option>']
      .concat(PROJECTS.map(p => `<option value="${p.id}">${p.name}</option>`)).join('');
    let proj = '';
    if (card) proj = card.project || '';
    else if (projectIds().has(activeTab)) proj = activeTab;   // new card on a project tab
    else if (activeTab === 'unassigned') proj = '';
    else if (PROJECTS.length) proj = PROJECTS[0].id;          // 'all' → first project
    fProject.value = proj;
  }

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
  const boardId = boardFor(activeTab);
  const targetCol = fCol.value;
  const project = boardId === 'projects' ? (fProject.value || null) : undefined;

  if (editing.card) {
    const c = editing.card;
    c.title = title;
    c.note = fNote.value.trim();
    c.priority = fPriority.value;
    if (boardId === 'projects') c.project = project;
    if (targetCol !== editing.colId) {
      const src = state[boardId][editing.colId];
      const i = src.findIndex(x => x.id === c.id);
      if (i !== -1) { src.splice(i, 1); state[boardId][targetCol].push(c); }
    }
  } else {
    const card = {
      id: uid(), title, note: fNote.value.trim(),
      priority: fPriority.value, created: Date.now(),
    };
    if (boardId === 'projects') card.project = project;
    state[boardId][targetCol].push(card);
  }
  save(); closeModal(); render();
}
document.getElementById('btnSave').onclick = saveModal;

btnDelete.onclick = () => {
  if (!editing || !editing.card) return;
  const src = state[boardFor(activeTab)][editing.colId];
  const i = src.findIndex(x => x.id === editing.card.id);
  if (i !== -1) src.splice(i, 1);
  save(); closeModal(); render();
};

/* Boot: load the project list, then paint. (state is already loaded from
 * localStorage synchronously above — only the project list is async.) */
async function init() {
  await loadProjects();
  render();
}
init();
