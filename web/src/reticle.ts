// The node under the screen centre, for the breadcrumb (PLAN §7.10), found
// in the loaded tiles.
//
// A node "owns" the wedge between its parent's radius and the rim over its
// arc: its stem, and everything of its subtree. The centre point (θ, ρ)
// therefore belongs to every node whose arc contains θ and whose parent sits
// at ρ or further in; the deepest of them (largest r) is the one under the
// reticle. Only levels already drawn (≤ V) count, so the breadcrumb matches
// the picture. Every such node is in a loaded tile: its arc contains θ,
// which is on screen, and tiles are fetched for the visible range widened
// by the span bound (PLAN §3.6).

import type { Tile } from './tiles/decode';

export interface ReticleNode {
  id: number;
  r: number;
}

/**
 * Deepest node containing angle `theta` (u32 units) whose parent radius is
 * ≤ `rho`, among tiles with level ≤ `maxLevel`. A tip contains the angles
 * within half a tip slot (`halfSlot`, u32 units) of it.
 */
export function nodeAtReticle(
  tiles: readonly Tile[],
  theta: number,
  rho: number,
  maxLevel: number,
  halfSlot: number,
): ReticleNode | null {
  let best: ReticleNode | null = null;
  for (const t of tiles) {
    if (t.level > maxLevel) continue;
    for (let i = 0; i < t.count; i++) {
      const r = t.r[i] ?? 0;
      if (best && r <= best.r) continue;
      if ((t.parentR[i] ?? 0) > rho) continue;
      const lo = (t.arcLo[i] ?? 0) - halfSlot;
      const hi = (t.arcHi[i] ?? 0) + halfSlot;
      // Strict for tips, so the angle exactly between two tips picks neither.
      const isTip = i >= t.internalCount;
      if (isTip ? theta > lo && theta < hi : theta >= lo && theta <= hi) {
        best = { id: t.id[i] ?? 0, r };
      }
    }
  }
  return best;
}
