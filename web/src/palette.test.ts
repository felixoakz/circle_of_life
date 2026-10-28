import { describe, expect, it } from 'vitest';
import { TWO_32 } from './angle';
import { BRANCH, GROUP_RAMPS, type Oklch, RunPalette, oklchToHex, oklchToLinear, oklchToSrgb } from './palette';

function hexDist(a: string, b: string): number {
  let d = 0;
  for (let i = 1; i < 7; i += 2) d = Math.max(d, Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)));
  return d;
}

/** The real tree's runs (meta.runs of otl16.1), as fractions of the circle. */
const N = 2_385_875;
const REAL_RUNS: [number, number, number][] = [
  [5, 0.0, 0.314],
  [4, 0.314, 17.881],
  [3, 17.881, 26.668],
  [2, 26.668, 28.074],
  [3, 28.074, 28.136],
  [2, 28.136, 93.37],
  [1, 93.38, 135.077],
  [3, 135.077, 135.14],
  [0, 135.14, 360],
];
const deg = (d: number): number => (d / 360) * TWO_32;
const slot = TWO_32 / N;
const runs = REAL_RUNS.map(([group, lo, hi]) => ({
  group,
  angleLo: Math.round(deg(lo)) + slot / 2,
  angleHi: Math.min(TWO_32 - slot / 2, Math.round(deg(hi)) - slot / 2),
}));

const flat = (g: number): number[] => oklchToSrgb(GROUP_RAMPS[g]?.[0] ?? BRANCH);
const near = (a: number[], b: number[], tol = 0.01): boolean => a.every((x, k) => Math.abs(x - (b[k] ?? 0)) <= tol);

describe('palette tokens', () => {
  it('match the DESIGN.md hex values within ±1 per channel', () => {
    const expected = [
      ['#36dcec', '#659ff4'],
      ['#f49923', '#f2cf3b'],
      ['#61dc6b', '#b5e058'],
      ['#c797fd', '#c797fd'],
      ['#6572e4', '#6572e4'],
      ['#db5dab', '#db5dab'],
    ];
    GROUP_RAMPS.forEach(([s, e], g) => {
      expect(hexDist(oklchToHex(s), expected[g]?.[0] ?? '')).toBeLessThanOrEqual(1);
      expect(hexDist(oklchToHex(e), expected[g]?.[1] ?? '')).toBeLessThanOrEqual(1);
    });
    // oklch(0.60 0 0) is #808080 (0.6³ = 0.216 linear).
    expect(hexDist(oklchToHex(BRANCH), '#808080')).toBeLessThanOrEqual(1);
  });

  it('are all inside the sRGB gamut', () => {
    for (const ramp of GROUP_RAMPS) {
      for (const c of ramp) for (const v of oklchToLinear(c)) expect(v).toBeGreaterThanOrEqual(-1e-4);
    }
  });
});

describe('RunPalette', () => {
  const pal = new RunPalette(runs, N);
  // Seams of 2 px, at overview (rim ≈ 2300 px around) and at max zoom (48 px per tip).
  const seamOverview = (2 * TWO_32) / 2300;
  const seamDeep = (2 * slot) / 48;

  it('gives Archaea its own colour, at overview and deep in', () => {
    const mid = deg(0.157);
    expect(near(pal.colourAt(mid, seamDeep), flat(5))).toBe(true);
    // At overview the seams are capped at a quarter of the run: the middle is still Archaea.
    expect(near(pal.colourAt(mid, seamOverview), flat(5))).toBe(true);
  });

  it('colours the small Protist slivers inside Plants as Protists', () => {
    expect(near(pal.colourAt(deg(28.105), seamDeep), flat(3))).toBe(true);
  });

  it('runs a ramp along its group', () => {
    const fungiStart = pal.colourAt(deg(93.38) + slot, seamDeep);
    const fungiEnd = pal.colourAt(deg(135.077) - slot, seamDeep);
    expect(near(fungiStart, oklchToSrgb(GROUP_RAMPS[1]?.[0] ?? BRANCH), 0.02)).toBe(true);
    expect(near(fungiEnd, oklchToSrgb(GROUP_RAMPS[1]?.[1] ?? BRANCH), 0.02)).toBe(true);
  });

  it('meets halfway at a boundary, within a few px, without a third hue', () => {
    // Protists (violet) → Plants (green) at 26.668°.
    const b = pal.start[3] ?? 0;
    const violet = flat(3);
    const green = flat(2);
    const mid = pal.colourAt(b, seamOverview);
    mid.forEach((v, k) => expect(v).toBeCloseTo(((violet[k] ?? 0) + (green[k] ?? 0)) / 2, 2));
    // One seam width away it is all one or the other.
    expect(near(pal.colourAt(b - seamOverview, seamOverview), violet)).toBe(true);
    // The Plants run here is a 0.004° sliver: its seams are capped at a quarter of it.
    const sliver = (pal.start[4] ?? 0) - b;
    const plantsMid = green.map((v, k) => (v + (oklchToSrgb(GROUP_RAMPS[2]?.[1] ?? BRANCH)[k] ?? 0)) / 2);
    expect(near(pal.colourAt(b + sliver / 2, seamOverview), plantsMid, 0.02)).toBe(true);
  });

  it('wraps round from Animals to Archaea at angle 0', () => {
    const blue = oklchToSrgb(GROUP_RAMPS[0]?.[1] ?? BRANCH);
    expect(near(pal.colourAt(TWO_32 - 3 * slot, seamDeep), blue, 0.02)).toBe(true);
    const at0 = pal.colourAt(0, seamDeep);
    at0.forEach((v, k) => expect(v).toBeCloseTo(((blue[k] ?? 0) + (flat(5)[k] ?? 0)) / 2, 2));
  });
});

