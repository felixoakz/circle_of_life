// The pure half of the label overlay (ARCHITECTURE §7.7): which labels win the
// screen space, how they fade, and where text goes outside the rim. No DOM
// here, so it is unit-tested; labels.ts builds the candidates and draws.
//
// Every frame, each label that could show is a candidate with a priority
// (leaf count for clades), a fit ratio and one or more screen boxes:
//   - hysteresis: a candidate shows at fit ≥ 1 and, once shown, stays until
//     its fit drops below LABEL_HIDE_FIT (0.85), so a slow zoom never makes a
//     label blink at the threshold;
//   - greedy culling: candidates are placed in priority order and dropped if
//     any of their boxes hits an already placed box. A label that is already
//     shown counts LABEL_STICKY times its priority, so two labels nudging
//     past each other do not swap back and forth;
//   - fading: each label's opacity walks linearly towards 0 or 1 over
//     LABEL_FADE_MS, keyed by a stable id (the node id).

import { LABEL_FADE_MS, LABEL_HIDE_FIT, LABEL_STICKY } from './style';

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type LabelKey = number | string;

export interface Candidate {
  key: LabelKey;
  priority: number;
  /** Room available over room needed: ≥ 1 fits. */
  fit: number;
  /** Space the label always takes (for a clade bar: the bar). */
  boxes: Box[];
  /**
   * Alternative places for the text, best first; the first that is clear
   * (also of the soft obstacles, if any is) wins. Without alternatives,
   * `boxes` is all.
   */
  alts?: Box[][];
}

/** The winners of `cull`, with the alternative each one got (0 without alternatives). */
export type Placement = Map<LabelKey, number>;

/** Uniform grid over placed boxes, so a hit test only looks at nearby ones. */
export class CollisionGrid {
  private readonly cell: number;
  private readonly cells = new Map<number, Box[]>();

  constructor(cell = 32) {
    this.cell = cell;
  }

  /** True if `b` overlaps any placed box. */
  hits(b: Box): boolean {
    let hit = false;
    this.forCells(b, (list) => {
      if (hit) return;
      for (const p of list) {
        if (b.x0 < p.x1 && b.x1 > p.x0 && b.y0 < p.y1 && b.y1 > p.y0) {
          hit = true;
          return;
        }
      }
    });
    return hit;
  }

  add(b: Box): void {
    this.forCells(b, (list, key) => {
      if (list.length === 0) this.cells.set(key, list);
      list.push(b);
    });
  }

  private forCells(b: Box, fn: (list: Box[], key: number) => void): void {
    const c = this.cell;
    // Clamp so a box far off screen cannot make us walk millions of cells.
    const cx0 = Math.max(-64, Math.floor(b.x0 / c));
    const cx1 = Math.min(512, Math.floor(b.x1 / c));
    const cy0 = Math.max(-64, Math.floor(b.y0 / c));
    const cy1 = Math.min(512, Math.floor(b.y1 / c));
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const key = (cy + 64) * 1024 + (cx + 64);
        fn(this.cells.get(key) ?? [], key);
      }
    }
  }
}

/** Whether a candidate may show, given whether it shows now (hysteresis). */
export function fits(fit: number, shown: boolean): boolean {
  return fit >= 1 || (shown && fit >= LABEL_HIDE_FIT);
}

/**
 * Greedy collision culling. `obstacles` (e.g. the home leader bar) are
 * placed first and never drawn; `soft` obstacles (a hairline leader) only
 * steer text alternatives off them where one is clear, and never cost a
 * label (the hairline passes behind it). Returns the winners, at most `max`.
 */
export function cull(
  candidates: readonly Candidate[],
  shown: (key: LabelKey) => boolean,
  max: number,
  obstacles: readonly Box[] = [],
  soft: readonly Box[] = [],
): Placement {
  const grid = new CollisionGrid();
  for (const b of obstacles) grid.add(b);
  const softGrid = new CollisionGrid();
  for (const b of soft) softGrid.add(b);
  const eligible: { c: Candidate; p: number }[] = [];
  for (const c of candidates) {
    const was = shown(c.key);
    if (fits(c.fit, was)) eligible.push({ c, p: c.priority * (was ? LABEL_STICKY : 1) });
  }
  // Ties go to the smaller key, so the order never depends on tile order.
  eligible.sort((a, b) => b.p - a.p || String(a.c.key).localeCompare(String(b.c.key)));
  const out: Placement = new Map();
  for (const { c } of eligible) {
    if (out.size >= max) break;
    if (c.boxes.some((b) => grid.hits(b))) continue;
    let alt = 0;
    if (c.alts) {
      alt = c.alts.findIndex((boxes) => !boxes.some((b) => grid.hits(b) || softGrid.hits(b)));
      if (alt < 0) alt = c.alts.findIndex((boxes) => !boxes.some((b) => grid.hits(b)));
      if (alt < 0) continue;
      for (const b of c.alts[alt] ?? []) grid.add(b);
    }
    for (const b of c.boxes) grid.add(b);
    out.set(c.key, alt);
  }
  return out;
}

interface FadeState {
  alpha: number;
  target: number;
}

/** Per-label opacity, walking linearly towards its target. */
export class Fader {
  private readonly states = new Map<LabelKey, FadeState>();
  private last = -1;

  /** Whether the label is (fading towards) shown. */
  shown(key: LabelKey): boolean {
    return (this.states.get(key)?.target ?? 0) > 0;
  }

  alpha(key: LabelKey): number {
    return this.states.get(key)?.alpha ?? 0;
  }

