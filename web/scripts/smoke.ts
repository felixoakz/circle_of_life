// End-to-end smoke test (PLAN §9 P12, docs/plan-webgpu.md W5): load the app,
// search "homo sapiens", choose the first result, and expect the panel to
// open on Homo sapiens, with the selection in the URL. Runs:
//
//   default             lands on a working renderer (WebGL2 headless: no hardware adapter)
//   ?renderer=webgl     must be WebGL2
//   ?renderer=webgpu    must be WebGPU with SMOKE_WEBGPU=1; otherwise it must
//                       fall back to WebGL2, and the WebGPU checks are skipped
//                       with a log line
//   ?nowebgl            the fallback page, where search and the panel still work
//
// Every drawn run uses reduced motion, so choosing the result is a cut with
// a crossfade; the snapshot of the tree canvas must not be black (on WebGPU
// the canvas is only readable before it is presented). On WebGPU, a forced
// device loss (`__loseDevice`, `?debug`) must recover with tiles redrawn and
// no GPU errors, and a second loss must reload into WebGL2.
//
//   make smoke                                        # builds, starts a server, runs this
//   SMOKE_BASE=http://localhost:3000 pnpm -C web test:e2e   # against a running server
//   SMOKE_WEBGPU=1 make smoke                         # WebGPU required (docs/webgpu.md flags)
//
// By default headless Chromium draws WebGL2 through SwiftShader, so no GPU is
// needed. WebGPU canvases need ANGLE on the host's GL driver
// (docs/webgpu.md), so SMOKE_WEBGPU=1 uses those flags instead.

