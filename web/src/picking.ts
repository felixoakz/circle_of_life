// CPU hit testing over the loaded tiles, in doubles (ARCHITECTURE §7.8).
//
// The pointer is turned into polar coordinates (θ in u32 units, ρ in world
// units) by the camera; everything here compares those with node geometry
// and measures distances in device px (× scale), so it is exact at any zoom.
//
// What can be hit is what is drawn: only tiles at levels ≤ V (the view
// level), and a node's radial line runs on to the rim while its children
// are not drawn (its frontier extension, ARCHITECTURE §3.5). In priority order:
//   1. In the rim zone (from the inner end of the tip bars to just past the
//      spikes): the nearest tip within half a tip slot, found by binary
//      search in each tile's tip run (sorted by angle); else the deepest
//      frontier clade whose tips contain θ (the spike or fur under the
//      pointer).
//   2. Elsewhere: the radial segment or arc nearest the pointer, within
//      the tolerance; ties go to the deeper node.
// Homo sapiens' two subspecies are drawn as one bar at the species' angle
// (renderer), so either tip, or that bar, picks Homo sapiens itself.

import { RAD_PER_UNIT, cladeRim, wrapDiff } from './angle';
import type { Tile } from './tiles/decode';

export interface PickQuery {
  /** Pointer angle, u32 units (fractional allowed). */
  theta: number;
  /** Pointer radius, world units. */
  rho: number;
  /** Device px per world unit. */
  scale: number;
  /** View level V: tiles above it are not drawn. */
  level: number;
  tipCount: number;
  /** Pre-order id and angle of the home node (Homo sapiens), or −1. */
  homeId: number;
  homeAngle: number;
  /** Hit tolerance, device px (larger for touch). */
  tolPx: number;
  /** The rim zone reaches this far inside the rim (tip bars) and outside it (spikes), device px. */
  rimInPx: number;
  rimOutPx: number;
}

export interface Pick {
  id: number;
  tile: Tile;
  index: number;
  /** Distance from the pointer to what was hit, device px. */
  distPx: number;
}

const HALF_PI = Math.PI / 2;
/** 2/π: on |x| ≤ π/2, |sin x| ≥ (2/π)|x|. */
const SIN_LOWER = 2 / Math.PI;

export function pick(tiles: readonly Tile[], q: PickQuery): Pick | null {
  const rimPx = (q.rho - 1) * q.scale;
  const inRim = rimPx >= -q.rimInPx - q.tolPx && rimPx <= q.rimOutPx + q.tolPx;
  if (inRim) {
    const tip = nearestTip(tiles, q);
    if (tip) return tip;
    const frontier = frontierAt(tiles, q);
    if (frontier) return frontier;
  }
  return nearestLine(tiles, q);
}

/** The tip nearest θ within half a slot (or the tolerance), home subspecies merged into Homo sapiens. */
function nearestTip(tiles: readonly Tile[], q: PickQuery): Pick | null {
  const slotPx = (2 ** 32 / q.tipCount) * RAD_PER_UNIT * q.scale;
  const reach = Math.max(slotPx / 2, q.tolPx);
  let best: Pick | null = null;
  for (const t of tiles) {
    if (t.level > q.level || t.internalCount === t.count) continue;
    // First tip with angle ≥ θ (tips of one tile never wrap: one sector).
    let lo = t.internalCount;
    let hi = t.count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((t.angle[mid] ?? 0) < q.theta) lo = mid + 1;
      else hi = mid;
    }
    for (const i of [lo - 1, lo]) {
      if (i < t.internalCount || i >= t.count) continue;
      const home = q.homeId >= 0 && t.parent[i] === q.homeId;
      const own = Math.abs(wrapDiff(q.theta, t.angle[i] ?? 0));
      // A merged subspecies counts over its own slot and over the shared bar.
      const units = home ? Math.min(own, Math.abs(wrapDiff(q.theta, q.homeAngle))) : own;
      const d = units * RAD_PER_UNIT * q.scale;
      if (d <= reach && (!best || d < best.distPx)) best = { id: home ? q.homeId : (t.id[i] ?? 0), tile: t, index: i, distPx: d };
    }
  }
  return best;
}

