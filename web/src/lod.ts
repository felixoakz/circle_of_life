// Level of detail (ARCHITECTURE §3.6): continuous view level λ, integer level V, the
// angular range on screen, and which tiles to fetch, in priority order.

import {
  type AngleRange,
  FULL_CIRCLE,
  RAD_PER_UNIT,
  TWO_32,
  fromRad,
  sectorWidth,
  sectorsIn,
  widen,
  wrap,
  wrapDiff,
  wrapRad,
} from './angle';
import type { Camera } from './camera';

/**
 * A level is fetched only if it needs at most this many sectors. With the
 * whole circle in view that is exactly the budget rule (levels ≤ 6, ≤ 127
 * tiles); it also guards views hugging the origin, where the angular range
 * is wide but deep nodes are almost never present.
 */
export const MAX_SECTORS_PER_LEVEL = 64;
/** Screen margin (px) when deciding what is visible. */
const VIEW_MARGIN_PX = 4;
/** Nothing is drawn further out than the rim plus a few px of marks. */
const RIM_REACH_PX = 24;

export function viewLevel(lambda: number, maxLevel: number): number {
  return Math.max(0, Math.min(maxLevel, Math.floor(lambda)));
}

/** `smoothstep(level, level + 0.6, λ)`, the per-level fade-in (level 0 is always on). */
export function levelFade(level: number, lambda: number): number {
  if (level === 0) return 1;
  const t = Math.min(1, Math.max(0, (lambda - level) / 0.6));
  return t * t * (3 - 2 * t);
}

export function tileKey(level: number, sector: number): number {
  return level * 65536 + sector;
}

export function keyLevel(key: number): number {
  return Math.floor(key / 65536);
}

export function keySector(key: number): number {
  return key % 65536;
}

/**
 * The angular range of the screen seen from the origin, or `null` when the
 * screen is entirely outside the rim. The screen is a convex polygon, so if
 * it does not contain the origin its extreme angles are at its corners
 * (relative to the centre's angle, they all lie within ±π).
 */
export function visibleRange(cam: Camera): AngleRange | null {
  const m = VIEW_MARGIN_PX;
  const o = cam.worldToScreen(0, 0);
  const x0 = -m;
  const y0 = -m;
  const x1 = cam.width + m;
  const y1 = cam.height + m;
  if (o.x >= x0 && o.x <= x1 && o.y >= y0 && o.y <= y1) return FULL_CIRCLE;

  const gapX = Math.max(x0 - o.x, 0, o.x - x1);
  const gapY = Math.max(y0 - o.y, 0, o.y - y1);
  if (Math.hypot(gapX, gapY) / cam.scale > 1 + RIM_REACH_PX / cam.scale) return null;

  let lo = Infinity;
  let hi = -Infinity;
  for (const [px, py] of [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
  ] as const) {
    const w = cam.screenToWorld(px, py);
    const d = wrapRad(Math.atan2(w.y, w.x) - cam.angle);
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  }
  return { lo: wrap(fromRad(cam.angle) + lo / RAD_PER_UNIT), span: (hi - lo) / RAD_PER_UNIT };
}

export interface View {
  lambda: number;
  /** Integer view level V. */
  level: number;
  /** Visible angular range, or null when off the rim. */
  range: AngleRange | null;
  /** Highest level that is fetched (≤ level; lower under the sector budget). */
  fetchLevel: number;
  /** Tile keys, lowest level first, then nearest to the view centre. */
  keys: number[];
}

export function computeView(cam: Camera, tileP: number, maxLevel: number): View {
  const lambda = cam.lambda(tileP);
  const level = viewLevel(lambda, maxLevel);
  const range = visibleRange(cam);
  const centre = fromRad(cam.angle);
  const keys: number[] = [];
  let fetchLevel = 0;

  // Off the rim: keep only the root tile wanted, so the coarse tree stays put.
  const levels = range ? level : 0;
  const r = range ?? FULL_CIRCLE;
  for (let L = 0; L <= levels; L++) {
    // A node's arc reaches less than W_L/P beyond its sector (ARCHITECTURE §3.6).
    const sectors = sectorsIn(widen(r, Math.ceil(sectorWidth(L) / tileP)), L);
    if (sectors.length > MAX_SECTORS_PER_LEVEL) break;
    const w = sectorWidth(L);
    const dist = (s: number): number => Math.abs(wrapDiff((s + 0.5) * w, centre));
    sectors.sort((a, b) => dist(a) - dist(b));
    for (const s of sectors) keys.push(tileKey(L, s));
    fetchLevel = L;
  }
  return { lambda, level, range, fetchLevel, keys };
}

/** The visible range as shader uniforms: start and span in u32 units (span 2^32 − 1 = everything). */
export function rangeUniforms(range: AngleRange | null): { lo: number; span: number } {
  if (!range || range.span >= TWO_32 - 1) return { lo: 0, span: TWO_32 - 1 };
  return { lo: Math.floor(range.lo), span: Math.min(TWO_32 - 1, Math.ceil(range.span) + 1) };
}

/**
 * Radii [min, max] that can appear on screen (with a small margin). Shaders
 * clamp branch endpoints to it, so lines never reach far off screen.
 */
export function radialWindow(cam: Camera): [number, number] {
  const m = VIEW_MARGIN_PX + 2;
  const o = cam.worldToScreen(0, 0);
  const gapX = Math.max(-m - o.x, 0, o.x - (cam.width + m));
  const gapY = Math.max(-m - o.y, 0, o.y - (cam.height + m));
  let far = 0;
  for (const px of [-m, cam.width + m]) {
    for (const py of [-m, cam.height + m]) far = Math.max(far, Math.hypot(px - o.x, py - o.y));
  }
  return [Math.max(0, Math.hypot(gapX, gapY) / cam.scale), far / cam.scale];
}
