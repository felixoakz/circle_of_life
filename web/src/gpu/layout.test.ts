import { describe, expect, it } from 'vitest';
import { structLayout, wgslStruct } from './layout';
import { FRAME_FIELDS, PALETTE_FIELDS } from './uniforms';

describe('structLayout', () => {
  it('packs scalars 4 bytes apart', () => {
    const l = structLayout([['a', 'f32'], ['b', 'u32'], ['c', 'i32']]);
    expect(l.offsets).toEqual({ a: 0, b: 4, c: 8 });
    expect(l.size).toBe(12);
    expect(l.align).toBe(4);
  });

  it('aligns vec2 to 8', () => {
    const l = structLayout([['a', 'f32'], ['b', 'vec2f'], ['c', 'f32']]);
    expect(l.offsets).toEqual({ a: 0, b: 8, c: 16 });
    expect(l.size).toBe(24); // 20 rounded up to align 8
    expect(l.align).toBe(8);
  });

  it('aligns vec3 to 16 with size 12, so a scalar packs after it', () => {
    const l = structLayout([['a', 'f32'], ['v', 'vec3f'], ['s', 'f32'], ['t', 'u32']]);
    expect(l.offsets).toEqual({ a: 0, v: 16, s: 28, t: 32 });
    expect(l.size).toBe(48);
    expect(l.align).toBe(16);
  });

  it('aligns vec4 to 16', () => {
    const l = structLayout([['a', 'u32'], ['v', 'vec4u']]);
    expect(l.offsets).toEqual({ a: 0, v: 16 });
    expect(l.size).toBe(32);
  });

  it('rounds the struct size up to its largest alignment', () => {
    expect(structLayout([['v', 'vec4f'], ['a', 'f32']]).size).toBe(32);
    expect(structLayout([['v', 'vec2u'], ['a', 'f32']]).size).toBe(16);
    expect(structLayout([['a', 'f32']]).size).toBe(4);
  });

  it('lays out arrays of vec4 with stride 16', () => {
    const l = structLayout([['n', 'i32'], ['xs', { array: 'vec4f', length: 3 }], ['m', 'f32']]);
    expect(l.offsets).toEqual({ n: 0, xs: 16, m: 64 });
    expect(l.fields[1]?.size).toBe(48);
    expect(l.size).toBe(80);
  });

  it('rejects uniform arrays whose stride is not a multiple of 16', () => {
    expect(() => structLayout([['xs', { array: 'f32', length: 4 }]], 'uniform')).toThrow(/stride/);
    expect(() => structLayout([['xs', { array: 'vec2f', length: 4 }]])).toThrow(/stride/);
  });

  it('allows such arrays in storage buffers', () => {
    const l = structLayout([['n', 'u32'], ['xs', { array: 'f32', length: 4 }]], 'storage');
    expect(l.offsets).toEqual({ n: 0, xs: 4 });
    expect(l.size).toBe(20);
  });

  it('keeps fields in declaration order with their types', () => {
    const l = structLayout([['a', 'f32'], ['b', 'vec3f']]);
    expect(l.fields).toEqual([
      { name: 'a', type: 'f32', offset: 0, size: 4 },
      { name: 'b', type: 'vec3f', offset: 16, size: 12 },
    ]);
  });
});

describe('Frame struct (plan §2.3 table)', () => {
  it('matches the planned offsets and is 128 bytes', () => {
    const l = structLayout(FRAME_FIELDS);
    expect(l.offsets).toEqual({
      camA: 0,
      camFrac: 4,
      camR: 8,
      scale: 16,
      rotCS: 24,
      half: 32,
      rWin: 40,
      winLo: 48,
      winSpan: 52,
      seamUnits: 56,
      lambdaExt: 60,
      homeId: 64,
      homeAngle: 68,
      reveal: 72,
      revealSoft: 76,
      tintPow: 80,
      rimBand: 84,
      rimBoost: 88,
      pxPerUnit: 92,
      branch: 96,
      extInner: 108,
      extPow: 112,
      extFar: 116,
    });
    expect(l.size).toBe(128);
  });

  it('generates the WGSL struct text', () => {
    expect(wgslStruct('Frame', structLayout(FRAME_FIELDS))).toBe(
      [
        'struct Frame {',
        '  camA: u32,',
        '  camFrac: f32,',
        '  camR: vec2f,',
        '  scale: f32,',
        '  rotCS: vec2f,',
        '  half: vec2f,',
        '  rWin: vec2f,',
        '  winLo: u32,',
        '  winSpan: u32,',
        '  seamUnits: f32,',
        '  lambdaExt: f32,',
        '  homeId: u32,',
        '  homeAngle: u32,',
        '  reveal: f32,',
        '  revealSoft: f32,',
        '  tintPow: f32,',
        '  rimBand: f32,',
        '  rimBoost: f32,',
        '  pxPerUnit: f32,',
        '  branch: vec3f,',
        '  extInner: f32,',
        '  extPow: f32,',
        '  extFar: f32,',
        '}',
        '',
      ].join('\n'),
    );
  });
});

describe('Palette struct', () => {
  it('holds 32 run starts as 8 vec4u and two 32-entry colour arrays', () => {
    const l = structLayout(PALETTE_FIELDS);
    expect(l.offsets).toEqual({ count: 0, start: 16, rgb0: 144, rgb1: 656 });
    expect(l.size).toBe(1168);
  });

  it('writes array types in WGSL syntax', () => {
    const text = wgslStruct('Palette', structLayout(PALETTE_FIELDS));
    expect(text).toContain('  count: i32,\n');
    expect(text).toContain('  start: array<vec4u, 8>,\n');
    expect(text).toContain('  rgb0: array<vec4f, 32>,\n');
  });
});
