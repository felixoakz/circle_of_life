// The WebGPU backend: executes the shared frame plan (render/plan.ts) with
// WebGPU pipelines, one per pass (gpu/pipelines.ts).
//
// WebGPU concepts used here:
// - Buffers are created with a fixed size and *usage* flags saying what they
//   may be used for (UNIFORM, STORAGE, COPY_DST…). `queue.writeBuffer`
//   copies JS bytes into one; the copy happens in queue order, before any
//   commands submitted after it.
// - Storage-buffer vertex pulling: there are no vertex buffers. Each tile's
//   bytes go into one read-only STORAGE buffer, bound as group 2, and the
//   vertex shader reads node `instance_index` from it (tile.wgsl). That
//   keeps the zero-copy upload WebGL had. The frontier fans and each
//   highlighted path get a storage buffer of their own the same way.
// - Bind groups with a dynamic offset: every draw's own uniforms (fade,
//   alpha…) live in one shared buffer of 256-byte slots, uploaded once per
//   frame. A single bind group points at "256 bytes somewhere in that
//   buffer"; `setBindGroup(1, group, [offset])` picks the slot per draw.
// - A *command encoder* records GPU work; nothing runs until
//   `queue.submit([encoder.finish()])`. Inside it, a *render pass* draws into
//   its attachments: here the 4× MSAA texture, cleared at the start and
//   *resolved* into the canvas texture at the end (gpu/target.ts).
// - Within a pass: `setPipeline` (shaders + fixed state), `setBindGroup`
//   for each group, then `draw(vertexCount, instanceCount, firstVertex,
//   firstInstance)`.
// - Device loss (docs/plan-webgpu.md §2.4): everything made by a device dies
//   with it, so all of it lives in one `DeviceState`, built by
//   `buildDeviceState`. After a loss we build a new one on a new device,
//   re-upload the fans, and let the scene re-upload its tiles
//   (`onRestored`). That happens once per page; a second loss, or a failed
//   recovery, goes to `onLost` (the app reloads into WebGL2).
// - GPU frame time (`?debug`, `?shot`): when the device has
//   `timestamp-query`, the tree pass writes timestamps that gpu/timing.ts
//   reads back without ever waiting for them.

import { type RunPalette } from '../palette';
import { type DrawCmd, type Pass, fanSpans, parsePasses, planFrame } from '../render/plan';
import type { FrameParams, FrameStats, GpuTile, Pixels, Renderer, RendererOptions } from '../render/types';
import type { Tile } from '../tiles/decode';
import { FAN_WORDS } from '../tiles/fans';
import { describeAdapter, openDevice, watchErrors } from './device';
import { structLayout } from './layout';
import { type Layouts, createLayouts, createPipelines, pipelineKey } from './pipelines';
import { readTexture } from './readback';
import { CanvasTarget } from './target';
import { GpuTimer } from './timing';
import { tileBindingBytes } from './tiles';
import { DRAW_SLOT_BYTES, DrawSlots, FRAME_FIELDS, packDraw, packFrame, packLines, packPalette } from './uniforms';

/** A tile's bytes on the GPU: one storage buffer and the bind group (group 2) that points at it. */
export class WebGpuTile implements GpuTile {
  readonly buffer: GPUBuffer;
  readonly bindGroup: GPUBindGroup;
  readonly level: number;
  readonly count: number;
  readonly internalCount: number;

  constructor(buffer: GPUBuffer, bindGroup: GPUBindGroup, tile: Tile) {
    this.buffer = buffer;
    this.bindGroup = bindGroup;
    this.level = tile.level;
    this.count = tile.count;
    this.internalCount = tile.internalCount;
  }
}

/** Narrows a tile from the shared plan to this backend's kind. */
function gpuTile(t: GpuTile): WebGpuTile {
  if (!(t instanceof WebGpuTile)) throw new Error('tile was not uploaded by the WebGPU renderer');
  return t;
}

