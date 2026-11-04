// The WebGL2 backend (PLAN §7.3): frontier fans, branches, arcs, the rim
// ring and rim marks, additively blended on black (saturating for the tree,
// so dense areas keep their hue; see `setBlend`). Glow comes only from that
// blending and soft-edged geometry; there is no bloom pass (DESIGN.md §5).
// Each tile's bytes are uploaded once as a single ARRAY_BUFFER and one VAO
// points every attribute at its array's byte offset, without copies.
//
// What to draw is decided by `planFrame` (render/plan.ts), shared with the
// WebGPU backend; this class only turns its commands into GL calls.

import { RAD_PER_UNIT } from '../angle';
import { BRANCH, MAX_RUNS, type RunPalette, oklchToSrgb } from '../palette';
import { PATH_WORDS } from '../path';
import { flipRows } from '../render/pixels';
import {
  type ArcsCmd,
  type BackdropCmd,
  type Blend,
  type BranchesCmd,
  type DimCmd,
  type DrawCmd,
  type FansCmd,
  type MarksCmd,
  type Pass,
  type PathCmd,
  type RimCmd,
  type RingCmd,
  fanSpans,
  parsePasses,
  planFrame,
  revealUniform,
} from '../render/plan';
import type { FrameParams, FrameStats, GpuTile, Pixels, Renderer, RendererFactory } from '../render/types';
import * as S from '../style';
import type { Tile } from '../tiles/decode';
import { FAN_WORDS } from '../tiles/fans';
import { type Program, createGL, createProgram } from './context';
import arcsVert from './shaders/arcs.vert?raw';
import backdropFrag from './shaders/backdrop.frag?raw';
import backdropVert from './shaders/backdrop.vert?raw';
import branchesVert from './shaders/branches.vert?raw';
import common from './shaders/common.glsl?raw';
import dimFrag from './shaders/dim.frag?raw';
import dimVert from './shaders/dim.vert?raw';
import fansFrag from './shaders/fans.frag?raw';
import fansVert from './shaders/fans.vert?raw';
import fragCommon from './shaders/frag.glsl?raw';
import lineFrag from './shaders/line.frag?raw';
import marksFrag from './shaders/marks.frag?raw';
import marksVert from './shaders/marks.vert?raw';
import pathFrag from './shaders/path.frag?raw';
import pathVert from './shaders/path.vert?raw';
import ringFrag from './shaders/ring.frag?raw';
import ringVert from './shaders/ring.vert?raw';
import paletteGlsl from './shaders/palette.glsl?raw';
import rimFrag from './shaders/rim.frag?raw';
import rimVert from './shaders/rim.vert?raw';


/** A tile's bytes on the GPU: one buffer, one VAO pointing into it. */
export class WebGl2Tile implements GpuTile {
  readonly vao: WebGLVertexArrayObject;
  readonly buffer: WebGLBuffer;
  readonly level: number;
  readonly count: number;
  readonly internalCount: number;

  constructor(vao: WebGLVertexArrayObject, buffer: WebGLBuffer, tile: Tile) {
    this.vao = vao;
    this.buffer = buffer;
    this.level = tile.level;
    this.count = tile.count;
    this.internalCount = tile.internalCount;
  }
}

/** Narrows a tile from the shared plan to this backend's kind. */
function glTile(t: GpuTile): WebGl2Tile {
  if (!(t instanceof WebGl2Tile)) throw new Error('tile was not uploaded by the WebGL2 renderer');
  return t;
}

const NO_HOME = 0xffffffff;

interface PathBuffer {
  buffer: WebGLBuffer;
  vao: WebGLVertexArrayObject;
  data: Uint32Array | null;
}

const vertex = (body: string): string => `#version 300 es\n${common}\n${paletteGlsl}\n${body}`;
const fragment = (body: string): string => `#version 300 es\n${fragCommon}\n${paletteGlsl}\n${body}`;

/** Builds the WebGL2 renderer, or null when the canvas cannot give a WebGL2 context. */
export const createWebGl2Renderer: RendererFactory = async (canvas, palette) => {
  const gl = createGL(canvas);
  if (!gl) return null;
  return new WebGl2Renderer(gl, palette, parsePasses(new URLSearchParams(location.search)));
};

export class WebGl2Renderer implements Renderer {
  readonly kind = 'webgl2';
  onLost: (reason: string) => void = () => {};
  // WebGL context loss is not handled (docs/plan-webgpu.md §8.5), so this never fires.
  onRestored: () => void = () => {};

