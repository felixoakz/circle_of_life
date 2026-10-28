// Double-precision camera (PLAN §7.2).
//
// World space: the tree's unit disc, x = r·cos θ, y = r·sin θ (y up, so angles
// grow counter-clockwise on screen). The camera looks at the world point
// (angle, r) — kept in polar form because that is what the shaders need —
// with `scale` device pixels per world unit and the world turned by `rot`.
//
// Screen space: device pixels, origin top-left, y down (like pointer events).
// Everything here is plain JS doubles; only `uniforms()` narrows to float32.

import { TAU, TWO_32, fromRad } from './angle';
import { GUTTER_PX, HUD_BAND_PX } from './style';

export interface Point {
  x: number;
  y: number;
}

/** Shader inputs for the camera-relative transform (see branches.vert). */
export interface CameraUniforms {
  /** Integer part of the camera angle in u32 units. */
  camA: number;
  /** Fractional u32 units left over (0 ≤ frac < 1); keeps sub-unit panning smooth. */
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
/** At full fit the rim sits this fraction inside the room for the wheel (see `fitScale`). */
const FIT_MARGIN = 0.86;

/** The view centre may not wander further than this from the origin. */
const MAX_CENTRE_R = 1.15;

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
    this.scale = this.clampScale(this.scale);
  }

  /**
   * Scale at which the whole wheel fits the room for it: the screen less the
   * side gutters and the bottom HUD band, so group labels clear the HUD and,
   * on a phone, the screen edges.
   */
  fitScale(): number {
    const w = this.width - 2 * GUTTER_PX * this.dpr;
    const h = this.height - HUD_BAND_PX * this.dpr;
    return (Math.max(1, Math.min(w, h)) / 2) * FIT_MARGIN;
  }

  /**
   * The world point to put at the screen centre so that, at rotation `rot`
   * and the fit scale, the wheel is centred in the room above the HUD band.
   */
  fitCentre(rot: number): Point {
    // The origin should sit `up` world units above the screen centre, which
    // on screen is the direction (0, 1) turned back by the rotation.
    const up = (HUD_BAND_PX * this.dpr) / 2 / this.fitScale();
    return { x: -up * Math.sin(rot), y: -up * Math.cos(rot) };
  }

  minScale(): number {
    return this.fitScale() * 0.8;
  }

  maxScale(): number {
    const tips = (MAX_TIP_SPACING_CSS * this.dpr * this.tipCount) / TAU;
    return Math.max(tips, this.fitScale() * 8);
  }

  clampScale(s: number): number {
    return Math.min(this.maxScale(), Math.max(this.minScale(), s));
  }

  /** Whole wheel, centred above the HUD band at the current rotation. */
  fit(): void {
    this.scale = this.fitScale();
    const c = this.fitCentre(this.rot);
    this.setCentre(c.x, c.y);
  }

  /** Pixel distance between neighbouring tips on the rim. */
  tipSpacingPx(): number {
    return (this.scale * TAU) / this.tipCount;
  }

  centre(): Point {
    return { x: this.r * Math.cos(this.angle), y: this.r * Math.sin(this.angle) };
  }

  setCentre(x: number, y: number): void {
    let r = Math.hypot(x, y);
    let angle = r > 0 ? Math.atan2(y, x) : this.angle;
    if (r > MAX_CENTRE_R) r = MAX_CENTRE_R;
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

  /** Multiplies the scale by `factor`, keeping the world point under (px, py) fixed. */
  zoomAt(px: number, py: number, factor: number): void {
    const anchor = this.screenToWorld(px, py);
    this.scale = this.clampScale(this.scale * factor);
    const d = this.screenToOffset(px, py);
    this.setCentre(anchor.x - d.x, anchor.y - d.y);
  }

  /** Moves the picture by (dx, dy) screen pixels, like dragging it. */
  panBy(dx: number, dy: number): void {
    const c = this.centre();
    const d = this.screenToOffset(this.width / 2 + dx, this.height / 2 + dy);
    this.setCentre(c.x - d.x, c.y - d.y);
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
