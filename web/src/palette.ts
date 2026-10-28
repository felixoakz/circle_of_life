// Kingdom colours from DESIGN.md §2.2, and the angle → colour function the
// shaders and labels share (PLAN §7.4). Colours are given in OKLCH and
// converted here, so DESIGN.md stays the single source of truth.
//
// Colour along the rim comes from the group runs: each run of tips spans
// from half a slot before its first tip to half a slot after its last and
// maps t ∈ [0, 1] along it to its group's ramp. Neighbouring runs meet in a
// short seam a few screen px wide (never more than a quarter of the shorter
// run), mixed straight across in sRGB, so even Archaea, 0.09% of the
// circle, keeps its own colour, and no seam passes through a third hue.
// gl/shaders/palette.glsl is the same function on the GPU.

import { TWO_32 } from './angle';
import type { GroupRun } from './types';

export type Rgb = [number, number, number];
/** OKLCH: lightness 0..1, chroma, hue in degrees. */
export type Oklch = [number, number, number];

/** Ramp start → end along each group's arc (counter-clockwise), indexed by group id (0..5). */
export const GROUP_RAMPS: readonly [Oklch, Oklch][] = [
  [[0.82, 0.13, 205], [0.7, 0.14, 258]], // 0 Animals: cyan → blue
  [[0.76, 0.16, 66], [0.86, 0.16, 95]], // 1 Fungi: amber → yellow
  [[0.8, 0.19, 145], [0.85, 0.17, 125]], // 2 Plants: green → yellow-green
  [[0.76, 0.15, 305], [0.76, 0.15, 305]], // 3 Protists: violet
  [[0.6, 0.17, 275], [0.6, 0.17, 275]], // 4 Bacteria: indigo
  [[0.66, 0.18, 345], [0.66, 0.18, 345]], // 5 Archaea: magenta-rose
];

/** `--branch`, oklch(0.60 0 0): interior branch grey. */
export const BRANCH: Oklch = [0.6, 0, 0];

/** Most runs the shaders take (uniform arrays); the real tree has 12. */
export const MAX_RUNS = 32;

/** OKLCH → linear-light sRGB (Björn Ottosson's OKLab matrices). */
export function oklchToLinear([L, C, h]: Oklch): Rgb {
  const hr = (h * Math.PI) / 180;
  const a = C * Math.cos(hr);
  const b = C * Math.sin(hr);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** Linear-light channel → sRGB-encoded channel, both 0..1 (clamped). */
export function encodeSrgb(c: number): number {
  const x = Math.min(1, Math.max(0, c));
  return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
}

export function oklchToSrgb(c: Oklch): Rgb {
  const [r, g, b] = oklchToLinear(c);
  return [encodeSrgb(r), encodeSrgb(g), encodeSrgb(b)];
}

export function oklchToHex(c: Oklch): string {
  return (
    '#' +
    oklchToSrgb(c)
      .map((v) => Math.round(v * 255).toString(16).padStart(2, '0'))
      .join('')
  );
}

/** OKLCH of a group at position t ∈ [0, 1] along one of its runs. */
function rampColour(group: number, t: number): Oklch {
  const ramp = GROUP_RAMPS[group];
  if (!ramp) return BRANCH;
  // Interpolate in OKLCH (hues within one ramp never cross 0°).
  const [s, e] = ramp;
  return [s[0] + (e[0] - s[0]) * t, s[1] + (e[1] - s[1]) * t, s[2] + (e[2] - s[2]) * t];
}

/** Linear blend of two sRGB colours. */
function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * The runs as the shaders take them: where each run starts (u32 units; the
 * first starts at 0 and the last ends at 2^32), and its sRGB colours at
 * start and end. The OKLCH ramp is sampled at both ends only, so a long
 * ramp is a straight sRGB blend, close enough at these lightnesses.
 */
export class RunPalette {
  /** Start of each run, u32 units, ascending; start[0] = 0. */
  readonly start: Float64Array;
  /** sRGB at each run's start and end, 3 floats per run. */
  readonly startRgb: Float32Array;
  readonly endRgb: Float32Array;
  readonly count: number;

  constructor(runs: readonly GroupRun[], tipCount: number) {
    const halfSlot = TWO_32 / tipCount / 2;
    let list = [...runs].sort((a, b) => a.angleLo - b.angleLo);
    if (list.length > MAX_RUNS) {
      console.warn(`palette: ${list.length} group runs, the shaders take ${MAX_RUNS}`);
      list = list.slice(0, MAX_RUNS);
    }
    if (list.length === 0) list = [{ group: 255, angleLo: halfSlot, angleHi: TWO_32 - halfSlot }];
    this.count = list.length;
    this.start = new Float64Array(this.count);
    this.startRgb = new Float32Array(this.count * 3);
    this.endRgb = new Float32Array(this.count * 3);
    list.forEach((run, i) => {
      // Tips are evenly spaced from the start, so a run's first tip is half
      // a slot past its start and the first run starts at 0.
      this.start[i] = i === 0 ? 0 : Math.round(run.angleLo - halfSlot);
      this.startRgb.set(oklchToSrgb(rampColour(run.group, 0)), i * 3);
      this.endRgb.set(oklchToSrgb(rampColour(run.group, 1)), i * 3);
    });
  }

  /** Start of run `i` (any i; run count wraps to 2^32 + the first start). */
  private edge(i: number): number {
    return i >= this.count ? TWO_32 : (this.start[i] ?? 0);
  }

  /** Length of run `i` (wrapping), u32 units. */
  private runLen(i: number): number {
    const k = ((i % this.count) + this.count) % this.count;
    return this.edge(k + 1) - this.edge(k);
  }

  private rgb(arr: Float32Array, i: number): Rgb {
    const k = ((i % this.count) + this.count) % this.count;
    return [arr[k * 3] ?? 0, arr[k * 3 + 1] ?? 0, arr[k * 3 + 2] ?? 0];
  }

  /**
   * sRGB colour (0..1) at angle `a` (u32 units), with seams `seamUnits`
   * wide (u32 units: the seam's screen width over px per unit).
   */
  colourAt(a: number, seamUnits: number): Rgb {
    const x = ((a % TWO_32) + TWO_32) % TWO_32;
    let i = 0;
    while (i + 1 < this.count && x >= this.edge(i + 1)) i++;
    const lo = this.edge(i);
    const hi = this.edge(i + 1);
    const len = hi - lo;
    let c = mixRgb(this.rgb(this.startRgb, i), this.rgb(this.endRgb, i), (x - lo) / len);
    if (this.count === 1) return c;
    // Half-width of the seam at each end: at most a quarter of the shorter run.
    const wLo = Math.min(seamUnits / 2, len / 4, this.runLen(i - 1) / 4);
    const wHi = Math.min(seamUnits / 2, len / 4, this.runLen(i + 1) / 4);
    const dLo = x - lo;
    const dHi = hi - x;
    // Halfway at the boundary, all this run's colour wLo (wHi) inside it.
    if (wLo > 0 && dLo < wLo) c = mixRgb(this.rgb(this.endRgb, i - 1), c, 0.5 + (0.5 * dLo) / wLo);
    else if (wHi > 0 && dHi < wHi) c = mixRgb(this.rgb(this.startRgb, i + 1), c, 0.5 + (0.5 * dHi) / wHi);
    return c;
  }
}
