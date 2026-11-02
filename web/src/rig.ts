// The camera rig (DESIGN.md §4, PLAN §7.5): the state the user controls,
// zoom and rotation, and nothing else. There is no pan.
//
// Each viewport has a composition (layout.ts): an anchor point on screen,
// the focus angle φ and the wheel's radius at minimum zoom. The rig keeps
//   scale   device px per world unit, from the layout's radius (minimum zoom)
//           to 48 CSS px between tips (maximum zoom);
//   theta   the world angle of the rim point sitting on the anchor.
// The rim point at angle theta is always on the anchor, at screen angle φ
// from the wheel's centre, so
//   rot     = φ − theta                           the world's screen rotation
//   centre  = anchor − scale · (cos φ, −sin φ)     the wheel's centre on screen
// Zooming changes `scale` alone, which scales the picture about the anchor:
// whatever sits at the anchor stays put from minimum to maximum zoom.
// Rotating changes `theta` alone, which turns the wheel about its centre.
//
// φ eases from the layout's focus angle (30° desktop, 60° phone) to 0° as
// tips resolve (`turn`, orient.ts), so at deep zoom the rim runs vertically
// through the anchor and tip names read left to right (docs/reference/1.png).
// The anchor itself drifts left over the whole zoom, from the layout's
// anchor at minimum zoom to `deepX` where the turn completes, so at deep
// zoom the column of names clears the card:
//   k        = smoothstep(log2 0.25, log2 4, log2 tipSpacing)   (CSS px)
//   u        = (log2 scale − log2 min) / (log2 end − log2 min)  end: 4 px tips
//   φ        = φ0 · (1 − turn·k)
//   anchor.x = x0 + (deepX − x0) · smoothstep(0, 1, u)
// Spread over ~11 octaves, the slide is slow and even: at most 1.5× the
// mean rate, about 15 px per wheel notch on a 2000 px screen, easing in
// and out at the ends. The rim point at theta stays on the anchor
// throughout, so zoom is still anchored: what is under the anchor stays
// under it while the anchor glides left.
//
// The rig writes the camera (camera.ts) whenever it changes; the camera's
// centre is the world point under the screen centre, worked out from the
// anchor so it stays exact at any zoom.

import { TAU, wrapRad } from './angle';
import type { Camera, Point } from './camera';
import { smoothstep } from './ease';
import type { Layout } from './layout';
import { TURN_SPACING } from './style';

/** The user's view: rotation and zoom. */
export interface Pose {
  /** World angle at the anchor, radians. */
  theta: number;
  /** Device px per world unit. */
  scale: number;
}

/**
 * The focus angle for a tip spacing (CSS px): `focus` while the rim is a
 * curve, easing to 0 over TURN_SPACING (log scale) by the share `turn`.
 */
export function focusAngle(focus: number, spacing: number, turn: number): number {
  return focus * (1 - turn * deepShare(spacing));
}

/**
 * The anchor's drift, 0 at `min` to 1 at `end` (scales), smoothstep in log
 * scale: slow and even over the whole zoom.
 */
export function driftShare(scale: number, min: number, end: number): number {
  if (end <= min) return scale >= end ? 1 : 0;
  return smoothstep(0, 1, (Math.log2(scale) - Math.log2(min)) / (Math.log2(end) - Math.log2(min)));
}

/** How far into the deep-zoom turn a tip spacing (CSS px) is: 0 to 1 over TURN_SPACING (log scale). */
export function deepShare(spacing: number): number {
  const lo = Math.log2(TURN_SPACING[0]);
  const hi = Math.log2(TURN_SPACING[1]);
  return smoothstep(lo, hi, Math.log2(Math.max(spacing, 1e-12)));
}

export class Rig {
  readonly camera: Camera;
  scale = 1;
  theta = 0;
  /** Auto-orient's share, 0 (off) to 1 (on); orient.ts eases it when toggled. */
  turn = 1;
  private layout: Layout | null = null;

  constructor(camera: Camera) {
    this.camera = camera;
  }

