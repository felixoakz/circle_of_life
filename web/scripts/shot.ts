// Visual QA screenshots (PLAN §10.2). Needs the server running on a fresh
// build (`pnpm -C web build`, then `make server`), then:
//
//   pnpm -C web shot                 # all states
//   pnpm -C web shot deep-homo       # just some states
//   SHOT_BASE=http://localhost:3077 pnpm -C web shot
//   SHOT_GPU=1 pnpm -C web shot      # hardware GPU (frame times)
//   SHOT_OUT=../screens/review-fixed pnpm -C web shot hidpi-overview   # another folder
//
// Headless Chromium renders WebGL2 through SwiftShader (a CPU rasteriser), so
// it is slow but needs no GPU. Each state opens a URL, waits for
// `window.__renderIdle`, and writes screens/<state>.png (the state name says
// the size where it is not the 1440×900 desktop default, e.g. mobile-…). Camera
// positions use the `v` URL parameter (src/url.ts), computed from /api/meta.

import { mkdir } from 'node:fs/promises';
import { type Page, chromium } from 'playwright';

const BASE = process.env.SHOT_BASE ?? 'http://localhost:3000';
// SHOT_GPU=1 renders on the machine's GPU instead of SwiftShader: real
// frame times, and the precision test runs on real GPU float maths.
const GPU = process.env.SHOT_GPU === '1';
const BROWSER_ARGS = GPU
  ? ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist']
  : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const OUT = process.env.SHOT_OUT
  ? new URL(`file://${process.env.SHOT_OUT.replace(/\/?$/, '/')}`)
  : new URL('../../screens/', import.meta.url);
const TAU = Math.PI * 2;
const TWO_32 = 2 ** 32;

interface MetaLite {
  tipCount: number;
  tileP: number;
  runs: { group: number; angleLo: number; angleHi: number }[];
  home: { angle: number } | null;
}

interface State {
  name: string;
  width: number;
  height: number;
  /** Query string after `?shot`. */
  query: (meta: MetaLite, width: number, height: number) => string | Promise<string>;
  /** Wait for the precision test result too. */
  precision?: boolean;
  /** Device pixel ratio (default 1). */
  dpr?: number;
  /** A click to make once idle (CSS selector), then wait for idle again. */
  click?: string;
  /** Something to do once idle (hover, drag the sheet), then wait for idle again. */
  act?: (page: Page) => Promise<void>;
}

/** Moves the mouse over a grid until the hover tooltip shows, starting near (fx, fy) of the window. */
function hoverNear(fx: number, fy: number): (page: Page) => Promise<void> {
  return async (page) => {
    const vp = page.viewportSize() ?? { width: 1440, height: 900 };
    for (let ring = 0; ring < 40; ring++) {
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
      ] as const) {
        const x = vp.width * fx + dx * ring * 3;
        const y = vp.height * fy + dy * ring * 3;
        await page.mouse.move(x, y);
        await page.waitForTimeout(40);
        if (await page.evaluate(() => !document.querySelector('.tooltip')?.hasAttribute('hidden'))) {
          // Let the lineage fetch complete the path to the root.
          await page.waitForTimeout(400);
          return;
        }
      }
    }
    throw new Error('hover: nothing under the pointer');
  };
}

/** Opens the search palette with "/" and types `q` (P9). */
function typeSearch(q: string): (page: Page) => Promise<void> {
  return async (page) => {
    await page.keyboard.press('/');
    await page.waitForSelector('.search-layer.open');
    await page.keyboard.type(q, { delay: 20 });
    // Debounce (120 ms) plus the answer; the scene waits for search too.
    await page.waitForTimeout(300);
  };
}

/** Searches for `q`, presses Enter on the first result and waits for the panel title. */
function chooseSearch(q: string): (page: Page) => Promise<void> {
  return async (page) => {
    await typeSearch(q)(page);
    await page.keyboard.press('Enter');
    await page.waitForSelector('#panel-title');
    await page.waitForTimeout(1500);
  };
}

/** Drags the bottom sheet's handle by dy CSS px. */
function dragSheet(dy: number): (page: Page) => Promise<void> {
  return async (page) => {
    const box = await page.locator('.sheet-handle').boundingBox();
    if (!box) throw new Error('no sheet handle');
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(x, y + (dy * i) / 10);
    await page.waitForTimeout(300);
    await page.mouse.up();
    await page.waitForTimeout(400);
  };
}

