// Camera flights (PLAN §7.9, DESIGN.md §6). The view is a rotation and a
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

import { wrapRad } from './angle';
import { smoothstep } from './ease';
import type { Pose, Rig } from './rig';

/** A path between two poses: its duration, and the pose at t ∈ [0, 1]. */
export interface FlightPath {
  ms: number;
  at(t: number): Pose;
}

/** Zoom/pan trade-off: higher zooms out further on long pans (van Wijk & Nuij suggest √2). */
export const RHO = 1.4;
/** Duration per unit of path length S, and its bounds (PLAN §7.9). */
export const MS_PER_S = 600;
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

/** van Wijk–Nuij between two poses; `span` is the screen's shorter side, device px. */
export function interpolate(from: Pose, to: Pose, span: number): FlightPath {
  span = Math.max(1, span);
  const w0 = span / from.scale;
  const w1 = span / to.scale;
  const end = nearAngle(from.theta, to.theta);
  const du = end - from.theta;
  const u1 = Math.abs(du);
  const rho2 = RHO * RHO;
  const exact = (t: number, p: Pose): Pose => (t <= 0 ? from : t >= 1 ? { ...to, theta: end } : p);

  // Same angle (to within far less than a pixel): a pure zoom, exponential
  // in s, with the angle moved along in step in case it differs at all.
  if (u1 < 1e-6 * Math.min(w0, w1)) {
    const k = Math.log(w1 / w0);
    const S = Math.abs(k) / RHO;
    return {
      ms: flightMs(S),
      at(t) {
        const e = ease(t);
        const w = w0 * Math.exp(k * e);
        return exact(t, { theta: from.theta + du * e, scale: span / w });
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
    ms: flightMs(S),
    at(t) {
      const s = S * ease(t);
      const u = (w0 / rho2) * (coshR0 * Math.tanh(RHO * s + r0) - sinhR0);
      const w = (w0 * coshR0) / Math.cosh(RHO * s + r0);
      return exact(t, { theta: from.theta + du * (u / u1), scale: span / w });
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
  private path: FlightPath | null = null;
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
    const path = opts.turnOnly ? turnPath(rig.pose(), target, span) : interpolate(rig.pose(), target, span);
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

  /** Moves the rig to time `now`; true while flying. */
  step(now: number): boolean {
    const path = this.path;
    if (!path) return false;
    const t = Math.min(1, Math.max(0, (now - this.t0) / path.ms));
    this.rig.set(path.at(t));
    if (t >= 1) {
      this.path = null;
      this.onEnd(now);
    }
    return this.path !== null;
  }
}
