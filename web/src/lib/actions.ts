// actions.ts — tiny Svelte actions shared across components.
//
// clickOutside : fires the supplied callback on every click that lands
// outside the element the action is mounted on. Used to auto-close
// dropdowns when the user clicks anywhere else in the window —
// daisyUI's <details>-based dropdown otherwise stays open until the
// user clicks the summary again, which feels broken.

export function clickOutside(node: HTMLElement, callback: () => void) {
  function onClick(ev: MouseEvent) {
    const t = ev.target as Node | null;
    if (t && !node.contains(t)) callback();
  }
  // mousedown beats click on text-selection drags + fires before
  // the dropdown's own close handlers, so a click on a menu entry
  // still gets through normally.
  document.addEventListener('mousedown', onClick, true);
  return {
    destroy() {
      document.removeEventListener('mousedown', onClick, true);
    },
  };
}
