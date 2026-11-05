// The shared frame plan (docs/plan-webgpu.md §2.1): every per-draw CPU
// decision the WebGL2 renderer's `draw` used to make, as a pure function from the
// tiles, the fans and the frame parameters to a list of draw commands. Both
// backends only execute the commands, so they cannot drift apart.

import { RAD_PER_UNIT } from '../angle';
import { smoothstep } from '../ease';
import { PATH_WORDS } from '../path';
import * as S from '../style';
import type { Look } from '../style';
import { FAN_WORDS } from '../tiles/fans';
import type { Dim, FrameParams, FrameStats, GpuTile } from './types';

/**
 * The reveal radius once the intro is done. `FrameParams.reveal` is then
 * Infinity, but WGSL may assume floats are finite and smoothstep(∞ − s, ∞, r)
 * is NaN, so both backends hand their shaders this instead (far beyond r = 1).
 */
export const REVEAL_DONE = 1e4;

/** The reveal radius the shaders get: Infinity (intro done) becomes `REVEAL_DONE`. */
export function revealUniform(reveal: number): number {
  return Number.isFinite(reveal) ? reveal : REVEAL_DONE;
}

export type Pass = 'fans' | 'branches' | 'arcs' | 'rim' | 'edge' | 'marks' | 'tips' | 'backdrop' | 'dim' | 'path' | 'ring';

export const PASSES: readonly Pass[] = ['fans', 'branches', 'arcs', 'rim', 'edge', 'marks', 'tips', 'backdrop', 'dim', 'path', 'ring'];

/**
 * Blend modes, colour and alpha alike (src factor, dst factor):
 * - saturating: (1 − dst alpha, 1), the tree, the rim ring and the backdrop
 * - additive: (1, 1), rim marks
 * - over: (1, 1 − src alpha), the rim edge, tip dots, paths and rings
 * - dim: (0, 1 − src alpha), the tree dim and the HUD plates
 */
export type Blend = 'saturating' | 'additive' | 'over' | 'dim';

export const PASS_BLEND: Readonly<Record<Pass, Blend>> = {
  fans: 'saturating',
  branches: 'saturating',
  arcs: 'saturating',
  rim: 'saturating',
  // Over the glow, so the edge stays crisp where the tree has used up the light.
  edge: 'over',
  marks: 'additive',
  // Opaque on its line, so the dot keeps its colour where it covers the line.
  tips: 'over',
  // Drawn after the tree, it only fills the light the tree left: it stays behind.
  backdrop: 'saturating',
  dim: 'dim',
  path: 'over',
  ring: 'over',
};

/** Fields every command has: a non-indexed instanced draw. */
interface DrawBase {
  blend: Blend;
  vertexCount: number;
  instanceCount: number;
  firstInstance: number;
}

export interface FansCmd extends DrawBase {
  pass: 'fans';
  /** Steps along each fan (vertexCount = 6k). */
  k: number;
  lambda: number;
  fadeF: number;
  alpha: number;
  linePx: number;
}

export interface BranchesCmd extends DrawBase {
  pass: 'branches';
  tile: GpuTile;
  fade: number;
  alpha: number;
  homeAlpha: number;
  /** 0: native 1-device-px lines (vertexCount 4); else half the width, device px, drawn as quads (12). */
  halfW: number;
}

export interface ArcsCmd extends DrawBase {
  pass: 'arcs';
  tile: GpuTile;
  /** Chords per arc (vertexCount = 2k as lines, 6k as quads). */
  k: number;
  fade: number;
  alpha: number;
  homeAlpha: number;
  /** As BranchesCmd. */
  halfW: number;
}

export interface RimCmd extends DrawBase {
  pass: 'rim';
  k: number;
  strength: number;
  reach: [number, number];
  core: [number, number];
  halo: [number, number, number, number];
  fur: [number, number, number];
}

export interface EdgeCmd extends DrawBase {
  pass: 'edge';
  /** Steps around the visible rim (vertexCount = 6k). */
  k: number;
  /** The annulus drawn: px inside, px outside the rim. */
  reach: [number, number];
  alpha: number;
  /** Line width, device px, starting at the rim and running outward. */
  width: number;
  /** How far the kingdom colour is lifted toward white (0..1). */
  lift: number;
}