/** The deepest drawn node whose children are not drawn and whose tips contain θ. */
function frontierAt(tiles: readonly Tile[], q: PickQuery): Pick | null {
  let best: Pick | null = null;
  let bestR = -1;
  for (const t of tiles) {
    if (t.level > q.level) continue;
    for (let i = 0; i < t.internalCount; i++) {
      if ((t.childLevel[i] ?? 255) <= q.level) continue;
      const r = t.r[i] ?? 0;
      if (r <= bestR) continue;
      const [lo, span] = cladeRim(t.firstTip[i] ?? 0, t.leafCount[i] ?? 1, q.tipCount);
      const u = q.theta - lo; // clades never wrap through angle 0
      if (u >= 0 && u <= span) {
        best = { id: t.id[i] ?? 0, tile: t, index: i, distPx: 0 };
        bestR = r;
      }
    }
  }
  return best;
}

/** The radial segment or arc nearest the pointer, within the tolerance. */
function nearestLine(tiles: readonly Tile[], q: PickQuery): Pick | null {
  const { rho, scale, tolPx } = q;
  let best: Pick | null = null;
  let bestR = -1;
  const consider = (t: Tile, i: number, id: number, d: number, r: number): void => {
    if (d > tolPx) return;
    if (!best || d < best.distPx - 0.5 || (d < best.distPx + 0.5 && r > bestR)) {
      best = { id, tile: t, index: i, distPx: d };
      bestR = r;
    }
  };
  for (const t of tiles) {
    if (t.level > q.level) continue;
    for (let i = 0; i < t.count; i++) {
      const isTip = i >= t.internalCount;
      const home = isTip && q.homeId >= 0 && t.parent[i] === q.homeId;
      const angle = home ? q.homeAngle : (t.angle[i] ?? 0);
      const r = t.r[i] ?? 0;
      const id = home ? q.homeId : (t.id[i] ?? 0);
      // Radial segment, on to the rim while the children are not drawn.
      const r0 = t.parentR[i] ?? 0;
      const r1 = !isTip && (t.childLevel[i] ?? 255) > q.level ? 1 : r;
      const dth = wrapDiff(q.theta, angle) * RAD_PER_UNIT;
      const adth = Math.abs(dth);
      // Cheap lower bounds first: most segments are far off to the side.
      const far = adth < HALF_PI ? rho * SIN_LOWER * adth * scale > tolPx : rho * scale > tolPx;
      if (!far && r1 > r0) {
        const x = rho * Math.cos(dth);
        const y = rho * Math.sin(dth);
        const cx = Math.min(r1, Math.max(r0, x));
        consider(t, i, id, Math.hypot(x - cx, y) * scale, r1);
      }
      // Arc at the node's radius, between its first and last child.
      if (!isTip) {
        const lo = t.arcLo[i] ?? 0;
        const span = (t.arcHi[i] ?? 0) - lo;
        if (span > 0) {
          // Arcs never wrap through angle 0 (ARCHITECTURE §3.3).
          const u = q.theta - lo;
          if (u >= 0 && u <= span) consider(t, i, id, Math.abs(rho - r) * scale, r);
        }
      }
    }
  }
  return best;
}

/** Where each loaded node lives, for walking parent links (hover paths). */
export class TileIndex {
  private readonly map = new Map<number, { tile: Tile; index: number }>();
  private source: readonly Tile[] = [];

  /** Rebuilds the index when the tile list changed (cheap to call every frame). */
  update(tiles: readonly Tile[]): void {
    if (tiles.length === this.source.length && tiles.every((t, k) => t === this.source[k])) return;
    this.source = tiles;
    this.map.clear();
    for (const t of tiles) {
      for (let i = 0; i < t.count; i++) this.map.set(t.id[i] ?? 0, { tile: t, index: i });
    }
  }

  get(id: number): { tile: Tile; index: number } | undefined {
    return this.map.get(id);
  }
}
