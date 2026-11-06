// Ties camera, input, tiles and renderer together, and owns the frame loop.
// Frames are rendered on demand only: when the camera, tiles or an animation
// change (ARCHITECTURE §7.1). `window.__renderIdle` turns true once nothing is
// pending and two quiet frames have passed, for the screenshot script.

import { fetchTile } from './api';
import { Camera } from './camera';
import { crossfade } from './crossfade';
import { cubicBezier } from './ease';
import { Flight } from './flyto';
import { type Dim, type GpuTile, type Highlight, NO_HIGHLIGHT, type Renderer } from './render/types';
import { Input } from './input';
import { type View, computeView, levelFade, radialWindow, rangeUniforms } from './lod';
import { AutoOrient } from './orient';
import { Rig } from './rig';
import { Spin } from './spin';
import type { Tour } from './tour';
import type { RunPalette } from './palette';
import { leaderLength } from './leader';
import { DIM_PAD_PX, DIM_SOFT_PX, HOME_LEADER_GAP_PX, INTRO_EASE, INTRO_MS, REVEAL_END } from './style';
import { TileCache } from './tiles/cache';
import type { Tile } from './tiles/decode';
import { buildFans } from './tiles/fans';
import type { Meta } from './types';
import { Obstacles } from './ui/obstacles';

declare global {
  interface Window {
    __renderIdle?: boolean;
    /** Last frame's numbers, for the screenshot script's report. */
    __stats?: SceneStats;
  }
}

export interface SceneStats {
  tiles: number;
  instances: number;
  drawCalls: number;
  lambda: number;
  level: number;
  resident: number;
  aborted: number;
}

export interface FrameInfo {
  view: View;
  tiles: number;
  instances: number;
  drawCalls: number;
  /** CPU time of the frame, plus GPU time when `syncGpu` is on (it waits for the GPU). */
  ms: number;
}

export class Scene {
  readonly camera: Camera;
  /** The user's view, zoom and rotation, written into the camera (rig.ts). */
  readonly rig: Rig;
  readonly input: Input;
  readonly cache: TileCache<GpuTile>;
  readonly orient: AutoOrient;
  readonly flight: Flight;
  /** The wheel's ambient turn and fling inertia (spin.ts). */
  readonly spin: Spin;
  /** The idle tour (tour.ts), set by main.ts; stepped every frame. */
  tour: Tour | null = null;
  /** Called on any user input that moves the view (main.ts stops the tour). */
  onInteract: () => void = () => {};
  /** Screen areas labels keep clear of and the tree is darkened behind (HUD, panel, search). */
  readonly obstacles = new Obstacles();
  /** Angle → kingdom colour (labels colour tip names from it). */
  readonly palette: RunPalette;
  /** Called once when the intro reveal has finished (or was skipped). */
  onIntroDone: () => void = () => {};
  /** Called after every rendered frame (debug HUD). */
  onFrame: (info: FrameInfo) => void = () => {};
  /** Extra per-frame animation (precision mode); returns true while running. */
  animate: ((now: number) => boolean) | null = null;
  /** Wait for the GPU each frame so `ms` is a true frame time (debug only). */
  syncGpu = false;
  /**
   * Darken the tree behind the obstacles (HUD, panel). The precision test
   * turns it off: the plates are fixed to the screen, not the tree, so a
   * pan slides bars under their soft edges and skews the measurement.
   */
  dimsOn = true;
  /** Labels need fonts; idle also waits for them so screenshots are final. */
  fontsReady = false;
  /**
   * The overlay (labels, HUD readout), drawn after every frame and on its
   * own for label fades; returns true while it still needs frames.
   */
  overlay: (now: number) => boolean = () => false;
  /** Extra work that must finish before the scene counts as idle (HUD fetches). */
  busy: () => boolean = () => false;
  /** Hover and selection highlights for a frame (main.ts joins hover.ts and selection.ts); `animating` while they fade. */
  highlight: (now: number) => { draw: Highlight; animating: boolean } = () => ({ draw: NO_HIGHLIGHT, animating: false });
  /** Distance from the rim to the home leader bar, CSS px (labels.ts measures the label). */
  leaderGap: (tipSpacing: number) => number = () => HOME_LEADER_GAP_PX;
  /** Whether the home leader bar is drawn (not while Homo sapiens is the selection; main.ts). */
  homeLeader: () => boolean = () => true;
  /** The last frame's view and drawable tiles (CPU side), for labels and HUD. */
  lastView: View | null = null;
  lastTiles: Tile[] = [];

