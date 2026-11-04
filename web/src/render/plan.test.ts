// The frame plan must reproduce what gl/renderer.ts `Renderer.draw` does
// today; each expectation names the line of renderer.ts it comes from.

import { describe, expect, it } from 'vitest';
import { RAD_PER_UNIT } from '../angle';
import type { CameraUniforms } from '../camera';
import { PATH_WORDS } from '../path';
import * as S from '../style';
import { FAN_WORDS } from '../tiles/fans';
import {
  type ArcsCmd,
  type BackdropCmd,
  type BranchesCmd,
  type DimCmd,
  type DrawCmd,
  type FanSet,
  type FansCmd,
  type MarksCmd,
  PASS_BLEND,
  type Pass,
  type PathCmd,
  type RimCmd,
  type RingCmd,
  fanSpans,
  fansWiderThan,
  lineHalfWidth,
  parsePasses,
  planFrame,
  ringLevel,
} from './plan';
import { type FrameParams, type GpuTile, type Highlight, NO_HIGHLIGHT, type PathDraw } from './types';

const SIZE = { width: 800, height: 600 };
const SCALE = 1000;
/** Fan limits as renderer.ts computes them (draw, l. 301–304), in u32 units. */
const FINE_RAD = 2 * Math.sqrt(2 / SCALE);
const FINE_U = FINE_RAD / RAD_PER_UNIT;
const MIN_U = (S.FAN_MIN_PX * 1) / SCALE / RAD_PER_UNIT;
const FULL_SPAN = 0xffffffff;

function camera(scale = SCALE): CameraUniforms {
  return { camA: 0, camAFrac: 0, camRHi: 0.5, camRLo: 0, scale, rotCos: 1, rotSin: 0, halfW: 400, halfH: 300 };
}

/** λ = 5: fans and the rim ring on, tip bars off. */
function params(over: Partial<FrameParams> = {}): FrameParams {
  return {
    camera: camera(),
    lambda: 5,
    lambdaExt: 5,
    rWin: [0, 1],
    winLo: 0,
    winSpan: FULL_SPAN,
    fade: () => 1,
    fadeF: 1,
    reveal: Infinity,
    dpr: 1,
    tipSpacing: 0.01,
    homeId: -1,
    homeAngle: 0,
    leaderGap: 0,
    leaderLen: 0,
    homeLeader: 1,
    dims: [],
    highlight: NO_HIGHLIGHT,
    ...over,
  };
}

function tile(level: number, count: number, internalCount: number): GpuTile {
  return { level, count, internalCount };
}

const NO_FANS: FanSet = { count: 0, spans: new Float64Array(0) };

/** Spans straddling both limits: 2 wider than `fine`, 4 wider than the 1.5 px minimum. */
function fanSet(): FanSet {
  const spans = new Float64Array([FINE_U * 4, FINE_U * 1.0001, FINE_U, MIN_U * 2, MIN_U, MIN_U * 0.5]);
  return { count: spans.length, spans };
}

function ofPass<P extends Pass>(cmds: readonly DrawCmd[], pass: P): Extract<DrawCmd, { pass: P }>[] {
  return cmds.filter((c): c is Extract<DrawCmd, { pass: P }> => c.pass === pass);
}

function path(n: number, alpha: number, widthPx = 2): PathDraw {
  return { data: new Uint32Array(n * PATH_WORDS), rgb: [0.1, 0.2, 0.3], alpha, widthPx };
}

