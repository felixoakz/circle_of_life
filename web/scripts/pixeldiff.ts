// Per-pixel comparison of two screenshots (`SHOT_COMPARE`, scripts/shot.ts).
// `diffImages` is pure; `decodePng` decodes a PNG
// in a Playwright page (`<img>` → canvas → `getImageData`), so no image
// library is needed.

export interface DiffResult {
  /** Pixels whose largest channel difference exceeds `tol`. */
  over: number;
  /** `over` as a percentage of all pixels. */
  overPct: number;
  /** Mean absolute difference over every RGBA channel of every pixel. */
  meanAbs: number;
  /** Largest channel difference anywhere. */
  maxAbs: number;
  /** RGBA heatmap: black where equal, grey (64) where within `tol`, red where over. */
  heatmap: Uint8ClampedArray;
}

export function diffImages(
  a: Uint8Array | Uint8ClampedArray,
  b: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  tol: number,
): DiffResult {
  const n = width * height;
  if (a.length !== n * 4 || b.length !== n * 4) {
    throw new Error(`image size differs: expected ${n * 4} bytes, got ${a.length} and ${b.length}`);
  }
  const heatmap = new Uint8ClampedArray(n * 4);
  let over = 0;
  let sumAbs = 0;
  let maxAbs = 0;
  for (let i = 0; i < n; i++) {
    let worst = 0;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs((a[i * 4 + c] ?? 0) - (b[i * 4 + c] ?? 0));
      sumAbs += d;
      if (d > worst) worst = d;
    }
    if (worst > maxAbs) maxAbs = worst;
    const v = worst > tol ? [255, 0, 0] : worst > 0 ? [64, 64, 64] : [0, 0, 0];
    if (worst > tol) over++;
    heatmap.set([v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, 255], i * 4);
  }
  return { over, overPct: (100 * over) / Math.max(1, n), meanAbs: sumAbs / Math.max(1, n * 4), maxAbs, heatmap };
}

/** A decoded image: RGBA rows, top-down. */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** The parts of a Playwright `Page` the decoder needs. */
export interface EvalPage {
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
}

/** Decodes PNG bytes in the browser page (any blank page will do). */
export async function decodePng(page: EvalPage, png: Uint8Array): Promise<Rgba> {
  // Bytes cross the Playwright boundary as base64 strings: number arrays of
  // a 2560×1440 frame would be ~15 M JSON elements.
  const out = await page.evaluate(async (src: string) => {
    const img = new Image();
    img.src = `data:image/png;base64,${src}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    // Unpremultiplied readback must not round the colours of transparent pixels.
    const ctx = c.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let bin = '';
    for (let i = 0; i < d.length; i += 0x8000) bin += String.fromCharCode(...d.subarray(i, i + 0x8000));
    return { width: c.width, height: c.height, data: btoa(bin) };
  }, Buffer.from(png).toString('base64'));
  return { width: out.width, height: out.height, data: new Uint8ClampedArray(Buffer.from(out.data, 'base64')) };
}

/** Encodes RGBA pixels as PNG bytes in the browser page. */
export async function encodePng(page: EvalPage, img: Rgba): Promise<Uint8Array> {
  const b64 = await page.evaluate(
    async (arg: { width: number; height: number; data: string }) => {
      const bin = atob(arg.data);
      const px = new Uint8ClampedArray(bin.length);
      for (let i = 0; i < bin.length; i++) px[i] = bin.charCodeAt(i);
      const c = document.createElement('canvas');
      c.width = arg.width;
      c.height = arg.height;
      const ctx = c.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      ctx.putImageData(new ImageData(px, arg.width, arg.height), 0, 0);
      const url = c.toDataURL('image/png');
      return url.slice(url.indexOf(',') + 1);
    },
    { width: img.width, height: img.height, data: Buffer.from(img.data).toString('base64') },
  );
  return new Uint8Array(Buffer.from(b64, 'base64'));
}
