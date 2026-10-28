// Screen areas the canvas has to respect: the HUD's text and controls now,
// the panel (P8) and the search palette (P9) later. Each source registers
// a function returning its rectangles (CSS px), and says per rectangle
//   - whether labels keep clear of it (and whether that reaches to the
//     nearest screen edge, so a label scrolling past the HUD band leaves
//     for good instead of peeking out beyond it), and
//   - how much the renderer darkens the tree behind it (a soft-edged plate
//     drawn in the canvas, so DOM text stays legible over bright bars while
//     the DOM itself stays flat; search will use the same for its 50% dim).
// Sources call `changed()` when their boxes may have moved; the label
// layout includes `version` in its signature.

import type { Box } from '../labelLayout';

export interface Obstacle {
  box: Box;
  /** Labels keep clear of it. */
  keepClear: boolean;
  /** …and of everything between it and the nearer of the top and bottom edges. */
  toEdge: boolean;
  /** Darkening of the tree behind it, 0 (none) to 1 (black). */
  dim: number;
}

export type ObstacleSource = () => Obstacle[];

export class Obstacles {
  /** Bumped whenever a box may have moved. */
  version = 0;
  /** Called after `changed()` (the scene redraws). */
  onChange: () => void = () => {};

  private readonly sources = new Map<string, ObstacleSource>();
  private cache: Obstacle[] | null = null;

  /** Registers (or with null, removes) a named source. */
  set(name: string, source: ObstacleSource | null): void {
    if (source) this.sources.set(name, source);
    else this.sources.delete(name);
    this.changed();
  }

  changed(): void {
    this.cache = null;
    this.version++;
    this.onChange();
  }

  /** Every source's rectangles, measured once per change. */
  all(): Obstacle[] {
    if (!this.cache) {
      this.cache = [];
      for (const source of this.sources.values()) this.cache.push(...source());
    }
    return this.cache;
  }
}

/** The extent of an element's text (a block element is wider than its text), or null when empty or hidden. */
export function textBox(e: Element | null): Box | null {
  if (!e) return null;
  const range = document.createRange();
  range.selectNodeContents(e);
  return rectBox(range.getBoundingClientRect());
}

/** An element's border box, or null when hidden. */
export function elementBox(e: Element | null): Box | null {
  return e ? rectBox(e.getBoundingClientRect()) : null;
}

/** The smallest box holding all of `boxes` (nulls skipped), or null. */
export function union(...boxes: (Box | null)[]): Box | null {
  let out: Box | null = null;
  for (const b of boxes) {
    if (!b) continue;
    out = out
      ? { x0: Math.min(out.x0, b.x0), y0: Math.min(out.y0, b.y0), x1: Math.max(out.x1, b.x1), y1: Math.max(out.y1, b.y1) }
      : b;
  }
  return out;
}

function rectBox(r: DOMRect): Box | null {
  if (r.width === 0 || r.height === 0) return null;
  return { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom };
}
