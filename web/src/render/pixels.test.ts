import { describe, expect, it } from 'vitest';
import {
  bgraToRgba,
  compareFrames,
  flipRows,
  paddedBytesPerRow,
  readbackToPixels,
  stripRowPadding,
} from './pixels';
import type { Pixels } from './types';

/** A w×h RGBA image whose pixel (x, y) is [x, y, 10·x + y, 255]. */
function gradient(w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) out.set([x, y, 10 * x + y, 255], (y * w + x) * 4);
  }
  return out;
}

/** The same image with each row padded to `pitch` bytes, padding filled with 0xee. */
function padded(data: Uint8Array, w: number, h: number, pitch: number): Uint8Array {
  const out = new Uint8Array(pitch * h).fill(0xee);
  for (let y = 0; y < h; y++) out.set(data.subarray(y * w * 4, (y + 1) * w * 4), y * pitch);
  return out;
}

describe('row helpers', () => {
  it('pads rows to 256 bytes for copyTextureToBuffer', () => {
    expect(paddedBytesPerRow(1)).toBe(256);
    expect(paddedBytesPerRow(64)).toBe(256);
    expect(paddedBytesPerRow(65)).toBe(512);
    expect(paddedBytesPerRow(1440)).toBe(5888);
  });

  it('flipRows turns bottom-up rows top-down and leaves the input alone', () => {
    const src = gradient(2, 3);
    const before = src.slice();
    const out = flipRows(src, 2, 3);
    expect(src).toEqual(before);
    expect([...out.subarray(0, 8)]).toEqual([...src.subarray(16, 24)]);
    expect([...out.subarray(8, 16)]).toEqual([...src.subarray(8, 16)]);
    expect([...out.subarray(16, 24)]).toEqual([...src.subarray(0, 8)]);
  });

  it('bgraToRgba swaps red and blue only', () => {
    const px = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...bgraToRgba(px)]).toEqual([3, 2, 1, 4, 7, 6, 5, 8]);
  });

  it('stripRowPadding drops the bytes past each row', () => {
    const src = gradient(2, 2);
    const out = stripRowPadding(padded(src, 2, 2, 12), 2, 2, 12);
    expect([...out]).toEqual([...src]);
  });
});

describe('readbackToPixels', () => {
  const w = 3;
  const h = 2;
  const pitch = 256; // paddedBytesPerRow(3)
  const rgba = gradient(w, h);

  it('rgba8unorm: strips padding, keeps the channels, rows top-down', () => {
    const p = readbackToPixels(padded(rgba, w, h, pitch), w, h, pitch, 'rgba8unorm');
    expect(p.width).toBe(w);
    expect(p.height).toBe(h);
    expect([...p.data]).toEqual([...rgba]);
  });

  it('bgra8unorm: also swaps blue and red back', () => {
    const bgra = rgba.slice();
    for (let i = 0; i < bgra.length; i += 4) {
      bgra[i] = rgba[i + 2] ?? 0;
      bgra[i + 2] = rgba[i] ?? 0;
    }
    const p = readbackToPixels(padded(bgra, w, h, pitch), w, h, pitch, 'bgra8unorm');
    expect([...p.data]).toEqual([...rgba]);
  });
});

describe('compareFrames', () => {
  const W = 240;
  const H = 160;

  /** White 1 px diagonal lines 40 px apart, the scene moved by (dx, dy) on screen. */
  function diagonals(dx: number, dy: number): Pixels {
    const data = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const u = x - dx + (y - dy);
        if (((u % 40) + 40) % 40 === 0) data.set([255, 255, 255, 255], (y * W + x) * 4);
      }
    }
    return { width: W, height: H, data };
  }

  it('an exact pan by (37, 23) matches every line with no offset', () => {
    const r = compareFrames(diagonals(0, 0), diagonals(37, 23), [37, 23]);
    expect(r.lines).toBeGreaterThan(100);
    expect(r.maxOffsetPx).toBe(0);
    expect(r.meanOffsetPx).toBe(0);
    expect(r.unmatched).toBe(0);
  });

  it('a picture that moved 2 px more than the pan is detected', () => {
    const r = compareFrames(diagonals(0, 0), diagonals(39, 23), [37, 23]);
    expect(r.lines).toBeGreaterThan(100);
    expect(r.maxOffsetPx).toBeCloseTo(2, 6);
    expect(r.meanOffsetPx).toBeCloseTo(2, 6);
    // Frame a's coordinates, y down: only rows that still overlap after the pan.
    expect(r.maxAt[0]).toBeGreaterThanOrEqual(0);
    expect(r.maxAt[0]).toBeLessThan(W);
    expect(r.maxAt[1]).toBeGreaterThanOrEqual(0);
    expect(r.maxAt[1]).toBeLessThan(H - 23);
  });

  it('a jump past 3 px counts as unmatched, not as an offset', () => {
    const r = compareFrames(diagonals(0, 0), diagonals(37 + 10, 23), [37, 23]);
    expect(r.unmatched).toBeGreaterThan(0);
    expect(r.maxOffsetPx).toBeLessThanOrEqual(3);
  });

  it('rejects frames of different sizes', () => {
    const small: Pixels = { width: 2, height: 2, data: new Uint8Array(16) };
    expect(() => compareFrames(diagonals(0, 0), small, [37, 23])).toThrow(/size/);
  });
});
