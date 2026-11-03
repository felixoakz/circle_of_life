// `?debug=parity` (docs/plan-webgpu.md §2.5): runs the shared WGSL functions
// (`kingdomColour`, `polarToClipOffset`, `hash`, `strands`, `sinPrecise`)
// on the GPU with fixed inputs, reads the answers back and compares them
// with TS references (gpu/parityRef.ts, `RunPalette.colourAt`). The result
// lands in `window.__gpuParity = { ok, results }` and the debug HUD;
// scripts/parity.ts runs it headless.
//
// WebGPU concepts used here (compute):
// - A *compute pipeline* is a render pipeline's simpler sibling: one shader
//   stage (`@compute`), no vertices, no pixels, no blending. It reads and
//   writes buffers, nothing else.
// - *Workgroups.* `@workgroup_size(64)` in WGSL says invocations run in
//   groups of 64; `pass.dispatchWorkgroups(g)` launches g groups, so
//   g = ceil(n / 64) covers n inputs. Each invocation finds its own item in
//   `@builtin(global_invocation_id)` (group index × 64 + index in the group).
// - *Storage buffers.* Inputs and outputs are `var<storage>` arrays: read-only
//   for the inputs, `read_write` for the outputs (the bind group layout says
//   `read-only-storage` and `storage`). Uniform buffers (group 0, the same
//   `Frame` and `Palette` the tree reads) are small and read-only; storage
//   buffers can be large and written.
// - *Readback.* A GPU-written `STORAGE` buffer cannot be mapped directly. The
//   encoder copies it (`copyBufferToBuffer`) into a `MAP_READ | COPY_DST`
//   buffer; after `queue.submit`, `mapAsync` resolves once the GPU is done
//   and `getMappedRange()` gives its bytes. The same pattern as
//   gpu/readback.ts, without a texture.
// - The pipeline layout is explicit (like gpu/pipelines.ts). `layout:
//   'auto'` would also work, but it drops bindings an entry point does not
//   use, and then the shared group 0 would differ per entry point.

import { TWO_32 } from '../angle';
import { Camera } from '../camera';
import type { RunPalette } from '../palette';
import { NO_HIGHLIGHT } from '../render/types';
import type { FrameParams } from '../render/types';
import { structLayout } from './layout';
import {
  hashRef,
  kingdomInputs,
  polarInputs,
  polarRef,
  random,
  sinInputs,
  strandsInputs,
  strandsRef,
} from './parityRef';
import { describeAdapter } from './device';
import { reportCompilation, withShared } from './pipelines';
import parityWgsl from './shaders/parity.wgsl?raw';
import { FRAME_FIELDS, packFrame, packPalette } from './uniforms';

/** One function on one kind of input. */
export interface ParityResult {
  name: string;
  count: number;
  /** Largest error over the inputs, in `unit`. */
  maxErr: number;
  tol: number;
  unit: string;
  ok: boolean;
  /** The input with the largest error, and what the GPU and TS said. */
  worst: string | null;
  note?: string;
}

export interface GpuParity {
  ok: boolean;
  /** describeAdapter(): vendor, architecture, "(software)" for SwiftShader and the like. */
  adapter: string;
  results: ParityResult[];
  /** Set when the check could not run at all (no WebGPU here). */
  error?: string;
}

declare global {
  interface Window {
    /** `?debug=parity`: WGSL vs TS results (gpu/parity.ts). */
    __gpuParity?: GpuParity;
  }
}

const WORKGROUP = 64;
const ENTRIES = ['cs_kingdom', 'cs_polar', 'cs_hash', 'cs_strands', 'cs_sin'] as const;
type Entry = (typeof ENTRIES)[number];

/** The device, the compiled pipelines and the static palette buffer. */
interface Kit {
  device: GPUDevice;
  pipelines: Record<Entry, GPUComputePipeline>;
  frameLayout: GPUBindGroupLayout;
  ioLayout: GPUBindGroupLayout;
  palette: GPUBuffer;
}

