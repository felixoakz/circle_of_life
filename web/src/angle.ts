// u32 fixed-point angles (ARCHITECTURE §3.3): θ = a / 2^32 · 2π.
// Tiles store angles this way so differences wrap exactly; JS numbers hold
// them as plain non-negative integers in [0, 2^32).

export const TWO_32 = 4294967296;
export const TAU = Math.PI * 2;
/** Radians per u32 unit (≈ 1.46e-9). */
export const RAD_PER_UNIT = TAU / TWO_32;

/** u32 angle → radians in [0, 2π). Fractional units are allowed. */
export function toRad(a: number): number {
  return a * RAD_PER_UNIT;
}

/** Radians (any value) → angle units in [0, 2^32), keeping the fraction. */
export function fromRad(rad: number): number {
  let t = (rad / TAU) % 1;
  if (t < 0) t += 1;
  const a = t * TWO_32;
  return a >= TWO_32 ? 0 : a;
}

/**
 * The angle of tip `rank` out of `tipCount`, the middle of its slot (ARCHITECTURE
 * §3.3, the same integer the ingest computes): ⌊(2·rank + 1) · 2^31 / N⌋.
 */
export function tipAngle(rank: number, tipCount: number): number {
  // (2·rank + 1) · 2^31 is exact in a double (rank < 2^22, times a power of 2).
  return Math.floor(((2 * rank + 1) * 2 ** 31) / tipCount);
}

/**
 * A clade's extent on the rim in u32 units, from the start of its first
 * tip's slot to the end of its last one: its tips are ranks firstTip ..
 * firstTip + leafCount − 1 (tile format v2). Returns [lo, span].
 */
export function cladeRim(firstTip: number, leafCount: number, tipCount: number): [number, number] {
  const slot = TWO_32 / tipCount;
  return [firstTip * slot, leafCount * slot];
}

/** Wraps any number of units into [0, 2^32). */
export function wrap(a: number): number {
  const w = a % TWO_32;
  return w < 0 ? w + TWO_32 : w;
}

/**
 * Signed shortest difference a − b in units, in [−2^31, 2^31).
 * Works for fractional inputs too (unlike `| 0`, which drops the fraction).
 */
export function wrapDiff(a: number, b: number): number {
  let d = (a - b) % TWO_32;
  if (d >= TWO_32 / 2) d -= TWO_32;
  else if (d < -TWO_32 / 2) d += TWO_32;
  return d;
}

/** Wraps radians into (−π, π]. */
export function wrapRad(rad: number): number {
  let r = rad % TAU;
  if (r > Math.PI) r -= TAU;
  else if (r <= -Math.PI) r += TAU;
  return r;
}

/** Width of one sector at `level`, in units (2^32 at level 0). */
export function sectorWidth(level: number): number {
  return 2 ** (32 - level);
}

/** Sector index of an integer angle at `level` (ARCHITECTURE §3.6). */
export function sectorOf(a: number, level: number): number {
  // `>>> 32` is a no-op in JS (shift counts are taken mod 32), so level 0 is
  // special-cased, as in the server's tree.SectorOf.
  return level === 0 ? 0 : Math.floor(a) >>> (32 - level);
}

/** An angular interval: `lo` in [0, 2^32), `span` in [0, 2^32]. Wraps through 0. */
export interface AngleRange {
  lo: number;
  span: number;
}

export const FULL_CIRCLE: AngleRange = { lo: 0, span: TWO_32 };

/** Widens a range by `margin` units on both sides (saturating at the full circle). */
export function widen(range: AngleRange, margin: number): AngleRange {
  const span = range.span + 2 * margin;
  if (span >= TWO_32) return FULL_CIRCLE;
  return { lo: wrap(range.lo - margin), span };
}

/**
 * Sector indices at `level` that intersect `range`, in order from `range.lo`.
 * Returns every sector when the range covers the circle.
 */
export function sectorsIn(range: AngleRange, level: number): number[] {
  const n = 2 ** level;
  // A span within one sector of the full circle may end in the sector it
  // started in, which the count below would read as a single sector.
  if (range.span >= TWO_32 - sectorWidth(level)) return Array.from({ length: n }, (_, i) => i);
  const first = sectorOf(range.lo, level);
  const last = sectorOf(wrap(range.lo + range.span), level);
  const count = Math.min(n, ((last - first + n) % n) + 1);
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push((first + i) % n);
  return out;
}