import assert from 'node:assert/strict';
import { type Browser, type Page, chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:3000';
const WEBGPU = process.env.SMOKE_WEBGPU === '1';
const TIMEOUT = 60_000;
const SWIFTSHADER_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const WEBGPU_ARGS = ['--enable-unsafe-webgpu', '--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'];

// Records, when the crossfade snapshot copies the tree canvas, the share of
// its pixels that are not black (`window.__crossfadeLit`). Plain JS: it runs
// in the page before the app.
const CROSSFADE_PROBE = `
  const draw = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (...args) {
    draw.apply(this, args);
    const src = args[0];
    if (!(src instanceof HTMLCanvasElement) || src.id !== 'tree' || !this.canvas.classList.contains('crossfade')) return;
    const { width, height } = this.canvas;
    const d = this.getImageData(0, 0, width, height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 24) lit++;
    window.__crossfadeLit = lit / (width * height);
  };
`;

declare global {
  interface Window {
    __crossfadeLit?: number;
  }
}

async function searchAndOpen(page: Page): Promise<void> {
  await page.keyboard.press('/');
  await page.waitForSelector('.search-layer.open', { timeout: TIMEOUT });
  await page.keyboard.type('homo sapiens', { delay: 10 });
  // The first row is the best match: the species itself.
  const first = page.locator('.search-row').first();
  await first.waitFor({ timeout: TIMEOUT });
  assert.match((await first.textContent()) ?? '', /Homo sapiens/);
  await page.keyboard.press('Enter');
  const title = page.locator('#panel-title');
  await title.waitFor({ timeout: TIMEOUT });
  await page.waitForFunction(() => document.querySelector('#panel-title')?.textContent?.includes('Homo sapiens'), null, {
    timeout: TIMEOUT,
  });
  assert.equal(((await title.textContent()) ?? '').trim().startsWith('Homo sapiens'), true);
}

/** Checks after the cut: selection in the URL, canvas visible, crossfade snapshot not black, no GPU errors. */
async function drawnChecks(page: Page): Promise<void> {
  await page.waitForFunction(() => location.search.includes('n=ott770315'), null, { timeout: TIMEOUT });
  assert.equal(await page.locator('#tree').isVisible(), true);
  const lit = await page.evaluate(() => window.__crossfadeLit);
  assert.ok(lit !== undefined, 'the cut made a crossfade snapshot of the tree');
  assert.ok(lit > 0.005, `crossfade snapshot of the tree is not black (lit ${(lit * 100).toFixed(2)}%)`);
  console.log(`     crossfade snapshot of the tree: ${(lit * 100).toFixed(1)}% lit`);
  assert.equal(await page.evaluate(() => window.__gpuErrors ?? 0), 0, 'no WebGPU errors');
}

/** Lit share of the tree canvas right after a fresh frame (WebGPU readback), and that frame's tile count. */
async function freshFrame(page: Page): Promise<{ tiles: number; lit: number }> {
  return page.evaluate(async () => {
    const scene = window.__scene;
    if (!scene) throw new Error('window.__scene missing (needs ?debug)');
    const { tiles } = scene.renderNow();
    if (tiles === 0) return { tiles, lit: 0 };
    let px;
    try {
      px = await scene.renderer.readPixels();
    } catch {
      // The device went away while this frame was read back (the loss is still being noticed).
      return { tiles: 0, lit: 0 };
    }
    let lit = 0;
    for (let i = 0; i < px.data.length; i += 4) {
      if ((px.data[i] ?? 0) + (px.data[i + 1] ?? 0) + (px.data[i + 2] ?? 0) > 24) lit++;
    }
    return { tiles, lit: lit / (px.width * px.height) };
  });
}

/** Forced device loss: the first recovers in place, the second reloads into WebGL2. */
async function lossChecks(page: Page): Promise<void> {
  const before = await freshFrame(page);
  assert.ok(before.tiles > 0 && before.lit > 0.005, `drawn before the loss (${JSON.stringify(before)})`);
  const url = page.url();
  await page.evaluate(() => window.__loseDevice?.());
  let after = { tiles: 0, lit: 0 };
  const t0 = Date.now();
  while (Date.now() - t0 < TIMEOUT) {
    await page.waitForTimeout(200);
    after = await freshFrame(page);
    if (after.tiles > 0 && after.lit > 0.005) break;
  }
  assert.ok(after.tiles > 0 && after.lit > 0.005, `tiles redrawn after the loss (${JSON.stringify(after)})`);
  assert.equal(page.url(), url, 'recovered in place, no reload');
  assert.equal(await page.evaluate(() => window.__renderer), 'webgpu');
  assert.equal(await page.evaluate(() => window.__gpuErrors ?? 0), 0, 'no WebGPU errors after the recovery');
  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  console.log(`     device loss recovered: ${before.tiles} → ${after.tiles} tiles, lit ${pct(before.lit)} → ${pct(after.lit)}`);

  // Lost again: recovery happens once per page, so this one reloads into WebGL2.
  await Promise.all([
    page.waitForURL(/renderer=webgl(&|$)/, { timeout: TIMEOUT }),
    page.evaluate(() => window.__loseDevice?.()),
  ]);
  await page.waitForFunction(() => window.__renderIdle === true, null, { timeout: TIMEOUT });
  assert.equal(await page.evaluate(() => window.__renderer), 'webgl2');
  assert.match(page.url(), /n=ott770315/, 'the reload keeps the selection');
  assert.match(page.url(), /v=[-\d.,]+/, 'the reload keeps the camera');
  console.log(`     second loss reloaded into WebGL2: ${new URL(page.url()).search}`);
}

/** Opens `query`, waits for idle, searches, then runs `check` (which returns 'skip' when it could not run). */
async function run(
  browser: Browser,
  name: string,
  query: string,
  check: (page: Page) => Promise<void | 'skip'>,
): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(CROSSFADE_PROBE);
  const t0 = Date.now();
  try {
    await page.goto(`${BASE}/${query}`);
    await page.waitForFunction(() => window.__renderIdle === true, null, { timeout: TIMEOUT });
    const renderer = await page.evaluate(() => window.__renderer);
    await searchAndOpen(page);
    const outcome = await check(page);
    assert.deepEqual(errors, [], 'no uncaught page errors');
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (outcome === 'skip') console.log(`skip ${name}: WebGPU unavailable here, landed on ${renderer} (${secs} s)`);
    else console.log(`ok   ${name} [${renderer}] (${secs} s)`);
  } finally {
    await page.close();
  }
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ args: WEBGPU ? WEBGPU_ARGS : SWIFTSHADER_ARGS });
  try {
    await run(browser, 'default → search → panel', '?reduced', async (page) => {
      // Software WebGPU adapters are refused by default, so headless lands on WebGL2.
      const r = await page.evaluate(() => window.__renderer);
      assert.ok(r === 'webgpu' || r === 'webgl2', `a working renderer, got ${r}`);
      await drawnChecks(page);
    });
    await run(browser, '?renderer=webgl → search → panel', '?renderer=webgl&reduced', async (page) => {
      assert.equal(await page.evaluate(() => window.__renderer), 'webgl2');
      await drawnChecks(page);
    });
    await run(browser, '?renderer=webgpu → search → panel → device loss', '?renderer=webgpu&reduced&debug', async (page) => {
      const r = await page.evaluate(() => window.__renderer);
      if (r !== 'webgpu') {
        assert.equal(WEBGPU, false, `SMOKE_WEBGPU=1 needs WebGPU, got ${r}`);
        // Without WebGPU, asking for it must still land on WebGL2.
        assert.equal(r, 'webgl2');
        await drawnChecks(page);
        return 'skip';
      }
      await drawnChecks(page);
      await lossChecks(page);
    });
    await run(browser, 'no GPU: fallback → search → panel', '?nowebgl', async (page) => {
      assert.equal(await page.locator('.fallback img').isVisible(), true);
      assert.match((await page.locator('.fallback figcaption').textContent()) ?? '', /no WebGPU or WebGL2/);
      assert.equal(await page.evaluate(() => window.__renderer), 'none');
    });
  } finally {
    await browser.close();
  }
}

main().catch((err: unknown) => {
  console.error('FAIL', err);
  process.exit(1);
});