describe('fan helpers', () => {
  it('fanSpans is hi − lo per packed fan (setFans, l. 200–204)', () => {
    const data = new Uint32Array([10, 110, 0, 3, 5, 6, 0, 4]);
    expect(data.length).toBe(2 * FAN_WORDS);
    expect([...fanSpans(data)]).toEqual([100, 1]);
  });

  it('fansWiderThan counts spans strictly wider than the limit (l. 224–234)', () => {
    const spans = new Float64Array([5, 4, 3, 2, 1]);
    expect(fansWiderThan(spans, 5, 2.5 * RAD_PER_UNIT)).toBe(3);
    expect(fansWiderThan(spans, 5, 0)).toBe(5);
    expect(fansWiderThan(spans, 5, 10 * RAD_PER_UNIT)).toBe(0);
    // Only the first `count` fans exist (fanCount, not the array length).
    expect(fansWiderThan(spans, 3, 0)).toBe(3);
    expect(fansWiderThan(spans, 0, 0)).toBe(0);
  });

  it('a span equal to the limit is not wider', () => {
    const spans = new Float64Array([4, 4, 4]);
    expect(fansWiderThan(spans, 3, 4 * RAD_PER_UNIT)).toBe(0);
  });
});

describe('planFrame: fans', () => {
  it('splits wide (K=16) from narrow (K=2) fans and drops ones under 1.5 px (l. 298–308)', () => {
    const { cmds, stats } = planFrame([], fanSet(), params(), SIZE);
    const fans = ofPass(cmds, 'fans');
    expect(fans).toHaveLength(2);
    const [wide, narrow] = fans as [FansCmd, FansCmd];
    expect(wide).toMatchObject({ k: 16, vertexCount: 96, firstInstance: 0, instanceCount: 2 });
    expect(narrow).toMatchObject({ k: 2, vertexCount: 12, firstInstance: 2, instanceCount: 2 });
    expect(stats.instances).toBe(4);
    expect(stats.drawCalls).toBe(2 + 1 /* rim */ + 1 /* backdrop */);
  });

  it('carries the fan uniforms (l. 293–296)', () => {
    const p = params({ lambda: 12.9, lambdaExt: 12.9, fadeF: 0.25, dpr: 2 });
    const look = S.frameLook(p);
    const [first] = ofPass(planFrame([], fanSet(), p, SIZE).cmds, 'fans');
    expect(first).toMatchObject({
      lambda: 12.9,
      fadeF: 0.25,
      alpha: S.FAN_ALPHA * look.fans,
      linePx: S.FAN_LINE_PX * 2,
      blend: 'saturating',
    });
  });

  it('a window narrower than the fine limit draws no wide fans, but still counts 2 calls (l. 303, 308)', () => {
    const p = params({ winSpan: Math.floor(FINE_U) });
    const { cmds, stats } = planFrame([], fanSet(), p, SIZE);
    const fans = ofPass(cmds, 'fans');
    expect(fans).toHaveLength(1);
    expect(fans[0]).toMatchObject({ k: 2, firstInstance: 0, instanceCount: 4 });
    expect(stats.instances).toBe(4);
    expect(stats.drawCalls).toBe(2 + 1 + 1 /* backdrop */);
  });

  it('empty fan draws are left out, still counted as 2 calls (drawFans early return, l. 209)', () => {
    const tiny = new Float64Array([MIN_U * 0.5, MIN_U * 0.25]);
    const { cmds, stats } = planFrame([], { count: 2, spans: tiny }, params(), SIZE);
    expect(ofPass(cmds, 'fans')).toEqual([]);
    expect(stats.drawCalls).toBe(2 + 1 + 1 /* backdrop */);
    expect(stats.instances).toBe(0);
  });

  it('no fans at all, or faded out (λ ≥ 13.5), skips the pass entirely (l. 291)', () => {
    expect(planFrame([], NO_FANS, params(), SIZE).stats.drawCalls).toBe(1 + 1 /* backdrop */);
    const deep = params({ lambda: 14, lambdaExt: 14 });
    expect(S.frameLook(deep).fans).toBe(0);
    const { cmds, stats } = planFrame([], fanSet(), deep, SIZE);
    expect(ofPass(cmds, 'fans')).toEqual([]);
    expect(stats.drawCalls).toBe(1 /* backdrop */);
  });

  it('the 1.5 px minimum scales with the DPR (l. 304)', () => {
    // Spans kept clear of the limits: at dpr 2 the minimum doubles, so MIN_U·1.5 drops out.
    const spans = new Float64Array([FINE_U * 4, MIN_U * 3, MIN_U * 1.5, MIN_U * 0.5]);
    const shown = (dpr: number): number =>
      ofPass(planFrame([], { count: 4, spans }, params({ dpr }), SIZE).cmds, 'fans').reduce(
        (sum, c) => sum + c.instanceCount,
        0,
      );
    expect(shown(1)).toBe(3);
    expect(shown(2)).toBe(2);
  });
});