/** Scrolls the panel body to a fraction of its scroll height. */
function scrollPanel(fraction: number): (page: Page) => Promise<void> {
  return async (page) => {
    await page.evaluate((f) => {
      const body = document.querySelector('.panel-body');
      if (body) body.scrollTop = f * (body.scrollHeight - body.clientHeight);
    }, fraction);
    await page.waitForTimeout(200);
  };
}

/** Opens Data & credits from the wordmark menu. */
async function openCredits(page: Page): Promise<void> {
  await page.click('.wordmark-button');
  await page.click('.menu-item');
  await page.waitForTimeout(300);
}

/** The `v` parameter: angle units, centre radius, log2 CSS px per unit, degrees. */
function v(a: number, r: number, scaleCss: number, rotDeg: number): string {
  return `&v=${Math.round(a)},${r.toFixed(10)},${Math.log2(scaleCss).toFixed(4)},${rotDeg.toFixed(3)}`;
}

/** Scale (CSS px per world unit) at which λ equals `lambda`. */
function scaleForLambda(meta: MetaLite, lambda: number): number {
  return (2 ** lambda * meta.tileP * 0.5) / TAU;
}

/** The deepest zoom: 48 px between tips (PLAN §7.5). */
function maxScale(meta: MetaLite): number {
  return (48 * meta.tipCount) / TAU;
}

/** Rotation (degrees) that turns the outward direction at angle `a` to screen angle `deg`. */
function pointing(a: number, deg: number): number {
  return deg - (a / TWO_32) * 360;
}

/** The first search hit's OTT node id for a scientific name. */
async function ottOf(name: string): Promise<string> {
  const hits = (await (await fetch(`${BASE}/api/search?q=${encodeURIComponent(name)}`)).json()) as {
    nodeId: string;
    name: string;
  }[];
  const hit = hits.find((h) => h.name === name) ?? hits[0];
  if (!hit) throw new Error(`no node named ${name}`);
  return hit.nodeId;
}

/** Max zoom on a named node, outward pointing left (labels left of the rim, as in 1.png). */
function deepAt(name: string): State['query'] {
  return async (meta, w) => {
    const { a } = await nodeSpan(meta, await ottOf(name));
    const s = maxScale(meta);
    return v(a, 1 + (0.25 * w) / s, s, pointing(a, 180));
  };
}

/** The midpoint of a group's largest run, at view level λ, the rim `below` px under the centre. */
function groupAt(group: number, lambda: number, below: number): State['query'] {
  return (meta) => {
    const runs = meta.runs.filter((r) => r.group === group);
    const run = runs.sort((x, y) => y.angleHi - y.angleLo - (x.angleHi - x.angleLo))[0];
    const a = run ? (run.angleLo + run.angleHi) / 2 : 0;
    const s = scaleForLambda(meta, lambda);
    return v(a, 1 - below / s, s, pointing(a, 270));
  };
}

/** A node's angle and the angular width of its tips (u32 units), from the read API. */
async function nodeSpan(meta: MetaLite, nodeId: string): Promise<{ a: number; span: number }> {
  const n = (await (await fetch(`${BASE}/api/nodes/${nodeId}`)).json()) as {
    angle: number;
    leafCount: number;
  };
  return { a: n.angle, span: (n.leafCount * TWO_32) / meta.tipCount };
}

/** States shot when none are named (the rest are the review extras). */
const DEFAULTS = ['overview', 'animals', 'mammals', 'deep-homo', 'key-fungi', 'crumb-fly', 'precision'];

