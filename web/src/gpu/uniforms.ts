// Packs the uniform buffers (docs/plan-webgpu.md §2.3): the per-frame
// `Frame` struct (group 0, binding 0), the static `Palette` (group 0,
// binding 1) and the per-draw slots (group 1, one 256-byte slot per draw
// command, picked with a dynamic offset).

import { RAD_PER_UNIT } from '../angle';
import { BRANCH, MAX_RUNS, type RunPalette, oklchToSrgb } from '../palette';
import {
  type ArcsCmd,
  type BackdropCmd,
  type BranchesCmd,
  type DimCmd,
  type FansCmd,
  type MarksCmd,
  type PathCmd,
  type RimCmd,
  type RingCmd,
  revealUniform,
} from '../render/plan';
import type { FrameParams } from '../render/types';
import * as S from '../style';
import type { Look } from '../style';
import { type StructLayout, type WgslType, structLayout } from './layout';

/** `homeId` of "no home node", as the shaders see it. */
export const NO_HOME = 0xffffffff;
// The finite reveal sentinel is shared with the WebGL2 backend (render/plan.ts).
export { REVEAL_DONE, revealUniform } from '../render/plan';
/** Bytes per draw slot: `minUniformBufferOffsetAlignment` on every adapter. */
export const DRAW_SLOT_BYTES = 256;

/** The `Frame` struct, field by field (renderer.ts `useProgram` uniforms). */
export const FRAME_FIELDS: readonly (readonly [string, WgslType])[] = [
  ['camA', 'u32'],
  ['camFrac', 'f32'],
  ['camR', 'vec2f'],
  ['scale', 'f32'],
  ['rotCS', 'vec2f'],
  ['half', 'vec2f'],
  ['rWin', 'vec2f'],
  ['winLo', 'u32'],
  ['winSpan', 'u32'],
  ['seamUnits', 'f32'],
  ['lambdaExt', 'f32'],
  ['homeId', 'u32'],
  ['homeAngle', 'u32'],
  ['reveal', 'f32'],
  ['revealSoft', 'f32'],
  ['tintPow', 'f32'],
  ['rimBand', 'f32'],
  ['rimBoost', 'f32'],
  ['pxPerUnit', 'f32'],
  ['branch', 'vec3f'],
  ['extInner', 'f32'],
  ['extPow', 'f32'],
  ['extFar', 'f32'],
];

/** The `Palette` struct: run starts read as `start[k / 4][k % 4]`, colours one vec4 per run. */
export const PALETTE_FIELDS: readonly (readonly [string, WgslType])[] = [
  ['count', 'i32'],
  ['start', { array: 'vec4u', length: 8 }],
  ['rgb0', { array: 'vec4f', length: 32 }],
  ['rgb1', { array: 'vec4f', length: 32 }],
];

/** `LinesDraw` (group 1, lines.wgsl `cmd`): per-draw values of branches and arcs. */
export const LINES_FIELDS: readonly (readonly [string, WgslType])[] = [
  ['fade', 'f32'],
  ['alpha', 'f32'],
  ['homeAlpha', 'f32'],
  ['k', 'i32'],
  ['halfW', 'f32'],
];

type Fields = readonly (readonly [string, WgslType])[];

/** `FansDraw` (fans.wgsl). */
export const FANS_FIELDS: Fields = [
  ['lambda', 'f32'],
  ['fadeF', 'f32'],
  ['alpha', 'f32'],
  ['linePx', 'f32'],
  ['k', 'i32'],
];

/** `RimDraw` (rim.wgsl): halo = (out amount, out decay px, in amount, in decay px), fur = (amount, length px, column px). */
export const RIM_FIELDS: Fields = [
  ['k', 'i32'],
  ['strength', 'f32'],
  ['reach', 'vec2f'],
  ['core', 'vec2f'],
  ['halo', 'vec4f'],
  ['fur', 'vec3f'],
];

/** `MarksDraw` (marks.wgsl), the vectors as in render/plan.ts `MarksCmd`. */
export const MARKS_FIELDS: Fields = [
  ['fade', 'f32'],
  ['px', 'f32'],
  ['spike', 'vec2f'],
  ['tipBar', 'vec4f'],
  ['leaderHalo', 'vec2f'],
  ['leader', 'vec4f'],
];

/** `PathDraw` (path.wgsl). */
export const PATH_FIELDS: Fields = [
  ['colour', 'vec4f'],
  ['k', 'i32'],
  ['halfW', 'f32'],
];

/** `RingDraw` (ring.wgsl). */
export const RING_FIELDS: Fields = [
  ['colour', 'vec4f'],
  ['angle', 'u32'],
  ['r', 'f32'],
  ['radius', 'f32'],
  ['linePx', 'f32'],
];

/** `BackdropDraw` (backdrop.wgsl), the vectors as in render/plan.ts `BackdropCmd`. */
export const BACKDROP_FIELDS: Fields = [
  ['grid', 'vec4f'],
  ['wash', 'vec4f'],
  ['fade', 'vec2f'],
  ['corona', 'vec2f'],
  ['cells', 'vec2f'],
  ['strength', 'f32'],
  ['camRPx', 'f32'],
  ['rimOff', 'f32'],
  ['ringFade', 'f32'],
];