describe('planFrame: tiles', () => {
  const tiles = [tile(2, 10, 4), tile(5, 20, 0), tile(6, 30, 7)];
  const fade = (level: number): number => (level === 6 ? 0 : level === 5 ? 0.5 : 1);

  it('skips tiles whose fade is ≤ 0 in branches, arcs and marks (l. 318, 331, 375)', () => {
    const { cmds } = planFrame(tiles, NO_FANS, params({ fade }), SIZE);
    expect(ofPass(cmds, 'branches').map((c) => c.tile)).toEqual([tiles[0], tiles[1]]);
    expect(ofPass(cmds, 'marks').map((c) => c.tile)).toEqual([tiles[0], tiles[1]]);
    const negative = planFrame(tiles, NO_FANS, params({ fade: () => -0.1 }), SIZE);
    expect(ofPass(negative.cmds, 'branches')).toEqual([]);
  });

  it('skips arcs of tiles without internal nodes (l. 331)', () => {
    const { cmds } = planFrame(tiles, NO_FANS, params({ fade }), SIZE);
    expect(ofPass(cmds, 'arcs').map((c) => c.tile)).toEqual([tiles[0]]);
  });

  it('branches: 4 vertices per node, fade and alpha per tile (l. 312–323)', () => {
    const p = params({ fade });
    const look = S.frameLook(p);
    const [, b] = ofPass(planFrame(tiles, NO_FANS, p, SIZE).cmds, 'branches') as [BranchesCmd, BranchesCmd];
    expect(b).toMatchObject({
      vertexCount: 4,
      instanceCount: 20,
      firstInstance: 0,
      fade: 0.5,
      alpha: look.branchAlpha,
      homeAlpha: S.HOME_LINE_ALPHA,
      blend: 'saturating',
    });
  });

  it('arcs: K=128 for levels ≤ 3, else 16; 2K vertices per internal node (l. 332–336)', () => {
    const t = [tile(0, 5, 1), tile(3, 5, 2), tile(4, 5, 3), tile(9, 5, 4)];
    const arcs = ofPass(planFrame(t, NO_FANS, params(), SIZE).cmds, 'arcs');
    expect(arcs.map((c) => c.k)).toEqual([128, 128, 16, 16]);
    expect(arcs.map((c) => c.vertexCount)).toEqual([256, 256, 32, 32]);
    expect(arcs.map((c) => c.instanceCount)).toEqual([1, 2, 3, 4]);
    const look = S.frameLook(params());
    expect(arcs[0] as ArcsCmd).toMatchObject({ alpha: look.branchAlpha, homeAlpha: S.HOME_LINE_ALPHA, fade: 1 });
  });
});

