// Tree draw passes (PLAN §7.3): frontier fans, branches, arcs, the rim ring
// and rim marks, additively blended on black (saturating for the tree, so
// dense areas keep their hue; see `draw`). Glow comes only from that
// blending and soft-edged geometry; there is no bloom pass (DESIGN.md §5).
// Each tile's bytes are uploaded once as a single ARRAY_BUFFER and one VAO
// points every attribute at its array's byte offset, without copies.

import { RAD_PER_UNIT } from '../angle';
import type { CameraUniforms } from '../camera';
import { BRANCH, MAX_RUNS, type RunPalette, oklchToSrgb } from '../palette';
import * as S from '../style';
import type { Tile } from '../tiles/decode';
import { FAN_WORDS } from '../tiles/fans';
import { PATH_WORDS } from '../path';
import { type Program, createProgram } from './context';
import arcsVert from './shaders/arcs.vert?raw';
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

export interface GpuTile {
  vao: WebGLVertexArrayObject;
  buffer: WebGLBuffer;
  level: number;
  count: number;
  internalCount: number;
}

/** Everything a frame needs besides the tiles. */
export interface FrameParams {
  camera: CameraUniforms;
  lambda: number;
  /** λ capped below the first level that is not fully loaded. */
  lambdaExt: number;
  /** Visible radii [min, max]. */
  rWin: [number, number];
  /** Visible angular window, u32 units (span ≥ 2^30 disables arc clamping). */
  winLo: number;
  winSpan: number;
  /** Per-tile fade for each level. */
  fade: (level: number) => number;
  /** Fade-in of the last fully loaded level (fans fading out with it). */
  fadeF: number;
  /** Intro reveal: nothing beyond this radius is drawn (Infinity when done). */
  reveal: number;
  /** Device px per CSS px. */
  dpr: number;
  /** Distance between neighbouring tips on the rim, CSS px. */
  tipSpacing: number;
  /** Pre-order id of the home node, or −1, and its angle. */
  homeId: number;
  homeAngle: number;
  /** Distance from the rim to the home leader bar, CSS px (past the home label). */
  leaderGap: number;
  /** Length of the home leader bar, CSS px (leader.ts: stops at the gutter). */
  leaderLen: number;
  /** Plates to darken (HUD, later panel and search), device px. */
  dims: readonly Dim[];
  /** Hover and selection highlights, drawn over the tree. */
  highlight: Highlight;
}

/** A highlighted path (path.ts), drawn as an opaque line of `widthPx` CSS px; `alpha` scales its brightness. */
export interface PathDraw {
  /** Packed segments (`encodePath`); a new array means new contents. */
  data: Uint32Array;
  rgb: readonly [number, number, number];
  alpha: number;
  widthPx: number;
}

/** A hairline circle round a node's point (the selection ring). */
export interface RingDraw {
  angle: number;
  r: number;
  rgb: readonly [number, number, number];
  alpha: number;
  /** Radius, CSS px. */
  radiusPx: number;
}

export interface Highlight {
  /** How much the tree darkens behind the highlights (hover: 0.4, DESIGN.md §5). */
  treeDim: number;
  paths: readonly PathDraw[];
  rings: readonly RingDraw[];
}

export const NO_HIGHLIGHT: Highlight = { treeDim: 0, paths: [], rings: [] };

/** A darkened rectangle with a soft edge, device px (ui/obstacles.ts). */
export interface Dim {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  amount: number;
  soft: number;
}

export interface FrameStats {
  tiles: number;
  instances: number;
  drawCalls: number;
}

/** Steps along a fan: wide fans need many to follow the circle, most need 2. */
const K_FAN_WIDE = 16;
const K_FAN_NARROW = 2;
/** Chords per arc: many for the big low-level arcs, few for the rest (PLAN §7.3). */
const K_COARSE = 128;
const K_FINE = 16;
/** Steps around the rim ring: under 0.1 px of chord sag at overview. */
const K_RING = 256;
/** Steps per highlighted path segment (arcs are clamped to the window first). */
const K_PATH = 64;
const NO_HOME = 0xffffffff;

