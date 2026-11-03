// The selection's leader (DESIGN.md §4.1, §5): a hairline polyline from the
// selection to the card, drawn on the label overlay. It is never hidden.
//
// Where it starts (`leaderStart`). The selection is its stem on screen: the
// straight radial segment from its node (the ring) out to the rim, which
// for a tip is a single point. The leader starts at the stem's point
// nearest the node that is in the free area (the screen less a 12 px margin
// and less the card; the free area stops above the bottom HUD band). As a
// clade's node goes further off screen (zoomed in past it), the start
// slides along the visible stem to the rim, where the clade's tips are,
// over the node's first 240 px off screen. When the whole stem is outside
// the free area (turned or zoomed away, or behind the card), the leader
// starts where the ray from the anchor towards the stem's nearest point
// leaves the free area, with a small arrowhead pointing along that ray; the
// arrowhead fades in over the first 24 px of distance, so the line reads as
// "that way, off screen".
// Every step is continuous in the view, so the start glides rather than
// jumps while the wheel turns or flies.
//
// Its route (`leaderPath`). From the start it rises at 60° to an elbow,
// then runs square into the card: horizontally into its left edge on
// desktop, vertically into its bottom edge on a phone. A start below a
// desktop card's left edge enters the bottom edge instead, one above a
// card enters its top edge, so the line never crosses the card.
//
// Once tip names show, a tip's leader first runs straight out along its own
// row, past the end of the whole column of names (`columnLead`), and only
// then rises: the rise never crosses a neighbour's name, so none has to be
// shortened to make way for it.
// Pure geometry here; labels.ts draws it and keeps text off it.

import type { Box } from './labelLayout';
import type { Point } from './layout';

/** The diagonal's slope: 60° from the horizontal. */
const TAN = Math.tan(Math.PI / 3);
/** The square run into the card (desktop, compact). */
const RUN = 24;
const COMPACT_RUN = 20;
/** The elbow keeps this far inside the card's ends. */
const INSET = 24;
/** The leader starts this far from an on-screen node: just outside its ring. */
export const LEADER_START_GAP = 8;
/** The free area keeps this far from the screen's edges and the card, and stops this far above the bottom (the HUD band). */
const MARGIN = 12;
const BOTTOM = 56;
const CARD_CLEAR = 8;
/** An off-screen start's arrowhead fades in over this distance to the stem, px. */
const ARROW_FADE_PX = 24;
/** A clade's start slides to the rim as its node goes this far off screen, px. */
const RIM_SLIDE_PX = 240;