describe('planFrame: rim ring', () => {
  it('is drawn once, without instances, while look.ring > 0 (l. 341–358)', () => {
    const p = params({ dpr: 2 });
    const look = S.frameLook(p);
    expect(look.ring).toBeGreaterThan(0);
    const { cmds, stats } = planFrame([], NO_FANS, p, SIZE);
    const rims = ofPass(cmds, 'rim');
    expect(rims).toHaveLength(1);
    expect(rims[0] as RimCmd).toEqual({
      pass: 'rim',
      blend: 'saturating',
      k: 256,
      vertexCount: 6 * 256,
      instanceCount: 1,
      firstInstance: 0,
      strength: look.ring,
      reach: [S.RING_REACH_IN_PX * 2, S.RING_REACH_OUT_PX * 2],
      core: [S.RING_CORE, S.RING_CORE_SIGMA_PX * 2],
      halo: [S.RING_HALO, S.RING_HALO_OUT_PX * 2, S.RING_HALO_IN, S.RING_HALO_IN_PX * 2],
      fur: [S.RING_FUR, S.RING_FUR_PX * 2, S.RING_FUR_LINE_PX * 2],
    });
    expect(stats).toEqual({ tiles: 0, instances: 0, drawCalls: 1 + 1 /* backdrop */ });
  });

  it('is skipped once it has faded (λ ≥ 13)', () => {
    const p = params({ lambda: 13, lambdaExt: 13 });
    expect(S.frameLook(p).ring).toBe(0);
    expect(ofPass(planFrame([], NO_FANS, p, SIZE).cmds, 'rim')).toEqual([]);
  });
});

describe('planFrame: rim marks', () => {
  it('carries the mark uniforms, additive blend (l. 363–378)', () => {
    const p = params({ lambda: 13, lambdaExt: 13, dpr: 2, tipSpacing: 12, leaderGap: 30, leaderLen: 200 });
    const look = S.frameLook(p);
    const [m] = ofPass(planFrame([tile(8, 7, 0)], NO_FANS, p, SIZE).cmds, 'marks') as [MarksCmd];
    expect(m).toEqual({
      pass: 'marks',
      blend: 'additive',
      tile: tile(8, 7, 0),
      vertexCount: 4,
      instanceCount: 7,
      firstInstance: 0,
      fade: 1,
      px: 2,
      spike: [S.SPIKE_ALPHA * look.glow, S.SPIKE_MAX_W_PX * 2],
      tipBar: [look.tipBar, S.TIP_BAR_MAX_LEN_PX * 2, Math.max(0.5, look.lineWidth), 0],
      leader: [look.leader, 30 * 2, 200 * 2, Math.max(S.HOME_LEADER_WIDTH_DEVICE_PX, look.lineWidth * 2)],
      leaderHalo: [0, 1],
    });
  });

  it('leaves the home bar out while Homo sapiens is the selection', () => {
    const p = params({ lambda: 13, lambdaExt: 13, dpr: 2, tipSpacing: 12, leaderGap: 30, leaderLen: 200, homeLeader: 0 });
    const [m] = ofPass(planFrame([tile(8, 7, 0)], NO_FANS, p, SIZE).cmds, 'marks') as [MarksCmd];
    expect(m?.leader[0]).toBe(0);
  });

  it('fades the leader out as the screen edge squeezes it: (len − 24) / 40, clamped (l. 371–372)', () => {
    const leader = (leaderLen: number): [number, number, number] => {
      const p = params({ tipSpacing: 12, leaderGap: 10, leaderLen, dpr: 2 });
      expect(S.frameLook(p).leader).toBe(1);
      const [m] = ofPass(planFrame([tile(8, 1, 0)], NO_FANS, p, SIZE).cmds, 'marks');
      const [alpha = NaN, gap = NaN, len = NaN] = m?.leader ?? [];
      return [alpha, gap, len];
    };
    expect(leader(0)).toEqual([0, 20, 2]); // length clamped to ≥ 1 px
    expect(leader(24)).toEqual([0, 20, 48]);
    expect(leader(44)).toEqual([0.5, 20, 88]);
    expect(leader(64)).toEqual([1, 20, 128]);
    expect(leader(500)).toEqual([1, 20, 1000]);
  });

  it('marks are drawn even when look values are 0 (no look guard, l. 363)', () => {
    const p = params({ lambda: 0, lambdaExt: 0, tipSpacing: 0.001 });
    expect(ofPass(planFrame([tile(1, 3, 0)], NO_FANS, p, SIZE).cmds, 'marks')).toHaveLength(1);
  });
});

