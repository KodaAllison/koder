// @ts-check
/* Indirection seam for repaints. Every module that needs to trigger a
 * re-render imports render() from here; board.js registers the real
 * implementation at boot. This one level of indirection is what keeps the
 * module graph acyclic — without it, modal.js and sidebar.js would have to
 * import board.js while board.js imports them. */

let impl = () => {};
/** @param {() => void} fn */
export function setRenderImpl(fn) { impl = fn; }
export function render() { impl(); }
