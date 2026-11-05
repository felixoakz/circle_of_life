// packFrame must hand the shaders exactly what renderer.ts `useProgram`
// sets as WebGL uniforms (l. 487–519), at the offsets of layout.ts.

import { describe, expect, it } from 'vitest';
import { RAD_PER_UNIT, TWO_32 } from '../angle';
import { BRANCH, MAX_RUNS, RunPalette, oklchToSrgb } from '../palette';
import { type FrameParams, NO_HIGHLIGHT } from '../render/types';
import * as S from '../style';
import type { GroupRun } from '../types';
import { structLayout } from './layout';
import {
  BACKDROP_FIELDS,
  DRAW_SLOT_BYTES,
  DrawSlots,
  FRAME_FIELDS,
  DRAW_STRUCTS,
  NO_HOME,
  PALETTE_FIELDS,
  REVEAL_DONE,
  EDGE_FIELDS,
  RIM_FIELDS,
  TIPS_FIELDS,
  RING_FIELDS,
  packDraw,
  packFrame,
  packPalette,
  revealUniform,
} from './uniforms';

// Computed in the tests, not at import, so one stub fails tests, not the whole file.
const frame = () => structLayout(FRAME_FIELDS);
const paletteLayout = () => structLayout(PALETTE_FIELDS);
const off = (name: string): number => frame().offsets[name] ?? NaN;
const f32 = Math.fround;

function params(over: Partial<FrameParams> = {}): FrameParams {
  return {
    camera: {
      camA: 0xffffffff,
      camAFrac: 0.1,
      camRHi: f32(0.9999),
      camRLo: 1.234e-9,
      scale: 123456.789,
      rotCos: Math.cos(0.3),
      rotSin: Math.sin(0.3),
      halfW: 720,
      halfH: 450,
    },
    lambda: 7.3,
    lambdaExt: 6.999,
    rWin: [0.25, 1.05],
    winLo: 0x80000001,
    winSpan: 0xfffffffe,
    fade: () => 1,
    fadeF: 1,
    reveal: 0.7,
    dpr: 2,
    tipSpacing: 1,
    homeId: 4242,
    homeAngle: 0xdeadbeef,
    leaderGap: 0,
    leaderLen: 0,
    homeLeader: 1,
    dims: [],
    highlight: NO_HIGHLIGHT,
    ...over,
  };
}

function pack(p: FrameParams, glow = 0.8): { u: Uint32Array; f: Float32Array } {
  const buf = new ArrayBuffer(frame().size);
  packFrame(p, { glow }, buf);
  return { u: new Uint32Array(buf), f: new Float32Array(buf) };
}

describe('revealUniform', () => {
  it('turns Infinity (intro done) into the finite sentinel', () => {
    expect(revealUniform(Infinity)).toBe(REVEAL_DONE);
    expect(Number.isFinite(REVEAL_DONE)).toBe(true);
    expect(REVEAL_DONE).toBe(1e4);
  });

  it('passes finite radii through', () => {
    expect(revealUniform(0)).toBe(0);
    expect(revealUniform(0.5)).toBe(0.5);
    expect(revealUniform(1.05)).toBe(1.05);
  });
});