describe('planFrame: backdrop', () => {
  it('is one draw after the tree, before the dims, with the camera in device px', () => {
    const p = params({ dpr: 2, camera: { ...camera(4096), camRHi: 0.75, camRLo: 1e-9 } });
    const { cmds } = planFrame([tile(1, 3, 0)], NO_FANS, p, SIZE);
    const iBack = cmds.findIndex((c) => c.pass === 'backdrop');
    expect(iBack).toBe(cmds.findIndex((c) => c.pass === 'marks') + 1);
    const b = cmds[iBack] as BackdropCmd;
    expect(b.blend).toBe('saturating');
    // 800×600 at DPR 2 in 128 device px cells: 7 × 5.
    expect(b.cells).toEqual([Math.ceil(800 / (2 * S.BACKDROP_CELL_PX)), Math.ceil(600 / (2 * S.BACKDROP_CELL_PX))]);
    expect([b.vertexCount, b.instanceCount]).toEqual([6 * b.cells[0] * b.cells[1], 1]);
    expect(b.strength).toBe(1);
    expect(b.camRPx).toBeCloseTo((0.75 + 1e-9) * 4096, 9);
    expect(b.rimOff).toBeCloseTo((0.75 + 1e-9 - 1) * 4096, 9);
    expect(b.grid).toEqual([S.BACKDROP_GRID_ALPHA, 2 * S.BACKDROP_LINE_PX, 2 * S.BACKDROP_SPOKE_PX, b.grid[3]]);
    expect(b.fade).toEqual([2 * S.BACKDROP_GAP_PX, 2 * S.BACKDROP_RAMP_PX]);
    expect(b.corona).toEqual([S.BACKDROP_CORONA, 2 * S.BACKDROP_CORONA_PX]);
  });

  it('fades in at the end of the intro reveal', () => {
    const at = (reveal: number): DrawCmd[] => ofPass(planFrame([], NO_FANS, params({ reveal }), SIZE).cmds, 'backdrop');
    expect(at(0.3)).toEqual([]);
    const mid = at((S.BACKDROP_INTRO[0] + S.BACKDROP_INTRO[1]) / 2)[0] as BackdropCmd;
    expect(mid.strength).toBeCloseTo(0.5);
    expect((at(Infinity)[0] as BackdropCmd).strength).toBe(1);
  });

  it('eases the wash down when deep, keeping the grid', () => {
    const wash = (lambda: number): BackdropCmd => ofPass(planFrame([], NO_FANS, params({ lambda }), SIZE).cmds, 'backdrop')[0] as BackdropCmd;
    expect(wash(S.BACKDROP_DEEP_RAMP[0]).wash[0]).toBeCloseTo(S.BACKDROP_WASH_ALPHA);
    expect(wash(18).wash[0]).toBeCloseTo(S.BACKDROP_WASH_ALPHA * S.BACKDROP_DEEP);
    expect(wash(18).grid[0]).toBe(S.BACKDROP_GRID_ALPHA);
  });

  it('?passes can leave it out or draw it alone', () => {
    const only = planFrame([tile(1, 3, 0)], NO_FANS, params(), SIZE, new Set<Pass>(['backdrop']));
    expect(only.cmds.map((c) => c.pass)).toEqual(['backdrop']);
    const without = planFrame([tile(1, 3, 0)], NO_FANS, params(), SIZE, new Set<Pass>(['branches']));
    expect(ofPass(without.cmds, 'backdrop')).toEqual([]);
  });
});

