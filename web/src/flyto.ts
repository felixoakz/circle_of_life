// Camera flights (PLAN §7.9, DESIGN.md §6): van Wijk & Nuij's "smooth and
// efficient zooming and panning" (2003), with ρ = 1.4.
//
// The camera here is a world point at the screen centre, a log scale and a
// rotation. The flight moves the first two along the optimal path in world
// space (doubles throughout): for a far target it zooms out until both ends
// fit, glides, then dives in; for a near one it is almost a straight zoom.
// The path is parameterised by its length S (in "screen widths" of
// perceived motion), so the speed feels constant; a smoothstep on top eases
// the start and the stop. Duration is clamp(S · 600 ms, 600, 2000).
//
// Rotation is eased separately (Flight): auto-orient (orient.ts) predicts
// the rotation the view will have on arrival, the flight turns there while
// it travels, and auto-orient sits out until the flight ends or is
// cancelled, so the two never fight over the rotation mid-air.

import { TAU, wrapRad } from './angle';
import type { Camera } from './camera';
import { smoothstep } from './ease';

export interface Pose {
  /** World point at the screen centre. */
  x: number;
  y: number;
  /** Device px per world unit. */
  scale: number;
}

/** A path between two poses: its duration, and the pose at t ∈ [0, 1]. */
export interface FlightPath {
  ms: number;
  at(t: number): Pose;
}

export type Interpolator = (from: Pose, to: Pose, viewport: { width: number; height: number }) => FlightPath;

/** Zoom/pan trade-off: higher zooms out further on long pans (van Wijk & Nuij suggest √2). */
export const RHO = 1.4;
/** Duration per unit of path length S, and its bounds (PLAN §7.9). */
export const MS_PER_S = 600;
export const MIN_MS = 600;
export const MAX_MS = 2000;

export function flightMs(S: number): number {
  return Math.min(MAX_MS, Math.max(MIN_MS, S * MS_PER_S));
}

/** The eased path parameter: smooth start and stop, monotone. */
function ease(t: number): number {
  return smoothstep(0, 1, t);
}

/**
 * van Wijk–Nuij between two poses. The view's width w (world units) is the
 * viewport's shorter side over the scale; the centre moves along the
 * straight line between the two centres, by u(s) out of u1.
 */
