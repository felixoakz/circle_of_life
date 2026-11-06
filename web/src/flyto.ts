// Camera flights (ARCHITECTURE §7.9, DESIGN.md §6). The view is a rotation and a
// zoom (rig.ts), so a flight moves `theta`, the world angle at the anchor,
// and `scale`.
//
// Fly-to (search, lineage, keys): van Wijk & Nuij's "smooth and efficient
// zooming and panning" (2003), with ρ = 1.4, in one dimension: the "pan" is
// the arc along the rim from the old angle to the new (the short way round),
// and the view's width w is the screen's shorter side over the scale. For a
// far target it zooms out until both ends fit, glides, then dives in; for a
// near one it is almost a straight zoom. The path is parameterised by its
// length S (in "screen widths" of perceived motion), so the speed feels
// constant; a smoothstep on top eases the start and the stop. Duration is
// clamp(S · 600 ms, 600, 2000). Zoom is clamped to the rig's range, so a long
// way round at minimum zoom simply turns.
//
// Turn (a click on the canvas): the zoom stays, and only the angle eases to
// the target, 250–900 ms by how far the anchor travels on screen.
//
// From free view (freeview.ts) every flight is a way back to the locked
// view: the same van Wijk–Nuij path, in two dimensions, from the free
// camera to the camera the locked target puts on screen (Rig.cameraFor),
// with the screen rotation eased the short way round alongside. It lands
// through Rig.set, so the rig is locked again exactly where the path ends.

import { wrapRad } from './angle';
import { smoothstep } from './ease';
import type { FreePose, Pose, Rig } from './rig';

/** A path between two poses: its duration, and the pose at t ∈ [0, 1]. */
export interface FlightPath {
  ms: number;
  at(t: number): Pose;
}

/** Zoom/pan trade-off: higher zooms out further on long pans (van Wijk & Nuij suggest √2). */
const RHO = 1.4;
/** Duration per unit of path length S, and its bounds (ARCHITECTURE §7.9). */
const MS_PER_S = 600;
export const MIN_MS = 600;
export const MAX_MS = 2000;
/** Turn-only bounds. */
export const TURN_MIN_MS = 250;
export const TURN_MAX_MS = 900;

export function flightMs(S: number): number {
  return Math.min(MAX_MS, Math.max(MIN_MS, S * MS_PER_S));
}

/** The eased path parameter: smooth start and stop, monotone. */
function ease(t: number): number {
  return smoothstep(0, 1, t);
}

/** The target angle the short way round from `from`. */
function nearAngle(from: number, to: number): number {
  return from + wrapRad(to - from);
}

/**
 * The van Wijk–Nuij path between view widths w0 and w1 a pan of u1 apart
 * (any units, the same for all three): its length S, and at s ∈ [0, S]
 * how far along the pan it is (0 to u1) and the view width there.
 */
function zoomPan(w0: number, w1: number, u1: number): { S: number; at(s: number): { u: number; w: number } } {
  const rho2 = RHO * RHO;
  // No pan to speak of (far less than a pixel): a pure zoom, exponential
  // in s, with the pan moved along in step in case it differs at all.
  if (u1 < 1e-6 * Math.min(w0, w1)) {
    const k = Math.log(w1 / w0);
    const S = Math.abs(k) / RHO;
    return {
      S,
      at(s) {
        const e = S > 0 ? s / S : 1;
        return { u: u1 * e, w: w0 * Math.exp(k * e) };
      },
    };
  }
  // b_i and r_i of the paper. r_i = ln(−b_i + √(b_i² + 1)) is −asinh(b_i),
  // which stays accurate when b_i is large (deep zooms make w1 tiny).
  const b0 = (w1 * w1 - w0 * w0 + rho2 * rho2 * u1 * u1) / (2 * w0 * rho2 * u1);
  const b1 = (w1 * w1 - w0 * w0 - rho2 * rho2 * u1 * u1) / (2 * w1 * rho2 * u1);
  const r0 = -Math.asinh(b0);
  const r1 = -Math.asinh(b1);
  const S = (r1 - r0) / RHO;
  const coshR0 = Math.cosh(r0);
  const sinhR0 = Math.sinh(r0);
  return {
    S,
    at(s) {
      const u = (w0 / rho2) * (coshR0 * Math.tanh(RHO * s + r0) - sinhR0);
      const w = (w0 * coshR0) / Math.cosh(RHO * s + r0);
      return { u, w };
    },
  };
}

/** van Wijk–Nuij between two poses; `span` is the screen's shorter side, device px. */
export function interpolate(from: Pose, to: Pose, span: number): FlightPath {
  span = Math.max(1, span);
  const end = nearAngle(from.theta, to.theta);
  const du = end - from.theta;
  const u1 = Math.abs(du);
  const path = zoomPan(span / from.scale, span / to.scale, u1);
  return {
    ms: flightMs(path.S),
    at(t) {
      if (t <= 0) return from;
      if (t >= 1) return { ...to, theta: end };
      const { u, w } = path.at(path.S * ease(t));
      return { theta: from.theta + (u1 > 0 ? du * (u / u1) : 0), scale: span / w };
    },
  };
}

