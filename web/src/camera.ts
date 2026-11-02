// Double-precision camera (PLAN §7.2): the view transform the renderer,
// labels and picking share.
//
// World space: the tree's unit disc, x = r·cos θ, y = r·sin θ (y up, so angles
// grow counter-clockwise on screen). The camera looks at the world point
// (angle, r) — kept in polar form because that is what the shaders need —
// with `scale` device pixels per world unit and the world turned by `rot`.
//
// Screen space: device pixels, origin top-left, y down (like pointer events).
// Everything here is plain JS doubles; only `uniforms()` narrows to float32.
//
// The user does not move this camera directly: the rig (rig.ts) holds the
// state the user controls, zoom and rotation, and writes the pose here.

import { TAU, TWO_32, fromRad } from './angle';

export interface Point {
  x: number;
  y: number;
}

/** Shader inputs for the camera-relative transform (see branches.vert). */
export interface CameraUniforms {
  /** Integer part of the camera angle in u32 units. */
  camA: number;
  /** Fractional u32 units left over (0 ≤ frac < 1); keeps sub-unit motion smooth. */
  camAFrac: number;
  /** camR split into float32 hi + lo so hi + lo ≈ camR to ~1e-14. */
  camRHi: number;
  camRLo: number;
  scale: number;
  /** cos/sin of the screen angle of the camera's local radial axis. */
  rotCos: number;
  rotSin: number;
  halfW: number;
  halfH: number;
}

/** Tip spacing at maximum zoom, in CSS px (PLAN §7.5). */
const MAX_TIP_SPACING_CSS = 48;

export class Camera {
  /** Polar angle of the screen centre, radians. */
  angle = 0;
  /** World radius of the screen centre. */
  r = 0;
  /** Device px per world unit. */
  scale = 1;
  /** Rotation of the world on screen, radians (counter-clockwise). */
  rot = 0;
  width = 1;
  height = 1;
  dpr = 1;
  /** Number of tips on the rim; sets the maximum zoom. */
  tipCount: number;

  constructor(tipCount: number) {
    this.tipCount = tipCount;
  }

  setViewport(width: number, height: number, dpr: number): void {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
  }

  /** The deepest zoom: MAX_TIP_SPACING_CSS between neighbouring tips. */
  maxScale(): number {
    return (MAX_TIP_SPACING_CSS * this.dpr * this.tipCount) / TAU;
  }

  /** Pixel distance between neighbouring tips on the rim. */
  tipSpacingPx(): number {
    return (this.scale * TAU) / this.tipCount;
  }

  centre(): Point {
    return { x: this.r * Math.cos(this.angle), y: this.r * Math.sin(this.angle) };
  }

  setCentre(x: number, y: number): void {
    const r = Math.hypot(x, y);
    let angle = r > 0 ? Math.atan2(y, x) : this.angle;
    if (angle < 0) angle += TAU;
    this.r = r;
    this.angle = angle;
  }

  worldToScreen(x: number, y: number): Point {
    const c = this.centre();
    const dx = x - c.x;
    const dy = y - c.y;
    const cos = Math.cos(this.rot);
    const sin = Math.sin(this.rot);
    return {
      x: this.width / 2 + (dx * cos - dy * sin) * this.scale,
      y: this.height / 2 - (dx * sin + dy * cos) * this.scale,
    };
  }

  screenToWorld(px: number, py: number): Point {
    const c = this.centre();
    const d = this.screenToOffset(px, py);
    return { x: c.x + d.x, y: c.y + d.y };
  }

  /** World polar coordinates (θ in [0, 2π)) under a screen point. */
  screenToPolar(px: number, py: number): { theta: number; r: number } {
    const w = this.screenToWorld(px, py);
    let theta = Math.atan2(w.y, w.x);
    if (theta < 0) theta += TAU;
    return { theta, r: Math.hypot(w.x, w.y) };
  }

  polarToScreen(theta: number, r: number): Point {
    return this.worldToScreen(r * Math.cos(theta), r * Math.sin(theta));
  }

  /** λ (PLAN §3.6): log2 of rim circumference over P · 0.5 px. */
  lambda(tileP: number): number {
    return Math.log2((TAU * this.scale) / (tileP * 0.5));
  }

  uniforms(): CameraUniforms {
    const a = fromRad(this.angle);
    const camA = Math.floor(a) % TWO_32;
    const camRHi = Math.fround(this.r);
    // The local frame's x axis points outward at the camera angle; on screen
    // it is turned by rot + angle.
    const screenAngle = this.rot + this.angle;
    return {
      camA,
      camAFrac: a - Math.floor(a),
      camRHi,
      camRLo: this.r - camRHi,
      scale: this.scale,
      rotCos: Math.cos(screenAngle),
      rotSin: Math.sin(screenAngle),
      halfW: this.width / 2,
      halfH: this.height / 2,
    };
  }

  /** Screen point → world offset from the camera centre (undoing scale and rotation). */
  private screenToOffset(px: number, py: number): Point {
    const sx = (px - this.width / 2) / this.scale;
    const sy = (this.height / 2 - py) / this.scale;
    const cos = Math.cos(this.rot);
    const sin = Math.sin(this.rot);
    return { x: sx * cos + sy * sin, y: -sx * sin + sy * cos };
  }
}
