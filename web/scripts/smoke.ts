// End-to-end smoke test (PLAN §9 P12): load the app, search "homo sapiens",
// choose the first result, and expect the panel to open on Homo sapiens,
// with the selection in the URL. Then the same through the no-WebGL2
// fallback (`?nowebgl`), where search and the panel must still work.
//
//   make smoke                                        # builds, starts a server, runs this
//   SMOKE_BASE=http://localhost:3000 pnpm -C web test:e2e   # against a running server
//
// Headless Chromium draws WebGL2 through SwiftShader, so no GPU is needed.

import assert from 'node:assert/strict';
import { type Browser, type Page, chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:3000';
const TIMEOUT = 60_000;

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

async function run(browser: Browser, name: string, query: string, check: (page: Page) => Promise<void>): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const t0 = Date.now();
  try {
    await page.goto(`${BASE}/${query}`);
    await page.waitForFunction(() => window.__renderIdle === true, null, { timeout: TIMEOUT });
    await searchAndOpen(page);
    await check(page);
    assert.deepEqual(errors, [], 'no uncaught page errors');
    console.log(`ok   ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } finally {
    await page.close();
  }
}

async function main(): Promise<void> {
  const browser = await chromium.launch({
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  try {
    await run(browser, 'load → search → panel', '?reduced', async (page) => {
      // The selection is in the URL (deep link) and the canvas is drawn.
      await page.waitForFunction(() => location.search.includes('n=ott770315'), null, { timeout: TIMEOUT });
      assert.equal(await page.locator('#tree').isVisible(), true);
    });
    await run(browser, 'no WebGL2: fallback → search → panel', '?nowebgl', async (page) => {
      assert.equal(await page.locator('.fallback img').isVisible(), true);
      assert.match((await page.locator('.fallback figcaption').textContent()) ?? '', /WebGL2 unavailable/);
    });
  } finally {
    await browser.close();
  }
}

main().catch((err: unknown) => {
  console.error('FAIL', err);
  process.exit(1);
});