/**
 * Builds the WebGPU renderer on `device` (render/select.ts already applied
 * the adapter policy). Throws, destroying the device, when it cannot.
 */
export async function createWebGpuRenderer(
  device: GPUDevice,
  canvas: HTMLCanvasElement,
  palette: RunPalette,
  opts: RendererOptions,
): Promise<Renderer> {
  watchErrors(device);
  try {
    // Compile everything before getContext: once a canvas gave a `webgpu`
    // context it can never give `webgl2`, so a failure here must leave the
    // canvas free for the WebGL2 fallback.
    const format = navigator.gpu.getPreferredCanvasFormat();
    const layouts = createLayouts(device);
    const pipelines = await createPipelines(device, format, layouts);
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('canvas gave no webgpu context');
    const q = new URLSearchParams(location.search);
    // GPU timing is for the debug HUD and the screenshot benchmark only.
    const timing = q.has('debug') || q.has('shot');
    const target = new CanvasTarget(device, canvas, context, format);
    const state = buildDeviceState(device, target, layouts, pipelines, palette, timing);
    window.__gpuAdapter = describeAdapter(device.adapterInfo);
    return new WebGpuRenderer(state, canvas, context, palette, opts, parsePasses(q), timing);
  } catch (err) {
    device.destroy();
    throw err;
  }
}

declare global {
  interface Window {
    /** The WebGPU adapter in use, e.g. "amd rdna-2" or "google swiftshader (software)"; perf notes label numbers with it. */
    __gpuAdapter?: string;
  }
}

/** A growable storage buffer for group 2 (the fans, or one path slot), and the bind group pointing at it. */
interface DataBuffer {
  buffer: GPUBuffer;
  group: GPUBindGroup;
  /** The array last uploaded (paths: a new array means new contents). */
  data: Uint32Array | null;
}

/** Everything owned by one GPU device; replaced as a whole after a loss. */
interface DeviceState {
  device: GPUDevice;
  target: CanvasTarget;
  layouts: Layouts;
  pipelines: Map<string, GPURenderPipeline>;
  /** Group 0: the per-frame `Frame` uniforms and the static `Palette`. */
  frameBuffer: GPUBuffer;
  paletteBuffer: GPUBuffer;
  frameGroup: GPUBindGroup;
  /** Group 1: the per-draw uniform slots (re-created when they grow). */
  drawBuffer: GPUBuffer | null;
  drawGroup: GPUBindGroup | null;
  fans: DataBuffer | null;
  /** One storage buffer per highlighted path slot. */
  paths: DataBuffer[];
  /** Frame timing, when asked for and the device has `timestamp-query`. */
  timer: GpuTimer | null;
}

