// Pointer, wheel, pinch and keyboard → camera (PLAN §7.5).
// All positions are device pixels relative to the canvas, like the camera.

import type { Camera } from './camera';

/** Wheel zoom: scale ×= exp(−dy · WHEEL_RATE), dy in px. */
const WHEEL_RATE = 0.0015;
/** Inertia time constant: velocity decays as e^(−t/τ); ~300 ms to settle. */
const INERTIA_TAU_MS = 75;
const ZOOM_TWEEN_MS = 220;
const KEY_ZOOM = 1.5;
const KEY_PAN_FRACTION = 0.15;
/** A press that moves less than this (CSS px) and lifts within TAP_MS is a tap (select), not a drag. */
const TAP_SLOP_PX = 6;
const TAP_MS = 500;

interface Ptr {
  x: number;
  y: number;
}

interface ZoomTween {
  px: number;
  py: number;
  from: number; // log2 scale
  to: number;
  t0: number;
}

export class Input {
  /** Set by ?reduced or prefers-reduced-motion: no inertia, zooms are cuts. */
  reducedMotion = false;
  /** Called on any user input that moves the camera (cancels a flight). */
  onUserInput: () => void = () => {};
  /** Called when a drag (one or more pointers down) starts and ends. */
  onDrag: (dragging: boolean) => void = () => {};
  /** Called for a tap or click that did not drag: device px, and whether it was a finger or pen. */
  onTap: (x: number, y: number, touch: boolean) => void = () => {};
  /** Arrow keys pan only while this says so (with a selection they walk the tree, selection.ts). */
  arrowsPan: () => boolean = () => true;

  private readonly canvas: HTMLCanvasElement;
  private readonly camera: Camera;
  private readonly onChange: () => void;
  private readonly pointers = new Map<number, Ptr>();
  private velocity: Ptr = { x: 0, y: 0 }; // px per ms, smoothed
  private lastMoveT = 0;
  private inertia: { vx: number; vy: number; t: number } | null = null;
  private tween: ZoomTween | null = null;
  /** The press that may become a tap: where and when it started, and whether it stayed put. */
  private press: { x: number; y: number; t: number; still: boolean; touch: boolean } | null = null;