/** `DimDraw` (dim.wgsl): rect = x0, y0, x1, y1 in device px, y down. */
export const DIM_FIELDS: Fields = [
  ['rect', 'vec4f'],
  ['viewport', 'vec2f'],
  ['soft', 'f32'],
  ['amount', 'f32'],
];

/** Per-draw structs, by WGSL name; pipelines.ts generates each one's WGSL text. */
export const DRAW_STRUCTS: Readonly<Record<string, Fields>> = {
  LinesDraw: LINES_FIELDS,
  FansDraw: FANS_FIELDS,
  RimDraw: RIM_FIELDS,
  MarksDraw: MARKS_FIELDS,
  PathDraw: PATH_FIELDS,
  RingDraw: RING_FIELDS,
  BackdropDraw: BACKDROP_FIELDS,
  DimDraw: DIM_FIELDS,
};

// Layouts are computed on first use, so a broken field list fails a test, not the import.
let frameLayout: StructLayout | null = null;
let paletteLayout: StructLayout | null = null;
const branchRgb = oklchToSrgb(BRANCH);

/** Writes the `Frame` struct for this frame into `out` (at least the struct's size). */
export function packFrame(p: FrameParams, look: Pick<Look, 'glow'>, out: ArrayBuffer): void {
  frameLayout ??= structLayout(FRAME_FIELDS);
  const at = frameLayout.offsets;
  const u = new Uint32Array(out);
  // Float32Array stores Math.fround of each value, as uniform1f does.
  const f = new Float32Array(out);
  const word = (name: string): number => (at[name] ?? 0) / 4;
  const c = p.camera;
  u[word('camA')] = c.camA;
  f[word('camFrac')] = c.camAFrac;
  f.set([c.camRHi, c.camRLo], word('camR'));
  f[word('scale')] = c.scale;
  f.set([c.rotCos, c.rotSin], word('rotCS'));
  f.set([c.halfW, c.halfH], word('half'));
  f.set(p.rWin, word('rWin'));
  u[word('winLo')] = p.winLo;
  u[word('winSpan')] = p.winSpan;
  f[word('seamUnits')] = (S.SEAM_PX * p.dpr) / (RAD_PER_UNIT * c.scale);
  f[word('lambdaExt')] = p.lambdaExt;
  u[word('homeId')] = p.homeId < 0 ? NO_HOME : p.homeId;
  u[word('homeAngle')] = p.homeAngle;
  f[word('reveal')] = revealUniform(p.reveal);
  f[word('revealSoft')] = S.REVEAL_SOFT;
  f[word('tintPow')] = S.TINT_POWER;
  f[word('rimBand')] = 1 - (S.RIM_BAND_PX * p.dpr) / c.scale;
  f[word('rimBoost')] = S.RIM_BOOST * look.glow;
  f[word('pxPerUnit')] = RAD_PER_UNIT * c.scale;
  f.set(branchRgb, word('branch'));
  f[word('extInner')] = S.EXT_INNER;
  f[word('extPow')] = S.EXT_POWER;
  f[word('extFar')] = S.EXT_FAR;
}

let linesLayout: StructLayout | null = null;

/** Writes a branches or arcs command's `LinesDraw` at byte `offset` of `out`. */
export function packLines(c: BranchesCmd | ArcsCmd, out: ArrayBuffer, offset: number): void {
  linesLayout ??= structLayout(LINES_FIELDS);
  const at = linesLayout.offsets;
  const f = new Float32Array(out, offset, linesLayout.size / 4);
  const i32 = new Int32Array(out, offset, linesLayout.size / 4);
  const word = (name: string): number => (at[name] ?? 0) / 4;
  f[word('fade')] = c.fade;
  f[word('alpha')] = c.alpha;
  f[word('homeAlpha')] = c.homeAlpha;
  i32[word('k')] = c.pass === 'arcs' ? c.k : 0;
  f[word('halfW')] = c.halfW;
}

const layouts = new Map<Fields, StructLayout>();

/** Scalar kind of a type's lanes: 'f32' and 'vec3f' → 'f', 'u32' and 'vec4u' → 'u', … */
function laneKind(t: WgslType): 'f' | 'u' | 'i' {
  const name = typeof t === 'string' ? t : t.array;
  const c = name.startsWith('vec') ? name.charAt(4) : name.charAt(0);
  return c === 'u' ? 'u' : c === 'i' ? 'i' : 'f';
}

/**
 * Writes one per-draw struct at byte `offset` of `out`: each named value
 * (a number, or the lanes of a vector) goes to its field's offset, as u32,
 * i32 or f32 by the field's type. Fields left out stay as they were.
 */