function buildDeviceState(
  device: GPUDevice,
  target: CanvasTarget,
  layouts: Layouts,
  pipelines: Map<string, GPURenderPipeline>,
  palette: RunPalette,
  timing: boolean,
): DeviceState {
  const frameBuffer = device.createBuffer({
    label: 'frame',
    size: structLayout(FRAME_FIELDS).size,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const paletteBytes = packPalette(palette);
  const paletteBuffer = device.createBuffer({
    label: 'palette',
    size: paletteBytes.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(paletteBuffer, 0, paletteBytes);
  const frameGroup = device.createBindGroup({
    label: 'frame',
    layout: layouts.frame,
    entries: [
      { binding: 0, resource: { buffer: frameBuffer } },
      { binding: 1, resource: { buffer: paletteBuffer } },
    ],
  });
  return {
    device,
    target,
    layouts,
    pipelines,
    frameBuffer,
    paletteBuffer,
    frameGroup,
    drawBuffer: null,
    drawGroup: null,
    fans: null,
    paths: [],
    timer: timing && GpuTimer.supported(device) ? new GpuTimer(device) : null,
  };
}

/** One planned command, ready to encode. */
interface Encoded {
  cmd: DrawCmd;
  pipeline: GPURenderPipeline;
  /** Byte offset of its slot in the per-draw buffer. */
  slot: number;
  /** Group 2 (tile, fans or path), when the pass reads one. */
  data: GPUBindGroup | null;
}

export class WebGpuRenderer implements Renderer {
  readonly kind = 'webgpu';
  onLost: (reason: string) => void = () => {};
  onRestored: () => void = () => {};

  private gpu: DeviceState;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: GPUCanvasContext;
  private readonly palette: RunPalette;
  private readonly opts: RendererOptions;
  /** `?passes=…` debug filter, or null for every pass. */
  private readonly passes: ReadonlySet<Pass> | null;
  /** Time frames on the GPU when the device can (`?debug`, `?shot`). */
  private readonly timing: boolean;
  /** The per-frame `Frame` uniforms, staged on the CPU. */
  private readonly frameBytes = new ArrayBuffer(structLayout(FRAME_FIELDS).size);
  /** Per-draw uniform slots, staged on the CPU and uploaded once per frame. */
  private readonly slots = new DrawSlots();
  /** The fans last set, kept to upload again on a new device. */
  private fanData: Uint32Array = new Uint32Array(0);
  private fanCount = 0;
  /** Angular span of each fan, in buffer order (widest first); the plan needs them for the fan split. */
  private fanSpans: Float64Array = new Float64Array(0);
  /** Between a loss and the end of recovery: frames are skipped. */
  private lost = false;
  /** Recovery happens once per page; the next loss reloads into WebGL2. */
  private recovered = false;
  /** `loseDevice()` destroyed the device on purpose, to be treated as a real loss. */
  private simulatingLoss = false;

  constructor(
    gpu: DeviceState,
    canvas: HTMLCanvasElement,
    context: GPUCanvasContext,
    palette: RunPalette,
    opts: RendererOptions,
    passes: ReadonlySet<Pass> | null = null,
    timing = false,
  ) {
    this.gpu = gpu;
    this.canvas = canvas;
    this.context = context;
    this.palette = palette;
    this.opts = opts;
    this.passes = passes;
    this.timing = timing;
    this.watchLoss(gpu.device);
  }

  /** `?debug`: destroys the device and recovers as if the GPU had been lost. */
  loseDevice(): void {
    this.simulatingLoss = true;
    this.gpu.device.destroy();
  }

  /** Replaces the frontier fans (built by tiles/fans.ts, widest first). */
  setFans(data: Uint32Array): void {
    this.fanData = data;
    this.fanCount = data.length / FAN_WORDS;
    this.fanSpans = fanSpans(data);
    this.gpu.fans = this.fill(this.gpu.fans, data, 'fans');
  }

  upload(tile: Tile): GpuTile {
    // Only the bytes before the names: the shaders never read names.
    const size = tileBindingBytes(tile);
    const { device, layouts } = this.gpu;
    const buffer = device.createBuffer({
      label: `tile ${tile.level}/${tile.sector}`,
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buffer, 0, tile.buffer, 0, size);
    const bindGroup = device.createBindGroup({
      label: `tile ${tile.level}/${tile.sector}`,
      layout: layouts.data,
      entries: [{ binding: 0, resource: { buffer } }],
    });
    return new WebGpuTile(buffer, bindGroup, tile);
  }

  release(tile: GpuTile): void {
    // Safe: draw() encodes and submits synchronously, so no pending frame still names this buffer.
    gpuTile(tile).buffer.destroy();
  }

  size(): { width: number; height: number } {
    return { width: this.canvas.width, height: this.canvas.height };
  }

  draw(tiles: readonly GpuTile[], p: FrameParams): FrameStats {
    // Lost and not yet recovered: nothing can draw (the scene redraws on onRestored).
    if (this.lost) return { tiles: 0, instances: 0, drawCalls: 0 };
    const gpu = this.gpu;
    const device = gpu.device;
    const plan = planFrame(tiles, { count: this.fanCount, spans: this.fanSpans }, p, this.size(), this.passes);
    packFrame(p, plan.look, this.frameBytes);
    device.queue.writeBuffer(gpu.frameBuffer, 0, this.frameBytes);

    // Stage every command's uniforms first, so the per-draw buffer is
    // uploaded (and re-created if it grew) before anything is encoded.
    this.slots.reset();
    const encoded: Encoded[] = [];
    for (const cmd of plan.cmds) {
      const wide = (cmd.pass === 'branches' || cmd.pass === 'arcs') && cmd.halfW > 0;
      const pipeline = gpu.pipelines.get(pipelineKey(cmd.pass, wide));
      if (!pipeline) continue; // createPipelines builds every pass and variant; this only narrows the type
      const slot = this.slots.next();
      encoded.push({ cmd, pipeline, slot, data: this.stage(cmd, slot) });
    }
    const grown = this.slots.takeGrown();
    let drawBuffer = gpu.drawBuffer;
    let drawGroup = gpu.drawGroup;
    if (!drawBuffer || !drawGroup || grown) {
      drawBuffer?.destroy();
      [drawBuffer, drawGroup] = this.createDrawBuffer();
      gpu.drawBuffer = drawBuffer;
      gpu.drawGroup = drawGroup;
    }
    if (this.slots.used > 0) {
      device.queue.writeBuffer(drawBuffer, 0, this.slots.bytes, 0, this.slots.used * DRAW_SLOT_BYTES);
    }

    // A pass runs even with nothing to draw: it clears the canvas.
    const encoder = device.createCommandEncoder({ label: 'frame' });
    const pass = encoder.beginRenderPass({
      label: 'tree',
      colorAttachments: [gpu.target.colourAttachment()],
      timestampWrites: gpu.timer?.passWrites(),
    });
    pass.setBindGroup(0, gpu.frameGroup);
    let current: GPURenderPipeline | null = null;
    for (const e of encoded) {
      if (e.pipeline !== current) {
        current = e.pipeline;
        pass.setPipeline(current);
      }
      pass.setBindGroup(1, drawGroup, [e.slot]);
      if (e.data) pass.setBindGroup(2, e.data);
      const c = e.cmd;
      pass.draw(c.vertexCount, c.instanceCount, 0, c.firstInstance);
    }
    pass.end();
    gpu.timer?.resolve(encoder);
    device.queue.submit([encoder.finish()]);
    gpu.timer?.submitted();
    return plan.stats;
  }

  /** The GPU is done, and so is reading back the frame times of everything submitted. */
  async finish(): Promise<void> {
    const gpu = this.gpu;
    await gpu.device.queue.onSubmittedWorkDone();
    await gpu.timer?.settled();
  }

  readPixels(): Promise<Pixels> {
    // Same task as draw(): getCurrentTexture() still returns the frame just drawn.
    return readTexture(this.gpu.device, this.context.getCurrentTexture());
  }

  gpuMs(): number | null {
    return this.gpu.timer?.ms() ?? null;
  }

  destroy(): void {
    releaseDeviceState(this.gpu);
    this.gpu.device.destroy();
  }

  /** Recovers from a real loss (any reason but our own destroy()), or reports it. */
  private watchLoss(device: GPUDevice): void {
    void device.lost.then((info) => {
      const simulated = this.simulatingLoss;
      this.simulatingLoss = false;
      if (info.reason === 'destroyed' && !simulated) return;
      // A device that was replaced already is not this renderer's any more.
      if (device !== this.gpu.device) return;
      void this.recover(info.message || 'device lost');
    });
  }

  /**
   * Plan §2.4: a new adapter and device, the canvas configured for it,
   * pipelines and buffers re-created, fans re-uploaded; then the scene
   * re-uploads its tiles (`onRestored`). Once per page, else `onLost`.
   */
  private async recover(reason: string): Promise<void> {
    this.lost = true;
    if (this.recovered) {
      this.onLost(`${reason} (lost again after a recovery)`);
      return;
    }
    this.recovered = true;
    console.warn(`WebGPU device lost (${reason}); re-creating it`);
    let device: GPUDevice | null = null;
    try {
      device = await openDevice(this.opts);
      if (!device) throw new Error('no WebGPU device after the loss');
      const format = navigator.gpu.getPreferredCanvasFormat();
      const layouts = createLayouts(device);
      const pipelines = await createPipelines(device, format, layouts);
      // The old buffers died with the old device; destroying them just drops our handles.
      releaseDeviceState(this.gpu);
      const target = new CanvasTarget(device, this.canvas, this.context, format);
      this.gpu = buildDeviceState(device, target, layouts, pipelines, this.palette, this.timing);
    } catch (err) {
      device?.destroy();
      this.onLost(`${reason}; recovery failed: ${String(err)}`);
      return;
    }
    this.watchLoss(device);
    this.lost = false;
    this.setFans(this.fanData);
    this.onRestored();
  }

  /** Writes `cmd`'s uniforms into its slot; returns the group-2 bind group it reads, if any. */
  private stage(cmd: DrawCmd, slot: number): GPUBindGroup | null {
    switch (cmd.pass) {
      case 'branches':
      case 'arcs':
        packLines(cmd, this.slots.bytes, slot);
        return gpuTile(cmd.tile).bindGroup;
      case 'marks':
        packDraw(cmd, this.slots.bytes, slot);
        return gpuTile(cmd.tile).bindGroup;
      case 'fans':
        packDraw(cmd, this.slots.bytes, slot);
        return this.gpu.fans?.group ?? null;
      case 'path': {
        packDraw(cmd, this.slots.bytes, slot);
        const paths = this.gpu.paths;
        const old = paths[cmd.slot] ?? null;
        const buf = old?.data === cmd.data ? old : this.fill(old, cmd.data, `path ${cmd.slot}`);
        paths[cmd.slot] = buf;
        return buf.group;
      }
      case 'rim':
      case 'ring':
      case 'backdrop':
      case 'dim':
        packDraw(cmd, this.slots.bytes, slot);
        return null;
    }
  }

  /**
   * Uploads `data` into `old`'s storage buffer, or into a new one (with its
   * bind group) when `old` is missing or too small. Buffers only grow, and
   * are at least 16 bytes: a binding cannot be empty.
   */
  private fill(old: DataBuffer | null, data: Uint32Array, label: string): DataBuffer {
    const { device, layouts } = this.gpu;
    let buf = old;
    if (!buf || buf.buffer.size < data.byteLength) {
      // Destroying a buffer an earlier, already submitted frame still reads is
      // safe: WebGPU frees it only after that work is done.
      old?.buffer.destroy();
      let size = 16;
      while (size < data.byteLength) size *= 2;
      const buffer = device.createBuffer({ label, size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      const group = device.createBindGroup({
        label,
        layout: layouts.data,
        entries: [{ binding: 0, resource: { buffer } }],
      });
      buf = { buffer, group, data: null };
    }
    if (data.byteLength > 0) device.queue.writeBuffer(buf.buffer, 0, data);
    buf.data = data;
    return buf;
  }

  /** The per-draw uniform buffer at the slots' capacity, and its bind group (one slot visible at a time). */
  private createDrawBuffer(): [GPUBuffer, GPUBindGroup] {
    const { device, layouts } = this.gpu;
    const buffer = device.createBuffer({
      label: 'draw slots',
      size: this.slots.bytes.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const group = device.createBindGroup({
      label: 'draw slots',
      layout: layouts.draw,
      entries: [{ binding: 0, resource: { buffer, size: DRAW_SLOT_BYTES } }],
    });
    return [buffer, group];
  }
}

/** Destroys a device state's buffers and textures (not the device itself). */
function releaseDeviceState(gpu: DeviceState): void {
  gpu.target.destroy();
  gpu.frameBuffer.destroy();
  gpu.paletteBuffer.destroy();
  gpu.drawBuffer?.destroy();
  gpu.fans?.buffer.destroy();
  for (const b of gpu.paths) b.buffer.destroy();
  gpu.timer?.destroy();
}