  /** Draws the tree (gl/renderer.ts). */
  readonly renderer: Renderer;
  private readonly meta: Meta;
  private scheduled = false;
  private dirty = false;
  /** The tree itself needs redrawing (not just the overlay). */
  private glDirty = false;
  private idleWaiters: (() => void)[] = [];
  /** What the current fans were built from: F and the drawn tile keys. */
  private fanSource = '';
  /**
   * Intro reveal (DESIGN.md §6): 'waiting' until the first view's tiles are
   * in, then the time it started; 'done' once finished or skipped.
   */
  private intro: 'waiting' | number | 'done' = 'done';
  private readonly introEase = cubicBezier(...INTRO_EASE);
  private reveal = Infinity;
  private highlightAnimating = false;

  constructor(renderer: Renderer, canvas: HTMLCanvasElement, meta: Meta, palette: RunPalette) {
    this.renderer = renderer;
    this.meta = meta;
    this.camera = new Camera(meta.tipCount);
    this.palette = palette;
    this.cache = new TileCache<GpuTile>({
      fetch: (level, sector, signal) => fetchTile(meta.dataVersion, level, sector, signal),
      upload: (tile) => this.renderer.upload(tile),
      release: (gpu) => this.renderer.release(gpu),
    });
    this.cache.onChange = () => this.requestRender();
    this.rig = new Rig(this.camera);
    this.input = new Input(canvas, this.rig, () => this.requestRender());
    this.orient = new AutoOrient(this.rig);
    this.flight = new Flight(this.rig);
    this.flight.onEnd = () => this.requestRender();
    this.spin = new Spin(this.rig);
    this.spin.wake = () => this.requestRender();
    this.input.onFling = (v) => this.spin.fling(v, performance.now());
    this.flight.onCut = () => this.snapshotForCut(canvas);
    this.input.onUserInput = () => {
      this.flight.cancel();
      this.spin.interact(performance.now());
      this.onInteract();
    };
    this.obstacles.onChange = () => this.requestRender();
    window.__renderIdle = false;
  }

  /** Plays the intro reveal once the first view's tiles have arrived. */
  playIntro(): void {
    this.intro = 'waiting';
    this.reveal = 0;
    this.requestRender();
  }

  requestRender(): void {
    this.glDirty = true;
    this.schedule();
  }

  /** Repaints only the overlay next frame (label fades, HUD updates). */
  requestOverlay(): void {
    this.schedule();
  }

  private schedule(): void {
    this.dirty = true;
    window.__renderIdle = false;
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame((now) => {
      this.scheduled = false;
      this.frame(now);
    });
  }