function smooth(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

/** Where the leader starts, and, when the selection is off screen, which way it lies. */
export interface LeaderStart {
  p: Point;
  /** Unit vector from `p` towards the off-screen selection, and the arrowhead's opacity (0 on screen). */
  toward: Point;
  arrow: number;
  /** How far the start has slid from the node to the rim, 0 to 1 (1 for a tip). */
  atRim: number;
}

/** A leader: its points (CSS px), and an arrowhead at the start when the selection is off screen. */
export interface Leader {
  path: Point[];
  arrow: { x: number; y: number; ux: number; uy: number; alpha: number } | null;
}

/** The screen less its margins and the bottom HUD band. */
function freeScreen(w: number, h: number): Box {
  return { x0: MARGIN, y0: MARGIN, x1: w - MARGIN, y1: Math.max(MARGIN, h - BOTTOM) };
}

/** True when `p` is inside `b` grown by `pad`. */
function inside(p: Point, b: Box, pad: number): boolean {
  return p.x > b.x0 - pad && p.x < b.x1 + pad && p.y > b.y0 - pad && p.y < b.y1 + pad;
}

/** The parameter range [t0, t1] of segment a→b inside box `r` (Liang–Barsky), or null. */
function clip(a: Point, b: Point, r: Box): [number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const edges: [number, number][] = [
    [-dx, a.x - r.x0],
    [dx, r.x1 - a.x],
    [-dy, a.y - r.y0],
    [dy, r.y1 - a.y],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  return [t0, t1];
}

function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** The nearest point of box `r` to `p`. */
function clampTo(p: Point, r: Box): Point {
  return { x: Math.min(r.x1, Math.max(r.x0, p.x)), y: Math.min(r.y1, Math.max(r.y0, p.y)) };
}

/** A point inside the card (grown by CARD_CLEAR) moved to its nearer free side: left or below on desktop, below on a phone. */
function outOfCard(p: Point, card: Box, screen: Box): Point {
  if (!inside(p, card, CARD_CLEAR)) return p;
  const below = { x: p.x, y: card.y1 + CARD_CLEAR };
  const left = { x: card.x0 - CARD_CLEAR, y: p.y };
  const canLeft = left.x >= screen.x0;
  if (!canLeft || below.y - p.y < p.x - left.x) return below;
  return left;
}

/**
 * Where the leader starts for a selection whose stem runs from `node` to
 * `rim` (CSS px; the same point for a tip), on a w × h screen with the card.
 */
export function leaderStart(node: Point, rim: Point, anchor: Point, card: Box, w: number, h: number): LeaderStart {
  const screen = freeScreen(w, h);
  const none = { x: 0, y: 0 };
  // The stem's first free point from the node: inside the screen, past the card.
  const tip = node.x === rim.x && node.y === rim.y;
  const span = clip(node, rim, screen);
  if (span) {
    const nc = clampTo(node, screen);
    const off = Math.hypot(node.x - nc.x, node.y - nc.y);
    const atRim = tip ? 1 : smooth(off / RIM_SLIDE_PX);
    const t = span[0] + (span[1] - span[0]) * atRim;
    const q = lerp(node, rim, t);
    const p = outOfCard(q, card, screen);
    if (!inside(p, card, CARD_CLEAR - 0.5)) {
      // Behind the card: start beside it, pointing in.
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      const toward = d > 0 ? { x: (q.x - p.x) / d, y: (q.y - p.y) / d } : none;
      return { p, toward, arrow: smooth(d / ARROW_FADE_PX), atRim };
    }
  }
  // Off screen (or behind the card): the stem's point nearest the screen
  // (distance to a box is convex along a line, so a ternary search finds it).
  let lo = 0;
  let hi = 1;
  const dist = (t: number): number => {
    const q = lerp(node, rim, t);
    const c = clampTo(q, screen);
    return Math.hypot(q.x - c.x, q.y - c.y);
  };
  for (let i = 0; i < 60; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (dist(m1) <= dist(m2)) hi = m2;
    else lo = m1;
  }
  const target = lerp(node, rim, (lo + hi) / 2);
  // Where the ray from the anchor towards it leaves the free area (the
  // anchor is inside it); at the edge itself that is the target, so the
  // start does not jump as the stem leaves the screen.
  const from = clampTo(anchor, screen);
  const leave = clip(from, target, screen);
  const edge = leave ? lerp(from, target, leave[1]) : clampTo(target, screen);
  const p = outOfCard(edge, card, screen);
  const dx = target.x - p.x;
  const dy = target.y - p.y;
  const d = Math.hypot(dx, dy);
  const arrow = d / ARROW_FADE_PX;
  return { p, toward: d > 0 ? { x: dx / d, y: dy / d } : none, arrow: smooth(arrow), atRim: tip ? 1 : 0 };
}

/**
 * Moves an on-screen start `run` px along `out` (the selection's outward
 * direction), past the names once tip names show (a tip's own name, a
 * clade's column of names), so the leader leaves from there instead of
 * crossing its neighbours' names. The caller scales `run` by `atRim`. It
 * stays in the free area; off screen (arrow shown) it moves less, and not
 * at all once the arrow is fully in.
 */
export function afterName(start: LeaderStart, out: Point, run: number, card: Box, w: number, h: number): LeaderStart {
  const k = run * (1 - start.arrow);
  if (k <= 0) return start;
  const screen = freeScreen(w, h);
  const p = outOfCard(clampTo({ x: start.p.x + out.x * k, y: start.p.y + out.y * k }, screen), card, screen);
  return { ...start, p };
}

/** The square run's room before the card, and the gap past the name column, px. */
const COLUMN_GAP = 24;

/**
 * Where a tip's leader turns, once names show: `run` px further along `out`
 * from the start (the rest of the name column beyond its own name, plus
 * COLUMN_GAP), but never closer to the card than its square run or out of
 * the free area. Null when there is nothing to add (off screen, or the
 * column ends at its own name).
 */
export function columnLead(start: LeaderStart, out: Point, run: number, card: Box, compact: boolean, w: number, h: number): Point | null {
  if (run <= 0 || start.arrow > 0.01) return null;
  const screen = freeScreen(w, h);
  let k = run + COLUMN_GAP;
  // Stop short of the card's left edge (desktop) or the screen's right margin (phone).
  const limitX = compact ? screen.x1 - INSET : card.x0 - RUN - 16;
  if (out.x > 1e-6) k = Math.min(k, (limitX - start.p.x) / out.x);
  if (k <= 1) return null;
  const p = clampTo({ x: start.p.x + out.x * k, y: start.p.y + out.y * k }, screen);
  if (inside(p, card, CARD_CLEAR)) return null;
  return p;
}

/** The leader from `start` into `card`, by way of `lead` (columnLead) when given. */
export function leaderPath(start: LeaderStart, card: Box, compact: boolean, lead: Point | null = null): Leader {
  const from = lead ?? start.p;
  let path: Point[];
  if (!compact && from.x <= card.x0 - 8) path = intoLeft(from, card);
  else if (from.y >= card.y1 + 8) path = intoBottom(from, card, compact ? COMPACT_RUN : RUN);
  else if (from.y <= card.y0 - 8) path = intoTop(from, card);
  else path = [from, clampTo(from, card)];
  if (lead) path = [start.p, ...path];
  // On screen the line starts just outside the ring; off screen, at the edge.
  path = trimStart(path, LEADER_START_GAP * (1 - start.arrow));
  const p0 = path[0] ?? from;
  const arrow = start.arrow > 0.01 ? { x: p0.x, y: p0.y, ux: start.toward.x, uy: start.toward.y, alpha: start.arrow } : null;
  return { path, arrow };
}

/** Desktop: up at 60° to an elbow, then horizontally into the card's left edge. */
function intoLeft(from: Point, card: Box): Point[] {
  const edge = card.x0;
  // The height the diagonal reaches ending RUN short of the card, kept within the card's side.
  const ideal = from.y - (edge - RUN - from.x) * TAN;
  const y = Math.min(card.y1 - INSET, Math.max(card.y0 + INSET, ideal));
  let ex = from.x + Math.abs(from.y - y) / TAN;
  // Too close for a 60° rise: a steeper diagonal straight to just short of the edge.
  if (ex > edge - 8) ex = edge - 8;
  return [from, { x: ex, y }, { x: edge, y }];
}

/** Below the card: up at 60° to an elbow under it, then vertically into its bottom edge. */
function intoBottom(from: Point, card: Box, run: number): Point[] {
  const edge = card.y1;
  const rise = Math.max(0, from.y - edge - run);
  const x = Math.min(card.x1 - INSET, Math.max(card.x0 + INSET, from.x + rise / TAN));
  if (rise === 0) return [from, { x, y: edge }];
  return [from, { x, y: edge + run }, { x, y: edge }];
}

/** Above the card: down at 60° to an elbow over it, then vertically into its top edge. */
function intoTop(from: Point, card: Box): Point[] {
  const edge = card.y0;
  const drop = Math.max(0, edge - COMPACT_RUN - from.y);
  const x = Math.min(card.x1 - INSET, Math.max(card.x0 + INSET, from.x + drop / TAN));
  if (drop === 0) return [from, { x, y: edge }];
  return [from, { x, y: edge - COMPACT_RUN }, { x, y: edge }];
}

/** Moves the first point `gap` px along the first segment (or as far as it goes). */
function trimStart(path: Point[], gap: number): Point[] {
  const [a, b] = path;
  if (!a || !b || gap <= 0) return path;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const t = len > 0 ? Math.min(gap, len) / len : 0;
  return [{ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, ...path.slice(1)];
}

/**
 * Boxes along the leader, padded, for text to keep clear of. The first
 * `skip` px are left out: there the leader leaves the node beside the
 * node's own name, which it clears by its 60° rise.
 */
export function leaderBoxes(path: readonly Point[], pad: number, skip = 0): Box[] {
  const out: Box[] = [];
  let walked = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    if (!a || !b) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    // A long diagonal's box is mostly empty: split it so labels beside it survive.
    const steps = Math.max(1, Math.ceil(len / 12));
    for (let k = 0; k < steps; k++) {
      const t0 = k / steps;
      const t1 = (k + 1) / steps;
      if (walked + len * t1 <= skip) continue;
      const p = lerp(a, b, t0);
      const q = lerp(a, b, t1);
      out.push({
        x0: Math.min(p.x, q.x) - pad,
        y0: Math.min(p.y, q.y) - pad,
        x1: Math.max(p.x, q.x) + pad,
        y1: Math.max(p.y, q.y) + pad,
      });
    }
    walked += len;
  }
  return out;
}
