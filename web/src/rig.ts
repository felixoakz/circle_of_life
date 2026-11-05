// The camera rig (DESIGN.md §4, PLAN §7.5): the state the user controls.
// In the locked view (the default) that is zoom and rotation, and nothing
// else: there is no pan. Free view (below) adds the pan.
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
//
// Free view (DESIGN.md §4.1, freeview.ts) drops the composition: the pose
// is the camera's own, a FreePose (the world point at the screen centre,
// the zoom and the screen rotation), and nothing drifts or turns by
// itself. Zoom and rotation go about any screen point p (the cursor):
//   w  = the world point under p              (stays under p)
//   c' = w − R(−rot') · (p − half) / scale'    the new centre
// all in doubles, from the world point itself, so a deep zoom anywhere on
// the wheel is as exact as on the rim (the camera keeps the centre in
// polar form and the shaders work relative to it). `set` (a locked pose)
// leaves free view; flights back land through it.

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

/** Free view's pose: the world point at the screen centre, the zoom and the screen rotation. */
export interface FreePose {
  x: number;
  y: number;
  /** Device px per world unit. */
  scale: number;
  /** The world's rotation on screen, radians (counter-clockwise). */
  rot: number;
}

/** Free view keeps the screen centre within this share of the screen's longer side outside the rim. */
const FREE_REACH = 0.5;

/** A screen offset (device px from the screen centre, y down) as a world offset under rotation `rot` and `scale`. */
function screenOffset(dx: number, dy: number, scale: number, rot: number): Point {
  const sx = dx / scale;
  const sy = -dy / scale;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  return { x: sx * cos + sy * sin, y: -sx * sin + sy * cos };
}

/**
 * Zooms a free pose to `scale` and turns it by `delta` radians
 * (counter-clockwise), about the screen point p (device px) on a w × h
 * screen: the world point under p stays under it.
 */
export function freeAbout(f: FreePose, scale: number, delta: number, p: Point, w: number, h: number): FreePose {
  const dx = p.x - w / 2;
  const dy = p.y - h / 2;
  const before = screenOffset(dx, dy, f.scale, f.rot);
  const rot = f.rot + delta;
  const after = screenOffset(dx, dy, scale, rot);
  // w = c + before = c' + after, written so c' stays exact at deep zoom.
  return { x: f.x + (before.x - after.x), y: f.y + (before.y - after.y), scale, rot: wrapRad(rot) };
}

/** Moves a free pose so the picture follows a drag of (dx, dy) device px. */
export function freePan(f: FreePose, dx: number, dy: number): FreePose {
  const d = screenOffset(dx, dy, f.scale, f.rot);
  return { ...f, x: f.x - d.x, y: f.y - d.y };
}

/** Keeps the screen centre within `reach` device px of the rim (the wheel never leaves the screen). */
export function clampFree(f: FreePose, reach: number): FreePose {
  const r = Math.hypot(f.x, f.y);
  const max = 1 + reach / f.scale;
  if (r <= max) return f;
  return { ...f, x: (f.x / r) * max, y: (f.y / r) * max };
}

export class Rig {
  readonly camera: Camera;
  scale = 1;
  theta = 0;
  /** Auto-orient's share, 0 (off) to 1 (on); orient.ts eases it when toggled. */
  turn = 1;
  /** Free view's pose, or null in the locked view. */
  free: FreePose | null = null;
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

  /** True in free view. */
  isFree(): boolean {
    return this.free !== null;
  }

  /** Jumps to a locked pose (zoom clamped), leaving free view. */
  set(p: Pose): void {
    this.free = null;
    this.scale = this.clampScale(p.scale);
    this.theta = wrapAngle(p.theta);
    this.apply();
  }

  /** Enters free view where the camera is now: nothing moves. */
  enterFree(): void {
    if (this.free) return;
    this.free = this.cameraFor(this.pose());
    this.apply();
  }

  /** Jumps to a free pose (zoom clamped), entering free view. */
  setFree(f: FreePose): void {
    const scale = this.clampScale(f.scale);
    this.free = { ...f, scale, rot: wrapRad(f.rot) };
    this.scale = scale;
    this.apply();
  }

  /** The screen centre, device px. */
  screenCentre(): Point {
    return { x: this.camera.width / 2, y: this.camera.height / 2 };
  }

  /** Multiplies the zoom by `factor`: about the anchor, or in free view about the screen centre. */
  zoomBy(factor: number): void {
    this.setScale(this.scale * factor);
  }

  /** Multiplies the zoom by `factor` about screen point p (device px) in free view; about the anchor otherwise. */
  zoomAt(factor: number, p: Point): void {
    this.setScale(this.scale * factor, p);
  }

  /** Zooms to `scale` (clamped): about the anchor, or in free view about p (default the screen centre). */
  setScale(scale: number, p: Point = this.screenCentre()): void {
    const s = this.clampScale(scale);
    const f = this.free;
    if (f) {
      this.freeMove(freeAbout(f, s, 0, p, this.camera.width, this.camera.height));
      return;
    }
    this.scale = s;
    this.apply();
  }

  /** Turns the wheel by `delta` radians (counter-clockwise on screen); in free view about the screen centre. */
  rotateBy(delta: number): void {
    if (this.free) {
      this.rotateAt(delta, this.screenCentre());
      return;
    }
    this.theta = wrapAngle(this.theta - delta);
    this.apply();
  }

  /** Free view: turns the picture by `delta` radians (counter-clockwise) about screen point p. */
  rotateAt(delta: number, p: Point): void {
    const f = this.free;
    if (!f) return;
    this.freeMove(freeAbout(f, f.scale, delta, p, this.camera.width, this.camera.height));
  }

  /** Free view: moves the picture by (dx, dy) device px, as a drag does. */
  panBy(dx: number, dy: number): void {
    const f = this.free;
    if (!f) return;
    this.freeMove(freePan(f, dx, dy));
  }

  /** A user's free move: the wheel stays within reach of the screen. */
  private freeMove(f: FreePose): void {
    const reach = FREE_REACH * Math.max(this.camera.width, this.camera.height);
    this.setFree(clampFree(f, reach));
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

  /** The camera a locked pose puts on screen (its zoom clamped), as a free pose. */
  cameraFor(p: Pose): FreePose {
    const cam = this.camera;
    const s = this.clampScale(p.scale);
    const rot = this.focusAt(s) - p.theta;
    const a = this.anchorAt(s);
    // The screen centre's offset from the anchor, in world units (y up),
    // turned back by the rotation, added to the world point at the anchor.
    const dx = (cam.width / 2 - a.x) / s;
    const dy = (a.y - cam.height / 2) / s;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    return { x: Math.cos(p.theta) + dx * cos + dy * sin, y: Math.sin(p.theta) - dx * sin + dy * cos, scale: s, rot };
  }

  /** Writes the pose into the camera. */
  apply(): void {
    const f = this.free ?? this.cameraFor(this.pose());
    const cam = this.camera;
    cam.scale = f.scale;
    cam.rot = f.rot;
    cam.setCentre(f.x, f.y);
  }
}

/** An angle in [0, 2π). */
export function wrapAngle(a: number): number {
  const w = wrapRad(a);
  return w < 0 ? w + TAU : w;
}
