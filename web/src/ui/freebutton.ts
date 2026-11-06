// The free view switch (DESIGN.md §4.1): a small glass button beside the
// zoom strip's reset button, a padlock that opens while the view is free.
// A toggle button (aria-pressed), labelled "Free view". It follows the mode
// every frame, however it changed (Esc, a search flying back).

import { track } from '../analytics';

const LOCK_PATH = 'M5.5 7.5V5.5a2.5 2.5 0 0 1 5 0v2';
const OPEN_PATH = 'M5.5 7.5V5.5a2.5 2.5 0 0 1 5 0';

/** The padlock icon, shut (locked view) or open (free view). */
function lockIcon(open: boolean): string {
  return (
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
    '<rect x="3.5" y="7.5" width="9" height="6" fill="none" stroke="currentColor" stroke-width="1"/>' +
    `<path d="${open ? OPEN_PATH : LOCK_PATH}" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="square"/></svg>`
  );
}

export class FreeButton {
  readonly el: HTMLButtonElement;
  private shown: boolean | null = null;

  constructor(toggle: () => void) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctl zoom-free';
    b.setAttribute('aria-label', 'Free view');
    b.addEventListener('click', () => {
      // Counted when it opens free view, not when it closes it.
      if (b.getAttribute('aria-pressed') !== 'true') track('free-view');
      toggle();
    });
    this.el = b;
    this.show(false);
  }

  /** Called after every frame with whether the view is free. */
  show(free: boolean): void {
    if (free === this.shown) return;
    this.shown = free;
    const b = this.el;
    b.setAttribute('aria-pressed', String(free));
    b.title = free ? 'Back to the locked view (F or Esc)' : 'Free view: pan and zoom anywhere (F)';
    b.innerHTML = lockIcon(free);
  }
}
