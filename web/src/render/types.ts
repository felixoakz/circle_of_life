// The renderer interface the scene draws through, and the frame types it
// draws from. Nothing here knows about WebGL: the frame plan
// (render/plan.ts) and its tests work on these types alone.

import type { CameraUniforms } from '../camera';
import type { Tile } from '../tiles/decode';

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
  /** 1 to draw the home leader bar, 0 while Homo sapiens is the selection. */
  homeLeader: number;
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

/** The renderer's GPU copy of one tile; gl/renderer.ts narrows it with instanceof. */
export interface GpuTile {
  readonly level: number;
  readonly count: number;
  readonly internalCount: number;
}

/** Top-down RGBA8 pixels of the tree canvas (precision test, smoke test). */
export interface Pixels {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface Renderer {
  upload(tile: Tile): GpuTile;
  release(tile: GpuTile): void;
  setFans(data: Uint32Array): void;
  draw(tiles: readonly GpuTile[], p: FrameParams): FrameStats;
  /** Drawing-buffer size in device px. */
  size(): { width: number; height: number };
  /** Returns once the GPU has finished all submitted work. */
  finish(): void;
  /** The frame just drawn. Call in the same task as draw(). */
  readPixels(): Pixels;
  destroy(): void;
}