  /**
   * Sets the targets: `winners` fade in, every other key in `present` fades
   * out. Keys not present any more (scrolled away, tile gone) are dropped at
   * once: their geometry is unknown. Advances to time `now`; returns true
   * while some label is still fading.
   */
  update(now: number, present: Iterable<LabelKey>, winners: { has(key: LabelKey): boolean }): boolean {
    const dt = this.last < 0 ? 0 : Math.max(0, now - this.last);
    this.last = now;
    const step = dt / LABEL_FADE_MS;
    const seen = new Set<LabelKey>();
    let moving = false;
    for (const key of present) {
      seen.add(key);
      let s = this.states.get(key);
      const target = winners.has(key) ? 1 : 0;
      if (!s) {
        if (target === 0) continue;
        s = { alpha: 0, target };
        this.states.set(key, s);
      }
      s.target = target;
      s.alpha = s.alpha < target ? Math.min(target, s.alpha + step) : Math.max(target, s.alpha - step);
      if (s.alpha !== s.target) moving = true;
    }
    for (const [key, s] of this.states) {
      if (!seen.has(key) || (s.alpha === 0 && s.target === 0)) this.states.delete(key);
    }
    return moving;
  }

  /** Skips every fade to its end (screenshots, reduced motion). */
  settle(): void {
    for (const s of this.states.values()) s.alpha = s.target;
  }
}

/**
 * Where to put a w × h text box outside a circle, so it hangs away from the
 * rim: `(ax, ay)` is the anchor on the outward ray and `(ux, uy)` the unit
 * outward direction on screen. The box centre moves out by half the box in
 * each axis, so on the right the text starts at the anchor, on the left it
 * ends there, and above or below it is centred.
 */
export function outsideBox(ax: number, ay: number, ux: number, uy: number, w: number, h: number): Box {
  const cx = ax + (ux * w) / 2;
  const cy = ay + (uy * h) / 2;
  return { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
}

/** Axis-aligned bounds of a w × h rectangle centred at (cx, cy), turned by `angle`. */
export function rotatedBox(cx: number, cy: number, w: number, h: number, angle: number): Box {
  const c = Math.abs(Math.cos(angle));
  const s = Math.abs(Math.sin(angle));
  const hw = (w * c + h * s) / 2;
  const hh = (w * s + h * c) / 2;
  return { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh };
}

export function inflate(b: Box, dx: number, dy = dx): Box {
  return { x0: b.x0 - dx, y0: b.y0 - dy, x1: b.x1 + dx, y1: b.y1 + dy };
}

/**
 * The rotation that lays text along the outward ray at screen angle `psi`
 * (radians, y down) and keeps it upright: text on the left half is turned a
 * half turn more and right-aligned, so it still reads left to right.
 */
export function radialText(psi: number): { rot: number; align: 'left' | 'right' } {
  const c = Math.cos(psi);
  if (c >= 0) return { rot: psi, align: 'left' };
  return { rot: psi + Math.PI, align: 'right' };
}

/** How far past vertical arc text may lean before it turns the other way, radians (10°). */
const ARC_SLACK = (10 * Math.PI) / 180;

/**
 * Text along a circle, centred on screen angle `phi` (radians, y up, as
 * seen from the circle's centre). Above the centre the glyphs stand on the
 * circle with their tops outward and the text runs clockwise; below it their
 * tops point inward and it runs counter-clockwise, so it never reads upside
 * down: whichever of the two turns the glyphs less than 90° (plus a little
 * slack) from upright. Near the sides (within ARC_SLACK of vertical, where
 * auto-orient puts the rim at deep zoom) both would do, and it reads bottom
 * to top, so it cannot flip back and forth as the view turns. `dir` is the
 * sign of dφ per px of text; `rot` gives a glyph's canvas rotation at its
 * angle.
 */
export function arcTextDirection(phi: number): { dir: 1 | -1; rot: (phiAt: number) => number } {
  const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
  const upper = wrap(Math.PI / 2 - phi);
  const lower = wrap(-Math.PI / 2 - phi);
  const okUpper = Math.abs(upper) <= Math.PI / 2 + ARC_SLACK;
  const okLower = Math.abs(lower) <= Math.PI / 2 + ARC_SLACK;
  // Both readable (the text runs up or down the screen): bottom to top, a −90° turn.
  const useUpper = okUpper && okLower ? Math.abs(upper + Math.PI / 2) < Math.abs(lower + Math.PI / 2) : okUpper;
  if (useUpper) return { dir: -1, rot: (p) => Math.PI / 2 - p };
  return { dir: 1, rot: (p) => -Math.PI / 2 - p };
}

/**
 * A greeked name (DESIGN.md §3, §5): one stroke per word of `text`, as
 * [start, length] along a run `width` px long. Every character gets the same
 * share, so the spaces between words become the gaps; good enough for a
 * texture that stands in for text too small to read.
 */
export function greekWords(text: string, width: number): [number, number][] {
  const out: [number, number][] = [];
  if (text.length === 0 || width <= 0) return out;
  const per = width / text.length;
  let start = -1;
  for (let i = 0; i <= text.length; i++) {
    const space = i === text.length || text[i] === ' ';
    if (!space && start < 0) start = i;
    if (space && start >= 0) {
      out.push([start * per, (i - start) * per]);
      start = -1;
    }
  }
  return out;
}

/**
 * Which greeked rows a hairline (the selection's leader, "You are here")
 * crosses. Like a readable name, a greeked one is never dropped for a
 * hairline: the line is cut round its strokes instead (labels.ts
 * drawGreek). One flag per row box.
 */
export function greekKnocks(rows: readonly Box[], hairlines: CollisionGrid): boolean[] {
  return rows.map((b) => hairlines.hits(b));
}