describe('packFrame', () => {
  it('writes u32 fields as u32, bit for bit', () => {
    const { u } = pack(params());
    expect(u[off('camA') / 4]).toBe(0xffffffff);
    expect(u[off('winLo') / 4]).toBe(0x80000001);
    expect(u[off('winSpan') / 4]).toBe(0xfffffffe);
    expect(u[off('homeId') / 4]).toBe(4242);
    expect(u[off('homeAngle') / 4]).toBe(0xdeadbeef);
  });

  it('homeId −1 becomes NO_HOME (0xffffffff), as uHomeId does (l. 506)', () => {
    const { u } = pack(params({ homeId: -1 }));
    expect(NO_HOME).toBe(0xffffffff);
    expect(u[off('homeId') / 4]).toBe(NO_HOME);
  });

  it('writes f32 fields bit-equal to Math.fround of the WebGL uniforms', () => {
    const p = params();
    const c = p.camera;
    const { f } = pack(p, 0.8);
    const at = (name: string, k = 0): number | undefined => f[off(name) / 4 + k];
    expect(at('camFrac')).toBe(f32(0.1));
    expect([at('camR'), at('camR', 1)]).toEqual([f32(c.camRHi), f32(c.camRLo)]);
    expect(at('scale')).toBe(f32(c.scale));
    expect([at('rotCS'), at('rotCS', 1)]).toEqual([f32(c.rotCos), f32(c.rotSin)]);
    expect([at('half'), at('half', 1)]).toEqual([720, 450]);
    expect([at('rWin'), at('rWin', 1)]).toEqual([f32(0.25), f32(1.05)]);
    expect(at('seamUnits')).toBe(f32((S.SEAM_PX * 2) / (RAD_PER_UNIT * c.scale)));
    expect(at('lambdaExt')).toBe(f32(6.999));
    expect(at('reveal')).toBe(f32(0.7));
    expect(at('revealSoft')).toBe(f32(S.REVEAL_SOFT));
    expect(at('tintPow')).toBe(f32(S.TINT_POWER));
    expect(at('rimBand')).toBe(f32(1 - (S.RIM_BAND_PX * 2) / c.scale));
    expect(at('rimBoost')).toBe(f32(S.RIM_BOOST * 0.8));
    expect(at('pxPerUnit')).toBe(f32(RAD_PER_UNIT * c.scale));
    expect([at('branch'), at('branch', 1), at('branch', 2)]).toEqual(oklchToSrgb(BRANCH).map(f32));
    // tipSpacing 1: zoomed in, extensions are solid (style.ts extLevels).
    expect(at('extInner')).toBe(1);
    expect(at('extPow')).toBe(f32(S.EXT_POWER));
    expect(at('extFar')).toBe(1);
    // On the whole wheel they keep the build-up.
    const whole = pack(params({ tipSpacing: 0.001 }), 0.8).f;
    expect(whole[off('extInner') / 4]).toBe(f32(S.EXT_INNER));
    expect(whole[off('extFar') / 4]).toBe(f32(S.EXT_FAR));
  });

  it('writes the reveal sentinel once the intro is done', () => {
    const { f } = pack(params({ reveal: Infinity }));
    const v = f[off('reveal') / 4] ?? NaN;
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBe(1e4);
  });
});

describe('packPalette', () => {
  /** `n` runs of the given groups, evenly spread over a 1000-tip circle. */
  function palette(n: number): RunPalette {
    const tips = 1000;
    const runs: GroupRun[] = [];
    for (let i = 0; i < n; i++) {
      runs.push({ group: i % 6, angleLo: (TWO_32 * i) / n + TWO_32 / tips / 2, angleHi: (TWO_32 * (i + 1)) / n });
    }
    return new RunPalette(runs, tips);
  }

  for (const n of [1, 12, 32]) {
    it(`packs ${n} run(s), padded to MAX_RUNS`, () => {
      const pal = palette(n);
      const buf = packPalette(pal);
      const PALETTE = paletteLayout();
      expect(buf.byteLength).toBe(PALETTE.size);
      const i32 = new Int32Array(buf);
      const u = new Uint32Array(buf);
      const f = new Float32Array(buf);
      expect(i32[0]).toBe(n);
      const start = (PALETTE.offsets.start ?? NaN) / 4;
      const rgb0 = (PALETTE.offsets.rgb0 ?? NaN) / 4;
      const rgb1 = (PALETTE.offsets.rgb1 ?? NaN) / 4;
      for (let k = 0; k < MAX_RUNS; k++) {
        // start[k / 4][k % 4] is word start + k.
        expect(u[start + k]).toBe(k < n ? pal.start[k] : 0);
        for (let c = 0; c < 3; c++) {
          expect(f[rgb0 + 4 * k + c]).toBe(k < n ? pal.startRgb[3 * k + c] : 0);
          expect(f[rgb1 + 4 * k + c]).toBe(k < n ? pal.endRgb[3 * k + c] : 0);
        }
      }
    });
  }
});

