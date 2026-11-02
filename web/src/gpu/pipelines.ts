// The WebGPU render pipelines (docs/plan-webgpu.md §2.2): which WGSL module
// and entry points draw each pass, with what topology and blend, and the
// code that builds them.
//
// WebGPU concepts used here:
// - A *shader module* is compiled WGSL text. WGSL has no `#include`, so each
//   module is the generated structs + the shared files + the pass's own file.
// - A *render pipeline* bakes nearly all draw state up front: shaders,
//   primitive topology (line-list, triangle-list…), blending, the target's
//   texture format and its MSAA sample count. WebGL set these as global
//   switches before each draw; here you pick a whole pipeline instead.
// - A *bind group layout* declares what resources a shader reads at
//   `@group(g) @binding(b)` (a uniform buffer, a storage buffer…); a
//   *pipeline layout* lists the bind group layouts of groups 0, 1, 2. A
//   *bind group* (renderer.ts) is a concrete set of buffers matching a
//   layout. Groups are split by how often they change: 0 per frame
//   (Frame, Palette), 1 per draw (that draw's uniforms, chosen with a
//   *dynamic offset* into one shared buffer), 2 per data source (a tile).

import type { Blend, Pass } from '../render/plan';
import { structLayout, wgslStruct } from './layout';
import common from './shaders/common.wgsl?raw';
import dim from './shaders/dim.wgsl?raw';
import fans from './shaders/fans.wgsl?raw';
import frag from './shaders/frag.wgsl?raw';
import lines from './shaders/lines.wgsl?raw';
import marks from './shaders/marks.wgsl?raw';
import palette from './shaders/palette.wgsl?raw';
import path from './shaders/path.wgsl?raw';
import rim from './shaders/rim.wgsl?raw';
import ring from './shaders/ring.wgsl?raw';
import tile from './shaders/tile.wgsl?raw';
import { DRAW_SLOT_BYTES, DRAW_STRUCTS, FRAME_FIELDS, PALETTE_FIELDS } from './uniforms';

/** Shared WGSL modules, prepended in this order to every pipeline's own module. */
export const SHARED_MODULES = ['common.wgsl', 'palette.wgsl', 'frag.wgsl', 'tile.wgsl'] as const;

export interface PipelineSpec {
  pass: Pass;
  /** File in gpu/shaders/. */
  module: string;
  vertex: string;
  fragment: string;
  topology: GPUPrimitiveTopology;
  blend: Blend;
  /** Bind group layouts: frame + draw, plus a storage `data` group (tile, fans or path). */
  groups: 'frame-draw-data' | 'frame-draw';
}

export const PIPELINES: readonly PipelineSpec[] = [
  { pass: 'branches', module: 'lines.wgsl', vertex: 'vs_branches', fragment: 'fs_line', topology: 'line-list', blend: 'saturating', groups: 'frame-draw-data' },
  { pass: 'arcs', module: 'lines.wgsl', vertex: 'vs_arcs', fragment: 'fs_line', topology: 'line-list', blend: 'saturating', groups: 'frame-draw-data' },
  { pass: 'fans', module: 'fans.wgsl', vertex: 'vs_fans', fragment: 'fs_fans', topology: 'triangle-list', blend: 'saturating', groups: 'frame-draw-data' },
  { pass: 'rim', module: 'rim.wgsl', vertex: 'vs_rim', fragment: 'fs_rim', topology: 'triangle-list', blend: 'saturating', groups: 'frame-draw' },
  { pass: 'marks', module: 'marks.wgsl', vertex: 'vs_marks', fragment: 'fs_marks', topology: 'triangle-strip', blend: 'additive', groups: 'frame-draw-data' },
  { pass: 'path', module: 'path.wgsl', vertex: 'vs_path', fragment: 'fs_path', topology: 'triangle-list', blend: 'over', groups: 'frame-draw-data' },
  { pass: 'ring', module: 'ring.wgsl', vertex: 'vs_ring', fragment: 'fs_ring', topology: 'triangle-strip', blend: 'over', groups: 'frame-draw' },
  { pass: 'dim', module: 'dim.wgsl', vertex: 'vs_dim', fragment: 'fs_dim', topology: 'triangle-list', blend: 'dim', groups: 'frame-draw' },
];

/** WGSL text of each module, by file name. */
const SOURCES: Readonly<Record<string, string>> = {
  'common.wgsl': common,
  'palette.wgsl': palette,
  'frag.wgsl': frag,
  'tile.wgsl': tile,
  'lines.wgsl': lines,
  'fans.wgsl': fans,
  'rim.wgsl': rim,
  'marks.wgsl': marks,
  'path.wgsl': path,
  'ring.wgsl': ring,
  'dim.wgsl': dim,
};

/** MSAA samples of the colour target; WebGPU guarantees 1 and 4. */
export const SAMPLE_COUNT = 4;

