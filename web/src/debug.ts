// Debug aids behind `?debug` (PLAN §7.11): a small HUD with fps, frame time
// (CPU, and GPU when the backend times frames), tiles, instances, λ and V;
// `?debug=precision`, which checks that the picture moves rigidly at max
// zoom (no float jitter, PLAN §7.2); and the result line of
// `?debug=parity` (gpu/parity.ts). main.ts loads this module lazily, only
// when `?debug` is in the URL.

import { toRad } from './angle';
import type { Camera } from './camera';
import type { GpuParity } from './gpu/parity';
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
  let gpuAvg = 0;
  let lastPaint = 0;
  scene.onFrame = (f: FrameInfo) => {
    const now = performance.now();
    frameTimes.push(now);
    while (frameTimes.length > 0 && (frameTimes[0] ?? 0) < now - 1000) frameTimes.shift();
    msAvg = msAvg === 0 ? f.ms : 0.9 * msAvg + 0.1 * f.ms;
    window.__frameMs = msAvg;
    // The GPU time arrives a frame or two late (gpu/timing.ts); null on WebGL2.
    const gpu = scene.renderer.gpuMs();
    if (gpu !== null) gpuAvg = gpuAvg === 0 ? gpu : 0.9 * gpuAvg + 0.1 * gpu;
    if (now - lastPaint < 250) return;
    lastPaint = now;
    const s = scene.cache.stats();
    const cam = scene.camera;
    el.textContent = [
      `fps ${frameTimes.length}  frame ${msAvg.toFixed(1)} ms` +
        (gpu !== null ? `  gpu ${gpuAvg.toFixed(2)} ms` : '') +
        `  ${scene.renderer.kind}`,
      `tiles ${f.tiles} drawn · ${s.resident} resident · ${s.inFlight} in flight · ${s.pending} pending · ${s.aborted} aborted`,
      `instances ${f.instances.toLocaleString('en')} · ${f.drawCalls} draws`,
      `λ ${f.view.lambda.toFixed(2)}  V ${f.view.level}  fetch ≤ ${f.view.fetchLevel}`,
      `tip spacing ${cam.tipSpacingPx().toFixed(3)} px`,
      window.__precision ? precisionLine(window.__precision) : '',
      window.__gpuParity ? parityLine(window.__gpuParity) : '',
    ]
      .filter((line) => line !== '')
      .join('\n');
  };
}

function parityLine(p: GpuParity): string {
  if (p.error) return `parity: ${p.error}`;
  const failed = p.results.filter((r) => !r.ok).map((r) => r.name);
  return `parity ${p.ok ? 'ok' : 'FAIL'} on ${p.adapter}: ${p.results.length} checks` + (failed.length > 0 ? `, failed ${failed.join(', ')}` : '');
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
 * tests the renderer at a fixed pose and moves it by exact pixels.
 */
export function precisionCamera(scene: Scene, meta: Meta): void {
  const cam = scene.camera;
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
    // Same task as the draw: the frame is not readable afterwards.
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
