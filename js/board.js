// @ts-check
/* Kanban board rendering: tabs, columns, cards, drag & drop, and the
 * composite render() that modal.js/sidebar.js reach through render.js.
 * Everything re-renders from `state` on each change — simple and correct at
 * this scale; inline editors that must keep focus (sticky notes) opt out. */

import { BOARDS, colsFor, boardFor, cardMatchesView, sortByPriority } from './store.js';
import { state, activeTab, setActiveTab, PROJECTS, projectIds, projectById, save } from './state.js';
import { renderSidebar } from './sidebar.js';
import { openModal } from './modal.js';
import { setRenderImpl } from './render.js';

const PRI_LABEL = { low: 'Low', med: 'Med', high: 'High' };

/** @param {number} ts */
function fmtDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Shared button construction for both nav layers below — same shape (active
 * class, "name (count)" label, click handler), different container/class.
 * @param {HTMLElement} container
 * @param {string} baseClass
 * @param {{active: boolean, name: string, count: number, onclick: () => void, id?: string}} t
 */
function appendTabButton(container, baseClass, t) {
  const b = document.createElement('button');
  b.className = baseClass + (t.active ? ' active' : '');
  if (t.id) b.dataset.tab = t.id;
  b.textContent = t.count ? `${t.name} (${t.count})` : t.name;
  b.onclick = t.onclick;
  container.appendChild(b);
}

/* Top-level mode toggle: Life (a dashboard) vs Projects (the shared kanban).
 * The second-layer tab strip below only makes sense in Projects mode, so it's
 * hidden whenever Life is active — see renderTabs(). */
function renderTopTabs() {
  const el = /** @type {HTMLElement} */ (document.getElementById('topTabs'));
  el.innerHTML = '';
  const inProjects = boardFor(activeTab) === 'projects';
  const lifeCount = Object.values(state.life).flat().length;
  const projCount = Object.values(state.projects).flat().length;

  [
    { active: !inProjects, name: 'Life', count: lifeCount, onclick: () => { setActiveTab('life'); render(); } },
    { active: inProjects, name: 'Projects', count: projCount, onclick: () => { setActiveTab('all'); render(); } },
  ].forEach(m => appendTabButton(el, 'top-tab', m));
}

function renderTabs() {
  const el = /** @type {HTMLElement} */ (document.getElementById('tabs'));
  const inProjects = boardFor(activeTab) === 'projects';
  el.hidden = !inProjects;
  if (!inProjects) return;
  el.innerHTML = '';

  const projCards = Object.values(state.projects).flat();
  const ids = projectIds();

  // All → each project → (Unassigned) → (Unlinked).
  const tabs = [
    { id: 'all', name: 'All', count: projCards.length },
  ];
  PROJECTS.forEach(p => {
    tabs.push({ id: p.id, name: p.name, count: projCards.filter(c => c.project === p.id).length });
  });
  const unassigned = projCards.filter(c => c.project == null).length;
  if (unassigned) tabs.push({ id: 'unassigned', name: 'Unassigned', count: unassigned });
  const unlinked = projCards.filter(c => c.project != null && !ids.has(c.project)).length;
  if (unlinked) tabs.push({ id: 'unlinked', name: 'Unlinked', count: unlinked });

  tabs.forEach(t => appendTabButton(el, 'tab', {
    active: t.id === activeTab, name: t.name, count: t.count, id: t.id,
    onclick: () => { setActiveTab(t.id); render(); },
  }));
}

function renderBoard() {
  const board = /** @type {HTMLElement} */ (document.getElementById('board'));
  board.innerHTML = '';
  const boardId = boardFor(activeTab);
  const cols = colsFor(boardId);
  const ids = projectIds();
  // Show the project chip only where it's informative: the combined views.
  const showProject = boardId === 'projects' &&
    (activeTab === 'all' || activeTab === 'unassigned' || activeTab === 'unlinked');
  board.style.setProperty('--board-cols', String(cols.length));
  cols.forEach(col => {
    let cards = state[boardId][col.id] || [];
    if (boardId === 'projects') cards = cards.filter(c => cardMatchesView(c, activeTab, ids));
    if (boardId === 'life' && col.id === 'todo') cards = sortByPriority(cards);
    const colEl = document.createElement('div');
    colEl.className = 'col';
    colEl.dataset.col = col.id;

    const head = document.createElement('div');
    head.className = 'col-head';
    head.innerHTML = `<span class="col-title"></span><span class="count">${cards.length}</span>`;
    /** @type {HTMLElement} */ (head.querySelector('.col-title')).textContent = col.name;
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

    board.appendChild(colEl);
  });
}