describe('DrawSlots', () => {
  it('hands out 256-byte aligned slots in order', () => {
    const s = new DrawSlots(4);
    expect(DRAW_SLOT_BYTES).toBe(256);
    expect([s.next(), s.next(), s.next()]).toEqual([0, 256, 512]);
    expect(s.used).toBe(3);
    expect(s.bytes.byteLength).toBe(4 * 256);
  });

  it('starts over on reset without growing', () => {
    const s = new DrawSlots(2);
    s.next();
    s.next();
    s.reset();
    expect(s.used).toBe(0);
    expect(s.next()).toBe(0);
    expect(s.capacity).toBe(2);
    expect(s.takeGrown()).toBe(false);
  });

  it('doubles when full, keeping what was written, and reports the growth once', () => {
    const s = new DrawSlots(2);
    const a = s.next();
    new Float32Array(s.bytes, a, 1)[0] = 1.5;
    const b = s.next();
    new Float32Array(s.bytes, b, 1)[0] = 2.5;
    const c = s.next();
    expect(c).toBe(512);
    expect(s.capacity).toBe(4);
    expect(s.bytes.byteLength).toBe(4 * 256);
    expect(new Float32Array(s.bytes, a, 1)[0]).toBe(1.5);
    expect(new Float32Array(s.bytes, b, 1)[0]).toBe(2.5);
    expect(s.takeGrown()).toBe(true);
    expect(s.takeGrown()).toBe(false);
    for (let i = 0; i < 10; i++) expect(s.next() % 256).toBe(0);
    expect(s.capacity).toBe(16);
  });
});