interface PathBuffer {
  buffer: WebGLBuffer;
  vao: WebGLVertexArrayObject;
  data: Uint32Array | null;
}

const vertex = (body: string): string => `#version 300 es\n${common}\n${paletteGlsl}\n${body}`;
const fragment = (body: string): string => `#version 300 es\n${fragCommon}\n${paletteGlsl}\n${body}`;

export class Renderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly branches: Program;
  private readonly arcs: Program;
  private readonly fans: Program;
  private readonly rim: Program;
  private readonly marks: Program;
  private readonly dim: Program;
  private readonly path: Program;
  private readonly ring: Program;
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
  private fanSpans = new Float64Array(0);
  private readonly branchRgb = oklchToSrgb(BRANCH);

  constructor(gl: WebGL2RenderingContext, palette: RunPalette) {
    this.gl = gl;
    this.branches = createProgram(gl, vertex(branchesVert), fragment(lineFrag));
    this.arcs = createProgram(gl, vertex(arcsVert), fragment(lineFrag));
    this.fans = createProgram(gl, vertex(fansVert), fragment(fansFrag));
    this.rim = createProgram(gl, vertex(rimVert), fragment(rimFrag));
    this.marks = createProgram(gl, vertex(marksVert), fragment(marksFrag));
    this.dim = createProgram(gl, `#version 300 es\n${dimVert}`, `#version 300 es\n${dimFrag}`);
    this.path = createProgram(gl, vertex(pathVert), `#version 300 es\n${pathFrag}`);
    this.ring = createProgram(gl, vertex(ringVert), `#version 300 es\n${ringFrag}`);
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
    this.fanSpans = new Float64Array(this.fanCount);
    for (let i = 0; i < this.fanCount; i++) {
      this.fanSpans[i] = (data[i * FAN_WORDS + 1] ?? 0) - (data[i * FAN_WORDS] ?? 0);
    }
  }

  /** Draws fans [first, first + count) with K steps each. */
  private drawFans(first: number, count: number, k: number): void {
    if (count <= 0) return;
    const gl = this.gl;
    // WebGL2 has no "base instance", so point the attributes at the first fan.
    const stride = FAN_WORDS * 4;
    const base = first * stride;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fanBuffer);
    gl.vertexAttribIPointer(0, 1, gl.UNSIGNED_INT, stride, base);
    gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_INT, stride, base + 4);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, base + 8);
    gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_INT, stride, base + 12);
    gl.uniform1i(loc(this.fans, 'uK'), k);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6 * k, count);
  }

  /** How many fans (widest first) are wider than `limit` radians. */
  private fansWiderThan(limit: number): number {
    const units = limit / RAD_PER_UNIT;
    let lo = 0;
    let hi = this.fanCount;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.fanSpans[mid] ?? 0) > units) lo = mid + 1;
      else hi = mid;
    }
    return lo;
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
    return { vao, buffer, level: tile.level, count: tile.count, internalCount: tile.internalCount };
  }

  release(t: GpuTile): void {
    this.gl.deleteVertexArray(t.vao);
    this.gl.deleteBuffer(t.buffer);
  }

  draw(tiles: readonly GpuTile[], p: FrameParams): FrameStats {
    const gl = this.gl;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    // Alpha starts at 0: it counts how much light each pixel has taken.
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    // Saturating additive blending for the tree and the ring: each fragment
    // (premultiplied) adds its light scaled by the room left, 1 − dst alpha,
    // and alpha accumulates the same way. Sparse areas add up as plain
    // additive glow; dense ones converge on the brightest hue that lit them
    // instead of clipping per channel and drifting to white.
    gl.blendFuncSeparate(gl.ONE_MINUS_DST_ALPHA, gl.ONE, gl.ONE_MINUS_DST_ALPHA, gl.ONE);

    const look = S.frameLook(p);
    let instances = 0;
    let drawCalls = 0;

    if (this.fanCount > 0 && look.fans > 0) {
      this.useProgram(this.fans, p, look);
      gl.uniform1f(loc(this.fans, 'uLambda'), p.lambda);
      gl.uniform1f(loc(this.fans, 'uFadeF'), p.fadeF);
      gl.uniform1f(loc(this.fans, 'uAlpha'), S.FAN_ALPHA * look.fans);
      gl.uniform1f(loc(this.fans, 'uLinePx'), S.FAN_LINE_PX * p.dpr);
      gl.bindVertexArray(this.fanVao);
      // With 2 steps, a fan narrower than 2·sqrt(2/scale) radians bows away
      // from the true circle by at most a quarter pixel at the rim. The
      // visible window clamps every fan, so a narrow window needs no more.
      const scale = p.camera.scale;
      const fine = 2 * Math.sqrt(2 / scale);
      const wide = p.winSpan * RAD_PER_UNIT <= fine ? 0 : this.fansWiderThan(fine);
      const shown = Math.max(wide, this.fansWiderThan((S.FAN_MIN_PX * p.dpr) / scale));
      this.drawFans(0, wide, K_FAN_WIDE);
      this.drawFans(wide, shown - wide, K_FAN_NARROW);
      instances += shown;
      drawCalls += 2;
    }

    this.useProgram(this.branches, p, look);
    gl.uniform1f(loc(this.branches, 'uAlpha'), look.branchAlpha);
    gl.uniform1f(loc(this.branches, 'uHomeAlpha'), S.HOME_LINE_ALPHA);
    // Once tip bars are strong, tips' hairlines stop where their bars start.
    gl.uniform1f(loc(this.branches, 'uTipCut'), look.tipBar > 0.5 ? S.TIP_BAR_MAX_LEN_PX * p.dpr : 0);
    for (const t of tiles) {
      const fade = p.fade(t.level);
      if (fade <= 0) continue;
      gl.uniform1f(loc(this.branches, 'uFade'), fade);
      gl.bindVertexArray(t.vao);
      gl.drawArraysInstanced(gl.LINES, 0, 4, t.count);
      instances += t.count;
      drawCalls++;
    }

    this.useProgram(this.arcs, p, look);
    gl.uniform1f(loc(this.arcs, 'uAlpha'), look.branchAlpha);
    gl.uniform1f(loc(this.arcs, 'uHomeAlpha'), S.HOME_LINE_ALPHA);
    for (const t of tiles) {
      const fade = p.fade(t.level);
      if (fade <= 0 || t.internalCount === 0) continue;
      const k = t.level <= 3 ? K_COARSE : K_FINE;
      gl.uniform1f(loc(this.arcs, 'uFade'), fade);
      gl.uniform1i(loc(this.arcs, 'uK'), k);
      gl.bindVertexArray(t.vao);
      gl.drawArraysInstanced(gl.LINES, 0, 2 * k, t.internalCount);
      instances += t.internalCount;
      drawCalls++;
    }

    if (look.ring > 0) {
      const px = p.dpr;
      this.useProgram(this.rim, p, look);
      gl.uniform1i(loc(this.rim, 'uK'), K_RING);
      gl.uniform2f(loc(this.rim, 'uReach'), S.RING_REACH_IN_PX * px, S.RING_REACH_OUT_PX * px);
      gl.uniform1f(loc(this.rim, 'uStrength'), look.ring);
      gl.uniform2f(loc(this.rim, 'uCore'), S.RING_CORE, S.RING_CORE_SIGMA_PX * px);
      gl.uniform4f(
        loc(this.rim, 'uHalo'),
        S.RING_HALO,
        S.RING_HALO_OUT_PX * px,
        S.RING_HALO_IN,
        S.RING_HALO_IN_PX * px,
      );
      gl.uniform3f(loc(this.rim, 'uFur'), S.RING_FUR, S.RING_FUR_PX * px, S.RING_FUR_LINE_PX * px);
      gl.bindVertexArray(this.emptyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 6 * K_RING);
      drawCalls++;
    }

    // Rim marks sit on their own terminal branch, which has used up most of
    // the room: plain additive, so the bars stay solid.
    gl.blendFunc(gl.ONE, gl.ONE);
    this.useProgram(this.marks, p, look);
    const m = this.marks;
    gl.uniform1f(loc(m, 'uPx'), p.dpr);
    gl.uniform2f(loc(m, 'uSpike'), S.SPIKE_ALPHA * look.glow, S.SPIKE_MAX_W_PX * p.dpr);
    gl.uniform3f(loc(m, 'uTipBar'), look.tipBar, look.tipWidth * p.dpr, S.TIP_BAR_MAX_LEN_PX * p.dpr);
    gl.uniform2f(loc(m, 'uTipHalo'), S.TIP_HALO, look.tipHalo * p.dpr);
    // A leader squeezed by the screen edge (leader.ts) fades out rather than shrinking to a stub.
    const leaderAlpha = look.leader * Math.min(1, Math.max(0, (p.leaderLen - 24) / 40));
    gl.uniform3f(loc(m, 'uLeader'), leaderAlpha, p.leaderGap * p.dpr, Math.max(1, p.leaderLen) * p.dpr);
    for (const t of tiles) {
      const fade = p.fade(t.level);
      if (fade <= 0) continue;
      gl.uniform1f(loc(m, 'uFade'), fade);
      gl.bindVertexArray(t.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, t.count);
      instances += t.count;
      drawCalls++;
    }

    drawCalls += this.drawHighlight(p, look);
    drawCalls += this.drawDims(p.dims);
    gl.bindVertexArray(null);
    return { tiles: tiles.length, instances, drawCalls };
  }

  /**
   * Hover and selection (DESIGN.md §5): the tree dims, then the paths and
   * rings go on top, opaque (path.frag), so they read over bright bars.
   * Returns the draw calls.
   */
  private drawHighlight(p: FrameParams, look: S.Look): number {
    const h = p.highlight;
    const gl = this.gl;
    let calls = 0;
    if (h.treeDim > 0) {
      const w = gl.drawingBufferWidth;
      const ht = gl.drawingBufferHeight;
      calls += this.drawDims([{ x0: -1, y0: -1, x1: w + 1, y1: ht + 1, amount: h.treeDim, soft: 0 }]);
    }
    if (h.paths.length === 0 && h.rings.length === 0) return calls;
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.useProgram(this.path, p, look);
    gl.uniform1i(loc(this.path, 'uK'), K_PATH);
    h.paths.forEach((d, k) => {
      const buf = this.pathBuffer(k, d.data);
      const n = d.data.length / PATH_WORDS;
      if (n === 0 || d.alpha <= 0) return;
      gl.uniform1f(loc(this.path, 'uHalfW'), 0.5 * d.widthPx * p.dpr);
      gl.uniform4f(loc(this.path, 'uColour'), d.rgb[0], d.rgb[1], d.rgb[2], d.alpha);
      gl.bindVertexArray(buf.vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6 * K_PATH, n);
      calls++;
    });
    if (h.rings.length > 0) {
      this.useProgram(this.ring, p, look);
      gl.bindVertexArray(this.emptyVao);
      gl.uniform1f(loc(this.ring, 'uLinePx'), p.dpr);
      for (const r of h.rings) {
        gl.uniform1ui(loc(this.ring, 'uA'), r.angle >>> 0);
        gl.uniform1f(loc(this.ring, 'uR'), r.r);
        gl.uniform1f(loc(this.ring, 'uRadius'), r.radiusPx * p.dpr);
        gl.uniform4f(loc(this.ring, 'uColour'), r.rgb[0], r.rgb[1], r.rgb[2], r.alpha);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        calls++;
      }
    }
    return calls;
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

  /**
   * Darkens the plates behind the HUD: multiplies what is drawn by
   * 1 − amount, easing out over the soft edge, so DOM text stays legible
   * over bright glow without opaque boxes. Returns the draw calls.
   */
  private drawDims(dims: readonly Dim[]): number {
    if (dims.length === 0) return 0;
    const gl = this.gl;
    const d = this.dim;
    gl.blendFuncSeparate(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(d.program);
    gl.bindVertexArray(this.emptyVao);
    gl.uniform2f(loc(d, 'uViewport'), gl.drawingBufferWidth, gl.drawingBufferHeight);
    for (const r of dims) {
      gl.uniform4f(loc(d, 'uRect'), r.x0, r.y0, r.x1, r.y1);
      gl.uniform1f(loc(d, 'uSoft'), r.soft);
      gl.uniform1f(loc(d, 'uAmount'), r.amount);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    return dims.length;
  }

  private useProgram(prog: Program, p: FrameParams, look: S.Look): void {
    const gl = this.gl;
    const c = p.camera;
    gl.useProgram(prog.program);
    gl.uniform1ui(loc(prog, 'uCamA'), c.camA);
    gl.uniform1f(loc(prog, 'uCamFrac'), c.camAFrac);
    gl.uniform2f(loc(prog, 'uCamR'), c.camRHi, c.camRLo);
    gl.uniform1f(loc(prog, 'uScale'), c.scale);
    gl.uniform2f(loc(prog, 'uRotCS'), c.rotCos, c.rotSin);
    gl.uniform2f(loc(prog, 'uHalf'), c.halfW, c.halfH);
    gl.uniform2f(loc(prog, 'uRWin'), p.rWin[0], p.rWin[1]);
    gl.uniform1ui(loc(prog, 'uWinLo'), p.winLo);
    gl.uniform1ui(loc(prog, 'uWinSpan'), p.winSpan);
    gl.uniform1i(loc(prog, 'uRunCount'), this.palette.count);
    gl.uniform1uiv(loc(prog, 'uRunStart[0]'), this.runStart);
    gl.uniform3fv(loc(prog, 'uRunRgb0[0]'), this.runRgb0);
    gl.uniform3fv(loc(prog, 'uRunRgb1[0]'), this.runRgb1);
    gl.uniform1f(loc(prog, 'uSeamUnits'), (S.SEAM_PX * p.dpr) / (RAD_PER_UNIT * c.scale));
    gl.uniform1f(loc(prog, 'uLambdaExt'), p.lambdaExt);
    gl.uniform1ui(loc(prog, 'uHomeId'), p.homeId < 0 ? NO_HOME : p.homeId);
    gl.uniform1ui(loc(prog, 'uHomeAngle'), p.homeAngle);
    // Fragment side (frag.glsl).
    gl.uniform1f(loc(prog, 'uReveal'), p.reveal);
    gl.uniform1f(loc(prog, 'uRevealSoft'), S.REVEAL_SOFT);
    gl.uniform3f(loc(prog, 'uBranch'), ...this.branchRgb);
    gl.uniform1f(loc(prog, 'uTintPow'), S.TINT_POWER);
    gl.uniform1f(loc(prog, 'uRimBand'), 1 - (S.RIM_BAND_PX * p.dpr) / c.scale);
    gl.uniform1f(loc(prog, 'uRimBoost'), S.RIM_BOOST * look.glow);
    gl.uniform1f(loc(prog, 'uPxPerUnit'), RAD_PER_UNIT * c.scale);
    gl.uniform1f(loc(prog, 'uExtInner'), S.EXT_INNER);
    gl.uniform1f(loc(prog, 'uExtPow'), S.EXT_POWER);
    gl.uniform1f(loc(prog, 'uExtFar'), S.EXT_FAR);
  }
}

function loc(p: Program, name: string): WebGLUniformLocation | null {
  return p.u[name] ?? null;
}
