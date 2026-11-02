// TS references for the `?debug=parity` compute check (gpu/parity.ts): the
// shared WGSL functions written again in plain JS doubles, and the fixed
// inputs they are evaluated on. Pure, so vitest checks them without a GPU.

import { RAD_PER_UNIT, TWO_32, fromRad, toRad } from '../angle';
import type { Camera, CameraUniforms } from '../camera';

/** frag.wgsl `hash` (lowbias32 → [0, 1)), with the same float32 rounding at the end. */
export function hashRef(input: number): number {
  let x = input >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  // f32(x) * (1 / 2^32): the power of two is exact, so only the conversion rounds.
  return Math.fround(x) / TWO_32;
}

/** frag.wgsl `strands(units, px)` with `pxPerUnit` from the frame. */
export function strandsRef(units: number, px: number, pxPerUnit: number): [number, number, number] {
  const k = Math.log2(Math.max(px / pxPerUnit, 1));
  const k0 = Math.floor(k);
  const w0 = 2 ** k0;
  const c0 = Math.floor(units / w0) >>> 0;
  const c1 = Math.floor(units / (2 * w0)) >>> 0;
  // `u32(k0) << 27u` keeps the low 32 bits, as `<<` then `>>> 0` does here.
  return [hashRef(c0 ^ (k0 << 27)), hashRef(c1 ^ ((k0 + 1) << 27)), k - k0];
}

/**
 * Where common.wgsl `polarToClipOffset(a, r, off)` should land, in device
 * px from the screen centre (y up), computed the plain way from the
 * double-precision camera (camera.ts `polarToScreen`): the point's screen
 * position, plus the offset turned to the point's outward direction.
 */
export function polarRef(cam: Camera, a: number, r: number, off: readonly [number, number]): [number, number] {
  const theta = toRad(a);
  const s = cam.polarToScreen(theta, r);
  const turn = cam.rot + theta;
  const c = Math.cos(turn);
  const sn = Math.sin(turn);
  return [s.x - cam.width / 2 + off[0] * c - off[1] * sn, cam.height / 2 - s.y + off[0] * sn + off[1] * c];
}

/**
 * The shader's own formula (camera-relative, hi/lo split) in doubles, in
 * device px from the centre. Not used on the page: the tests check it
 * equals `polarRef`, i.e. that the formula is right and only float32 can
 * make the GPU differ.
 */
export function polarFormula(u: CameraUniforms, a: number, r: number, off: readonly [number, number]): [number, number] {
  let d = (a - u.camA) % TWO_32;
  if (d < 0) d += TWO_32;
  const units = d >= 2 ** 31 ? d - TWO_32 : d;
  const dth = (units - u.camAFrac) * RAD_PER_UNIT;
  const s = Math.sin(0.5 * dth);
  const sn = Math.sin(dth);
  const cs = 1 - 2 * s * s;
  const x = r - u.camRHi - u.camRLo - 2 * r * s * s + (off[0] * cs - off[1] * sn) / u.scale;
  const y = r * sn + (off[0] * sn + off[1] * cs) / u.scale;
  return [(x * u.rotCos - y * u.rotSin) * u.scale, (x * u.rotSin + y * u.rotCos) * u.scale];
}

/** One polar input: an integer angle (u32 units), a float32 radius, an offset in device px. */
export interface PolarInput {
  a: number;
  r: number;
  off: [number, number];
}

/**
 * Points spread over the screen (a 9 × 7 grid), as the shader would get
 * them: the angle rounded to whole units, r to float32, with and without
 * an offset.
 */
export function polarInputs(cam: Camera): PolarInput[] {
  const out: PolarInput[] = [];
  for (let gy = 0; gy < 7; gy++) {
    for (let gx = 0; gx < 9; gx++) {
      const p = cam.screenToPolar((cam.width * (gx + 0.5)) / 9, (cam.height * (gy + 0.5)) / 7);
      const a = Math.round(fromRad(p.theta)) % TWO_32;
      const r = Math.fround(p.r);
      out.push({ a, r, off: [0, 0] }, { a, r, off: [3.5, -2.25] });
    }
  }
  return out;
}

/** A small deterministic PRNG (mulberry32), so the inputs are the same every run. */
export function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / TWO_32;
  };
}

/** Distance of x from the nearest integer. */
function offInteger(x: number): number {
  return Math.abs(x - Math.round(x));
}

/**
 * (units, px) pairs for `strands`, float32. Pairs that sit within 1% of an
 * octave boundary or a cell edge are skipped: there float32 and double may
 * fairly round to different cells, and the test would compare two
 * unrelated hashes.
 */
export function strandsInputs(pxPerUnit: number, n: number, seed: number): [number, number][] {
  const rnd = random(seed);
  const out: [number, number][] = [];
  while (out.length < n) {
    const units = Math.fround(rnd() * 2 ** 24);
    const px = Math.fround(0.25 + rnd() * 200);
    const k = Math.log2(Math.max(px / pxPerUnit, 1));
    if (k > 0 && offInteger(k) < 0.01) continue;
    const w0 = 2 ** Math.floor(k);
    if (offInteger(units / w0) < 0.01 || offInteger(units / (2 * w0)) < 0.01) continue;
    out.push([units, px]);
  }
  return out;
}

/** Inputs for `sinPrecise`: both branches (|x| < 0.1 and above), both signs, float32. */
export function sinInputs(): number[] {
  const out: number[] = [];
  for (let i = 0; i <= 120; i++) {
    const x = Math.fround(1e-9 * 10 ** (i / 12)); // 1e-9 … 1e1, log-spaced
    if (x > 3.1) break;
    out.push(x, -x);
  }
  out.push(Math.fround(0.0999999), Math.fround(0.1), Math.fround(0.1000001));
  return out;
}

/**
 * Angles for `kingdomColour`: every run start, points inside the seams on
 * both sides of each start (at fractions of `seamUnits`), and an even sweep
 * of the circle.
 */
export function kingdomInputs(starts: ArrayLike<number>, seamUnits: number): number[] {
  const out: number[] = [];
  const add = (a: number): void => {
    out.push(((Math.round(a) % TWO_32) + TWO_32) % TWO_32);
  };
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k] ?? 0;
    add(s);
    add(s + 1);
    for (const f of [0.1, 0.2, 0.35, 0.45]) {
      add(s + f * seamUnits);
      add(s - f * seamUnits);
    }
  }
  for (let i = 0; i < 256; i++) add(((i + 0.5) / 256) * TWO_32);
  return out;
}