  /** A new composition (startup, resize). Call after the camera's viewport is set. */
  setLayout(layout: Layout): void {
    this.layout = layout;
    this.scale = this.clampScale(this.scale);
    this.apply();
  }

  /** The current composition (CSS px). */
  composition(): Layout | null {
    return this.layout;
  }

  /** Minimum zoom: the layout's wheel. */
  minScale(): number {
    return (this.layout?.radius ?? 1) * this.camera.dpr;
  }

  maxScale(): number {
    return Math.max(this.camera.maxScale(), this.minScale() * 2);
  }

  clampScale(s: number): number {
    return Math.min(this.maxScale(), Math.max(this.minScale(), s));
  }

  /** The anchor at the current zoom, device px (it drifts left as tips resolve). */
  anchor(): Point {
    return this.anchorAt(this.scale);
  }

  /** The anchor at `scale`, device px. */
  anchorAt(scale: number): Point {
    const cam = this.camera;
    const dpr = cam.dpr;
    const l = this.layout;
    if (!l) return { x: cam.width / 2, y: cam.height / 2 };
    // The drift ends where the turn does: TURN_SPACING[1] px between tips.
    const end = (TURN_SPACING[1] * dpr * cam.tipCount) / TAU;
    const x = l.anchor.x + (l.deepX - l.anchor.x) * driftShare(scale, this.minScale(), end);
    return { x: x * dpr, y: l.anchor.y * dpr };
  }

  /** φ at `scale` (radians, counter-clockwise from screen +x). */
  focusAt(scale: number): number {
    return focusAngle(this.layout?.focus ?? 0, this.spacingAt(scale), this.turn);
  }

  /** CSS px between tips at `scale`. */
  private spacingAt(scale: number): number {
    const cam = this.camera;
    return (scale * TAU) / cam.tipCount / cam.dpr;
  }

  pose(): Pose {
    return { theta: this.theta, scale: this.scale };
  }

  /** Jumps to a pose (zoom clamped). */
  set(p: Pose): void {
    this.scale = this.clampScale(p.scale);
    this.theta = wrapAngle(p.theta);
    this.apply();
  }

  /** Multiplies the zoom by `factor`, about the anchor. */
  zoomBy(factor: number): void {
    this.scale = this.clampScale(this.scale * factor);
    this.apply();
  }

  /** Turns the wheel by `delta` radians (counter-clockwise on screen). */
  rotateBy(delta: number): void {
    this.theta = wrapAngle(this.theta - delta);
    this.apply();
  }

  /** The wheel's centre on screen, device px (far off screen at deep zoom). */
  centre(): Point {
    const a = this.anchor();
    const phi = this.focusAt(this.scale);
    return { x: a.x - this.scale * Math.cos(phi), y: a.y + this.scale * Math.sin(phi) };
  }

  /**
   * The angle (radians, counter-clockwise on screen) swept about the wheel's
   * centre from screen point p0 to p1: dragging turns the wheel by this.
   */
  sweep(p0: Point, p1: Point): number {
    const o = this.centre();
    // y up, so counter-clockwise is positive.
    const ax = p0.x - o.x;
    const ay = o.y - p0.y;
    const bx = p1.x - o.x;
    const by = o.y - p1.y;
    return Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
  }

  /** Writes the pose into the camera. */
  apply(): void {
    const cam = this.camera;
    const s = this.scale;
    const rot = this.focusAt(s) - this.theta;
    const a = this.anchor();
    // The screen centre's offset from the anchor, in world units (y up),
    // turned back by the rotation, added to the world point at the anchor.
    const dx = (cam.width / 2 - a.x) / s;
    const dy = (a.y - cam.height / 2) / s;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    cam.scale = s;
    cam.rot = rot;
    cam.setCentre(Math.cos(this.theta) + dx * cos + dy * sin, Math.sin(this.theta) - dx * sin + dy * cos);
  }
}

/** An angle in [0, 2π). */
export function wrapAngle(a: number): number {
  const w = wrapRad(a);
  return w < 0 ? w + TAU : w;
}