describe('ringLevel', () => {
  it('spaces rings target..2·target px apart, at 1/2^n world units', () => {
    for (const scale of [300, 1000, 4096, 1.8e7]) {
      const [px, fade] = ringLevel(scale, 96);
      expect(px).toBeGreaterThanOrEqual(96);
      expect(px).toBeLessThan(192);
      expect(Math.log2(scale / px) % 1).toBeCloseTo(0);
      expect(fade).toBeGreaterThanOrEqual(0);
      expect(fade).toBeLessThan(1);
    }
  });

  it('is continuous across an octave: the half-spaced rings are fully in as the level steps', () => {
    const [pxBelow, fadeBelow] = ringLevel(96 * 4 * 0.99999, 96);
    const [pxAt, fadeAt] = ringLevel(96 * 4, 96);
    expect(fadeBelow).toBeCloseTo(1, 4);
    expect(fadeAt).toBe(0);
    expect(pxBelow / 2).toBeCloseTo(pxAt, 2);
  });
});

describe('planFrame: highlight and dims', () => {
  const hl = (h: Partial<Highlight>): Highlight => ({ ...NO_HIGHLIGHT, ...h });

  it('darkens the whole tree first, a 1 px oversized rect with no soft edge (l. 398–402)', () => {
    const p = params({ highlight: hl({ treeDim: 0.4, paths: [path(2, 1)] }), dims: [] });
    const { cmds } = planFrame([tile(9, 1, 0)], NO_FANS, p, SIZE);
    const iDim = cmds.findIndex((c) => c.pass === 'dim');
    const iPath = cmds.findIndex((c) => c.pass === 'path');
    const iMarks = cmds.findIndex((c) => c.pass === 'marks');
    expect(iMarks).toBeLessThan(iDim);
    expect(iDim).toBeLessThan(iPath);
    expect(cmds[iDim] as DimCmd).toEqual({
      pass: 'dim',
      blend: 'dim',
      vertexCount: 6,
      instanceCount: 1,
      firstInstance: 0,
      rect: { x0: -1, y0: -1, x1: 801, y1: 601, amount: 0.4, soft: 0 },
      viewport: [800, 600],
    });
  });

  it('no tree dim when treeDim is 0', () => {
    const p = params({ highlight: hl({ treeDim: 0, paths: [path(2, 1)] }) });
    expect(ofPass(planFrame([], NO_FANS, p, SIZE).cmds, 'dim')).toEqual([]);
  });

  it('skips paths with no segments or alpha ≤ 0, keeping each path its slot (l. 407–416)', () => {
    const paths = [path(0, 1), path(2, 0), path(3, 0.6, 2), path(1, -1)];
    const p = params({ dpr: 2, highlight: hl({ paths }) });
    const drawn = ofPass(planFrame([], NO_FANS, p, SIZE).cmds, 'path');
    expect(drawn).toHaveLength(1);
    expect(drawn[0] as PathCmd).toEqual({
      pass: 'path',
      blend: 'over',
      slot: 2,
      data: paths[2]?.data,
      k: 64,
      vertexCount: 6 * 64,
      instanceCount: 3,
      firstInstance: 0,
      halfW: 0.5 * 2 * 2,
      colour: [0.1, 0.2, 0.3, 0.6],
    });
  });

  it('draws every ring, even transparent ones, after the paths (l. 417–428)', () => {
    const rings = [
      { angle: -1, r: 0.5, rgb: [1, 1, 1] as const, alpha: 1, radiusPx: 6 },
      { angle: 123, r: 0.9, rgb: [0.5, 0.5, 0.5] as const, alpha: 0, radiusPx: 6 },
    ];
    const p = params({ dpr: 2, highlight: hl({ paths: [path(1, 1)], rings }) });
    const { cmds } = planFrame([], NO_FANS, p, SIZE);
    const out = ofPass(cmds, 'ring');
    expect(out).toHaveLength(2);
    expect(cmds.findIndex((c) => c.pass === 'path')).toBeLessThan(cmds.findIndex((c) => c.pass === 'ring'));
    expect(out[0] as RingCmd).toEqual({
      pass: 'ring',
      blend: 'over',
      vertexCount: 4,
      instanceCount: 1,
      firstInstance: 0,
      angle: 0xffffffff, // r.angle >>> 0
      r: 0.5,
      radius: 12,
      linePx: 2,
      colour: [1, 1, 1, 1],
    });
    expect(out[1]?.colour[3]).toBe(0);
  });

  it('rings are drawn without any paths', () => {
    const rings = [{ angle: 5, r: 0.5, rgb: [1, 1, 1] as const, alpha: 1, radiusPx: 6 }];
    const p = params({ highlight: hl({ rings }) });
    expect(ofPass(planFrame([], NO_FANS, p, SIZE).cmds, 'ring')).toHaveLength(1);
  });

  it('HUD dims come last, one per rect, unchanged (l. 384, 470–485)', () => {
    const dims = [
      { x0: 0, y0: 500, x1: 800, y1: 600, amount: 0.85, soft: 20 },
      { x0: 10, y0: 10, x1: 50, y1: 40, amount: 0.5, soft: 4 },
    ];
    const p = params({ dims, highlight: hl({ treeDim: 0.4, rings: [{ angle: 0, r: 1, rgb: [1, 1, 1], alpha: 1, radiusPx: 6 }] }) });
    const { cmds } = planFrame([], NO_FANS, p, SIZE);
    const last = cmds.slice(-2) as DimCmd[];
    expect(last.map((c) => c.rect)).toEqual(dims);
    expect(last.every((c) => c.pass === 'dim' && c.blend === 'dim' && c.vertexCount === 6)).toBe(true);
    expect(last[0]?.viewport).toEqual([800, 600]);
  });
});

