// Canvas sizing: backing-store size, the tree's
// device-pixel ratio under the pixel cap, and fitting the canvas to its CSS
// box.

/** The canvas fields `fitCanvas` touches (an HTMLCanvasElement in the app). */
export type SizedCanvas = Pick<HTMLCanvasElement, 'clientWidth' | 'clientHeight' | 'width' | 'height'>;

/** Backing-store size in device pixels for a canvas of the given CSS size. */
export function backingStoreSize(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
): { width: number; height: number } {
  // Round (not floor) so a 0.5px rounding error on fractional DPRs (1.25, 1.5)
  // does not leave a 1px blurry seam; clamp to 1 so the GPU never gets a 0-size buffer.
  return {
    width: Math.max(1, Math.round(cssWidth * devicePixelRatio)),
    height: Math.max(1, Math.round(cssHeight * devicePixelRatio)),
  };
}

/**
 * Device pixels per CSS px for the tree canvas: the screen's DPR, lowered
 * so the backing store holds at most `maxPixels` (ARCHITECTURE §7.12). A 5K screen
 * (5120×2880 device px, 14.7 Mpx) took 11–13 ms per overview frame on an
 * integrated GPU, and the fill-bound passes (ring, fans, marks) scale with
 * the pixel count (measurements at `MAX_BACKING_PX`). Never below 1, so a
 * big DPR-1 screen keeps its full resolution.
 */
export function treeDpr(cssWidth: number, cssHeight: number, dpr: number, maxPixels: number): number {
  const area = Math.max(1, cssWidth * cssHeight);
  const cap = Math.sqrt(maxPixels / area);
  return Math.max(Math.min(dpr, 1), Math.min(dpr, cap));
}

/** Resizes the canvas's backing store to match its CSS box. Returns true if it changed. */
export function fitCanvas(canvas: SizedCanvas, devicePixelRatio: number): boolean {
  const { width, height } = backingStoreSize(canvas.clientWidth, canvas.clientHeight, devicePixelRatio);
  if (canvas.width === width && canvas.height === height) return false;
  canvas.width = width;
  canvas.height = height;
  return true;
}