const STATES: State[] = [
  { name: 'overview', width: 1440, height: 900, query: () => '' },
  {
    name: 'animals',
    width: 1440,
    height: 900,
    query: (meta) => {
      // Midpoint of the largest Animals run, at λ ≈ 5.
      const runs = meta.runs.filter((r) => r.group === 0);
      const run = runs.sort((x, y) => y.angleHi - y.angleLo - (x.angleHi - x.angleLo))[0];
      const a = run ? (run.angleLo + run.angleHi) / 2 : 0;
      return v(a, 0.75, scaleForLambda(meta, 5), 0);
    },
  },
  {
    name: 'mammals',
    width: 1440,
    height: 900,
    query: async (meta, w, h) => {
      // Mid zoom (λ ≈ 8.5) on Mammalia, outward pointing up, rim near the top.
      const { a, span } = await nodeSpan(meta, 'ott244265');
      const s = w / (4 * span * (TAU / TWO_32));
      return v(a, 1 - (0.3 * h) / s, s, pointing(a, 90));
    },
  },
  {
    name: 'deep-homo',
    width: 1440,
    height: 900,
    query: (meta, w) => {
      // Max zoom at Homo sapiens as in docs/reference/1.png: outward points
      // left (as auto-orient would turn it), the rim runs vertically at
      // three quarters of the width, tip bars go right from it and labels
      // (P7) sit left of it.
      const a = meta.home?.angle ?? 0;
      const s = maxScale(meta);
      return v(a, 1 + (0.25 * w) / s, s, pointing(a, 180));
    },
  },
  {
    // The kingdom key's flight (review: key-fungi).
    name: 'key-fungi',
    width: 1440,
    height: 900,
    query: () => '',
    click: '.kingdom-key li:nth-child(2) button',
  },
  {
    // Max zoom on Pan, outward to the right (review P1-1: the Pan bracket).
    name: 'crumb-fly',
    width: 1440,
    height: 900,
    query: async (meta, w) => {
      const { a } = await nodeSpan(meta, 'ott417957');
      const s = maxScale(meta);
      return v(a, 1 - (0.15 * w) / s, s, pointing(a, 0));
    },
  },
  // Extra states from the P7 review (SHOT_OUT=../screens/review-fixed).
  { name: 'hidpi-overview', width: 2560, height: 1440, dpr: 2, query: () => '' },
  { name: 'reduced', width: 1440, height: 900, query: () => '&reduced' },
  { name: 'mobile-overview', width: 390, height: 844, dpr: 2, query: () => '' },
  { name: 'desktop-1280-overview', width: 1280, height: 800, query: () => '' },
  { name: 'mid-l4.5-animals', width: 1440, height: 900, query: groupAt(0, 4.5, 250) },
  { name: 'mid-l6.5-protists', width: 1440, height: 900, query: groupAt(3, 6.5, 250) },
  { name: 'mid-archaea', width: 1440, height: 900, query: groupAt(5, 10, 250) },
  { name: 'deep-archaea', width: 1440, height: 900, query: deepAt('Halobacterium salinarum') },
  { name: 'deep-quercus', width: 1440, height: 900, query: deepAt('Quercus petraea') },
  { name: 'deep-amanita', width: 1440, height: 900, query: deepAt('Amanita muscaria') },
  { name: 'deep-ecoli', width: 1440, height: 900, query: deepAt('Escherichia coli') },
  { name: 'hidpi-deep-homo', width: 1440, height: 900, dpr: 2, query: deepAt('Homo sapiens') },
  { name: 'mobile-deep-homo', width: 390, height: 844, dpr: 2, query: deepAt('Homo sapiens') },
  // P8: the panel, hover and the mobile sheet. No `v`: the view flies to
  // the node, leaving room for the panel.
  { name: 'panel-homo', width: 1440, height: 900, query: () => '&n=ott770315' },
  { name: 'panel-felidae', width: 1440, height: 900, query: () => '&n=ott563159' },
  { name: 'panel-mrca', width: 1440, height: 900, query: () => '&n=mrcaott54737ott660452' },
  {
    name: 'hover-path',
    width: 1440,
    height: 900,
    query: async (meta, w, h) => {
      const { a, span } = await nodeSpan(meta, 'ott244265');
      const s = w / (4 * span * (TAU / TWO_32));
      return v(a, 1 - (0.3 * h) / s, s, pointing(a, 90));
    },
    act: hoverNear(0.45, 0.35),
  },
  { name: 'hover-overview', width: 1440, height: 900, query: () => '', act: hoverNear(0.42, 0.42) },
  { name: 'mobile-sheet', width: 390, height: 844, dpr: 2, query: () => '&n=ott770315' },
  { name: 'mobile-sheet-peek', width: 390, height: 844, dpr: 2, query: () => '&n=ott770315', act: dragSheet(400) },
  // P10: the about section (needs the live APIs or a warm cache.db), the credits dialog.
  { name: 'panel-homo-about', width: 1440, height: 900, query: () => '&n=ott770315' },
  { name: 'panel-onca', width: 1440, height: 900, query: () => '&n=ott42322' },
  { name: 'panel-onca-lower', width: 1440, height: 900, query: () => '&n=ott42322', act: scrollPanel(1) },
  { name: 'panel-coelacanth', width: 1440, height: 900, query: () => '&n=ott773491' },
  { name: 'panel-coelacanth-lower', width: 1440, height: 900, query: () => '&n=ott773491', act: scrollPanel(1) },
  { name: 'panel-beetle', width: 1440, height: 900, query: () => '&n=ott3349025' },
  { name: 'panel-beetle-lower', width: 1440, height: 900, query: () => '&n=ott3349025', act: scrollPanel(1) },
  { name: 'mobile-sheet-onca', width: 390, height: 844, dpr: 2, query: () => '&n=ott42322', act: dragSheet(-400) },
  { name: 'credits', width: 1440, height: 900, query: () => '', act: openCredits },
  { name: 'mobile-credits', width: 390, height: 844, dpr: 2, query: () => '', act: openCredits },
  // P9: the search palette.
  { name: 'search-open', width: 1440, height: 900, query: () => '', act: typeSearch('homo sap') },
  { name: 'search-empty', width: 1440, height: 900, query: () => '', act: typeSearch('xyzzyq') },
  { name: 'mobile-search-open', width: 390, height: 844, dpr: 2, query: () => '', act: typeSearch('felid') },
  // P11: common names, English and Portuguese.
  { name: 'search-jaguar', width: 1440, height: 900, query: () => '', act: typeSearch('jaguar') },
  { name: 'search-onca', width: 1440, height: 900, query: () => '', act: typeSearch('onça') },
  { name: 'search-human', width: 1440, height: 900, query: () => '', act: typeSearch('human') },
  { name: 'mobile-search-onca', width: 390, height: 844, dpr: 2, query: () => '', act: typeSearch('onça') },
  // P12: the no-WebGL2 fallback (forced with ?nowebgl), and a search from it.
  { name: 'nowebgl', width: 1440, height: 900, query: () => '&nowebgl' },
  { name: 'mobile-nowebgl', width: 390, height: 844, dpr: 2, query: () => '&nowebgl' },
  { name: 'nowebgl-panel', width: 1440, height: 900, query: () => '&nowebgl', act: chooseSearch('homo sapiens') },
  {
    name: 'precision',
    width: 1440,
    height: 900,
    query: () => '&debug=precision',
    precision: true,
  },
];