describe('planFrame: order, blends and stats', () => {
  const tiles = [tile(2, 10, 4), tile(5, 20, 0), tile(6, 30, 7)];
  const fade = (level: number): number => (level === 6 ? 0 : 1);
  const full = (): FrameParams =>
    params({
      fade,
      highlight: { treeDim: 0.4, paths: [path(3, 1), path(0, 1)], rings: [{ angle: 0, r: 1, rgb: [1, 1, 1], alpha: 1, radiusPx: 6 }] },
      dims: [
        { x0: 0, y0: 0, x1: 1, y1: 1, amount: 1, soft: 0 },
        { x0: 0, y0: 0, x1: 2, y1: 2, amount: 1, soft: 0 },
      ],
    });

  it('draws the passes in renderer.ts order', () => {
    const { cmds } = planFrame(tiles, fanSet(), full(), SIZE);
    const order = cmds.map((c) => c.pass);
    expect(order).toEqual([
      'fans', 'fans',
      'branches', 'branches',
      'arcs',
      'rim',
      'marks', 'marks',
      'backdrop',
      'dim', // tree dim
      'path',
      'ring',
      'dim', 'dim', // HUD plates
    ]);
  });

  it('every command uses its pass blend, matching renderer.ts', () => {
    // l. 285 saturating; l. 363 (1,1); l. 404 (1, 1−srcA); l. 474 (0, 1−srcA).
    expect(PASS_BLEND).toEqual({
      fans: 'saturating',
      branches: 'saturating',
      arcs: 'saturating',
      rim: 'saturating',
      marks: 'additive',
      backdrop: 'saturating',
      dim: 'dim',
      path: 'over',
      ring: 'over',
    });
    for (const c of planFrame(tiles, fanSet(), full(), SIZE).cmds) expect(c.blend).toBe(PASS_BLEND[c.pass]);
  });

  it('counts FrameStats exactly as draw() does (l. 307–386)', () => {
    const { stats } = planFrame(tiles, fanSet(), full(), SIZE);
    expect(stats).toEqual({
      tiles: 3, // all tiles passed in, faded or not
      instances: 4 /* fans */ + 30 /* branches */ + 4 /* arcs */ + 30 /* marks */,
      drawCalls: 2 /* fans */ + 2 + 1 + 1 /* rim */ + 2 + 1 /* backdrop */ + 1 /* tree dim */ + 1 /* path */ + 1 /* ring */ + 2 /* dims */,
    });
  });

  it('returns the frame look it used', () => {
    expect(planFrame([], NO_FANS, full(), SIZE).look).toEqual(S.frameLook(full()));
  });

  it('a passes filter leaves out the other passes and their stats', () => {
    const only = new Set<Pass>(['branches', 'arcs']);
    const { cmds, stats } = planFrame(tiles, fanSet(), full(), SIZE, only);
    expect(new Set(cmds.map((c) => c.pass))).toEqual(only);
    expect(stats).toEqual({ tiles: 3, instances: 30 + 4, drawCalls: 2 + 1 });
  });

  it('the dim filter covers both the tree dim and the HUD plates', () => {
    const { cmds } = planFrame(tiles, fanSet(), full(), SIZE, new Set<Pass>(['dim']));
    expect(cmds.map((c) => c.pass)).toEqual(['dim', 'dim', 'dim']);
  });
});