export interface MarksCmd extends DrawBase {
  pass: 'marks';
  tile: GpuTile;
  fade: number;
  px: number;
  spike: [number, number];
  /** Alpha (0: off), max length px, half width px (as wide as their branch), unused. */
  tipBar: [number, number, number, number];
  /** Home leader: alpha (0: off), gap px, length px, width px. */
  leader: [number, number, number, number];
  /** The leader's halo: amount, decay px. */
  leaderHalo: [number, number];
}

export interface TipsCmd extends DrawBase {
  pass: 'tips';
  tile: GpuTile;
  /** The tile's level fade times the frame's dot fade-in (0..1). */
  alpha: number;
  /** Dot radius, device px. */
  radius: number;
  /** How far the kingdom colour is lifted toward white (0..1). */
  lift: number;
}

export interface BackdropCmd extends DrawBase {
  pass: 'backdrop';
  /** Overall strength (0 before the intro reveal reaches it). */
  strength: number;
  /** The camera point's distance from the centre, R·scale, device px. */
  camRPx: number;
  /** The rim's offset from it, (R − 1)·scale, device px (exact: from the double camera). */
  rimOff: number;
  /** Line alpha, line width px, spoke spacing px, ring spacing px (level 0; level 1 is half). */
  grid: [number, number, number, number];
  /** Fade-in of the level-1 rings (0..1 over the octave). */
  ringFade: number;
  /** Gap px beyond the rim, then ramp px over which everything fades in. */
  fade: [number, number];
  /** Wash alpha at the rim, its decay px, the blur window px along the circle, the grid's tint toward it. */
  wash: [number, number, number, number];
  /** How much the wash gathers into streamers (0: even), and a streamer's width px. */
  corona: [number, number];
  /** Columns and rows of the screen grid the hue is computed on (vertexCount = 6 · cols · rows). */
  cells: [number, number];
}

/**
 * Ring spacing for this scale: rings sit at 1 + m/n world units, n a power
 * of two chosen so they are `targetPx`..2·`targetPx` apart; the rings of
 * level n·2 fade in over the octave. Returns [spacing px of level n, fade].
 */
export function ringLevel(scale: number, targetPx: number): [number, number] {
  const q = Math.log2(Math.max(scale / targetPx, 1e-9));
  const n = 2 ** Math.floor(q);
  return [scale / n, q - Math.floor(q)];
}

export interface DimCmd extends DrawBase {
  pass: 'dim';
  rect: Dim;
  /** Drawing-buffer size, device px. */
  viewport: [number, number];
}

export interface PathCmd extends DrawBase {
  pass: 'path';
  /** Index of the path in `highlight.paths` (its buffer slot; skipped paths keep theirs). */
  slot: number;
  data: Uint32Array;
  k: number;
  halfW: number;
  colour: [number, number, number, number];
}

export interface RingCmd extends DrawBase {
  pass: 'ring';
  /** u32 units (`angle >>> 0`). */
  angle: number;
  r: number;
  radius: number;
  linePx: number;
  colour: [number, number, number, number];
  /** Centre dot radius, device px. */
  dot: number;
  /** The dark disc: px past the ring, and its opacity. */
  knock: [number, number];
}

export type DrawCmd = FansCmd | BranchesCmd | ArcsCmd | RimCmd | EdgeCmd | MarksCmd | TipsCmd | BackdropCmd | DimCmd | PathCmd | RingCmd;

/** The current frontier fans: how many, and each one's span in u32 units, widest first. */
export interface FanSet {
  count: number;
  spans: Float64Array;
}

export interface FramePlan {
  cmds: DrawCmd[];
  /** Counted exactly as `Renderer.draw` counts today. */
  stats: FrameStats;
  look: Look;
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

/** Spans (hi − lo, u32 units) of fans packed by tiles/fans.ts. */
export function fanSpans(data: Uint32Array): Float64Array {
  const count = Math.floor(data.length / FAN_WORDS);
  const spans = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    spans[i] = (data[i * FAN_WORDS + 1] ?? 0) - (data[i * FAN_WORDS] ?? 0);
  }
  return spans;
}