/**
 * van Wijk–Nuij between two free poses (the camera's centre in world
 * units), the screen rotation eased the short way round; `span` as for
 * `interpolate`.
 */
export function freePath(from: FreePose, to: FreePose, span: number): { ms: number; at(t: number): FreePose } {
  span = Math.max(1, span);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const u1 = Math.hypot(dx, dy);
  const dRot = wrapRad(to.rot - from.rot);
  const path = zoomPan(span / from.scale, span / to.scale, u1);
  // A pure turn still takes a moment: the rotation's travel at the screen's edge, in widths.
  const S = Math.max(path.S, Math.abs(dRot) / 2);
  return {
    ms: flightMs(S),
    at(t) {
      if (t <= 0) return from;
      if (t >= 1) return { ...to, rot: from.rot + dRot };
      const e = ease(t);
      const { u, w } = path.at(path.S * e);
      const k = u1 > 0 ? u / u1 : e;
      return { x: from.x + dx * k, y: from.y + dy * k, scale: span / w, rot: from.rot + dRot * e };
    },
  };
}

/** Turns from `from` to `to`'s angle at `from`'s zoom; `span` as for `interpolate`. */
export function turnPath(from: Pose, to: Pose, span: number): FlightPath {
  const end = nearAngle(from.theta, to.theta);
  const du = end - from.theta;
  // How far the anchor's content travels, in screen widths.
  const travel = (Math.abs(du) * from.scale) / Math.max(1, span);
  const ms = Math.min(TURN_MAX_MS, Math.max(TURN_MIN_MS, travel * MS_PER_S));
  return {
    ms,
    at: (t) => (t >= 1 ? { theta: end, scale: from.scale } : { theta: from.theta + du * ease(t), scale: from.scale }),
  };
}

export interface FlyOptions {
  /** Keep the zoom and only turn (a click on the canvas). */
  turnOnly?: boolean;
  /** Take at least this long (the idle tour's calm steps), ms. */
  minMs?: number;
  now?: number;
}

/** Drives one flight at a time; any user input cancels it. */
export class Flight {
  reducedMotion = false;
  /** A flight landed, was cancelled, or was cut. */
  onEnd: (now: number) => void = () => {};
  /**
   * Reduced motion: called just before a cut with the camera still at the
   * old view, so the scene can snapshot it and crossfade (DESIGN.md §6).
   */
  onCut: () => void = () => {};

  private readonly rig: Rig;
  /** The flight under way: its length, and how to put the rig at t ∈ [0, 1]. */
  private path: { ms: number; put(t: number): void } | null = null;
  private t0 = 0;

  constructor(rig: Rig) {
    this.rig = rig;
  }

  fly(to: Pose, opts: FlyOptions = {}): void {
    const now = opts.now ?? performance.now();
    const rig = this.rig;
    const target = { theta: to.theta, scale: opts.turnOnly ? rig.scale : rig.clampScale(to.scale) };
    if (this.reducedMotion) {
      // Reduced motion: a cut plus a short crossfade (DESIGN.md §6).
      this.path = null;
      this.onCut();
      rig.set(target);
      this.onEnd(now);
      return;
    }
    const cam = rig.camera;
    const span = Math.min(cam.width, cam.height);
    let path: { ms: number; put(t: number): void };
    if (rig.free) {
      // Back from free view: the camera flies to the locked target's, then the rig locks.
      const p = freePath(rig.free, rig.cameraFor(target), span);
      path = { ms: p.ms, put: (t) => (t >= 1 ? rig.set(target) : rig.setFree(p.at(t))) };
    } else {
      const p = opts.turnOnly ? turnPath(rig.pose(), target, span) : interpolate(rig.pose(), target, span);
      path = { ms: p.ms, put: (t) => rig.set(p.at(t)) };
    }
    this.path = opts.minMs && path.ms < opts.minMs ? { ...path, ms: opts.minMs } : path;
    this.t0 = now;
  }

  cancel(now = performance.now()): void {
    if (!this.path) return;
    this.path = null;
    this.onEnd(now);
  }

  active(): boolean {
    return this.path !== null;
  }

  /** The current flight's length, ms (0 when not flying). */
  durationMs(): number {
    return this.path?.ms ?? 0;
  }

  /** How far through the current flight `now` is, 0 to 1 (1 when not flying). */
  progress(now: number): number {
    const path = this.path;
    if (!path) return 1;
    return Math.min(1, Math.max(0, (now - this.t0) / path.ms));
  }

  /** Moves the rig to time `now`; true while flying. */
  step(now: number): boolean {
    const path = this.path;
    if (!path) return false;
    const t = Math.min(1, Math.max(0, (now - this.t0) / path.ms));
    path.put(t);
    if (t >= 1) {
      this.path = null;
      this.onEnd(now);
    }
    return this.path !== null;
  }
}