describe('parsePasses', () => {
  it('reads a comma-separated list of known passes', () => {
    expect(parsePasses(new URLSearchParams('passes=branches,arcs'))).toEqual(new Set(['branches', 'arcs']));
    expect(parsePasses(new URLSearchParams('passes=branches,bogus'))).toEqual(new Set(['branches']));
  });

  it('is null (all passes) when absent, empty or naming nothing known', () => {
    expect(parsePasses(new URLSearchParams(''))).toBeNull();
    expect(parsePasses(new URLSearchParams('passes='))).toBeNull();
    expect(parsePasses(new URLSearchParams('passes=bogus'))).toBeNull();
  });
});

describe('planFrame: line width', () => {
  const lines = (tipSpacing: number, dpr: number): { b: BranchesCmd; a: ArcsCmd } => {
    const p = params({ lambda: 16, lambdaExt: 16, dpr, tipSpacing });
    const cmds = planFrame([tile(9, 7, 3)], NO_FANS, p, SIZE).cmds;
    const [b] = ofPass(cmds, 'branches') as [BranchesCmd];
    const [a] = ofPass(cmds, 'arcs') as [ArcsCmd];
    return { b, a };
  };

  it('keeps native hairlines while lines are at most a device px (overview, mid zoom)', () => {
    for (const [spacing, dpr] of [
      [0.01, 1],
      [6, 2],
      [8, 1],
    ] as const) {
      const { b, a } = lines(spacing, dpr);
      expect(b.halfW).toBe(0);
      expect(b.vertexCount).toBe(4);
      expect(a.vertexCount).toBe(2 * a.k);
    }
  });

  it('draws quads LINE_DEEP_PX wide once tips are far apart', () => {
    const { b, a } = lines(48, 2);
    expect(b.halfW).toBeCloseTo(S.LINE_DEEP_PX, 9); // half of LINE_DEEP_PX CSS px at DPR 2
    expect(b.vertexCount).toBe(12);
    expect(a.vertexCount).toBe(6 * a.k);
  });

  it('draws them LINE_DEEP_PX wide at DPR 1 too', () => {
    expect(lines(48, 1).b.halfW).toBeCloseTo(S.LINE_DEEP_PX / 2, 9);
  });

  it('keeps the selection heavier than thick lines, capped at PATH_MAX_PX', () => {
    const p = params({ lambda: 18.8, lambdaExt: 18.8, dpr: 2, tipSpacing: 48, highlight: { ...NO_HIGHLIGHT, paths: [path(2, 1)] } });
    const [cmd] = ofPass(planFrame([], NO_FANS, p, SIZE).cmds, 'path') as [PathCmd];
    expect(cmd.halfW).toBeCloseTo(0.5 * S.PATH_MAX_PX * 2, 9);
    expect(cmd.halfW).toBeGreaterThan(lines(48, 2).b.halfW);
  });

  it('gives no half width (native lines) at or under a device px', () => {
    expect(lineHalfWidth(0.4, 2)).toBe(0);
    expect(lineHalfWidth(1.75, 2)).toBeCloseTo(1.75, 9);
  });
});
