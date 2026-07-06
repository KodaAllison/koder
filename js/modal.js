// @ts-check
/* Ticket create/edit modal. Owns the `editing` handle and the form elements.
 * Exports openModal (used by board.js) and editorBusy (used by sync.js to
 * avoid yanking state out from under an open editor). */

import { colsFor, boardFor, uid } from './store.js';
import { state, activeTab, PROJECTS, projectIds, save } from './state.js';
import { render } from './render.js';

/** @type {{ card: import('./store.js').Card|null, colId: string }|null} */
let editing = null;

const overlay = /** @type {HTMLElement} */ (document.getElementById('overlay'));
const fTitle = /** @type {HTMLInputElement} */ (document.getElementById('fTitle'));
const fNote = /** @type {HTMLTextAreaElement} */ (document.getElementById('fNote'));
const fPriority = /** @type {HTMLSelectElement} */ (document.getElementById('fPriority'));
const fCol = /** @type {HTMLSelectElement} */ (document.getElementById('fCol'));
const fProject = /** @type {HTMLSelectElement} */ (document.getElementById('fProject'));
const projectField = /** @type {HTMLElement} */ (document.getElementById('projectField'));
const btnDelete = /** @type {HTMLButtonElement} */ (document.getElementById('btnDelete'));

/* Don't yank state out from under an open modal or a focused text field. */
export function editorBusy() {
  const el = document.activeElement;
  return overlay.classList.contains('open') ||
    !!(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'));
}

/* <option>s are built with createElement, not string templates: column names
 * are our own constants, but project names come from folder names on disk
 * (via gen-projects.sh) and must get the same never-trust-as-HTML treatment
 * as every other externally-sourced string. */
/** @param {string} value @param {string} label */
function option(value, label) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  return o;
}

/**
 * @param {import('./store.js').Card|null} card  null = new ticket
 * @param {string} colId                          column the card lives in / lands in
 */
export function openModal(card, colId) {
  editing = { card, colId };
  const boardId = boardFor(activeTab);
  fCol.replaceChildren(...colsFor(boardId).map(c => option(c.id, c.name)));

  // Project selector — only relevant to the projects board (hidden for Life).
  const isProjects = boardId === 'projects';
  projectField.hidden = !isProjects;
  if (isProjects) {
    fProject.replaceChildren(
      option('', '— Unassigned —'),
      ...PROJECTS.map(p => option(p.id, p.name)),
    );
    let proj = '';
    if (card) proj = card.project || '';
    else if (projectIds().has(activeTab)) proj = activeTab;   // new card on a project tab
    else if (activeTab === 'unassigned') proj = '';
    else if (PROJECTS.length) proj = PROJECTS[0].id;          // 'all' → first project
    fProject.value = proj;
  }

  const modalTitle = /** @type {HTMLElement} */ (document.getElementById('modalTitle'));
  modalTitle.textContent = card ? 'Edit ticket' : 'New ticket';
  fTitle.value = card ? card.title : '';
  fNote.value = card ? (card.note || '') : '';
  fPriority.value = card ? card.priority : 'med';
  fCol.value = colId;
  btnDelete.hidden = !card;
  overlay.classList.add('open');
  fTitle.focus();
}

function closeModal() { overlay.classList.remove('open'); editing = null; }

function saveModal() {
  if (!editing) return;
  const title = fTitle.value.trim();
  if (!title) { fTitle.focus(); return; }
  const boardId = boardFor(activeTab);
  const targetCol = fCol.value;
  const priority = /** @type {import('./store.js').Priority} */ (fPriority.value);
  const project = boardId === 'projects' ? (fProject.value || null) : undefined;

  if (editing.card) {
    const c = editing.card;
    c.title = title;
    c.note = fNote.value.trim();
    c.priority = priority;
    if (boardId === 'projects') c.project = project;
    if (targetCol !== editing.colId) {
      const src = state[boardId][editing.colId];
      const i = src.findIndex(x => x.id === c.id);
      if (i !== -1) { src.splice(i, 1); state[boardId][targetCol].push(c); }
    }
  } else {
    /** @type {import('./store.js').Card} */
    const card = {
      id: uid(), title, note: fNote.value.trim(),
      priority, created: Date.now(),
    };
    if (boardId === 'projects') card.project = project;
    state[boardId][targetCol].push(card);
  }
  save(); closeModal(); render();
}

/* Static wiring — these elements exist for the lifetime of the page. */
const btnCancel = /** @type {HTMLButtonElement} */ (document.getElementById('btnCancel'));
const btnSave = /** @type {HTMLButtonElement} */ (document.getElementById('btnSave'));
btnCancel.onclick = closeModal;
btnSave.onclick = saveModal;
overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
  if (e.key === 'Enter' && overlay.classList.contains('open') && e.target === fTitle) saveModal();
});

btnDelete.onclick = () => {
  if (!editing || !editing.card) return;
  const src = state[boardFor(activeTab)][editing.colId];
  const i = src.findIndex(x => x.id === editing.card.id);
  if (i !== -1) src.splice(i, 1);
  save(); closeModal(); render();
};