/**
 * @param {import('./store.js').Card} card
 * @param {string} colId
 * @param {boolean} showProject
 */
function renderCard(card, colId, showProject) {
  const el = document.createElement('div');
  el.className = 'card';
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
  /** @type {HTMLElement} */ (el.querySelector('.card-title')).textContent = card.title;
  if (card.note) /** @type {HTMLElement} */ (el.querySelector('.card-note')).textContent = card.note;
  if (showProject) {
    const chip = /** @type {HTMLElement} */ (el.querySelector('.chip.project'));
    if (proj) {
      chip.textContent = proj.name;
      chip.style.background = proj.color;
      chip.style.color = proj.text;
    } else {
      chip.textContent = card.project == null ? 'Unassigned' : card.project;
    }
  }

  el.addEventListener('pointerdown', e => beginDrag(e, card, colId, el));
  el.addEventListener('click', () => {
    // A completed drag ends in a pointerup that the browser also reports as a
    // click; skip it so releasing a card doesn't also open the editor.
    if (suppressClick) return;
    openModal(card, colId);
  });
  return el;
}

/* ---------- pointer-based drag & drop ----------
 * HTML5 drag events never fire on touch, so cards are moved with a unified
 * Pointer Events implementation instead (one path for mouse, touch, and pen):
 *  - Mouse picks a card up as soon as it moves past a small threshold.
 *  - Touch uses a short press-and-hold to pick up, so a plain swipe still
 *    scrolls the board instead of dragging a card by accident.
 * A floating clone follows the pointer; the column under it (found via
 * elementFromPoint — the clone is pointer-events:none) highlights as the drop
 * target. Releasing moves the card there. */

const DRAG_THRESHOLD = 6; // px of mouse movement before a drag starts
const HOLD_MS = 250;      // press duration before a touch picks a card up

/** @type {null | {
 *   card: import('./store.js').Card, colId: string, el: HTMLElement,
 *   pointerId: number, startX: number, startY: number, touch: boolean,
 *   active: boolean, clone: HTMLElement|null, overCol: HTMLElement|null,
 *   holdTimer: any, offsetX: number, offsetY: number }} */
let drag = null;
/* Set for one tick after a real drag so the trailing click doesn't open the
 * editor. Module-scoped because the card's click listener reads it. */
let suppressClick = false;

/**
 * @param {PointerEvent} e
 * @param {import('./store.js').Card} card
 * @param {string} colId
 * @param {HTMLElement} el
 */
function beginDrag(e, card, colId, el) {
  if (e.button && e.button !== 0) return; // primary button / any touch only
  drag = {
    card, colId, el, pointerId: e.pointerId,
    startX: e.clientX, startY: e.clientY,
    touch: e.pointerType !== 'mouse',
    active: false, clone: null, overCol: null,
    holdTimer: null, offsetX: 0, offsetY: 0,
  };
  // Touch: arm a hold timer. If the finger moves first (onMove), it's a scroll
  // and we bail. Mouse: no delay — onMove starts the drag past the threshold.
  if (drag.touch) drag.holdTimer = setTimeout(activateDrag, HOLD_MS);
  window.addEventListener('pointermove', onDragMove, { passive: false });
  window.addEventListener('pointerup', onDragEnd);
  window.addEventListener('pointercancel', onDragEnd);
}

function activateDrag() {
  if (!drag || drag.active) return;
  drag.active = true;
  const r = drag.el.getBoundingClientRect();
  drag.offsetX = drag.startX - r.left;
  drag.offsetY = drag.startY - r.top;
  const clone = /** @type {HTMLElement} */ (drag.el.cloneNode(true));
  clone.className = 'card drag-clone';
  clone.style.width = r.width + 'px';
  document.body.appendChild(clone);
  drag.clone = clone;
  positionClone(drag.startX, drag.startY);
  drag.el.classList.add('dragging');
  document.body.classList.add('dragging-active');
}

