// Screen rotation: the initial composition and auto-orient (PLAN §7.5).
//
// Initial rotation. Tips run counter-clockwise from angle 0 in tree order:
// Bacteria (0–18°), Protists (18–27°), Plants (27–93°), Fungi (93–135°),
// Animals (135–360°). 5.png has Animals upper-left and Plants upper-right,
// but our data puts Fungi between them, so both cannot hold. We follow PLAN:
// the largest Animals run's midpoint sits at screen angle 160°. Animals then
// fill the top-left half, Fungi the upper right, Plants the right, and
// Bacteria and Protists the bottom, as in 5.png.
//
// Auto-orient. Once tips are more than ~4 px apart, the view turns (400 ms,
// ease-in-out) so the outward direction at the screen centre points to the
// nearer of screen −x and +x: the rim runs vertically and tip labels read
// horizontally (1.png). It then follows pans along the rim, and when zooming
// back out it eases back to the rotation from before it engaged.
//
// Flights (flyto.ts) turn the view themselves: `rotationFor` predicts the
// rotation at the flight's end, the flight eases towards it while it
// travels, and `flightEnd` hands control back (also after a cancelled
// flight, which may stop anywhere). Between the two, `step` is not called.

import { RAD_PER_UNIT, TAU, wrapRad } from './angle';
import type { Camera } from './camera';
import { easeInOut } from './ease';
import { ANIMALS_SCREEN_DEG, ORIENT_MS, ORIENT_OFF_SPACING, ORIENT_ON_SPACING } from './style';
import type { GroupRun } from './types';

const ANIMALS = 0;

/** Rotation (radians) that puts the largest Animals run's midpoint at ANIMALS_SCREEN_DEG. */
export function compositionRotation(runs: readonly GroupRun[]): number {
  let best: GroupRun | undefined;
  for (const run of runs) {
    if (run.group !== ANIMALS) continue;
    if (!best || run.angleHi - run.angleLo > best.angleHi - best.angleLo) best = run;
  }
  if (!best) return 0;
  const mid = ((best.angleLo + best.angleHi) / 2) * RAD_PER_UNIT;
  return wrapRad((ANIMALS_SCREEN_DEG * Math.PI) / 180 - mid);
}

/**
 * The rotation nearest to `ref` that makes the outward direction at world
 * angle `theta` horizontal on screen (theta + rot ≡ 0 or π).
 */
export function horizontalRotation(theta: number, ref: number): number {
  const s = theta + ref;
  return ref - (s - Math.PI * Math.round(s / Math.PI));
}

interface Tween {
  from: number;
  /** Fixed goal, or null to keep aiming at the horizontal rotation. */
  to: number | null;
  t0: number;
}

export class AutoOrient {
  enabled = true;
  reducedMotion = false;
  /** The rotation to return to once zoomed back out. */
  baseRot: number;

  private readonly camera: Camera;
  private active = false;
  private tween: Tween | null = null;

  constructor(camera: Camera, baseRot: number) {
    this.camera = camera;
    this.baseRot = baseRot;
  }

  /**
   * Treats the current view as already oriented, keeping `baseRot` (used on
   * load: a deep link's rotation is not the one to return to).
   */
  prime(): void {
    if (this.enabled && this.spacing() > ORIENT_ON_SPACING) this.active = true;
  }

  toggle(now: number): void {
    this.enabled = !this.enabled;
    if (!this.enabled && this.active) this.release(now);
  }

  /**
   * The rotation the view should have at a flight's end, at world point
   * (x, y) and `scale`: horizontal where auto-orient will be engaged there
   * (same hysteresis as `step`), the base rotation where it will have let go.
   */
  rotationFor(to: { x: number; y: number; scale: number }): number {
    const cam = this.camera;
    const spacing = (to.scale * TAU) / cam.tipCount / cam.dpr;
    const engaged = this.enabled && (spacing > ORIENT_ON_SPACING || (this.active && spacing >= ORIENT_OFF_SPACING));
    if (engaged) return horizontalRotation(Math.atan2(to.y, to.x), cam.rot);
    // Not engaged at the end: the base rotation (also when easing back to
    // it after auto-orient was switched off), else stay as is.
    return this.enabled || this.active || this.tween ? this.baseRot : cam.rot;
  }

  /** A flight takes over the rotation: drop any turn in progress. */
  flightStart(): void {
    this.tween = null;
  }

  /**
   * A flight ended (landed, cancelled or cut): engage or let go for the
   * zoom it stopped at, and ease from wherever it left the rotation. The
   * base rotation is kept: a flight that engages started from it (or from
   * an engaged view, which already remembers it).
   */
  flightEnd(now: number): void {
    const cam = this.camera;
    const spacing = this.spacing();
    const wasActive = this.active;
    this.tween = null;
    if (this.enabled && (spacing > ORIENT_ON_SPACING || (wasActive && spacing >= ORIENT_OFF_SPACING))) {
      this.active = true;
      const goal = horizontalRotation(cam.angle, cam.rot);
      if (Math.abs(goal - cam.rot) > 1e-9) this.start(null, now);
    } else {
      this.active = false;
      const back = wrapRad(this.baseRot - cam.rot);
      if ((wasActive || this.enabled) && Math.abs(back) > 1e-9) this.start(cam.rot + back, now);
    }
  }

  /** Updates the camera's rotation for time `now`; true while animating. */
  step(now: number): boolean {
    const spacing = this.spacing();
    if (this.enabled && !this.active && spacing > ORIENT_ON_SPACING) {
      this.active = true;
      this.baseRot = this.camera.rot;
      this.start(null, now);
    } else if (this.active && spacing < ORIENT_OFF_SPACING) {
      this.release(now);
    }

    const cam = this.camera;
    const tw = this.tween;
    if (tw) {
      const t = (now - tw.t0) / ORIENT_MS;
      const goal = tw.to ?? horizontalRotation(cam.angle, tw.from);
      cam.rot = t >= 1 ? goal : tw.from + (goal - tw.from) * easeInOut(t);
      if (t >= 1) this.tween = null;
    } else if (this.active) {
      cam.rot = horizontalRotation(cam.angle, cam.rot);
    }
    return this.tween !== null;
  }

  private release(now: number): void {
    this.active = false;
    const from = this.camera.rot;
    this.start(from + wrapRad(this.baseRot - from), now);
  }

  private start(to: number | null, now: number): void {
    const from = this.camera.rot;
    if (this.reducedMotion) {
      this.camera.rot = to ?? horizontalRotation(this.camera.angle, from);
      this.tween = null;
      return;
    }
    this.tween = { from, to, t0: now };
  }

  /** Tip spacing in CSS px. */
  private spacing(): number {
    return this.camera.tipSpacingPx() / this.camera.dpr;
  }
}
