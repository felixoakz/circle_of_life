// "Species in view" (PLAN §7.10): tips are evenly spaced around the rim, so
// the count is exact and cheap: intersect the rim circle with the screen
// rectangle, then count the tip angles inside the visible arcs.
//
// The rim is a circle on screen with centre o and radius R (device px).
// Where it crosses the four screen edges splits it into arcs that are wholly
// inside or outside; a midpoint test tells which. At deep zoom R is ~10^7 px
// and the visible arcs are ~10^-5 rad; doubles keep that far below a tip.

import { TAU } from './angle';
import type { Camera } from './camera';

/** An interval of world angles [lo, lo + len], radians, lo in [0, 2π). */
export interface Arc {
  lo: number;
  len: number;
}

/**
 * Arcs of the circle (centre `ox, oy`, radius `r`; screen y down) inside the
 * rectangle [0, w] × [0, h], as screen angles (y up, counter-clockwise).
 */
export function circleInRect(ox: number, oy: number, r: number, w: number, h: number): Arc[] {
  const cuts: number[] = [];
  // x = X  →  cos φ = (X − ox) / r;   y = Y  →  sin φ = (oy − Y) / r.
  for (const X of [0, w]) {
    const c = (X - ox) / r;
    if (c <= -1 || c >= 1) continue;
    const s = Math.sqrt((1 - c) * (1 + c));
    cuts.push(Math.atan2(s, c), Math.atan2(-s, c));
  }
  for (const Y of [0, h]) {
    const s = (oy - Y) / r;
    if (s <= -1 || s >= 1) continue;
    const c = Math.sqrt((1 - s) * (1 + s));
    cuts.push(Math.atan2(s, c), Math.atan2(s, -c));
  }
  const inside = (phi: number): boolean => {
    const x = ox + r * Math.cos(phi);
    const y = oy - r * Math.sin(phi);
    return x >= 0 && x <= w && y >= 0 && y <= h;
  };
  if (cuts.length === 0) return inside(0) ? [{ lo: 0, len: TAU }] : [];
  const norm = cuts.map((p) => (p < 0 ? p + TAU : p)).sort((a, b) => a - b);
  const arcs: Arc[] = [];
  for (let i = 0; i < norm.length; i++) {
    const a = norm[i] ?? 0;
    const next = i + 1 < norm.length ? (norm[i + 1] ?? 0) : (norm[0] ?? 0) + TAU;
    const len = next - a;
    if (len <= 0) continue;
    if (inside(a + len / 2)) arcs.push({ lo: a, len });
  }
  return arcs;
}

/** Tips k = 0…n−1 sit at world angle (k + ½)·2π/n; how many lie in the arc. */
export function tipsInArc(arc: Arc, n: number): number {
  if (arc.len >= TAU) return n;
  let lo = arc.lo % TAU;
  if (lo < 0) lo += TAU;
  const a = (lo * n) / TAU - 0.5;
  const b = ((lo + arc.len) * n) / TAU - 0.5;
  return Math.max(0, Math.floor(b) - Math.ceil(a) + 1);
}

/** Number of tips whose rim point is on screen, or null when the rim is off screen. */
export function tipsInView(cam: Camera, n: number): number | null {
  const o = cam.worldToScreen(0, 0);
  const arcs = circleInRect(o.x, o.y, cam.scale, cam.width, cam.height);
  if (arcs.length === 0) return null;
  let count = 0;
  // Screen angle = world angle + rotation (camera.ts).
  for (const arc of arcs) count += tipsInArc({ lo: arc.lo - cam.rot, len: arc.len }, n);
  return Math.min(n, count);
}
