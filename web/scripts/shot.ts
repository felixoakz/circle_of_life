// Visual QA screenshots (PLAN §10.2) and the renderer parity check
// (docs/plan-webgpu.md §5). Needs the server running on a fresh build
// (`pnpm -C web build`, then `make server`), then:
//
//   pnpm -C web shot                 # all states
//   pnpm -C web shot deep-homo       # just some states
//   SHOT_BASE=http://localhost:3077 pnpm -C web shot
//   SHOT_GPU=1 pnpm -C web shot      # hardware GPU (frame times)
//   SHOT_OUT=../screens/review-fixed pnpm -C web shot hidpi-overview   # another folder
//
// Renderers and parity:
//
//   SHOT_RENDERER=webgl|webgpu|both  # shots into screens/<renderer>/<state>.png
//   SHOT_COMPARE=../screens/baseline-webgl pnpm -C web shot   # diff against earlier shots
//   SHOT_QUERY='&passes=branches,arcs' pnpm -C web shot      # extra URL parameters for every state
//
// With `both`, the WebGPU shots are diffed against the WebGL ones; with
// SHOT_COMPARE, every shot is diffed against <dir>/<state>.png. Diffs go to
// screens/diff/<state>.png (red: over tolerance) plus report.json, a table
// is printed, and the run exits 1 when a state is over the thresholds. The
// `precision` state is not pixel-diffed (its frame depends on when the
// screenshot lands, docs/webgpu.md); its test result is compared instead,
// against <dir>/precision.json when that exists. Every shot also writes
// <state>.json (stats, frame time, GPU time from timestamp queries where the
// backend has them, the WebGPU adapter, precision) next to its PNG.
//
// Headless Chromium renders WebGL2 through SwiftShader (a CPU rasteriser), so
// it is slow but needs no GPU. WebGPU needs ANGLE on the host's GL driver
// (docs/webgpu.md), so WebGPU runs always use the SHOT_GPU flags. Each state
// opens a URL, waits for `window.__renderIdle`, checks `window.__renderer`,
// and writes the PNG (the state name says the size where it is not the
// 1440×900 desktop default, e.g. mobile-…). Camera positions use the `v` URL
// parameter (src/url.ts), computed from /api/meta.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type Browser, type Page, chromium } from 'playwright';
import { type DiffResult, decodePng, diffImages, encodePng } from './pixeldiff.ts';

const BASE = process.env.SHOT_BASE ?? 'http://localhost:3000';
// SHOT_GPU=1 renders on the machine's GPU instead of SwiftShader: real
// frame times, and the precision test runs on real GPU float maths.
const GPU = process.env.SHOT_GPU === '1';
const GPU_ARGS = ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'];
const SWIFTSHADER_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
/** docs/webgpu.md "Chosen headless flags": WebGPU canvases only work with ANGLE on native GL. */
const WEBGPU_ARGS = ['--enable-unsafe-webgpu', ...GPU_ARGS];
/** A folder given on the command line (relative to web/ under pnpm) as a file URL ending in '/'. */
const dirUrl = (dir: string): URL => new URL(`${pathToFileURL(resolve(dir)).href}/`);
const OUT = process.env.SHOT_OUT ? dirUrl(process.env.SHOT_OUT) : new URL('../../screens/', import.meta.url);

type RendererName = 'webgl' | 'webgpu';
/** What `window.__renderer` must say for each `?renderer=` value. */
const BACKEND: Record<RendererName, string> = { webgl: 'webgl2', webgpu: 'webgpu' };
const RENDERER_ENV = process.env.SHOT_RENDERER;
const RENDERERS: RendererName[] =
  RENDERER_ENV === 'both' ? ['webgl', 'webgpu'] : RENDERER_ENV === 'webgpu' ? ['webgpu'] : ['webgl'];
const COMPARE = process.env.SHOT_COMPARE ? dirUrl(process.env.SHOT_COMPARE) : null;
const EXTRA_QUERY = process.env.SHOT_QUERY ?? '';

/** Parity thresholds (docs/plan-webgpu.md §5). */
const TOL = 16;
const MAX_OVER_PCT = 0.5;
const MAX_MEAN_ABS = 1.0;
/** Precision without a reference: the plan's WebGPU bound, px. */
const PRECISION_MAX_PX = 0.25;

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

interface PrecisionLite {
  maxOffsetPx: number;
  meanOffsetPx: number;
  unmatched: number;
  lines: number;
}

interface Shot {
  state: State;
  renderer: RendererName;
  png: string;
  precision: PrecisionLite | undefined;
}

/** Folder for one renderer's shots: the plain output folder unless SHOT_RENDERER was given. */
function outDir(renderer: RendererName): URL {
  return RENDERER_ENV ? new URL(`${renderer}/`, OUT) : OUT;
}