  private readonly gl: WebGL2RenderingContext;
  private readonly programs: Record<Pass, Program>;
  /** `?passes=…` debug filter, or null for every pass. */
  private readonly passes: ReadonlySet<Pass> | null;
  /** One dynamic buffer per highlighted path slot. */
  private readonly pathBuffers: PathBuffer[] = [];
  private readonly palette: RunPalette;
  /** The runs as uniform arrays (palette.glsl), padded to MAX_RUNS. */
  private readonly runStart = new Uint32Array(MAX_RUNS);
  private readonly runRgb0 = new Float32Array(MAX_RUNS * 3);
  private readonly runRgb1 = new Float32Array(MAX_RUNS * 3);
  private readonly fanBuffer: WebGLBuffer;
  private readonly fanVao: WebGLVertexArrayObject;
  /** Attribute-less draws (the rim ring) still need a VAO bound. */
  private readonly emptyVao: WebGLVertexArrayObject;
  private fanCount = 0;
  /** Angular span of each fan, in buffer order (widest first). */
  private fanSpans: Float64Array = new Float64Array(0);
  private readonly branchRgb = oklchToSrgb(BRANCH);
  private readonly syncPixel = new Uint8Array(4);

  constructor(gl: WebGL2RenderingContext, palette: RunPalette, passes: ReadonlySet<Pass> | null = null) {
    this.gl = gl;
    this.passes = passes;
    this.programs = {
      branches: createProgram(gl, vertex(branchesVert), fragment(lineFrag)),
      arcs: createProgram(gl, vertex(arcsVert), fragment(lineFrag)),
      fans: createProgram(gl, vertex(fansVert), fragment(fansFrag)),
      rim: createProgram(gl, vertex(rimVert), fragment(rimFrag)),
      marks: createProgram(gl, vertex(marksVert), fragment(marksFrag)),
      backdrop: createProgram(gl, vertex(backdropVert), fragment(backdropFrag)),
      dim: createProgram(gl, `#version 300 es\n${dimVert}`, `#version 300 es\n${dimFrag}`),
      path: createProgram(gl, vertex(pathVert), `#version 300 es\n${pathFrag}`),
      ring: createProgram(gl, vertex(ringVert), `#version 300 es\n${ringFrag}`),
    };
    this.palette = palette;
    for (let i = 0; i < palette.count; i++) this.runStart[i] = palette.start[i] ?? 0;
    this.runRgb0.set(palette.startRgb);
    this.runRgb1.set(palette.endRgb);

    // Fans live in one dynamic buffer of 16-byte instances (tiles/fans.ts).
    this.fanBuffer = gl.createBuffer();
    this.fanVao = gl.createVertexArray();
    gl.bindVertexArray(this.fanVao);
    for (const loc of [0, 1, 2, 3]) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
    this.emptyVao = gl.createVertexArray();
  }