export const interpolate: Interpolator = (from, to, viewport) => {
  const span = Math.max(1, Math.min(viewport.width, viewport.height));
  const w0 = span / from.scale;
  const w1 = span / to.scale;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const u1 = Math.hypot(dx, dy);
  const rho2 = RHO * RHO;
  const exact = (t: number, p: Pose): Pose => (t <= 0 ? from : t >= 1 ? to : p);

  // Same centre (to within far less than a pixel): a pure zoom, exponential
  // in s, with the centre moved along in step in case it differs at all.
  if (u1 < 1e-6 * Math.min(w0, w1)) {
    const k = Math.log(w1 / w0);
    const S = Math.abs(k) / RHO;
    return {
      ms: flightMs(S),
      at(t) {
        const e = ease(t);
        const w = w0 * Math.exp(k * e);
        return exact(t, { x: from.x + dx * e, y: from.y + dy * e, scale: span / w });
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
      const f = u / u1;
      return exact(t, { x: from.x + dx * f, y: from.y + dy * f, scale: span / w });
    },
  };
};

export function poseOf(cam: Camera): Pose {
  const c = cam.centre();
  return { x: c.x, y: c.y, scale: cam.scale };
}

export function applyPose(cam: Camera, p: Pose): void {
  cam.scale = cam.clampScale(p.scale);
  cam.setCentre(p.x, p.y);
}

/** The whole wheel, centred above the HUD band once the view has turned to `rot`. */
export function wheelPose(cam: Camera, rot = cam.rot): Pose {
  const c = cam.fitCentre(rot);
  return { x: c.x, y: c.y, scale: cam.fitScale() };
}

/**
 * A pose framing a clade: the arc [lo, hi] (radians) at the rim, plus the
 * wedge inward from it down to radius `rIn`, but not much deeper than the arc
 * is wide, so a small clade is framed at the rim where its tips are. Clades
 * wider than a half turn get the whole wheel.
 */
export function cladePose(cam: Camera, lo: number, hi: number, rIn: number, wheelRot = cam.rot): Pose {
  const span = hi - lo;
  if (span > Math.PI) return wheelPose(cam, wheelRot);
  const inner = Math.max(rIn, 1 - 1.5 * Math.max(span, 1e-9));
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (theta: number, r: number): void => {
    const x = r * Math.cos(theta);
    const y = r * Math.sin(theta);
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  const steps = 16;
  for (let i = 0; i <= steps; i++) {
    const th = lo + (span * i) / steps;
    add(th, 1);
    add(th, inner);
  }
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  // The screen may turn (auto-orient), so fit the box's circumscribed
  // circle rather than the box itself.
  const radius = Math.max(Math.hypot(x1 - x0, y1 - y0) / 2, 1e-12);
  const scale = (Math.min(cam.width, cam.height) / 2) * (0.8 / radius);
  return { x: cx, y: cy, scale: cam.clampScale(Math.min(scale, cam.maxScale())) };
}

/** Converts a u32 [arcLo, arcHi] pair to radians, keeping lo ≤ hi. */
export function arcRadians(arcLo: number, arcHi: number): [number, number] {
  const k = TAU / 2 ** 32;
  return [arcLo * k, arcHi * k];
}

export interface FlyOptions {
  /** The rotation to arrive with; by default `Flight.endRotation(to)`. */
  rot?: number;
  now?: number;
}

/**
 * Drives one flight at a time; any user input cancels it. It owns the
 * camera's rotation while flying (see the file comment).
 */
export class Flight {
  reducedMotion = false;
  interpolate: Interpolator = interpolate;
  /** The rotation a flight to `to` arrives with (the scene asks auto-orient); by default it keeps the current one. */
  endRotation: (to: Pose) => number = () => this.camera.rot;
  /** A flight starts (auto-orient stands aside). */
  onStart: () => void = () => {};
  /** A flight landed, was cancelled, or was cut (auto-orient takes over again). */
  onEnd: (now: number) => void = () => {};
  /**
   * Reduced motion: called just before a cut with the camera still at the
   * old view, so the scene can snapshot it and crossfade (DESIGN.md §6).
   */
  onCut: () => void = () => {};

  private readonly camera: Camera;
  private path: FlightPath | null = null;
  private t0 = 0;
  private rot0 = 0;
  private rot1 = 0;

  constructor(camera: Camera) {
    this.camera = camera;
  }

  fly(to: Pose, opts: FlyOptions = {}): void {
    const now = opts.now ?? performance.now();
    const cam = this.camera;
    const target = { ...to, scale: cam.clampScale(to.scale) };
    const rot = opts.rot ?? this.endRotation(target);
    // Turn the short way round.
    const rot1 = cam.rot + wrapRad(rot - cam.rot);
    if (this.reducedMotion) {
      // Reduced motion: a cut plus a short crossfade (DESIGN.md §6).
      this.path = null;
      this.onCut();
      applyPose(cam, target);
      cam.rot = rot1;
      this.onEnd(now);
      return;
    }
    this.path = this.interpolate(poseOf(cam), target, cam);
    this.t0 = now;
    this.rot0 = cam.rot;
    this.rot1 = rot1;
    this.onStart();
  }

  cancel(now = performance.now()): void {
    if (!this.path) return;
    this.path = null;
    this.onEnd(now);
  }

  active(): boolean {
    return this.path !== null;
  }

  /** Moves the camera to time `now`; true while flying. */
  step(now: number): boolean {
    const path = this.path;
    if (!path) return false;
    const t = Math.min(1, Math.max(0, (now - this.t0) / path.ms));
    applyPose(this.camera, path.at(t));
    this.camera.rot = this.rot0 + (this.rot1 - this.rot0) * smoothstep(0, 1, t);
    if (t >= 1) {
      this.path = null;
      this.onEnd(now);
    }
    return this.path !== null;
  }
}