async function shoot(browser: Browser, s: State, renderer: RendererName, meta: MetaLite): Promise<Shot> {
  const page = await browser.newPage({
    viewport: { width: s.width, height: s.height },
    deviceScaleFactor: s.dpr ?? 1,
  });
  const tag = `${renderer}/${s.name}`;
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`  [${tag}] ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`  [${tag}] page error: ${e.message}`));
  const url = `${BASE}/?shot&renderer=${renderer}${await s.query(meta, s.width, s.height)}${EXTRA_QUERY}`;
  const t0 = Date.now();
  try {
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
    const dir = outDir(renderer);
    const file = new URL(`${s.name}.png`, dir);
    await page.screenshot({ path: file.pathname });
    const backend = await page.evaluate(() => window.__renderer);
    const stats = await page.evaluate(() => window.__stats);
    // SwiftShader WebGL is slow, so 3 frames there; WebGPU on SwiftShader is far quicker (~10–100 ms).
    const frames = GPU || renderer === 'webgpu' ? 60 : 3;
    const bench = await page.evaluate((n) => window.__bench?.(n), frames);
    const frameMs = bench?.ms;
    const gpuMs = bench?.gpuMs ?? null;
    const adapter = await page.evaluate(() => window.__gpuAdapter ?? null);
    const precision = await page.evaluate(() => window.__precision);
    const gpuErrors = await page.evaluate(() => window.__gpuErrors);
    await writeFile(new URL(`${s.name}.json`, dir), `${JSON.stringify({ url, backend, adapter, stats, frameMs, gpuMs, frames, precision, gpuErrors }, null, 2)}\n`);
    console.log(`${s.name} ${s.width}x${s.height}: ${file.pathname} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    console.log(`  url ${url}`);
    const where = renderer === 'webgpu' ? (adapter ?? 'WebGPU') : GPU ? 'GPU' : 'SwiftShader';
    const gpuNote = gpuMs !== null ? `, gpu ${gpuMs.toFixed(2)} ms` : '';
    console.log(`  renderer ${backend} stats ${JSON.stringify(stats)} frame ${frameMs?.toFixed(2)} ms${gpuNote} (${where})`);
    if (precision) console.log(`  precision ${JSON.stringify(precision)}`);
    // The fallback page has no renderer; everything else must run on the one asked for.
    const expected = url.includes('nowebgl') ? 'none' : BACKEND[renderer];
    if (backend !== expected) throw new Error(`window.__renderer is ${backend}, expected ${expected}`);
    if (gpuErrors) throw new Error(`window.__gpuErrors is ${gpuErrors}`);
    return { state: s, renderer, png: file.pathname, precision };
  } finally {
    await page.close();
  }
}

interface Row {
  state: string;
  /** What was compared with what, e.g. "webgpu vs webgl". */
  pair: string;
  pixels?: Omit<DiffResult, 'heatmap'>;
  precision?: { ours: PrecisionLite; reference: PrecisionLite | null };
  diff?: string;
  pass: boolean;
  note?: string;
}

async function readPrecision(file: string): Promise<PrecisionLite | null> {
  if (!existsSync(file)) return null;
  const j = JSON.parse(await readFile(file, 'utf8')) as { precision?: PrecisionLite } & Partial<PrecisionLite>;
  return j.precision ?? (j.maxOffsetPx !== undefined ? (j as PrecisionLite) : null);
}

/** Diffs `ours` against the PNG at `refPng` (and precision against its JSON). */
async function compare(page: Page, ours: Shot, refPng: string, refJson: string, pair: string, diffName: string): Promise<Row> {
  const state = ours.state.name;
  if (ours.state.precision) {
    const reference = await readPrecision(refJson);
    const p = ours.precision;
    if (!p) return { state, pair, pass: false, note: 'no precision result' };
    // Exact reruns differ in the last digits of the mean only; 1e-4 px is far below anything visible.
    const pass = reference
      ? p.maxOffsetPx <= reference.maxOffsetPx + 1e-4 && p.unmatched <= reference.unmatched
      : p.maxOffsetPx <= PRECISION_MAX_PX;
    return { state, pair, precision: { ours: p, reference }, pass, note: reference ? undefined : 'no reference JSON' };
  }
  if (!existsSync(refPng)) return { state, pair, pass: false, note: `missing ${refPng}` };
  const a = await decodePng(page, new Uint8Array(await readFile(refPng)));
  const b = await decodePng(page, new Uint8Array(await readFile(ours.png)));
  if (a.width !== b.width || a.height !== b.height) {
    return { state, pair, pass: false, note: `size ${a.width}x${a.height} vs ${b.width}x${b.height}` };
  }
  const { heatmap, ...pixels } = diffImages(a.data, b.data, a.width, a.height, TOL);
  const diffDir = new URL('diff/', OUT);
  await mkdir(diffDir, { recursive: true });
  const diff = new URL(diffName, diffDir).pathname;
  await writeFile(diff, await encodePng(page, { width: a.width, height: a.height, data: heatmap }));
  const pass = pixels.overPct <= MAX_OVER_PCT && pixels.meanAbs <= MAX_MEAN_ABS;
  return { state, pair, pixels, diff, pass };
}

