// @ts-check
/* ---------- Life dashboard sidebar ----------
 * Rendered only on the Life tab. Four sections in a top→bottom priority
 * gradient: Today's Focus (the hero) → Next Up (dates) → Notes → Incoming
 * (placeholder for now). Built with textContent throughout so user text is
 * never interpreted as HTML. */

import { uid } from './store.js';
import { state, activeTab, save, saveSoon } from './state.js';
import { render } from './render.js';

const lifeSidebar = /** @type {HTMLElement} */ (document.getElementById('lifeSidebar'));
const FOCUS_CAP = 3;          // the disappearing "+ add" button IS the cap
const STICKY_COLORS = ['yellow', 'pink', 'blue', 'green']; // new notes cycle through these
let showAllDates = false;     // "view all" toggle, persists across re-renders
let addingFocus = false;      // inline add-form open flags
let addingDate = false;
/** @type {string|null} */
let focusStickyId = null;     // a freshly-added sticky to focus after render

/** @param {string} dateStr yyyy-mm-dd */
function dayDiff(dateStr) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(dateStr + 'T00:00:00');
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}
/** @param {number} diff */
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
/**
 * @param {string} placeholder
 * @param {(value: string) => void} onCommit
 * @param {() => void} onCancel
 */
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

/** @param {import('./store.js').LifeMeta} meta */
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

/** @param {string} text */
function sideTitle(text) {
  const el = document.createElement('div');
  el.className = 'side-title';
  el.textContent = text;
  return el;
}
/** @param {() => void} onClick */
function sideDelBtn(onClick) {
  const del = document.createElement('button');
  del.className = 'side-del';
  del.textContent = '×';
  del.title = 'Remove';
  del.onclick = onClick;
  return del;
}

/** @param {import('./store.js').LifeMeta} meta */
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

/** @param {import('./store.js').LifeMeta} meta */
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

/** @param {import('./store.js').LifeMeta} meta */
function renderNotesSection(meta) {
  const sec = document.createElement('div');
  sec.className = 'side-sec';

  // Header: title + an inline "+ add" that drops a fresh, focused sticky.
  const head = document.createElement('div');
  head.className = 'notes-head';
  head.appendChild(sideTitle('Notes'));
  const add = document.createElement('button');
  add.className = 'side-link';
  add.textContent = '+ add';
  add.onclick = () => {
    const color = STICKY_COLORS[meta.stickies.length % STICKY_COLORS.length];
    const note = { id: uid(), text: '', color };
    meta.stickies.push(note);
    focusStickyId = note.id;
    save(); render();
  };
  head.appendChild(add);
  sec.appendChild(head);

  const wall = document.createElement('div');
  wall.className = 'sticky-wall';
  meta.stickies.forEach(note => {
    const el = document.createElement('div');
    el.className = 'sticky';
    el.dataset.color = note.color || 'yellow';

    const ta = document.createElement('textarea');
    ta.className = 'sticky-text';
    ta.placeholder = 'Note…';
    ta.value = note.text;
    // Autosave WITHOUT re-rendering, or typing would lose focus each keystroke.
    // saveSoon debounces the (whole-board) localStorage stringify per keypress;
    // the sync push is debounced separately on top of that.
    ta.addEventListener('input', () => { note.text = ta.value; saveSoon(); });
    el.appendChild(ta);

    el.appendChild(sideDelBtn(() => {
      meta.stickies = meta.stickies.filter(n => n.id !== note.id);
      save(); render();
    }));

    wall.appendChild(el);
    if (note.id === focusStickyId) setTimeout(() => ta.focus(), 0);
  });
  focusStickyId = null;
  sec.appendChild(wall);

  if (!meta.stickies.length) {
    const hint = document.createElement('div');
    hint.className = 'empty-hint';
    hint.textContent = 'No notes yet — add one';
    sec.appendChild(hint);
  }
  return sec;
}

/* Placeholder for future cross-repo work surfacing (e.g. strava-insights via
 * the ticket API or GitHub polling). No data source yet — this section only
 * renders a styled empty state. The .incoming-list wrapper exists so a future
 * list of real items can be dropped in without restructuring this section. */
function renderIncomingSection() {
  const sec = document.createElement('div');
  sec.className = 'side-sec';
  sec.appendChild(sideTitle('Incoming'));

  const list = document.createElement('div');
  list.className = 'incoming-list';
  const hint = document.createElement('div');
  hint.className = 'empty-hint';
  hint.textContent = 'Nothing incoming yet';
  list.appendChild(hint);
  sec.appendChild(list);

  return sec;
}

export function renderSidebar() {
  lifeSidebar.hidden = activeTab !== 'life';
  if (lifeSidebar.hidden) { addingFocus = false; addingDate = false; return; }
  const meta = state.lifeMeta;
  lifeSidebar.innerHTML = '';
  lifeSidebar.append(
    renderFocusSection(meta),
    renderDatesSection(meta),
    renderNotesSection(meta),
    renderIncomingSection(),
  );
}
