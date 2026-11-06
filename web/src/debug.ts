// Debug aids behind `?debug` (ARCHITECTURE §7.11): a small HUD with fps, frame
// time, tiles, instances, λ and V; and `?debug=precision`, which checks that
// the picture moves rigidly at max zoom (no float jitter, ARCHITECTURE §7.2).
// main.ts loads this module lazily, only when `?debug` is in the URL.

import { toRad } from './angle';
import type { Camera } from './camera';
import { type FrameComparison, compareFrames } from './render/pixels';
import type { Pixels, Renderer } from './render/types';
import type { FrameInfo, Scene } from './scene';
import type { Meta } from './types';

declare global {
  interface Window {
    __precision?: PrecisionResult;
    __frameMs?: number;
    /** ?debug and ?shot: the live scene, for poking at it from the console or tests. */
    __scene?: Scene;
  }
}

export function mountDebugHud(scene: Scene): void {
  const el = document.createElement('pre');
  el.className = 'debug-hud';
  document.body.append(el);
  scene.syncGpu = true;
  window.__scene = scene;

  const frameTimes: number[] = [];
  let msAvg = 0;
  let lastPaint = 0;
  scene.onFrame = (f: FrameInfo) => {
    const now = performance.now();
    frameTimes.push(now);
    while (frameTimes.length > 0 && (frameTimes[0] ?? 0) < now - 1000) frameTimes.shift();
    msAvg = msAvg === 0 ? f.ms : 0.9 * msAvg + 0.1 * f.ms;
    window.__frameMs = msAvg;
    if (now - lastPaint < 250) return;
    lastPaint = now;
    const s = scene.cache.stats();
    const cam = scene.camera;
    el.textContent = [
      `fps ${frameTimes.length}  frame ${msAvg.toFixed(1)} ms`,
      `tiles ${f.tiles} drawn · ${s.resident} resident · ${s.inFlight} in flight · ${s.pending} pending · ${s.aborted} aborted`,
      `instances ${f.instances.toLocaleString('en')} · ${f.drawCalls} draws`,
      `λ ${f.view.lambda.toFixed(2)}  V ${f.view.level}  fetch ≤ ${f.view.fetchLevel}`,
      `tip spacing ${cam.tipSpacingPx().toFixed(3)} px`,
      window.__precision ? precisionLine(window.__precision) : '',
    ]
      .filter((line) => line !== '')
      .join('\n');
  };
}


export interface PrecisionResult extends FrameComparison {
  shift: [number, number];
}

function precisionLine(p: PrecisionResult): string {
  return (
    `precision: ${p.lines} line crossings, offset max ${p.maxOffsetPx.toFixed(3)} px, ` +
    `mean ${p.meanOffsetPx.toFixed(4)} px, ${p.unmatched} unmatched`
  );
}

/**
 * Max zoom on the rim next to Homo sapiens, rotation 0 so lines are
 * diagonal. The camera is set directly, not through the rig (rig.ts): this
 * tests the renderer at a fixed pose and moves it by exact pixels. With a
 * free view link (`&v=a,r,z,rot`, url.ts) it stays where that link looks,
 * at max zoom, so free view anywhere on the wheel can be checked too
 * (e.g. mid-radius, among the inner branches).
 */
export function precisionCamera(scene: Scene, meta: Meta): void {
  const cam = scene.camera;
  const free = scene.rig.free;
  if (free) {
    scene.rig.setFree({ ...free, scale: cam.maxScale(), rot: 0 });
    return;
  }
  cam.rot = 0;
  cam.scale = cam.maxScale();
  cam.angle = toRad(meta.home?.angle ?? 0);
  cam.r = 1 - (0.3 * Math.min(cam.width, cam.height)) / cam.scale;
}

/** Moves the picture by (dx, dy) screen pixels, as if dragged (the test's camera only). */
function shift(cam: Camera, dx: number, dy: number): void {
  const c = cam.screenToWorld(cam.width / 2 - dx, cam.height / 2 - dy);
  cam.setCentre(c.x, c.y);
}

/**
 * Renders, shifts by an exact whole number of pixels, renders again and
 * compares where each line crosses each pixel row (render/pixels.ts
 * `compareFrames`). A jitter-free renderer draws the same picture shifted,
 * so every line comes back to within a small fraction of a pixel; float
 * jitter moves lines by whole pixels.
 */
export async function runPrecisionTest(scene: Scene, renderer: Renderer): Promise<PrecisionResult> {
  const offset: [number, number] = [37, 23];
  const grab = async (): Promise<Pixels> => {
    await scene.whenIdle();
    scene.renderNow();
    // Same task as the draw: the drawing buffer is not preserved.
    return renderer.readPixels();
  };

  // Geometry only: the HUD's dim plates are fixed to the screen (scene.ts).
  scene.dimsOn = false;
  const a = await grab();
  shift(scene.camera, offset[0], offset[1]);
  scene.requestRender();
  const b = await grab();
  shift(scene.camera, -offset[0], -offset[1]);
  scene.dimsOn = true;
  scene.requestRender();
  return { shift: offset, ...compareFrames(a, b, offset) };
}

/** After the test, glide slowly in a circle so jitter is visible to the eye. */
export function precisionGlide(scene: Scene): void {
  let last = -1;
  scene.animate = (now) => {
    if (last >= 0) {
      const t = now / 1000;
      const dt = (now - last) / 1000;
      // Velocity of a 120 px circle with a 6 s period.
      const w = (2 * Math.PI) / 6;
      shift(scene.camera, -120 * w * Math.sin(w * t) * dt, 120 * w * Math.cos(w * t) * dt);
    }
    last = now;
    return true;
  };
  scene.requestRender();
}