function printTable(rows: Row[]): void {
  console.log(`\nparity (tol ${TOL}; over% ≤ ${MAX_OVER_PCT}, meanAbs ≤ ${MAX_MEAN_ABS})`);
  console.log(`${'state'.padEnd(22)} ${'pair'.padEnd(26)} ${'over%'.padStart(8)} ${'meanAbs'.padStart(8)} ${'maxAbs'.padStart(6)}  result`);
  for (const r of rows) {
    let cols: string;
    if (r.pixels) {
      cols = `${r.pixels.overPct.toFixed(4).padStart(8)} ${r.pixels.meanAbs.toFixed(4).padStart(8)} ${String(r.pixels.maxAbs).padStart(6)}`;
    } else if (r.precision) {
      const o = r.precision.ours;
      const ref = r.precision.reference;
      cols = `precision max ${o.maxOffsetPx.toFixed(4)} px, ${o.unmatched} unmatched` +
        (ref ? ` (ref ${ref.maxOffsetPx.toFixed(4)}, ${ref.unmatched})` : '');
    } else {
      cols = ''.padStart(24);
    }
    console.log(`${r.state.padEnd(22)} ${r.pair.padEnd(26)} ${cols}  ${r.pass ? 'ok' : 'FAIL'}${r.note ? ` (${r.note})` : ''}`);
  }
}

async function main(): Promise<void> {
  const only = process.argv.slice(2);
  const states = STATES.filter((s) => (only.length > 0 ? only : DEFAULTS).includes(s.name));
  const meta = (await (await fetch(`${BASE}/api/meta`)).json()) as MetaLite;

  const shots: Shot[] = [];
  /** Shots that could not be taken or ran on the wrong backend; they fail the table too. */
  const failures: Row[] = [];
  for (const renderer of RENDERERS) {
    await mkdir(outDir(renderer), { recursive: true });
    const args = renderer === 'webgpu' ? WEBGPU_ARGS : GPU ? GPU_ARGS : SWIFTSHADER_ARGS;
    const browser = await chromium.launch({ args });
    try {
      for (const s of states) {
        try {
          shots.push(await shoot(browser, s, renderer, meta));
        } catch (err) {
          // A wrong backend fails the run but should not hide the other states.
          const note = err instanceof Error ? err.message : String(err);
          console.error(`  FAIL ${renderer}/${s.name}: ${note}`);
          failures.push({ state: s.name, pair: renderer, pass: false, note });
        }
      }
    } finally {
      await browser.close();
    }
  }

  const both = RENDERERS.length === 2;
  if (!COMPARE && !both) {
    if (failures.length > 0) process.exit(1);
    return;
  }

  // PNG decoding runs in a blank page of a plain browser.
  const decoder = await chromium.launch();
  const rows: Row[] = [...failures];
  try {
    const page = await decoder.newPage();
    for (const ours of shots) {
      const name = ours.state.name;
      if (COMPARE) {
        const pair = `${ours.renderer} vs ${decodeURIComponent(COMPARE.pathname.replace(/\/$/, '').split('/').pop() ?? '')}`;
        const diffName = both ? `${ours.renderer}-${name}.png` : `${name}.png`;
        rows.push(await compare(page, ours, new URL(`${name}.png`, COMPARE).pathname, new URL(`${name}.json`, COMPARE).pathname, pair, diffName));
      } else if (ours.renderer === 'webgpu') {
        const ref = shots.find((x) => x.renderer === 'webgl' && x.state === ours.state);
        if (!ref) continue;
        rows.push(await compare(page, ours, ref.png, ref.png.replace(/\.png$/, '.json'), 'webgpu vs webgl', `${name}.png`));
      }
    }
  } finally {
    await decoder.close();
  }

  printTable(rows);
  const diffDir = new URL('diff/', OUT);
  await mkdir(diffDir, { recursive: true });
  const report = new URL('report.json', diffDir).pathname;
  const thresholds = { tol: TOL, maxOverPct: MAX_OVER_PCT, maxMeanAbs: MAX_MEAN_ABS, precisionMaxPx: PRECISION_MAX_PX };
  await writeFile(report, `${JSON.stringify({ thresholds, gpu: GPU, rows }, null, 2)}\n`);
  console.log(`report ${report}`);
  if (rows.some((r) => !r.pass)) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
