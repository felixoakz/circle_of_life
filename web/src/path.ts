// Geometry of a highlighted root→node path (ARCHITECTURE §7.3 pass 5), as the
// renderer draws it: for each step from a parent to its child, the parent's
// arc from the parent's angle to the child's, then the child's radial
// segment out to the child's radius. Arcs never wrap through angle 0
// (ARCHITECTURE §3.3), so an arc is just [min, max] of the two angles.
//
// The points come from `/api/nodes` (lineage + the node: the whole way to
// the root) or, while that is loading, from the loaded tiles' parent links
// (`tilePoints`: as far up as tiles reach).

import type { TileIndex } from './picking';

export interface PathPoint {
  /** u32 angle units. */
  angle: number;
  r: number;
}

/** One drawn piece: an arc (span > 0, r0 = r1) or a radial segment (span = 0). */
export interface PathSeg {
  /** Start angle, u32 units, and the counter-clockwise span (0 for a radial segment). */
  a0: number;
  span: number;
  r0: number;
  r1: number;
}

/** Words per segment in the GPU buffer: a0, span (u32), r0, r1 (f32). */
export const PATH_WORDS = 4;

/**
 * Segments for points ordered root → node. `startR` adds the first point's
 * own radial segment from that radius (a partial path whose parent is not
 * known); `endR` carries the last segment on to that radius (a tip's line to
 * the rim, or Homo sapiens, which is drawn as a tip).
 */
export function pathSegments(points: readonly PathPoint[], startR?: number, endR?: number): PathSeg[] {
  const out: PathSeg[] = [];
  const first = points[0];
  if (!first) return out;
  if (startR !== undefined && startR < first.r) out.push({ a0: first.angle, span: 0, r0: startR, r1: first.r });
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1];
    const c = points[i];
    if (!p || !c) continue;
    if (c.angle !== p.angle) {
      out.push({ a0: Math.min(p.angle, c.angle), span: Math.abs(c.angle - p.angle), r0: p.r, r1: p.r });
    }
    if (c.r > p.r) out.push({ a0: c.angle, span: 0, r0: p.r, r1: c.r });
  }
  const last = points[points.length - 1];
  if (last && endR !== undefined && endR > last.r) out.push({ a0: last.angle, span: 0, r0: last.r, r1: endR });
  return out;
}

/**
 * The path to `id` as far up as the loaded tiles reach: points root-most
 * first, and the radius the top point's own segment starts from. Homo
 * sapiens' subspecies are drawn at the species' angle, so `homeAngle`
 * replaces their own.
 */
export function tilePoints(
  index: TileIndex,
  id: number,
  homeId: number,
  homeAngle: number,
): { points: PathPoint[]; startR: number } | null {
  const points: PathPoint[] = [];
  let startR = 0;
  let cur = index.get(id);
  // A lineage is at most ~110 deep (ARCHITECTURE §2.2); the cap guards bad data.
  for (let guard = 0; cur && guard < 512; guard++) {
    const { tile, index: i } = cur;
    const parent = tile.parent[i] ?? 0xffffffff;
    const merged = homeId >= 0 && parent === homeId && i >= tile.internalCount;
    points.push({ angle: merged ? homeAngle : (tile.angle[i] ?? 0), r: tile.r[i] ?? 0 });
    startR = tile.parentR[i] ?? 0;
    if (parent === 0xffffffff) break;
    cur = index.get(parent);
  }
  if (points.length === 0) return null;
  points.reverse();
  return { points, startR };
}

/** Packs segments for the renderer's path buffer (PATH_WORDS per segment). */
export function encodePath(segs: readonly PathSeg[]): Uint32Array {
  const words = new Uint32Array(segs.length * PATH_WORDS);
  const floats = new Float32Array(words.buffer);
  segs.forEach((s, k) => {
    const o = k * PATH_WORDS;
    words[o] = s.a0 >>> 0;
    words[o + 1] = s.span >>> 0;
    floats[o + 2] = s.r0;
    floats[o + 3] = s.r1;
  });
  return words;
}