/** @param {number} x @param {number} y */
function positionClone(x, y) {
  if (!drag || !drag.clone) return;
  drag.clone.style.left = (x - drag.offsetX) + 'px';
  drag.clone.style.top = (y - drag.offsetY) + 'px';
}

/** @param {PointerEvent} e */
function onDragMove(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  if (!drag.active) {
    const dist = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
    if (drag.touch) {
      // Moved before the hold fired → the user is scrolling, not dragging.
      if (dist > DRAG_THRESHOLD) endDrag();
      return;
    }
    if (dist < DRAG_THRESHOLD) return;
    activateDrag();
  }
  e.preventDefault(); // suppress scroll / text selection while dragging
  positionClone(e.clientX, e.clientY);
  highlightColumnAt(e.clientX, e.clientY);
}

/** @param {number} x @param {number} y */
function highlightColumnAt(x, y) {
  if (!drag) return;
  const under = document.elementFromPoint(x, y);
  const col = /** @type {HTMLElement|null} */ (under && under.closest('.col'));
  if (col === drag.overCol) return;
  if (drag.overCol) drag.overCol.classList.remove('drag-over');
  drag.overCol = col;
  if (col) col.classList.add('drag-over');
}

/** @param {PointerEvent} e */
function onDragEnd(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const { active, colId, card, overCol } = drag;
  const target = overCol && overCol.dataset.col;
  endDrag();
  if (active) {
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    if (target) moveCard(colId, card.id, target); // moveCard re-renders the board
  }
}

/* Tear down the active drag: cancel the hold timer, drop the clone, clear
 * highlight/dragging classes, and detach the window listeners. */
function endDrag() {
  if (!drag) return;
  clearTimeout(drag.holdTimer);
  if (drag.clone) drag.clone.remove();
  if (drag.overCol) drag.overCol.classList.remove('drag-over');
  drag.el.classList.remove('dragging');
  document.body.classList.remove('dragging-active');
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  window.removeEventListener('pointercancel', onDragEnd);
  drag = null;
}

/* ---------- data ops ---------- */
/** @param {string} fromCol @param {string} cardId @param {string} toCol */
function moveCard(fromCol, cardId, toCol) {
  const boardId = boardFor(activeTab);
  const src = state[boardId][fromCol];
  const i = src.findIndex(c => c.id === cardId);
  if (i === -1) return;
  const [card] = src.splice(i, 1);
  state[boardId][toCol].push(card);
  save(); render();
}

// The active tab drives the app-wide accent. Fixed hues for the non-project
// tabs; project tabs reuse their projects.json colour, brightened so the
// (light-optimised) hue reads well on the dark theme.
/** @param {string} view */
function accentForTab(view) {
  /** @type {Record<string, string>} */
  const fixed = { life: '#a78bfa', all: '#6d84ff', unassigned: '#f59e0b', unlinked: '#f87171' };
  if (fixed[view]) return fixed[view];
  const p = projectById(view);
  return p ? `color-mix(in srgb, ${p.text} 55%, white)` : '#6d84ff';
}

export function render() {
  // Guard a persisted view that no longer exists (legacy 'projects', a
  // removed project folder, or an empty Unassigned/Unlinked group).
  const projCards = Object.values(state.projects).flat();
  const ids = projectIds();
  const valid =
    activeTab === 'all' || activeTab === 'life' ||
    (activeTab === 'unassigned' && projCards.some(c => c.project == null)) ||
    (activeTab === 'unlinked' && projCards.some(c => c.project != null && !ids.has(c.project))) ||
    ids.has(activeTab);
  if (!valid) setActiveTab('all');
  document.body.style.setProperty('--accent', accentForTab(activeTab));
  renderTopTabs(); renderTabs(); renderBoard(); renderSidebar();
}

/* Register as the implementation behind render.js, so modal/sidebar/sync can
 * trigger repaints without importing this module (no cycles). */
setRenderImpl(render);
