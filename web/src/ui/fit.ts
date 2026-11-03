// Making a card tab's content fit its fixed area without scrolling
// (DESIGN.md §4.2). Nothing in the card scrolls: each tab gives way in a set
// order (shorter extract, fewer children, optional lines dropped) until it
// fits, and anything that still does not is left out whole rather than cut
// through a line. These measure the live layout, so they run on the shown
// tab, after it is filled and whenever it is shown again.

import { leadText } from './about';

/** True when `e`'s content runs past its own box. */
export function overflows(e: HTMLElement): boolean {
  return e.scrollHeight > e.clientHeight + 1;
}

/**
 * Shortens the extracts in `scope` (elements with `data-full` and
 * `data-per-line`, ui/about.ts) a sentence at a time, from `maxLines` worth
 * of text down to `minLines`, until `box` stops overflowing.
 */
export function fitExtracts(scope: HTMLElement, box: HTMLElement, maxLines: number, minLines: number): void {
  const extracts = [...scope.querySelectorAll<HTMLElement>('[data-full]')];
  for (let lines = maxLines; lines >= minLines; lines--) {
    for (const e of extracts) {
      const full = e.dataset.full ?? '';
      const perLine = Number(e.dataset.perLine ?? '40');
      e.textContent = leadText(full, Math.max(40, Math.round(perLine * lines)));
    }
    if (!overflows(box)) return;
  }
}

/** Hides `items` one at a time, in order, until `box` stops overflowing. */
export function dropUntilFits(box: HTMLElement, items: readonly (Element | null)[]): void {
  for (const item of items) {
    if (!overflows(box)) return;
    if (item instanceof HTMLElement) hide(item);
  }
}

/**
 * The last resort: hides every child of `box` that ends below the bottom
 * edge of `limit` (by default `box` itself), so a block is shown whole or
 * not at all.
 */
export function clipBlocks(box: HTMLElement, limit: HTMLElement = box): void {
  const bottom = limit.getBoundingClientRect().bottom + 1;
  for (const c of box.children) {
    if (c instanceof HTMLElement && !c.hidden && c.getBoundingClientRect().bottom > bottom) hide(c);
  }
}

/** Hides `e`, marked so `unfit` can bring it back. */
function hide(e: HTMLElement): void {
  e.hidden = true;
  e.dataset.fitHidden = '1';
}

/** Shows everything fitting hid in `box`, before fitting again (another tab size, new content). */
export function unfit(box: HTMLElement): void {
  for (const e of box.querySelectorAll<HTMLElement>('[data-fit-hidden]')) {
    e.hidden = false;
    delete e.dataset.fitHidden;
  }
}