// Colour vision deficiency check (DESIGN.md §2.2): Machado, Oliveira and
// Fernandes (2009) at severity 1, applied to linear sRGB, distances in OKLab.
const DEUTERANOPIA = [
  [0.367322, 0.860646, -0.227968],
  [0.280085, 0.672501, 0.047413],
  [-0.01182, 0.04294, 0.968881],
];
const PROTANOPIA = [
  [0.152286, 1.052583, -0.204868],
  [0.114503, 0.786281, 0.099216],
  [-0.003882, -0.048116, 1.051998],
];

function linearToOklab([r, g, b]: number[]): number[] {
  const l = Math.cbrt(0.4122214708 * (r ?? 0) + 0.5363325363 * (g ?? 0) + 0.0514459929 * (b ?? 0));
  const m = Math.cbrt(0.2119034982 * (r ?? 0) + 0.6806995451 * (g ?? 0) + 0.1073969566 * (b ?? 0));
  const s = Math.cbrt(0.0883024619 * (r ?? 0) + 0.2817188376 * (g ?? 0) + 0.6299787005 * (b ?? 0));
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function seen(c: Oklch, sim: number[][] | null): number[] {
  const lin = oklchToLinear(c).map((v) => Math.min(1, Math.max(0, v)));
  if (!sim) return linearToOklab(lin);
  const out = sim.map((row) => Math.min(1, Math.max(0, row.reduce((sum, w, k) => sum + w * (lin[k] ?? 0), 0))));
  return linearToOklab(out);
}

describe('kingdom colours under colour vision deficiency', () => {
  const ramp = (g: number, end: 0 | 1): Oklch => GROUP_RAMPS[g]?.[end] ?? BRANCH;
  const [ANIMALS, FUNGI, PLANTS, PROTISTS, BACTERIA, ARCHAEA] = [0, 1, 2, 3, 4, 5];
  // Colours that meet on the wheel (counter-clockwise: Archaea, Bacteria,
  // Protists, Plants, Fungi, Animals, back to Archaea), plus the purple family.
  const pairs: [string, Oklch, Oklch][] = [
    ['Animals end / Archaea', ramp(ANIMALS, 1), ramp(ARCHAEA, 0)],
    ['Archaea / Bacteria', ramp(ARCHAEA, 1), ramp(BACTERIA, 0)],
    ['Bacteria / Protists', ramp(BACTERIA, 1), ramp(PROTISTS, 0)],
    ['Protists / Plants start', ramp(PROTISTS, 1), ramp(PLANTS, 0)],
    ['Plants end / Protists', ramp(PLANTS, 1), ramp(PROTISTS, 0)],
    ['Plants end / Fungi start', ramp(PLANTS, 1), ramp(FUNGI, 0)],
    ['Fungi end / Animals start', ramp(FUNGI, 1), ramp(ANIMALS, 0)],
    ['Protists / Archaea', ramp(PROTISTS, 0), ramp(ARCHAEA, 0)],
  ];
  for (const [name, sim] of [
    ['normal vision', null],
    ['deuteranopia', DEUTERANOPIA],
    ['protanopia', PROTANOPIA],
  ] as const) {
    it(`keeps neighbours and the purple family apart (${name})`, () => {
      for (const [pair, a, b] of pairs) {
        const pa = seen(a, sim);
        const pb = seen(b, sim);
        const d = Math.hypot((pa[0] ?? 0) - (pb[0] ?? 0), (pa[1] ?? 0) - (pb[1] ?? 0), (pa[2] ?? 0) - (pb[2] ?? 0));
        expect(d, pair).toBeGreaterThanOrEqual(0.08);
      }
    });
  }
});