  /**
   * Average wall-clock time in ms of `n` back-to-back frames, waiting for
   * the GPU after each (a frame-time measurement for headless runs).
   */
  bench(n: number): number {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      this.renderNow();
      this.renderer.finish();
    }
    return (performance.now() - t0) / n;
  }

  /** Resolves the next time the scene goes idle. */
  whenIdle(): Promise<void> {
    if (window.__renderIdle) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Renders one frame right now (also used by the precision test). */
  renderNow(): FrameInfo {
    const t0 = performance.now();
    const cam = this.camera;
    const { tileP, maxLevel } = this.meta;
    const view = computeView(cam, tileP, maxLevel);
    this.cache.update(view.keys);

    const drawable = this.cache.drawable();
    const tiles = drawable.map((e) => e.gpu as GpuTile);
    const cpuTiles: Tile[] = [];
    for (const e of drawable) if (e.tile) cpuTiles.push(e.tile);
    this.lastTiles = cpuTiles;
    this.lastView = view;
    // Frontier extensions stay until the children's level is fully loaded.
    const lambdaExt = Math.min(view.lambda, this.cache.completeLevel() + 0.999);
    const fullLevel = Math.max(0, Math.floor(lambdaExt));
    const fanSource = `${fullLevel}:${drawable.map((e) => e.key).join(',')}`;
    if (fanSource !== this.fanSource) {
      this.fanSource = fanSource;
      this.renderer.setFans(buildFans(cpuTiles, fullLevel));
    }
    const win = rangeUniforms(view.range);
    const tipSpacing = cam.tipSpacingPx() / cam.dpr;
    const leaderGap = this.leaderGap(tipSpacing);
    const hl = this.intro === 'done' ? this.highlight(performance.now()) : { draw: NO_HIGHLIGHT, animating: false };
    this.highlightAnimating = hl.animating;
    const stats = this.renderer.draw(tiles, {
      camera: cam.uniforms(),
      lambda: view.lambda,
      lambdaExt,
      rWin: radialWindow(cam),
      winLo: win.lo,
      winSpan: win.span,
      fade: (level) => levelFade(level, view.lambda),
      fadeF: fullLevel === 0 ? 1 : levelFade(fullLevel, lambdaExt),
      reveal: this.reveal,
      dpr: cam.dpr,
      tipSpacing,
      homeId: this.meta.home?.id ?? -1,
      homeAngle: this.meta.home?.angle ?? 0,
      leaderGap,
      leaderLen: leaderLength(cam, this.meta.home?.angle ?? 0, leaderGap),
      homeLeader: this.homeLeader() ? 1 : 0,
      dims: this.dims(),
      highlight: this.dimsOn ? hl.draw : NO_HIGHLIGHT,
    });
    if (this.syncGpu) this.renderer.finish();
    const info = { view, ...stats, ms: performance.now() - t0 };
    const c = this.cache.stats();
    window.__stats = {
      tiles: stats.tiles,
      instances: stats.instances,
      drawCalls: stats.drawCalls,
      lambda: view.lambda,
      level: view.level,
      resident: c.resident,
      aborted: c.aborted,
    };
    this.onFrame(info);
    return info;
  }

  /**
   * Reduced motion: before a cut, redraw the old view (the canvas is only
   * readable in the task that drew it) and lay a fading
   * copy of it, labels included, over the canvases.
   */
  private snapshotForCut(canvas: HTMLCanvasElement): void {
    if (this.intro !== 'done' || !this.lastView) return;
    this.renderNow();
    const overlay = document.getElementById('overlay');
    crossfade(overlay instanceof HTMLCanvasElement ? [canvas, overlay] : [canvas]);
  }

  /** The obstacles' darkened plates in device px; none while the HUD is hidden for the intro. */
  private dims(): Dim[] {
    if (this.intro !== 'done' || !this.dimsOn) return [];
    const dpr = this.camera.dpr;
    const out: Dim[] = [];
    for (const o of this.obstacles.all()) {
      if (o.dim <= 0) continue;
      out.push({
        x0: o.box.x0 * dpr,
        y0: o.box.y0 * dpr,
        x1: o.box.x1 * dpr,
        y1: o.box.y1 * dpr,
        amount: o.dim,
        soft: (DIM_PAD_PX + DIM_SOFT_PX) * dpr,
      });
    }
    return out;
  }

  /** Advances the intro reveal; true while it still needs frames. */
  private stepIntro(now: number): boolean {
    if (this.intro === 'done') return false;
    if (this.intro === 'waiting') {
      // Start once the coarse tree is in, so the reveal is not of an empty canvas.
      const view = computeView(this.camera, this.meta.tileP, this.meta.maxLevel);
      if (this.cache.completeLevel() < view.fetchLevel) return false;
      this.intro = now;
    }
    const t = (now - this.intro) / INTRO_MS;
    if (t >= 1) {
      this.intro = 'done';
      this.reveal = Infinity;
      this.onIntroDone();
      return false;
    }
    this.reveal = REVEAL_END * this.introEase(t);
    return true;
  }

  private frame(now: number): void {
    this.dirty = false;
    this.input.step(now);
    const flying = this.flight.step(now);
    const orienting = this.orient.step(now);
    const spinning = this.spin.step(now);
    this.tour?.step(now);
    const revealing = this.stepIntro(now);
    const animating =
      this.input.animating() ||
      flying ||
      orienting ||
      spinning ||
      revealing ||
      this.highlightAnimating ||
      (this.animate?.(now) ?? false);
    if (this.glDirty || animating) {
      this.glDirty = false;
      this.renderNow();
    }
    const overlayBusy = this.overlay(now);
    if (animating) {
      this.requestRender();
      return;
    }
    if (overlayBusy) {
      this.requestOverlay();
      return;
    }
    if (this.cache.pending() === 0 && this.fontsReady && this.intro === 'done' && !this.busy()) {
      this.settle(0);
    }
  }

  /** True while the intro reveal has not finished. */
  introPlaying(): boolean {
    return this.intro !== 'done';
  }

  /** Declares idle after two frames with no new render request. */
  private settle(quietFrames: number): void {
    requestAnimationFrame(() => {
      if (this.dirty || this.scheduled) return;
      if (quietFrames + 1 < 2) {
        this.settle(quietFrames + 1);
        return;
      }
      window.__renderIdle = true;
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
    });
  }
}