export function packStruct(
  fields: Fields,
  values: Readonly<Record<string, number | readonly number[]>>,
  out: ArrayBuffer,
  offset: number,
): void {
  let layout = layouts.get(fields);
  if (!layout) {
    layout = structLayout(fields);
    layouts.set(fields, layout);
  }
  const words = layout.size / 4;
  const f = new Float32Array(out, offset, words);
  const u = new Uint32Array(out, offset, words);
  const i32 = new Int32Array(out, offset, words);
  for (const field of layout.fields) {
    const v = values[field.name];
    if (v === undefined) continue;
    const lanes = typeof v === 'number' ? [v] : v;
    const view = { f: f, u: u, i: i32 }[laneKind(field.type)];
    view.set(lanes, field.offset / 4);
  }
}

/** Writes a draw command's struct (everything but branches and arcs: `packLines`) at byte `offset`. */
export function packDraw(c: FansCmd | RimCmd | MarksCmd | BackdropCmd | PathCmd | RingCmd | DimCmd, out: ArrayBuffer, offset: number): void {
  switch (c.pass) {
    case 'fans':
      return packStruct(FANS_FIELDS, { lambda: c.lambda, fadeF: c.fadeF, alpha: c.alpha, linePx: c.linePx, k: c.k }, out, offset);
    case 'rim':
      return packStruct(
        RIM_FIELDS,
        { k: c.k, strength: c.strength, reach: c.reach, core: c.core, halo: c.halo, fur: c.fur },
        out,
        offset,
      );
    case 'marks':
      return packStruct(
        MARKS_FIELDS,
        { fade: c.fade, px: c.px, spike: c.spike, tipBar: c.tipBar, leaderHalo: c.leaderHalo, leader: c.leader },
        out,
        offset,
      );
    case 'backdrop':
      return packStruct(
        BACKDROP_FIELDS,
        {
          grid: c.grid,
          wash: c.wash,
          fade: c.fade,
          corona: c.corona,
          cells: c.cells,
          strength: c.strength,
          camRPx: c.camRPx,
          rimOff: c.rimOff,
          ringFade: c.ringFade,
        },
        out,
        offset,
      );
    case 'path':
      return packStruct(PATH_FIELDS, { colour: c.colour, k: c.k, halfW: c.halfW }, out, offset);
    case 'ring':
      return packStruct(
        RING_FIELDS,
        { colour: c.colour, angle: c.angle, r: c.r, radius: c.radius, linePx: c.linePx },
        out,
        offset,
      );
    case 'dim': {
      const r = c.rect;
      return packStruct(
        DIM_FIELDS,
        { rect: [r.x0, r.y0, r.x1, r.y1], viewport: c.viewport, soft: r.soft, amount: r.amount },
        out,
        offset,
      );
    }
  }
}

/** The `Palette` struct for these runs, padded to MAX_RUNS. */
export function packPalette(palette: RunPalette): ArrayBuffer {
  paletteLayout ??= structLayout(PALETTE_FIELDS);
  const at = paletteLayout.offsets;
  const buf = new ArrayBuffer(paletteLayout.size);
  const i32 = new Int32Array(buf);
  const u = new Uint32Array(buf);
  const f = new Float32Array(buf);
  i32[(at.count ?? 0) / 4] = palette.count;
  const start = (at.start ?? 0) / 4;
  const rgb0 = (at.rgb0 ?? 0) / 4;
  const rgb1 = (at.rgb1 ?? 0) / 4;
  for (let k = 0; k < Math.min(palette.count, MAX_RUNS); k++) {
    // start[k / 4][k % 4] is word start + k: the vec4u lanes are consecutive.
    u[start + k] = palette.start[k] ?? 0;
    for (let c = 0; c < 3; c++) {
      f[rgb0 + 4 * k + c] = palette.startRgb[3 * k + c] ?? 0;
      f[rgb1 + 4 * k + c] = palette.endRgb[3 * k + c] ?? 0;
    }
  }
  return buf;
}

/**
 * CPU staging for the per-draw uniform buffer: one 256-byte slot per draw
 * command, written each frame and uploaded with one `writeBuffer`. Doubles
 * when full; the renderer then re-creates the GPU buffer and bind group.
 */
export class DrawSlots {
  private buffer: ArrayBuffer;
  private count = 0;
  private grown = false;

  constructor(capacity = 64) {
    this.buffer = new ArrayBuffer(Math.max(1, capacity) * DRAW_SLOT_BYTES);
  }

  /** Slots the buffer holds. */
  get capacity(): number {
    return this.buffer.byteLength / DRAW_SLOT_BYTES;
  }

  /** Slots handed out since the last `reset`. */
  get used(): number {
    return this.count;
  }

  /** The staging bytes (`capacity · 256`); a new buffer after growth. */
  get bytes(): ArrayBuffer {
    return this.buffer;
  }

  /** Starts a new frame. */
  reset(): void {
    this.count = 0;
  }

  /** Hands out the next slot and returns its byte offset, growing when full. */
  next(): number {
    if (this.count === this.capacity) {
      const bigger = new ArrayBuffer(this.buffer.byteLength * 2);
      new Uint8Array(bigger).set(new Uint8Array(this.buffer));
      this.buffer = bigger;
      this.grown = true;
    }
    return this.count++ * DRAW_SLOT_BYTES;
  }

  /** True once after the capacity grew (the GPU buffer must be re-created). */
  takeGrown(): boolean {
    const g = this.grown;
    this.grown = false;
    return g;
  }
}
