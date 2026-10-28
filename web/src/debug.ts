// Debug aids behind `?debug` (PLAN §7.11): a small HUD with fps, frame time,
// tiles, instances, λ and V; and `?debug=precision`, which checks that the
// picture moves rigidly at max zoom (no float jitter, PLAN §7.2).

import { toRad } from './angle';
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
    ].join('\n');
  };
}

export interface PrecisionResult {
  shift: [number, number];
  /** Line crossings (lit runs along pixel rows) compared between the two frames. */
  lines: number;
  /** Largest and mean offset of a line's centre after undoing the pan, px. */
  maxOffsetPx: number;
  meanOffsetPx: number;
  /** Lines with no counterpart within 3 px (missing or jumped). */
  unmatched: number;
  /** Where the largest offset was found: CSS-free device px, y down. */
  maxAt: [number, number];
}

function precisionLine(p: PrecisionResult): string {
  return (
    `precision: ${p.lines} line crossings, offset max ${p.maxOffsetPx.toFixed(3)} px, ` +
    `mean ${p.meanOffsetPx.toFixed(4)} px, ${p.unmatched} unmatched`
  );
}

/** Max zoom on the rim next to Homo sapiens, rotation 0 so lines are diagonal. */
export function precisionCamera(scene: Scene, meta: Meta): void {
  const cam = scene.camera;
  cam.rot = 0;
  cam.scale = cam.maxScale();
  cam.angle = toRad(meta.home?.angle ?? 0);
  cam.r = 1 - (0.3 * Math.min(cam.width, cam.height)) / cam.scale;
}

/**
 * Centres (intensity-weighted, in px) of the lit runs in one pixel row,
 * restricted to columns [x0, x1).
 */
function rowCentres(px: Uint8Array, w: number, row: number, x0: number, x1: number): number[] {
  const out: number[] = [];
  let sum = 0;
  let moment = 0;
  for (let x = x0; x <= x1; x++) {
    const i = (row * w + x) * 4;
    const v = x < x1 ? (px[i] ?? 0) + (px[i + 1] ?? 0) + (px[i + 2] ?? 0) : 0;
    if (v > 12) {
      sum += v;
      moment += v * x;
    } else if (sum > 0) {
      out.push(moment / sum);
      sum = 0;
      moment = 0;
    }
  }
  return out;
}

/**
 * Renders, pans by an exact whole number of pixels, renders again and
 * compares where each line crosses each pixel row. A jitter-free renderer
 * draws the same picture shifted, so every line comes back to within a
 * small fraction of a pixel; float jitter moves lines by whole pixels.
 */
export async function runPrecisionTest(
  scene: Scene,
  gl: WebGL2RenderingContext,
): Promise<PrecisionResult> {
  const shift: [number, number] = [37, 23];
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const grab = async (): Promise<Uint8Array> => {
    await scene.whenIdle();
    scene.renderNow();
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };

  // Geometry only: the HUD's dim plates are fixed to the screen (scene.ts).
  scene.dimsOn = false;
  const a = await grab();
  scene.camera.panBy(shift[0], shift[1]);
  scene.requestRender();
  const b = await grab();
  scene.camera.panBy(-shift[0], -shift[1]);
  scene.dimsOn = true;
  scene.requestRender();

  // readPixels rows run bottom-up: content that moved down by dy on screen
  // sits dy rows lower in the buffer, and dx columns further right.
  const [dx, dy] = shift;
  let lines = 0;
  let unmatched = 0;
  let maxOffsetPx = 0;
  let maxAt: [number, number] = [0, 0];
  let total = 0;
  for (let row = dy; row < h; row++) {
    const ca = rowCentres(a, w, row, 1, w - dx - 1);
    const cb = rowCentres(b, w, row - dy, dx + 1, w - 1).map((x) => x - dx);
    for (const x of ca) {
      let best = Infinity;
      for (const y of cb) best = Math.min(best, Math.abs(x - y));
      if (best > 3) {
        unmatched++;
        continue;
      }
      lines++;
      total += best;
      if (best > maxOffsetPx) {
        maxOffsetPx = best;
        maxAt = [Math.round(x), h - 1 - row];
      }
    }
  }
  return { shift, lines, maxOffsetPx, meanOffsetPx: total / Math.max(1, lines), unmatched, maxAt };
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
      scene.camera.panBy(-120 * w * Math.sin(w * t) * dt, 120 * w * Math.cos(w * t) * dt);
    }
    last = now;
    return true;
  };
  scene.requestRender();
}