  constructor(canvas: HTMLCanvasElement, camera: Camera, onChange: () => void) {
    this.canvas = canvas;
    this.camera = camera;
    this.onChange = onChange;
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    canvas.addEventListener('dblclick', (e) => {
      this.onUserInput();
      const p = this.pos(e);
      this.zoomTo(p.x, p.y, 2);
    });
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  /** True while one or more pointers are down. */
  dragging(): boolean {
    return this.pointers.size > 0;
  }

  /** True while inertia or a zoom tween still moves the camera. */
  animating(): boolean {
    return this.inertia !== null || this.tween !== null;
  }

  /** Advances inertia and tweens to time `now`; called once per frame. */
  step(now: number): void {
    if (this.inertia) {
      const it = this.inertia;
      const dt = Math.max(0, Math.min(64, now - it.t));
      it.t = now;
      // Exact integral of v·e^(−t/τ) over this step, so the glide does not
      // depend on the frame rate.
      const k = 1 - Math.exp(-dt / INERTIA_TAU_MS);
      const dx = it.vx * INERTIA_TAU_MS * k;
      const dy = it.vy * INERTIA_TAU_MS * k;
      it.vx *= 1 - k;
      it.vy *= 1 - k;
      this.camera.panBy(dx, dy);
      if (Math.hypot(it.vx, it.vy) * INERTIA_TAU_MS < 0.3) this.inertia = null;
    }
    if (this.tween) {
      const tw = this.tween;
      const t = Math.min(1, (now - tw.t0) / ZOOM_TWEEN_MS);
      const e = 1 - (1 - t) ** 3; // ease-out cubic
      const target = 2 ** (tw.from + (tw.to - tw.from) * e);
      this.camera.zoomAt(tw.px, tw.py, target / this.camera.scale);
      if (t >= 1) this.tween = null;
    }
  }

  /** Stops any glide or tween (any new input does). */
  cancel(): void {
    this.inertia = null;
    this.tween = null;
  }

  /** Zooms by `factor` around (px, py), animated unless reduced motion. */
  zoomTo(px: number, py: number, factor: number): void {
    this.cancel();
    if (this.reducedMotion) {
      this.camera.zoomAt(px, py, factor);
    } else {
      const from = Math.log2(this.camera.scale);
      const to = Math.log2(this.camera.clampScale(this.camera.scale * factor));
      this.tween = { px, py, from, to, t0: performance.now() };
    }
    this.onChange();
  }

  private pos(e: MouseEvent): Ptr {
    const rect = this.canvas.getBoundingClientRect();
    const k = this.canvas.width / Math.max(1, rect.width);
    return { x: (e.clientX - rect.left) * k, y: (e.clientY - rect.top) * k };
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.cancel();
    this.onUserInput();
    // deltaMode: 0 pixels, 1 lines, 2 pages.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.canvas.clientHeight : 1;
    const p = this.pos(e);
    this.camera.zoomAt(p.x, p.y, Math.exp(-e.deltaY * unit * WHEEL_RATE));
    this.onChange();
  }

  private onPointerDown(e: PointerEvent): void {
    this.cancel();
    this.onUserInput();
    if (this.pointers.size === 0) this.onDrag(true);
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.pos(e);
    this.press =
      this.pointers.size === 0 && e.button === 0
        ? { x: p.x, y: p.y, t: e.timeStamp, still: true, touch: e.pointerType !== 'mouse' }
        : null;
    this.pointers.set(e.pointerId, p);
    this.velocity = { x: 0, y: 0 };
    this.lastMoveT = e.timeStamp;
  }

  private onPointerMove(e: PointerEvent): void {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const p = this.pos(e);
    const press = this.press;
    if (press && Math.hypot(p.x - press.x, p.y - press.y) > TAP_SLOP_PX * this.camera.dpr) press.still = false;
    if (this.pointers.size === 1) {
      const dx = p.x - prev.x;
      const dy = p.y - prev.y;
      this.camera.panBy(dx, dy);
      const dt = Math.max(1, e.timeStamp - this.lastMoveT);
      // Exponentially smoothed velocity, so one jittery sample cannot fling.
      this.velocity.x = 0.6 * (dx / dt) + 0.4 * this.velocity.x;
      this.velocity.y = 0.6 * (dy / dt) + 0.4 * this.velocity.y;
      this.lastMoveT = e.timeStamp;
    } else if (this.pointers.size === 2) {
      // Pinch: zoom by the change in finger distance around their midpoint,
      // and pan by the midpoint's movement.
      let other: Ptr | undefined;
      for (const [id, q] of this.pointers) if (id !== e.pointerId) other = q;
      if (!other) return;
      const d0 = Math.hypot(prev.x - other.x, prev.y - other.y);
      const d1 = Math.hypot(p.x - other.x, p.y - other.y);
      const m0 = { x: (prev.x + other.x) / 2, y: (prev.y + other.y) / 2 };
      const m1 = { x: (p.x + other.x) / 2, y: (p.y + other.y) / 2 };
      if (d0 > 0) this.camera.zoomAt(m0.x, m0.y, d1 / d0);
      this.camera.panBy(m1.x - m0.x, m1.y - m0.y);
    }
    this.pointers.set(e.pointerId, p);
    this.onChange();
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.pointers.delete(e.pointerId)) return;
    if (this.pointers.size === 0) this.onDrag(false);
    const press = this.press;
    this.press = null;
    if (e.type === 'pointerup' && press?.still && this.pointers.size === 0 && e.timeStamp - press.t < TAP_MS) {
      this.onTap(press.x, press.y, press.touch);
      return;
    }
    const recent = e.timeStamp - this.lastMoveT < 60;
    const fast = Math.hypot(this.velocity.x, this.velocity.y) > 0.05;
    if (this.pointers.size === 0 && recent && fast && !this.reducedMotion) {
      this.inertia = { vx: this.velocity.x, vy: this.velocity.y, t: performance.now() };
      this.onChange();
    }
  }

  private onKey(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const step = Math.min(w, h) * KEY_PAN_FRACTION;
    if (e.key.startsWith('Arrow') && !this.arrowsPan()) return;
    switch (e.key) {
      case '+':
      case '=':
        this.zoomTo(w / 2, h / 2, KEY_ZOOM);
        break;
      case '-':
      case '_':
        this.zoomTo(w / 2, h / 2, 1 / KEY_ZOOM);
        break;
      case 'ArrowLeft':
        this.pan(step, 0);
        break;
      case 'ArrowRight':
        this.pan(-step, 0);
        break;
      case 'ArrowUp':
        this.pan(0, step);
        break;
      case 'ArrowDown':
        this.pan(0, -step);
        break;
      default:
        return;
    }
    this.onUserInput();
    e.preventDefault();
  }

  private pan(dx: number, dy: number): void {
    this.cancel();
    this.camera.panBy(dx, dy);
    this.onChange();
  }
}
