// Frontier fans: where the tree is cut off by the level of detail.
//
// A drawn node D may have children that are not drawn yet (their level is
// above the view level). Children are ladderized by ascending leaf count and
// a node's level only grows as its leaf count shrinks, so the undrawn
// children are always a contiguous *prefix* of D's children: angles from
// arc_lo up to D's first drawn child. Each of them covers less than ~1 px of
// rim, and all of them branch off D at r_D, so together they look like a
// solid fan from r_D to the rim. Drawing that fan keeps every lineage
// reaching the rim at any zoom (the frontier extension of PLAN §3.5, widened
// from one line to the whole undrawn prefix).
//
// Children at level F (the last fully loaded level) are still fading in, so
// each node gets up to two fans: [arc_lo, first child at level ≤ F) at full
// strength and [that, first child at level ≤ F − 1) fading out as level F
// fades in. Both come out as instances of 4 u32 words, widest fan first:
//   lo, hi   angle range (u32 units)
//   r        D's radius (f32 bits)
//   meta     D's level | 0x100 when the fan fades out with level F

import type { Tile } from './decode';

export const FAN_WORDS = 4;
export const FAN_FADING = 0x100;

const NO_PARENT = 0xffffffff;

export function buildFans(tiles: readonly Tile[], fullLevel: number): Uint32Array {
  // First drawn child angle per parent id: `a` over levels ≤ F − 1, `b` over ≤ F.
  const firstA = new Map<number, number>();
  const firstB = new Map<number, number>();
  for (const t of tiles) {
    if (t.level > fullLevel) continue;
    const solid = t.level < fullLevel;
    for (let i = 0; i < t.count; i++) {
      const p = t.parent[i] ?? NO_PARENT;
      if (p === NO_PARENT) continue;
      const a = t.angle[i] ?? 0;
      if (a < (firstB.get(p) ?? Infinity)) firstB.set(p, a);
      if (solid && a < (firstA.get(p) ?? Infinity)) firstA.set(p, a);
    }
  }

  const fans: [number, number, number, number][] = [];
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  for (const t of tiles) {
    if (t.level > fullLevel) continue;
    for (let i = 0; i < t.internalCount; i++) {
      const id = t.id[i] ?? 0;
      const lo = t.arcLo[i] ?? 0;
      const hi = t.arcHi[i] ?? 0;
      if (hi <= lo) continue; // monotypic: its single child is a straight line
      // With no drawn child the whole arc is undrawn.
      const endB = Math.min(firstB.get(id) ?? hi, hi);
      const endA = Math.min(firstA.get(id) ?? hi, hi);
      f32[0] = t.r[i] ?? 0;
      const r = u32[0] ?? 0;
      if (endB > lo) fans.push([lo, endB, r, t.level]);
      if (endA > endB) fans.push([endB, endA, r, t.level | FAN_FADING]);
    }
  }
  // Widest first, so the renderer can give only the wide ones many steps.
  fans.sort((x, y) => y[1] - y[0] - (x[1] - x[0]));
  const out = new Uint32Array(fans.length * FAN_WORDS);
  fans.forEach((f, i) => out.set(f, i * FAN_WORDS));
  return out;
}
