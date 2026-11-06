// Pure pixel helpers for frames read back from the GPU: WebGL rows come
// bottom-up and end up as top-down RGBA8 `Pixels`. Also the precision
// comparison of two frames (the `?debug=precision` test).

import type { Pixels } from './types';

/** A copy of RGBA rows in the opposite vertical order (WebGL readPixels → top-down). */
export function flipRows(data: Uint8Array, width: number, height: number): Uint8Array {
  const row = width * 4;
  const out = new Uint8Array(row * height);
  for (let y = 0; y < height; y++) {
    out.set(data.subarray(y * row, (y + 1) * row), (height - 1 - y) * row);
  }
  return out;
}

/** The precision test's measurements (debug.ts `PrecisionResult` without `shift`). */
export interface FrameComparison {
  /** Line crossings (lit runs along pixel rows) compared between the two frames. */
  lines: number;
  /** Largest and mean offset of a line's centre after undoing the pan, px. */
  maxOffsetPx: number;
  meanOffsetPx: number;
  /** Lines with no counterpart within 3 px (missing or jumped). */
  unmatched: number;
  /** Where the largest offset was found: device px, y down. */
  maxAt: [number, number];
}

/**
 * Centres (intensity-weighted, in px) of the lit runs in one pixel row,
 * restricted to columns [x0, x1).
 */
function rowCentres(px: Uint8Array, w: number, row: number, x0: number, x1: number): number[] {
  const out: number[] = [];
  let sum = 0;
  let moment = 0;
  for (let x = x0; x <= x1; x++) {
    const i = (row * w + x) * 4;
    const v = x < x1 ? (px[i] ?? 0) + (px[i + 1] ?? 0) + (px[i + 2] ?? 0) : 0;
    if (v > 12) {
      sum += v;
      moment += v * x;
    } else if (sum > 0) {
      out.push(moment / sum);
      sum = 0;
      moment = 0;
    }
  }
  return out;
}

/**
 * Compares frame `b`, drawn after panning by `shift` device px, with frame
 * `a`: each lit run's centre along each row of `a` against the nearest one in
 * `b` once the pan is undone. Both frames are top-down and the same size.
 */
export function compareFrames(a: Pixels, b: Pixels, shift: readonly [number, number]): FrameComparison {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`frame size differs: ${a.width}×${a.height} vs ${b.width}×${b.height}`);
  }
  const w = a.width;
  const h = a.height;
  // Content that moved by (dx, dy) on screen sits dy rows lower in `b` and
  // dx columns further right. Rows run bottom of the screen first, the
  // order the WebGL-only version of this test used, so results match it bit
  // for bit (the mean's summation order, the first maximum's position).
  const [dx, dy] = shift;
  let lines = 0;
  let unmatched = 0;
  let maxOffsetPx = 0;
  let maxAt: [number, number] = [0, 0];
  let total = 0;
  for (let y = h - 1 - dy; y >= 0; y--) {
    const ca = rowCentres(a.data, w, y, 1, w - dx - 1);
    const cb = rowCentres(b.data, w, y + dy, dx + 1, w - 1).map((x) => x - dx);
    for (const x of ca) {
      let best = Infinity;
      for (const c of cb) best = Math.min(best, Math.abs(x - c));
      if (best > 3) {
        unmatched++;
        continue;
      }
      lines++;
      total += best;
      if (best > maxOffsetPx) {
        maxOffsetPx = best;
        maxAt = [Math.round(x), y];
      }
    }
  }
  return { lines, maxOffsetPx, meanOffsetPx: total / Math.max(1, lines), unmatched, maxAt };
}
