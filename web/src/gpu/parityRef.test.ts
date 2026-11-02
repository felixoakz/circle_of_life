// The parity page's references must be right before they can judge the GPU.

import { describe, expect, it } from 'vitest';
import { TWO_32 } from '../angle';
import { Camera } from '../camera';
import { hashRef, polarFormula, polarInputs, polarRef, sinInputs, strandsInputs, strandsRef } from './parityRef';

/** lowbias32 in BigInt, as an independent reference for hashRef. */
function lowbias32(x0: number): number {
  const M = 0xffffffffn;
  let x = BigInt(x0);
  x ^= x >> 16n;
  x = (x * 0x7feb352dn) & M;
  x ^= x >> 15n;
  x = (x * 0x846ca68bn) & M;
  x ^= x >> 16n;
  return Number(x);
}

describe('hashRef', () => {
  it('is lowbias32 rounded to float32, in [0, 1)', () => {
    for (const x of [0, 1, 2, 12345, 0x7fffffff, 0x80000000, 0xffffffff]) {
      const h = hashRef(x);
      expect(h).toBe(Math.fround(lowbias32(x)) / TWO_32);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(1);
    }
    expect(hashRef(0)).toBe(0);
  });
});

describe('strandsRef', () => {
  it('weights in [0, 1) and octave 0 below one unit per px', () => {
    const [, , w] = strandsRef(1000, 0.5, 1);
    expect(w).toBe(0);
    for (const [u, px] of strandsInputs(1e-3, 50, 3)) {
      const s = strandsRef(u, px, 1e-3);
      expect(s[2]).toBeGreaterThanOrEqual(0);
      expect(s[2]).toBeLessThan(1);
    }
  });

  it('inputs are float32 and deterministic', () => {
    const a = strandsInputs(5e-7, 20, 9);
    expect(a).toEqual(strandsInputs(5e-7, 20, 9));
    for (const [u, px] of a) {
      expect(Math.fround(u)).toBe(u);
      expect(Math.fround(px)).toBe(px);
    }
  });
});

describe('polarRef', () => {
  const cases: [string, (c: Camera) => void][] = [
    ['overview', (c) => c.fit()],
    ['max zoom', (c) => Object.assign(c, { scale: c.maxScale(), angle: 4.1, r: 1 - 300 / c.maxScale(), rot: 0.3 })],
    ['max zoom across 0', (c) => Object.assign(c, { scale: c.maxScale(), angle: 2 * Math.PI - 1e-7, r: 0.99999, rot: 2.5 })],
  ];
  for (const [name, setup] of cases) {
    it(`equals the shader formula in doubles (${name})`, () => {
      const cam = new Camera(2_390_000);
      cam.setViewport(1440, 900, 1);
      setup(cam);
      const u = cam.uniforms();
      for (const p of polarInputs(cam)) {
        const a = polarRef(cam, p.a, p.r, p.off);
        const b = polarFormula(u, p.a, p.r, p.off);
        expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(1e-4);
      }
    });
  }

  it('grid points land on screen', () => {
    const cam = new Camera(2_390_000);
    cam.setViewport(1440, 900, 1);
    cam.fit();
    for (const p of polarInputs(cam)) {
      const [x, y] = polarRef(cam, p.a, p.r, [0, 0]);
      expect(Math.abs(x)).toBeLessThan(721);
      expect(Math.abs(y)).toBeLessThan(451);
    }
  });
});

describe('sinInputs', () => {
  it('covers both branches of sinPrecise', () => {
    const xs = sinInputs();
    expect(xs.some((x) => Math.abs(x) < 1e-6)).toBe(true);
    expect(xs.some((x) => Math.abs(x) >= 0.1)).toBe(true);
    expect(xs.some((x) => x < 0)).toBe(true);
  });
});