  /** Replaces the frontier fans (built by tiles/fans.ts, widest first). */
  setFans(data: Uint32Array): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fanBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    this.fanCount = data.length / FAN_WORDS;
    this.fanSpans = fanSpans(data);
  }

  upload(tile: Tile): GpuTile {
    const gl = this.gl;
    const buffer = gl.createBuffer();
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, tile.buffer, gl.STATIC_DRAW);
    const o = tile.offsets;
    // Locations match the `layout(location = N)` declarations in the shaders.
    const uint = (loc: number, type: number, offset: number): void => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribIPointer(loc, 1, type, 0, offset);
      gl.vertexAttribDivisor(loc, 1);
    };
    const float = (loc: number, offset: number): void => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 1, gl.FLOAT, false, 0, offset);
      gl.vertexAttribDivisor(loc, 1);
    };
    uint(0, gl.UNSIGNED_INT, o.angle);
    uint(1, gl.UNSIGNED_INT, o.arcLo);
    uint(2, gl.UNSIGNED_INT, o.arcHi);
    float(3, o.r);
    float(4, o.parentR);
    uint(5, gl.UNSIGNED_BYTE, o.childLevel);
    uint(6, gl.UNSIGNED_BYTE, o.flags);
    uint(7, gl.UNSIGNED_INT, o.parent);
    uint(8, gl.UNSIGNED_INT, o.leafCount);
    gl.bindVertexArray(null);
    return new WebGl2Tile(vao, buffer, tile);
  }

  release(tile: GpuTile): void {
    const t = glTile(tile);
    this.gl.deleteVertexArray(t.vao);
    this.gl.deleteBuffer(t.buffer);
  }

  size(): { width: number; height: number } {
    return { width: this.gl.drawingBufferWidth, height: this.gl.drawingBufferHeight };
  }

  draw(tiles: readonly GpuTile[], p: FrameParams): FrameStats {
    const gl = this.gl;
    const size = this.size();
    const plan = planFrame(tiles, { count: this.fanCount, spans: this.fanSpans }, p, size, this.passes);
    gl.viewport(0, 0, size.width, size.height);
    // Alpha starts at 0: it counts how much light each pixel has taken.
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);

    let pass: Pass | null = null;
    let blend: Blend | null = null;
    for (const cmd of plan.cmds) {
      if (cmd.blend !== blend) {
        blend = cmd.blend;
        this.setBlend(blend);
      }
      // Frame uniforms go in once per run of one pass (one program).
      if (cmd.pass !== pass) {
        pass = cmd.pass;
        this.useProgram(pass, p, plan.look.glow);
      }
      this.execute(cmd);
    }
    gl.bindVertexArray(null);
    return plan.stats;
  }

  /** Resolves once the GPU has finished: gl.finish() does not block in Chrome, reading a pixel back does. */
  finish(): Promise<void> {
    const gl = this.gl;
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.syncPixel);
    return Promise.resolve();
  }

  readPixels(): Promise<Pixels> {
    // Read now, in the task that drew: the drawing buffer is not preserved.
    const gl = this.gl;
    const { width, height } = this.size();
    const px = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // GL rows run bottom-up.
    return Promise.resolve({ width, height, data: flipRows(px, width, height) });
  }

  gpuMs(): number | null {
    return null;
  }

  destroy(): void {
    const gl = this.gl;
    for (const prog of Object.values(this.programs)) gl.deleteProgram(prog.program);
    for (const b of this.pathBuffers) {
      gl.deleteBuffer(b.buffer);
      gl.deleteVertexArray(b.vao);
    }
    gl.deleteBuffer(this.fanBuffer);
    gl.deleteVertexArray(this.fanVao);
    gl.deleteVertexArray(this.emptyVao);
  }

  /**
   * Blend modes (render/plan.ts `Blend`):
   * - saturating, for the tree and the ring: each fragment (premultiplied)
   *   adds its light scaled by the room left, 1 − dst alpha, and alpha
   *   accumulates the same way. Sparse areas add up as plain additive glow;
   *   dense ones converge on the brightest hue that lit them instead of
   *   clipping per channel and drifting to white.
   * - additive, for rim marks: they sit on their own terminal branch, which
   *   has used up most of the room, so plain (1, 1) keeps the bars solid.
   * - over, for paths and rings: opaque on top of the tree.
   * - dim: multiplies what is drawn by 1 − amount.
   */
  private setBlend(b: Blend): void {
    const gl = this.gl;
    if (b === 'saturating') gl.blendFuncSeparate(gl.ONE_MINUS_DST_ALPHA, gl.ONE, gl.ONE_MINUS_DST_ALPHA, gl.ONE);
    else if (b === 'additive') gl.blendFunc(gl.ONE, gl.ONE);
    else if (b === 'over') gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    else gl.blendFuncSeparate(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
  }

  private execute(cmd: DrawCmd): void {
    switch (cmd.pass) {
      case 'fans':
        return this.drawFans(cmd);
      case 'branches':
        return this.drawBranches(cmd);
      case 'arcs':
        return this.drawArcs(cmd);
      case 'rim':
        return this.drawRim(cmd);
      case 'marks':
        return this.drawMarks(cmd);
      case 'backdrop':
        return this.drawBackdrop(cmd);
      case 'dim':
        return this.drawDim(cmd);
      case 'path':
        return this.drawPath(cmd);
      case 'ring':
        return this.drawRing(cmd);
    }
  }

  private drawFans(c: FansCmd): void {
    const gl = this.gl;
    const u = this.programs.fans.u;
    gl.uniform1f(u.uLambda ?? null, c.lambda);
    gl.uniform1f(u.uFadeF ?? null, c.fadeF);
    gl.uniform1f(u.uAlpha ?? null, c.alpha);
    gl.uniform1f(u.uLinePx ?? null, c.linePx);
    gl.uniform1i(u.uK ?? null, c.k);
    gl.bindVertexArray(this.fanVao);
    // WebGL2 has no "base instance", so point the attributes at the first fan.
    const stride = FAN_WORDS * 4;
    const base = c.firstInstance * stride;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fanBuffer);
    gl.vertexAttribIPointer(0, 1, gl.UNSIGNED_INT, stride, base);
    gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_INT, stride, base + 4);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, base + 8);
    gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_INT, stride, base + 12);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, c.vertexCount, c.instanceCount);
  }

  private drawBranches(c: BranchesCmd): void {
    const gl = this.gl;
    const u = this.programs.branches.u;
    gl.uniform1f(u.uAlpha ?? null, c.alpha);
    gl.uniform1f(u.uHomeAlpha ?? null, c.homeAlpha);
    gl.uniform1f(u.uFade ?? null, c.fade);
    gl.uniform1f(u.uHalfW ?? null, c.halfW);
    gl.bindVertexArray(glTile(c.tile).vao);
    // Hairlines are native lines; wider ones are quads (branches.vert).
    gl.drawArraysInstanced(c.halfW > 0 ? gl.TRIANGLES : gl.LINES, 0, c.vertexCount, c.instanceCount);
  }

  private drawArcs(c: ArcsCmd): void {
    const gl = this.gl;
    const u = this.programs.arcs.u;
    gl.uniform1f(u.uAlpha ?? null, c.alpha);
    gl.uniform1f(u.uHomeAlpha ?? null, c.homeAlpha);
    gl.uniform1f(u.uFade ?? null, c.fade);
    gl.uniform1i(u.uK ?? null, c.k);
    gl.uniform1f(u.uHalfW ?? null, c.halfW);
    gl.bindVertexArray(glTile(c.tile).vao);
    gl.drawArraysInstanced(c.halfW > 0 ? gl.TRIANGLES : gl.LINES, 0, c.vertexCount, c.instanceCount);
  }

  private drawRim(c: RimCmd): void {
    const gl = this.gl;
    const u = this.programs.rim.u;
    gl.uniform1i(u.uK ?? null, c.k);
    gl.uniform2f(u.uReach ?? null, ...c.reach);
    gl.uniform1f(u.uStrength ?? null, c.strength);
    gl.uniform2f(u.uCore ?? null, ...c.core);
    gl.uniform4f(u.uHalo ?? null, ...c.halo);
    gl.uniform3f(u.uFur ?? null, ...c.fur);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, c.vertexCount);
  }

  private drawMarks(c: MarksCmd): void {
    const gl = this.gl;
    const u = this.programs.marks.u;
    gl.uniform1f(u.uPx ?? null, c.px);
    gl.uniform2f(u.uSpike ?? null, ...c.spike);
    gl.uniform4f(u.uTipBar ?? null, ...c.tipBar);
    gl.uniform2f(u.uLeaderHalo ?? null, ...c.leaderHalo);
    gl.uniform4f(u.uLeader ?? null, ...c.leader);
    gl.uniform1f(u.uFade ?? null, c.fade);
    gl.bindVertexArray(glTile(c.tile).vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, c.vertexCount, c.instanceCount);
  }

  /** The graticule and wash behind the tree (backdrop.vert, backdrop.frag): a grid of quads over the screen. */
  private drawBackdrop(c: BackdropCmd): void {
    const gl = this.gl;
    const u = this.programs.backdrop.u;
    gl.uniform1f(u.uStrength ?? null, c.strength);
    gl.uniform1f(u.uCamRPx ?? null, c.camRPx);
    gl.uniform1f(u.uRimOff ?? null, c.rimOff);
    gl.uniform4f(u.uGrid ?? null, ...c.grid);
    gl.uniform1f(u.uRingFade ?? null, c.ringFade);
    gl.uniform2f(u.uFade ?? null, ...c.fade);
    gl.uniform4f(u.uWash ?? null, ...c.wash);
    gl.uniform2f(u.uCorona ?? null, ...c.corona);
    gl.uniform2f(u.uCells ?? null, ...c.cells);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, c.vertexCount);
  }

  /**
   * Darkens a plate (the HUD, or the whole tree behind a hover): multiplies
   * what is drawn by 1 − amount, easing out over the soft edge, so DOM text
   * stays legible over bright glow without opaque boxes.
   */
  private drawDim(c: DimCmd): void {
    const gl = this.gl;
    const u = this.programs.dim.u;
    const r = c.rect;
    gl.bindVertexArray(this.emptyVao);
    gl.uniform2f(u.uViewport ?? null, ...c.viewport);
    gl.uniform4f(u.uRect ?? null, r.x0, r.y0, r.x1, r.y1);
    gl.uniform1f(u.uSoft ?? null, r.soft);
    gl.uniform1f(u.uAmount ?? null, r.amount);
    gl.drawArrays(gl.TRIANGLES, 0, c.vertexCount);
  }

  private drawPath(c: PathCmd): void {
    const gl = this.gl;
    const u = this.programs.path.u;
    const buf = this.pathBuffer(c.slot, c.data);
    gl.uniform1i(u.uK ?? null, c.k);
    gl.uniform1f(u.uHalfW ?? null, c.halfW);
    gl.uniform4f(u.uColour ?? null, ...c.colour);
    gl.bindVertexArray(buf.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, c.vertexCount, c.instanceCount);
  }

  private drawRing(c: RingCmd): void {
    const gl = this.gl;
    const u = this.programs.ring.u;
    gl.bindVertexArray(this.emptyVao);
    gl.uniform1f(u.uLinePx ?? null, c.linePx);
    gl.uniform1ui(u.uA ?? null, c.angle);
    gl.uniform1f(u.uR ?? null, c.r);
    gl.uniform1f(u.uRadius ?? null, c.radius);
    gl.uniform4f(u.uColour ?? null, ...c.colour);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, c.vertexCount);
  }

  /** The buffer for path slot `k`, holding `data` (uploaded when it changed). */
  private pathBuffer(k: number, data: Uint32Array): PathBuffer {
    const gl = this.gl;
    let buf = this.pathBuffers[k];
    if (!buf) {
      const buffer = gl.createBuffer();
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      const stride = PATH_WORDS * 4;
      for (const l of [0, 1]) {
        gl.enableVertexAttribArray(l);
        gl.vertexAttribIPointer(l, 1, gl.UNSIGNED_INT, stride, l * 4);
        gl.vertexAttribDivisor(l, 1);
      }
      for (const l of [2, 3]) {
        gl.enableVertexAttribArray(l);
        gl.vertexAttribPointer(l, 1, gl.FLOAT, false, stride, l * 4);
        gl.vertexAttribDivisor(l, 1);
      }
      gl.bindVertexArray(null);
      buf = { buffer, vao, data: null };
      this.pathBuffers[k] = buf;
    }
    if (buf.data !== data) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      buf.data = data;
    }
    return buf;
  }

  /** Sets the per-frame uniforms shared by every tree program; the dim program has none. */
  private useProgram(pass: Pass, p: FrameParams, glow: number): void {
    const gl = this.gl;
    const prog = this.programs[pass];
    gl.useProgram(prog.program);
    if (pass === 'dim') return;
    const u = prog.u;
    const c = p.camera;
    gl.uniform1ui(u.uCamA ?? null, c.camA);
    gl.uniform1f(u.uCamFrac ?? null, c.camAFrac);
    gl.uniform2f(u.uCamR ?? null, c.camRHi, c.camRLo);
    gl.uniform1f(u.uScale ?? null, c.scale);
    gl.uniform2f(u.uRotCS ?? null, c.rotCos, c.rotSin);
    gl.uniform2f(u.uHalf ?? null, c.halfW, c.halfH);
    gl.uniform2f(u.uRWin ?? null, p.rWin[0], p.rWin[1]);
    gl.uniform1ui(u.uWinLo ?? null, p.winLo);
    gl.uniform1ui(u.uWinSpan ?? null, p.winSpan);
    gl.uniform1i(u.uRunCount ?? null, this.palette.count);
    gl.uniform1uiv(u['uRunStart[0]'] ?? null, this.runStart);
    gl.uniform3fv(u['uRunRgb0[0]'] ?? null, this.runRgb0);
    gl.uniform3fv(u['uRunRgb1[0]'] ?? null, this.runRgb1);
    gl.uniform1f(u.uSeamUnits ?? null, (S.SEAM_PX * p.dpr) / (RAD_PER_UNIT * c.scale));
    gl.uniform1f(u.uLambdaExt ?? null, p.lambdaExt);
    gl.uniform1ui(u.uHomeId ?? null, p.homeId < 0 ? NO_HOME : p.homeId);
    gl.uniform1ui(u.uHomeAngle ?? null, p.homeAngle);
    // Fragment side (frag.glsl).
    gl.uniform1f(u.uReveal ?? null, revealUniform(p.reveal));
    gl.uniform1f(u.uRevealSoft ?? null, S.REVEAL_SOFT);
    gl.uniform3f(u.uBranch ?? null, ...this.branchRgb);
    gl.uniform1f(u.uTintPow ?? null, S.TINT_POWER);
    gl.uniform1f(u.uRimBand ?? null, 1 - (S.RIM_BAND_PX * p.dpr) / c.scale);
    gl.uniform1f(u.uRimBoost ?? null, S.RIM_BOOST * glow);
    gl.uniform1f(u.uPxPerUnit ?? null, RAD_PER_UNIT * c.scale);
    gl.uniform1f(u.uExtInner ?? null, S.EXT_INNER);
    gl.uniform1f(u.uExtPow ?? null, S.EXT_POWER);
    gl.uniform1f(u.uExtFar ?? null, S.EXT_FAR);
  }
}