describe('packDraw', () => {
  it('packs the backdrop: vectors first, then the scalars, as f32', () => {
    const buf = new ArrayBuffer(DRAW_SLOT_BYTES);
    const at = structLayout(BACKDROP_FIELDS).offsets;
    packDraw(
      {
        pass: 'backdrop',
        blend: 'saturating',
        vertexCount: 3,
        instanceCount: 1,
        firstInstance: 0,
        strength: 0.5,
        camRPx: 18_000_000,
        rimOff: -12.25,
        grid: [0.12, 1, 96, 128],
        ringFade: 0.75,
        fade: [24, 160],
        wash: [0.16, 900, 320, 0.5],
        corona: [1, 64],
        cells: [32, 17],
      },
      buf,
      0,
    );
    const f = new Float32Array(buf);
    const vec = (name: string, n: number): number[] => [...f.subarray((at[name] ?? 0) / 4, (at[name] ?? 0) / 4 + n)];
    expect(vec('grid', 4)).toEqual([0.12, 1, 96, 128].map(Math.fround));
    expect(vec('wash', 4)).toEqual([0.16, 900, 320, 0.5].map(Math.fround));
    expect(vec('fade', 2)).toEqual([24, 160]);
    expect(vec('corona', 2)).toEqual([1, 64]);
    expect(vec('cells', 2)).toEqual([32, 17]);
    expect(f[(at.strength ?? 0) / 4]).toBe(0.5);
    expect(f[(at.camRPx ?? 0) / 4]).toBe(18_000_000);
    expect(f[(at.rimOff ?? 0) / 4]).toBe(-12.25);
    expect(f[(at.ringFade ?? 0) / 4]).toBe(0.75);
  });

  it('packs the tip dots as three f32 at their offsets, at the slot offset', () => {
    const buf = new ArrayBuffer(2 * DRAW_SLOT_BYTES);
    new Float32Array(buf).fill(-1);
    const at = structLayout(TIPS_FIELDS).offsets;
    const tile = { level: 13, count: 9, internalCount: 4 };
    packDraw(
      { pass: 'tips', blend: 'over', vertexCount: 4, instanceCount: 9, firstInstance: 0, tile, alpha: 0.3, radius: 7.5, lift: 0.3 },
      buf,
      DRAW_SLOT_BYTES,
    );
    const f = new Float32Array(buf, DRAW_SLOT_BYTES);
    expect(f[(at.alpha ?? 0) / 4]).toBe(Math.fround(0.3));
    expect(f[(at.radius ?? 0) / 4]).toBe(7.5);
    expect(f[(at.lift ?? 0) / 4]).toBe(Math.fround(0.3));
    // The first slot is untouched.
    expect(new Float32Array(buf, 0, 4)).toEqual(new Float32Array([-1, -1, -1, -1]));
  });

  it('packs the rim edge: reach, then k as i32, then the scalars', () => {
    const buf = new ArrayBuffer(DRAW_SLOT_BYTES);
    const at = structLayout(EDGE_FIELDS).offsets;
    packDraw(
      { pass: 'edge', blend: 'over', vertexCount: 6 * 256, instanceCount: 1, firstInstance: 0, k: 256, reach: [2, 5], alpha: 0.9, width: 3, lift: 0.3 },
      buf,
      0,
    );
    const f = new Float32Array(buf);
    expect([...f.subarray((at.reach ?? 0) / 4, (at.reach ?? 0) / 4 + 2)]).toEqual([2, 5]);
    expect(new Int32Array(buf)[(at.k ?? 0) / 4]).toBe(256);
    expect(f[(at.alpha ?? 0) / 4]).toBe(Math.fround(0.9));
    expect(f[(at.width ?? 0) / 4]).toBe(3);
    expect(f[(at.lift ?? 0) / 4]).toBe(Math.fround(0.3));
  });

  it('every per-draw struct fits one slot', () => {
    for (const [name, fields] of Object.entries(DRAW_STRUCTS)) {
      expect(structLayout(fields).size, name).toBeLessThanOrEqual(DRAW_SLOT_BYTES);
    }
  });

  it('writes u32 as u32, i32 as i32 and vectors at their offsets, at the slot offset', () => {
    const buf = new ArrayBuffer(2 * DRAW_SLOT_BYTES);
    const at = structLayout(RING_FIELDS).offsets;
    packDraw(
      { pass: 'ring', blend: 'over', vertexCount: 4, instanceCount: 1, firstInstance: 0, angle: 0xfffffffe, r: 0.5, radius: 7, linePx: 2, colour: [0.1, 0.2, 0.3, 0.4], dot: 4.5, knock: [5, 0.85] },
      buf,
      DRAW_SLOT_BYTES,
    );
    const u = new Uint32Array(buf, DRAW_SLOT_BYTES);
    const f = new Float32Array(buf, DRAW_SLOT_BYTES);
    expect(u[(at.angle ?? 0) / 4]).toBe(0xfffffffe);
    expect(f[(at.radius ?? 0) / 4]).toBe(7);
    expect([...f.subarray((at.colour ?? 0) / 4, (at.colour ?? 0) / 4 + 4)]).toEqual([0.1, 0.2, 0.3, 0.4].map(Math.fround));
    expect(f[(at.dot ?? 0) / 4]).toBe(4.5);
    expect([...f.subarray((at.knock ?? 0) / 4, (at.knock ?? 0) / 4 + 2)]).toEqual([5, Math.fround(0.85)]);
    // Slot 0 untouched.
    expect(new Uint32Array(buf, 0, DRAW_SLOT_BYTES / 4).every((w) => w === 0)).toBe(true);

    const rim = structLayout(RIM_FIELDS).offsets;
    packDraw(
      { pass: 'rim', blend: 'saturating', vertexCount: 6, instanceCount: 1, firstInstance: 0, k: -3, strength: 1, reach: [2, 3], core: [4, 5], halo: [6, 7, 8, 9], fur: [10, 11, 12] },
      buf,
      0,
    );
    expect(new Int32Array(buf)[(rim.k ?? 0) / 4]).toBe(-3);
    expect([...new Float32Array(buf, rim.halo ?? 0, 4)]).toEqual([6, 7, 8, 9]);
    expect([...new Float32Array(buf, rim.fur ?? 0, 3)]).toEqual([10, 11, 12]);
  });
});