/** A camera with the uniforms it gives, and the Frame bytes the renderer would upload for it. */
interface CameraCase {
  name: string;
  cam: Camera;
  frame: ArrayBuffer;
  /** The float32 values the shaders read from `frame`. */
  seamUnits: number;
  pxPerUnit: number;
}

/** Runs every check; never throws (the error goes into the result). */
export async function runGpuParity(palette: RunPalette, tipCount: number): Promise<GpuParity> {
  let kit: Kit | null = null;
  try {
    // Any adapter, software included: this checks the maths, not the speed.
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) return { ok: false, adapter: 'none', results: [], error: 'no WebGPU adapter' };
    const device = await adapter.requestDevice();
    kit = await buildKit(device, palette);
    const results = await runChecks(kit, palette, tipCount);
    return { ok: results.every((r) => r.ok), adapter: describeAdapter(adapter.info), results };
  } catch (err) {
    return { ok: false, adapter: 'unknown', results: [], error: String(err) };
  } finally {
    kit?.palette.destroy();
    kit?.device.destroy();
  }
}

async function buildKit(device: GPUDevice, palette: RunPalette): Promise<Kit> {
  const module = device.createShaderModule({ label: 'parity', code: withShared(parityWgsl) });
  if (await reportCompilation(module, 'parity.wgsl')) throw new Error('WGSL compile failed: parity.wgsl');
  const frameLayout = device.createBindGroupLayout({
    label: 'parity frame',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ],
  });
  const ioLayout = device.createBindGroupLayout({
    label: 'parity io',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });
  const layout = device.createPipelineLayout({ label: 'parity', bindGroupLayouts: [frameLayout, ioLayout] });
  const pipelines: Partial<Record<Entry, GPUComputePipeline>> = {};
  for (const entryPoint of ENTRIES) {
    pipelines[entryPoint] = await device.createComputePipelineAsync({
      label: entryPoint,
      layout,
      compute: { module, entryPoint },
    });
  }
  const bytes = packPalette(palette);
  const paletteBuffer = device.createBuffer({
    label: 'parity palette',
    size: bytes.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(paletteBuffer, 0, bytes);
  return { device, pipelines: pipelines as Record<Entry, GPUComputePipeline>, frameLayout, ioLayout, palette: paletteBuffer };
}

/**
 * Runs `entry` over `inputs` (4 words per item) with `frame` as the Frame
 * uniforms; returns 4 floats per item.
 */
async function dispatch(kit: Kit, entry: Entry, frame: ArrayBuffer, inputs: Uint32Array): Promise<Float32Array> {
  const { device } = kit;
  const n = inputs.length / 4;
  const frameBuffer = device.createBuffer({ size: frame.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const input = device.createBuffer({ size: inputs.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const output = device.createBuffer({ size: n * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ size: n * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  try {
    device.queue.writeBuffer(frameBuffer, 0, frame);
    device.queue.writeBuffer(input, 0, inputs);
    const frameGroup = device.createBindGroup({
      layout: kit.frameLayout,
      entries: [
        { binding: 0, resource: { buffer: frameBuffer } },
        { binding: 1, resource: { buffer: kit.palette } },
      ],
    });
    const ioGroup = device.createBindGroup({
      layout: kit.ioLayout,
      entries: [
        { binding: 0, resource: { buffer: input } },
        { binding: 1, resource: { buffer: output } },
      ],
    });
    const encoder = device.createCommandEncoder({ label: entry });
    const pass = encoder.beginComputePass({ label: entry });
    pass.setPipeline(kit.pipelines[entry]);
    pass.setBindGroup(0, frameGroup);
    pass.setBindGroup(1, ioGroup);
    pass.dispatchWorkgroups(Math.ceil(n / WORKGROUP));
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, n * 16);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    return new Float32Array(readback.getMappedRange().slice(0));
  } finally {
    // Destroying a mapped buffer also unmaps it.
    for (const b of [frameBuffer, input, output, readback]) b.destroy();
  }
}

/** Items of 4 u32 words, floats stored as their bits. */
class Inputs {
  readonly words: Uint32Array;
  private readonly floats: Float32Array;

  constructor(n: number) {
    this.words = new Uint32Array(4 * n);
    this.floats = new Float32Array(this.words.buffer);
  }

  u32(i: number, lane: number, v: number): void {
    this.words[4 * i + lane] = v;
  }

  f32(i: number, lane: number, v: number): void {
    this.floats[4 * i + lane] = v;
  }
}

/** Collects the largest error of one check. */
class Worst {
  maxErr = 0;
  worst: string | null = null;

  see(err: number, describe: () => string): void {
    // NaN counts as the worst possible answer.
    const e = Number.isNaN(err) ? Infinity : err;
    if (e > this.maxErr || (this.worst === null && e > 0)) {
      this.maxErr = e;
      this.worst = describe();
    }
  }

  result(name: string, count: number, tol: number, unit: string, note?: string): ParityResult {
    return { name, count, maxErr: this.maxErr, tol, unit, ok: this.maxErr <= tol, worst: this.worst, note };
  }
}

const fmt = (xs: ArrayLike<number>): string => `(${Array.from(xs, (x) => x.toPrecision(8)).join(', ')})`;

/** Frame bytes for a camera, packed exactly as the renderer packs them. */
function cameraCase(name: string, cam: Camera): CameraCase {
  const frame = new ArrayBuffer(structLayout(FRAME_FIELDS).size);
  const p: FrameParams = {
    camera: cam.uniforms(),
    lambda: 0,
    lambdaExt: 0,
    rWin: [0, 2],
    winLo: 0,
    winSpan: TWO_32 - 1,
    fade: () => 1,
    fadeF: 1,
    reveal: Infinity,
    dpr: cam.dpr,
    tipSpacing: cam.tipSpacingPx(),
    homeId: -1,
    homeAngle: 0,
    leaderGap: 0,
    leaderLen: 0,
    homeLeader: 1,
    dims: [],
    highlight: NO_HIGHLIGHT,
  };
  packFrame(p, { glow: 1 }, frame);
  const f = new Float32Array(frame);
  const at = structLayout(FRAME_FIELDS).offsets;
  return { name, cam, frame, seamUnits: f[(at.seamUnits ?? 0) / 4] ?? 0, pxPerUnit: f[(at.pxPerUnit ?? 0) / 4] ?? 0 };
}

/** The cameras the checks use: the whole wheel, a mid zoom, max zoom, and max zoom across angle 0. */
function cameras(tipCount: number): CameraCase[] {
  const make = (angle: number, r: number, scale: number | null, rot: number): Camera => {
    const cam = new Camera(tipCount);
    cam.setViewport(1440, 900, 1);
    // The whole wheel by default: centred, the rim 360 px out.
    cam.scale = scale ?? 360;
    cam.angle = angle;
    cam.r = r;
    cam.rot = rot;
    return cam;
  };
  const max = new Camera(tipCount).maxScale();
  return [
    cameraCase('overview', make(0, 0, null, 0.4)),
    cameraCase('mid zoom', make(2.2, 0.97, 2e5, -1.1)),
    cameraCase('max zoom', make(4.1, 1 - 300 / max, max, 0)),
    // 1e-7 rad (~68 units) before 2^32: the screen straddles angle 0, where u32 differences wrap.
    cameraCase('max zoom at 0', make(2 * Math.PI - 1e-7, 1 - 300 / max, max, 2.5)),
  ];
}

/** Run length (u32 units) of the run holding angle `a`. */
function runLength(palette: RunPalette, a: number): number {
  let i = 0;
  while (i + 1 < palette.count && a >= (palette.start[i + 1] ?? TWO_32)) i++;
  const hi = i + 1 < palette.count ? (palette.start[i + 1] ?? TWO_32) : TWO_32;
  return hi - (palette.start[i] ?? 0);
}

/** The gap between neighbouring float32 values near x (x > 0). */
function f32Step(x: number): number {
  return 2 ** (Math.floor(Math.log2(Math.max(x, 1))) - 23);
}

/**
 * Error budget of one polar point, device px: 0.05 px, plus, where the
 * shader uses the built-in sin (|Δθ| ≥ 0.1 rad: far from the camera angle,
 * which only happens zoomed out), the 2^-11 accuracy WGSL allows it, times
 * r · scale, for each of the two sines.
 */
function polarBudgetPx(cam: Camera, a: number, r: number): number {
  const u = cam.uniforms();
  let d = (a - u.camA) % TWO_32;
  if (d < 0) d += TWO_32;
  const dth = Math.abs((d >= 2 ** 31 ? d - TWO_32 : d) - u.camAFrac) * (2 * Math.PI / TWO_32);
  return 0.05 + (dth >= 0.1 ? 2 * 2 ** -11 * r * cam.scale : 0);
}

/**
 * Tolerances: kingdom colour 1/1024 per sRGB channel (a quarter of an 8-bit
 * step), at an angle within one float32 step (see the check); polar within
 * `polarBudgetPx` (0.05 px, a fifth of the precision test's 0.25 px bound,
 * near the camera angle);
 * hash and strand hashes one float32 step (2^-24; the u32 → f32 conversion
 * may round either way); strand weight 1e-5 (log2 in float32);
 * sinPrecise 1e-6 relative below 0.1 (a few float32 steps), and 2^-11
 * absolute above, the accuracy WGSL promises for the built-in sin.
 */
async function runChecks(kit: Kit, palette: RunPalette, tipCount: number): Promise<ParityResult[]> {
  const results: ParityResult[] = [];
  const cams = cameras(tipCount);
  const [overview, mid, deep] = cams;
  if (!overview || !mid || !deep) throw new Error('parity: camera cases missing');

  // kingdomColour, with the seams as wide as two of the cameras make them.
  for (const c of [overview, mid]) {
    const angles = kingdomInputs(palette.start, c.seamUnits);
    const inp = new Inputs(angles.length);
    angles.forEach((a, i) => inp.u32(i, 0, a));
    const out = await dispatch(kit, 'cs_kingdom', c.frame, inp.words);
    const w = new Worst();
    let maxStepPx = 0;
    angles.forEach((a, i) => {
      const got = out.subarray(4 * i, 4 * i + 3);
      // The shader measures the angle from the run start as a float32, so it
      // knows the angle to within one float32 step of the run's length: the
      // GPU colour is right if it is the TS colour somewhere in that window.
      const step = f32Step(runLength(palette, a));
      maxStepPx = Math.max(maxStepPx, step * c.pxPerUnit);
      let err = Infinity;
      let want = palette.colourAt(a, c.seamUnits);
      for (let s = -32; s <= 32; s++) {
        const ts = palette.colourAt(a + (s / 32) * step, c.seamUnits);
        const e = Math.max(...ts.map((v, k) => Math.abs(v - (got[k] ?? NaN))));
        if (e < err) {
          err = e;
          want = ts;
        }
      }
      w.see(err, () => `a ${a}: gpu ${fmt(got)} ts ${fmt(want)}`);
    });
    const note = `angle window: one float32 step of the run length, at most ${maxStepPx.toFixed(3)} px here`;
    results.push(w.result(`kingdomColour (${c.name} seams)`, angles.length, 1 / 1024, 'sRGB', note));
  }

  // polarToClipOffset, per camera, in px from the centre.
  for (const c of cams) {
    const pts = polarInputs(c.cam);
    const inp = new Inputs(pts.length);
    pts.forEach((p, i) => {
      inp.u32(i, 0, p.a);
      inp.f32(i, 1, p.r);
      inp.f32(i, 2, p.off[0]);
      inp.f32(i, 3, p.off[1]);
    });
    const out = await dispatch(kit, 'cs_polar', c.frame, inp.words);
    const w = new Worst();
    const halfW = c.cam.width / 2;
    const halfH = c.cam.height / 2;
    let maxPx = 0;
    pts.forEach((p, i) => {
      const want = polarRef(c.cam, p.a, p.r, p.off);
      const got = [(out[4 * i] ?? NaN) * halfW, (out[4 * i + 1] ?? NaN) * halfH];
      const err = Math.hypot((got[0] ?? NaN) - want[0], (got[1] ?? NaN) - want[1]);
      maxPx = Math.max(maxPx, err);
      const budget = polarBudgetPx(c.cam, p.a, p.r);
      w.see(err / budget, () => `a ${p.a} r ${p.r} off ${fmt(p.off)}: gpu ${fmt(got)} ts ${fmt(want)} (${err.toFixed(4)} of ${budget.toFixed(4)} px)`);
    });
    const note = `max ${maxPx.toFixed(4)} px`;
    results.push(w.result(`polarToClipOffset (${c.name})`, pts.length, 1, 'of budget', note));
  }

  // hash: edge values and a random sweep of u32.
  {
    const rnd = random(1);
    const xs = [0, 1, 2, 0x7fffffff, 0x80000000, 0xffffffff];
    while (xs.length < 512) xs.push(Math.floor(rnd() * TWO_32));
    const inp = new Inputs(xs.length);
    xs.forEach((x, i) => inp.u32(i, 0, x));
    const out = await dispatch(kit, 'cs_hash', overview.frame, inp.words);
    const w = new Worst();
    xs.forEach((x, i) => {
      const want = hashRef(x);
      const got = out[4 * i] ?? NaN;
      w.see(Math.abs(got - want), () => `x ${x}: gpu ${got} ts ${want}`);
    });
    results.push(w.result('hash', xs.length, 2 ** -24, 'abs'));
  }

  // strands, at the zoom of two cameras (it reads frame.pxPerUnit).
  for (const c of [overview, deep]) {
    const pairs = strandsInputs(c.pxPerUnit, 256, 2);
    const inp = new Inputs(pairs.length);
    pairs.forEach(([u, px], i) => {
      inp.f32(i, 0, u);
      inp.f32(i, 1, px);
    });
    const out = await dispatch(kit, 'cs_strands', c.frame, inp.words);
    const hashes = new Worst();
    const weight = new Worst();
    pairs.forEach(([u, px], i) => {
      const want = strandsRef(u, px, c.pxPerUnit);
      const got = out.subarray(4 * i, 4 * i + 3);
      const why = (): string => `units ${u} px ${px}: gpu ${fmt(got)} ts ${fmt(want)}`;
      hashes.see(Math.max(Math.abs((got[0] ?? NaN) - want[0]), Math.abs((got[1] ?? NaN) - want[1])), why);
      weight.see(Math.abs((got[2] ?? NaN) - want[2]), why);
    });
    results.push(hashes.result(`strands hashes (${c.name})`, pairs.length, 2 ** -24, 'abs'));
    results.push(weight.result(`strands weight (${c.name})`, pairs.length, 1e-5, 'abs'));
  }

  // sinPrecise against Math.sin; the built-in sin on small angles as a note.
  {
    const xs = sinInputs();
    const inp = new Inputs(xs.length);
    xs.forEach((x, i) => inp.f32(i, 0, x));
    const out = await dispatch(kit, 'cs_sin', overview.frame, inp.words);
    const small = new Worst();
    const large = new Worst();
    let builtinRel = 0;
    let smallCount = 0;
    xs.forEach((x, i) => {
      const want = Math.sin(x);
      const got = out[4 * i] ?? NaN;
      const why = (): string => `x ${x}: gpu ${got} ts ${want}`;
      if (Math.abs(x) < 0.1) {
        smallCount++;
        small.see(Math.abs(got - want) / Math.abs(want), why);
        builtinRel = Math.max(builtinRel, Math.abs((out[4 * i + 1] ?? NaN) - want) / Math.abs(want));
      } else {
        large.see(Math.abs(got - want), why);
      }
    });
    const note = `built-in sin on the same inputs: max relative error ${builtinRel.toExponential(2)}`;
    results.push(small.result('sinPrecise |x| < 0.1', smallCount, 1e-6, 'relative', note));
    results.push(large.result('sinPrecise |x| ≥ 0.1', xs.length - smallCount, 2 ** -11, 'abs'));
  }
  return results;
}