/** How many of the first `count` fans (widest first) are wider than `limit` radians. */
export function fansWiderThan(spans: Float64Array, count: number, limit: number): number {
  const units = limit / RAD_PER_UNIT;
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((spans[mid] ?? 0) > units) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** `?passes=branches,arcs` → those passes; null (all passes) when absent or naming none. */
export function parsePasses(q: URLSearchParams): ReadonlySet<Pass> | null {
  const raw = q.get('passes');
  if (!raw) return null;
  const out = new Set<Pass>();
  for (const name of raw.split(',')) {
    const pass = PASSES.find((p) => p === name.trim());
    if (pass) out.add(pass);
  }
  return out.size > 0 ? out : null;
}

/**
 * Half the line width, device px, for branches and arcs drawn as quads; 0
 * while the width is at most one device px, where they stay native lines
 * (so the overview and mid zoom are unchanged).
 */
export function lineHalfWidth(lineWidthCss: number, dpr: number): number {
  const dev = lineWidthCss * dpr;
  return dev > 1 ? dev / 2 : 0;
}

/** The fixed fields of a single, non-instanced-in-spirit draw. */
function single(vertexCount: number): { vertexCount: number; instanceCount: number; firstInstance: number } {
  return { vertexCount, instanceCount: 1, firstInstance: 0 };
}

/**
 * Draw commands for one frame, in draw order. `size` is the drawing buffer
 * in device px; `passes`, when given, leaves out every other pass (and its
 * stats).
 */
export function planFrame(
  tiles: readonly GpuTile[],
  fans: FanSet,
  p: FrameParams,
  size: { width: number; height: number },
  passes: ReadonlySet<Pass> | null = null,
): FramePlan {
  const on = (pass: Pass): boolean => passes === null || passes.has(pass);
  const look = S.frameLook(p);
  const cmds: DrawCmd[] = [];
  // Lines wider than a device px are quads; at or under it, native lines.
  const lineDev = look.lineWidth * p.dpr;
  const halfW = lineHalfWidth(look.lineWidth, p.dpr);
  let instances = 0;
  let drawCalls = 0;

  if (on('fans') && fans.count > 0 && look.fans > 0) {
    // With 2 steps, a fan narrower than 2·sqrt(2/scale) radians bows away
    // from the true circle by at most a quarter pixel at the rim. The
    // visible window clamps every fan, so a narrow window needs no more.
    const scale = p.camera.scale;
    const fine = 2 * Math.sqrt(2 / scale);
    const wide = p.winSpan * RAD_PER_UNIT <= fine ? 0 : fansWiderThan(fans.spans, fans.count, fine);
    const shown = Math.max(wide, fansWiderThan(fans.spans, fans.count, (S.FAN_MIN_PX * p.dpr) / scale));
    const uniforms = {
      lambda: p.lambda,
      fadeF: p.fadeF,
      alpha: S.FAN_ALPHA * look.fans,
      linePx: S.FAN_LINE_PX * p.dpr,
    };
    const spans: [number, number, number][] = [
      [0, wide, K_FAN_WIDE],
      [wide, shown - wide, K_FAN_NARROW],
    ];
    for (const [first, count, k] of spans) {
      if (count <= 0) continue;
      cmds.push({
        pass: 'fans',
        blend: PASS_BLEND.fans,
        vertexCount: 6 * k,
        instanceCount: count,
        firstInstance: first,
        k,
        ...uniforms,
      });
    }
    instances += shown;
    // Counted even when one of them is empty, as the renderer always did.
    drawCalls += 2;
  }

  if (on('branches')) {
    for (const t of tiles) {
      const fade = p.fade(t.level);
      if (fade <= 0) continue;
      cmds.push({
        pass: 'branches',
        blend: PASS_BLEND.branches,
        vertexCount: halfW > 0 ? 12 : 4,
        instanceCount: t.count,
        firstInstance: 0,
        tile: t,
        fade,
        alpha: look.branchAlpha,
        homeAlpha: S.HOME_LINE_ALPHA,
        halfW,
      });
      instances += t.count;
      drawCalls++;
    }
  }

  if (on('arcs')) {
    for (const t of tiles) {
      const fade = p.fade(t.level);
      if (fade <= 0 || t.internalCount === 0) continue;
      const k = t.level <= 3 ? K_COARSE : K_FINE;
      cmds.push({
        pass: 'arcs',
        blend: PASS_BLEND.arcs,
        vertexCount: (halfW > 0 ? 6 : 2) * k,
        instanceCount: t.internalCount,
        firstInstance: 0,
        tile: t,
        k,
        fade,
        alpha: look.branchAlpha,
        homeAlpha: S.HOME_LINE_ALPHA,
        halfW,
      });
      instances += t.internalCount;
      drawCalls++;
    }
  }

  if (on('rim') && look.ring > 0) {
    const px = p.dpr;
    cmds.push({
      pass: 'rim',
      blend: PASS_BLEND.rim,
      ...single(6 * K_RING),
      k: K_RING,
      strength: look.ring,
      reach: [S.RING_REACH_IN_PX * px, S.RING_REACH_OUT_PX * px],
      core: [S.RING_CORE, S.RING_CORE_SIGMA_PX * px],
      halo: [S.RING_HALO, S.RING_HALO_OUT_PX * px, S.RING_HALO_IN, S.RING_HALO_IN_PX * px],
      fur: [S.RING_FUR, S.RING_FUR_PX * px, S.RING_FUR_LINE_PX * px],
    });
    drawCalls++;
  }

  if (on('edge') && look.edge > 0) {
    const width = S.EDGE_WIDTH_PX * p.dpr;
    cmds.push({
      pass: 'edge',
      blend: PASS_BLEND.edge,
      ...single(6 * K_RING),
      k: K_RING,
      // A px of room each side for antialiasing.
      reach: [p.dpr, width + p.dpr],
      alpha: look.edge,
      width,
      lift: S.TIP_DOT_LIFT,
    });
    drawCalls++;
  }

  if (on('marks')) {
    // A leader squeezed by the screen edge (leader.ts) fades out rather than shrinking to a stub.
    const leaderAlpha = p.homeLeader * look.leader * Math.min(1, Math.max(0, (p.leaderLen - 24) / 40));
    for (const t of tiles) {
      const fade = p.fade(t.level);
      if (fade <= 0) continue;
      cmds.push({
        pass: 'marks',
        blend: PASS_BLEND.marks,
        vertexCount: 4,
        instanceCount: t.count,
        firstInstance: 0,
        tile: t,
        fade,
        px: p.dpr,
        spike: [S.SPIKE_ALPHA * look.glow, S.SPIKE_MAX_W_PX * p.dpr],
        tipBar: [look.tipBar, S.TIP_BAR_MAX_LEN_PX * p.dpr, Math.max(0.5, lineDev / 2), 0],
        leader: [leaderAlpha, p.leaderGap * p.dpr, Math.max(1, p.leaderLen) * p.dpr, Math.max(S.HOME_LEADER_WIDTH_DEVICE_PX, lineDev)],
        // No halo: the bar is a plain hairline like the tip bars (DESIGN.md §5).
        leaderHalo: [0, 1],
      });
      instances += t.count;
      drawCalls++;
    }
  }

  // Tip dots: one screen-aligned quad per node (the shader keeps the tips),
  // only once tips are far enough apart for the dots not to touch.
  if (on('tips') && look.tipDot > 0) {
    const radius = S.tipDotRadiusPx(look.lineWidth) * p.dpr;
    for (const t of tiles) {
      const fade = p.fade(t.level);
      if (fade <= 0 || t.count === t.internalCount) continue;
      cmds.push({
        pass: 'tips',
        blend: PASS_BLEND.tips,
        vertexCount: 4,
        instanceCount: t.count,
        firstInstance: 0,
        tile: t,
        alpha: fade * look.tipDot,
        radius,
        lift: S.TIP_DOT_LIFT,
      });
      instances += t.count;
      drawCalls++;
    }
  }

  if (on('backdrop')) {
    const strength = smoothstep(S.BACKDROP_INTRO[0], S.BACKDROP_INTRO[1], revealUniform(p.reveal));
    if (strength > 0) {
      const c = p.camera;
      const px = p.dpr;
      const [ringPx, ringFade] = ringLevel(c.scale, S.BACKDROP_RING_PX * px);
      const deep = smoothstep(S.BACKDROP_DEEP_RAMP[0], S.BACKDROP_DEEP_RAMP[1], p.lambda);
      const cols = Math.max(1, Math.ceil(size.width / (S.BACKDROP_CELL_PX * px)));
      const rows = Math.max(1, Math.ceil(size.height / (S.BACKDROP_CELL_PX * px)));
      const washAlpha = S.BACKDROP_WASH_ALPHA * (1 - (1 - S.BACKDROP_DEEP) * deep);
      cmds.push({
        pass: 'backdrop',
        blend: PASS_BLEND.backdrop,
        // The blurred hue is worked out per vertex of a coarse screen grid.
        ...single(6 * cols * rows),
        strength,
        camRPx: (c.camRHi + c.camRLo) * c.scale,
        rimOff: (c.camRHi - 1 + c.camRLo) * c.scale,
        grid: [S.BACKDROP_GRID_ALPHA, S.BACKDROP_LINE_PX * px, S.BACKDROP_SPOKE_PX * px, ringPx],
        ringFade,
        fade: [S.BACKDROP_GAP_PX * px, S.BACKDROP_RAMP_PX * px],
        wash: [washAlpha, S.BACKDROP_WASH_DECAY_PX * px, S.BACKDROP_WASH_BLUR_PX * px, S.BACKDROP_TINT],
        corona: [S.BACKDROP_CORONA, S.BACKDROP_CORONA_PX * px],
        cells: [cols, rows],
      });
      drawCalls++;
    }
  }

  // Hover and selection (DESIGN.md §5): the tree dims, then the paths and
  // rings go on top, opaque (path.frag), so they read over bright bars.
  const h = p.highlight;
  const viewport: [number, number] = [size.width, size.height];
  const dim = (rect: Dim): DimCmd => ({ pass: 'dim', blend: PASS_BLEND.dim, ...single(6), rect, viewport });
  if (on('dim') && h.treeDim > 0) {
    cmds.push(dim({ x0: -1, y0: -1, x1: size.width + 1, y1: size.height + 1, amount: h.treeDim, soft: 0 }));
    drawCalls++;
  }
  if (on('path')) {
    h.paths.forEach((d, slot) => {
      const n = d.data.length / PATH_WORDS;
      if (n === 0 || d.alpha <= 0) return;
      cmds.push({
        pass: 'path',
        blend: PASS_BLEND.path,
        vertexCount: 6 * K_PATH,
        instanceCount: n,
        firstInstance: 0,
        slot,
        data: d.data,
        k: K_PATH,
        // Heavier than the lines as they thicken (PATH_LINE_RATIO), within PATH_MAX_PX.
        halfW: 0.5 * S.pathWidthPx(d.widthPx, look.lineWidth) * p.dpr,
        colour: [d.rgb[0], d.rgb[1], d.rgb[2], d.alpha],
      });
      drawCalls++;
    });
  }
  if (on('ring')) {
    for (const r of h.rings) {
      cmds.push({
        pass: 'ring',
        blend: PASS_BLEND.ring,
        ...single(4),
        angle: r.angle >>> 0,
        r: r.r,
        radius: r.radiusPx * p.dpr,
        linePx: S.SELECT_RING_LINE_PX * p.dpr,
        colour: [r.rgb[0], r.rgb[1], r.rgb[2], r.alpha],
        dot: S.SELECT_DOT_PX * p.dpr,
        knock: [S.SELECT_KNOCK_PX * p.dpr, S.SELECT_KNOCK_ALPHA],
      });
      drawCalls++;
    }
  }

  // The HUD plates darken whatever is drawn under them, highlights included.
  if (on('dim')) {
    for (const r of p.dims) {
      cmds.push(dim(r));
      drawCalls++;
    }
  }

  return { cmds, stats: { tiles: tiles.length, instances, drawCalls }, look };
}