/** The generated structs (layout.ts), so TS and WGSL share one field list. */
function structsWgsl(): string {
  let out = wgslStruct('Frame', structLayout(FRAME_FIELDS)) + wgslStruct('Palette', structLayout(PALETTE_FIELDS));
  for (const [name, fields] of Object.entries(DRAW_STRUCTS)) out += wgslStruct(name, structLayout(fields));
  return out;
}

/** `body` with the generated structs and the shared modules in front: the text a shader module compiles. */
export function withShared(body: string): string {
  const shared = SHARED_MODULES.map((m) => SOURCES[m] ?? '');
  return [structsWgsl(), ...shared, body].join('\n');
}

/** The full WGSL text compiled for `module`, or null when that module is not written yet. */
export function moduleSource(module: string): string | null {
  const body = SOURCES[module];
  return body === undefined ? null : withShared(body);
}

/**
 * Blend state per mode (render/plan.ts `Blend`), the same for colour and
 * alpha: result = src·srcFactor + dst·dstFactor.
 */
export function blendState(b: Blend): GPUBlendState {
  const both = (srcFactor: GPUBlendFactor, dstFactor: GPUBlendFactor): GPUBlendState => ({
    color: { srcFactor, dstFactor, operation: 'add' },
    alpha: { srcFactor, dstFactor, operation: 'add' },
  });
  switch (b) {
    case 'saturating':
      return both('one-minus-dst-alpha', 'one');
    case 'additive':
      return both('one', 'one');
    case 'over':
      return both('one', 'one-minus-src-alpha');
    case 'dim':
      return both('zero', 'one-minus-src-alpha');
  }
}

/** The bind group layouts and the two pipeline layouts built from them. */
export interface Layouts {
  /** Group 0: `Frame` (binding 0) and `Palette` (binding 1) uniforms. */
  frame: GPUBindGroupLayout;
  /** Group 1: one 256-byte slot of the per-draw uniform buffer, at a dynamic offset. */
  draw: GPUBindGroupLayout;
  /** Group 2: a read-only storage buffer of u32 words (a tile, the fans or a path). */
  data: GPUBindGroupLayout;
  withData: GPUPipelineLayout;
  withoutData: GPUPipelineLayout;
}

export function createLayouts(device: GPUDevice): Layouts {
  const both = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
  const frame = device.createBindGroupLayout({
    label: 'frame',
    entries: [
      { binding: 0, visibility: both, buffer: { type: 'uniform' } },
      { binding: 1, visibility: both, buffer: { type: 'uniform' } },
    ],
  });
  const draw = device.createBindGroupLayout({
    label: 'draw',
    entries: [
      {
        binding: 0,
        visibility: both,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: DRAW_SLOT_BYTES },
      },
    ],
  });
  const data = device.createBindGroupLayout({
    label: 'data',
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } }],
  });
  return {
    frame,
    draw,
    data,
    withData: device.createPipelineLayout({ label: 'frame-draw-data', bindGroupLayouts: [frame, draw, data] }),
    withoutData: device.createPipelineLayout({ label: 'frame-draw', bindGroupLayouts: [frame, draw] }),
  };
}

/** Logs the compiler's messages for a module; returns true when it has errors. */
export async function reportCompilation(module: GPUShaderModule, name: string): Promise<boolean> {
  const info = await module.getCompilationInfo();
  let failed = false;
  for (const m of info.messages) {
    const where = `${name}:${m.lineNum}:${m.linePos}`;
    if (m.type === 'error') {
      failed = true;
      console.error(`WGSL error ${where}: ${m.message}`);
    } else {
      console.warn(`WGSL ${m.type} ${where}: ${m.message}`);
    }
  }
  return failed;
}

/**
 * Compiles every pass whose module exists and builds its pipeline, drawing
 * into `format` textures with SAMPLE_COUNT samples. Passes without a module
 * are missing from the result.
 */
export async function createPipelines(
  device: GPUDevice,
  format: GPUTextureFormat,
  layouts: Layouts,
): Promise<Partial<Record<Pass, GPURenderPipeline>>> {
  const modules = new Map<string, GPUShaderModule>();
  const out: Partial<Record<Pass, GPURenderPipeline>> = {};
  for (const spec of PIPELINES) {
    let module = modules.get(spec.module);
    if (!module) {
      const code = moduleSource(spec.module);
      if (code === null) continue;
      module = device.createShaderModule({ label: spec.module, code });
      if (await reportCompilation(module, spec.module)) throw new Error(`WGSL compile failed: ${spec.module}`);
      modules.set(spec.module, module);
    }
    // Async creation compiles in the background instead of stalling the page.
    out[spec.pass] = await device.createRenderPipelineAsync({
      label: spec.pass,
      layout: spec.groups === 'frame-draw-data' ? layouts.withData : layouts.withoutData,
      vertex: { module, entryPoint: spec.vertex },
      fragment: { module, entryPoint: spec.fragment, targets: [{ format, blend: blendState(spec.blend) }] },
      primitive: { topology: spec.topology },
      multisample: { count: SAMPLE_COUNT },
    });
  }
  return out;
}
