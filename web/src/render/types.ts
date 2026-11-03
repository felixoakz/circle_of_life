// The one interface both backends implement (docs/plan-webgpu.md §1), and
// the frame types they draw from. Nothing here knows about WebGL or WebGPU.

import type { CameraUniforms } from '../camera';
import type { RunPalette } from '../palette';
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


export type BackendKind = 'webgpu' | 'webgl2';

/** Backend-owned GPU copy of one tile; backends narrow it with instanceof. */
export interface GpuTile {
  readonly level: number;
  readonly count: number;
  readonly internalCount: number;
}

/** Top-down RGBA8 pixels of the tree canvas (precision test, parity). */
export interface Pixels {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface Renderer {
  readonly kind: BackendKind;
  upload(tile: Tile): GpuTile;
  release(tile: GpuTile): void;
  setFans(data: Uint32Array): void;
  draw(tiles: readonly GpuTile[], p: FrameParams): FrameStats;
  /** Drawing-buffer size in device px. */
  size(): { width: number; height: number };
  /** Resolves when the GPU has finished all submitted work. */
  finish(): Promise<void>;
  /** The frame just drawn. Call in the same task as draw(). */
  readPixels(): Promise<Pixels>;
  /** Last GPU frame time in ms when timestamp-query is available, else null. */
  gpuMs(): number | null;
  /** Fired when the GPU was lost and the backend could not recover. */
  onLost: (reason: string) => void;
  /**
   * Fired after the backend recovered from a GPU loss on a new device: every
   * tile handle from before is dead and must be uploaded again.
   */
  onRestored: () => void;
  /** `?debug` only: simulate a GPU loss (WebGPU; absent where it cannot happen this way). */
  loseDevice?: () => void;
  destroy(): void;
}

export interface RendererOptions {
  /** Accept a software adapter (`isFallbackAdapter`); only when the URL forces WebGPU. */
  allowFallbackAdapter: boolean;
}

/** Builds one backend, or null when it is unavailable here (no adapter, no context). */
export type RendererFactory = (
  canvas: HTMLCanvasElement,
  palette: RunPalette,
  opts: RendererOptions,
) => Promise<Renderer | null>;