async function main(): Promise<void> {
  const only = process.argv.slice(2);
  const states = STATES.filter((s) => (only.length > 0 ? only : DEFAULTS).includes(s.name));
  const meta = (await (await fetch(`${BASE}/api/meta`)).json()) as MetaLite;
  await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch({ args: BROWSER_ARGS });
  try {
    for (const s of states) {
      const page = await browser.newPage({
        viewport: { width: s.width, height: s.height },
        deviceScaleFactor: s.dpr ?? 1,
      });
      page.on('console', (m) => {
        if (m.type() === 'error' || m.type() === 'warning') console.log(`  [${s.name}] ${m.text()}`);
      });
      page.on('pageerror', (e) => console.log(`  [${s.name}] page error: ${e.message}`));
      const url = `${BASE}/?shot${await s.query(meta, s.width, s.height)}`;
      const t0 = Date.now();
      await page.goto(url);
      if (s.precision) await page.waitForFunction(() => window.__precision !== undefined, null, { timeout: 300_000 });
      await page.waitForFunction(() => window.__renderIdle === true, null, { timeout: 300_000 });
      if (s.click) {
        await page.click(s.click);
        await page.waitForTimeout(100);
        await page.waitForFunction(() => window.__renderIdle === true, null, { timeout: 300_000 });
      }
      if (s.act) {
        await s.act(page);
        await page.waitForFunction(() => window.__renderIdle === true, null, { timeout: 300_000 });
      }
      const file = new URL(`${s.name}.png`, OUT);
      await page.screenshot({ path: file.pathname });
      const stats = await page.evaluate(() => window.__stats);
      const frameMs = await page.evaluate((n) => window.__bench?.(n), GPU ? 60 : 3);
      const precision = await page.evaluate(() => window.__precision);
      console.log(`${s.name} ${s.width}x${s.height}: ${file.pathname} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      console.log(`  url ${url}`);
      console.log(`  stats ${JSON.stringify(stats)} frame ${frameMs?.toFixed(2)} ms (${GPU ? 'GPU' : 'SwiftShader'})`);
      if (precision) console.log(`  precision ${JSON.stringify(precision)}`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
