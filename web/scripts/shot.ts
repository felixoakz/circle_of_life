// Visual QA screenshots (ARCHITECTURE §9.2), optionally diffed against an
// earlier set. Needs the server running on a fresh build
// (`pnpm -C web build`, then `make server`), then:
//
//   pnpm -C web shot                 # all states
//   pnpm -C web shot deep-homo       # just some states
//   SHOT_BASE=http://localhost:3077 pnpm -C web shot
//   SHOT_GPU=1 pnpm -C web shot      # hardware GPU (frame times)
//   SHOT_OUT=../screens/review-fixed pnpm -C web shot hidpi-overview   # another folder
//
// Comparing:
//
//   SHOT_COMPARE=../screens/baseline pnpm -C web shot        # diff against earlier shots
//   SHOT_QUERY='&passes=branches,arcs' pnpm -C web shot      # extra URL parameters for every state
//
// With SHOT_COMPARE, every shot is diffed against <dir>/<state>.png. Diffs go
// to <out>/diff/<state>.png (red: over tolerance) plus report.json, a table
// is printed, and the run exits 1 when a state is over the thresholds. The
// `precision` state is not pixel-diffed (its frame depends on when the
// screenshot lands); its test result is compared instead, against
// <dir>/precision.json when that exists. Every shot also writes <state>.json
// (stats, frame time, precision) next to its PNG.
//
// Headless Chromium renders WebGL2 through SwiftShader (a CPU rasteriser), so
// it is slow but needs no GPU. Each state opens a URL, waits for
// `window.__renderIdle`, checks that `window.__renderer` says `webgl2`,
// and writes the PNG (the state name says the size where it is not the
// 1440×900 desktop default, e.g. mobile-…). Views use the `n` (selection)
// and `v` (rotation and zoom, no pan) URL parameters (src/url.ts), computed
// from /api/meta and /api/nodes. The `locked-*` states are the review set
// for the locked view (no pan, fixed card; DESIGN.md §4):
//
//   SHOT_OUT=../screens/locked pnpm -C web shot locked
//
// The `free-*` states are free view's (DESIGN.md §4.1 "Free view"): links
// with the pan (`v=a,r,z,rot`) and the padlock pressed.

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
/** A folder given on the command line (relative to web/ under pnpm) as a file URL ending in '/'. */
const dirUrl = (dir: string): URL => new URL(`${pathToFileURL(resolve(dir)).href}/`);
const OUT = process.env.SHOT_OUT ? dirUrl(process.env.SHOT_OUT) : new URL('../../screens/', import.meta.url);

const COMPARE = process.env.SHOT_COMPARE ? dirUrl(process.env.SHOT_COMPARE) : null;
const EXTRA_QUERY = process.env.SHOT_QUERY ?? '';

/** Diff thresholds: a pixel is over when a channel differs by more than TOL. */
const TOL = 16;
const MAX_OVER_PCT = 0.5;
const MAX_MEAN_ABS = 1.0;
/** Precision without a reference: the bound, px (WebGL2 on an AMD iGPU measured 0.215). */
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
  /** Something to do once idle (hover, search, scroll the card), then wait for idle again. */
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

/** Shows one of the card's tabs (nothing in the card scrolls; DESIGN.md §4.2). */
function showTab(tab: 'overview' | 'range' | 'tree'): (page: Page) => Promise<void> {
  return async (page) => {
    await page.click(`#panel-tab-${tab}`);
    await page.waitForTimeout(300);
  };
}

/** Opens Data & credits from the wordmark menu. */
async function openCredits(page: Page): Promise<void> {
  await page.click('.wordmark-button');
  await page.click('.menu-item');
  await page.waitForTimeout(300);
}

/** The `v` parameter: the angle at the anchor (u32 units) and log2 of the zoom in CSS px per unit. */
function v(a: number, scaleCss: number): string {
  return `&v=${Math.round(a)},${Math.log2(scaleCss).toFixed(4)}`;
}

/** A free view `v`: the screen centre at angle `a` (u32 units) and radius `r`, the zoom, the rotation in degrees. */
function fv(a: number, r: number, scaleCss: number, rotDeg: number): string {
  return `&v=${Math.round(a)},${r},${Math.log2(scaleCss).toFixed(4)},${rotDeg}`;
}

/** The rotation (degrees) that turns the radius at angle `a` (u32 units) straight up the screen: the rim at the top. */
function rimUp(a: number): number {
  return +(90 - (a / TWO_32) * 360).toFixed(3);
}

/** A node's angle and radius, from the read API. */
async function nodePoint(id: string): Promise<{ a: number; r: number; span: number }> {
  const n = (await (await fetch(`${BASE}/api/nodes/${id}`)).json()) as { angle: number; r: number; arcLo: number; arcHi: number };
  return { a: n.angle, r: n.r, span: n.arcHi - n.arcLo };
}

/** Scale (CSS px per world unit) at which λ equals `lambda`. */
function scaleForLambda(meta: MetaLite, lambda: number): number {
  return (2 ** lambda * meta.tileP * 0.5) / TAU;
}

/** The deepest zoom: 48 px between tips (ARCHITECTURE §7.5). */
function maxScale(meta: MetaLite): number {
  return (48 * meta.tipCount) / TAU;
}

/** Below any window's minimum zoom: the app clamps it to the minimum. */
const MIN_SCALE = 1;

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

/** A named node selected and on the anchor, at `scale` (default max zoom). */
function deepAt(name: string, scale?: (meta: MetaLite) => number): State['query'] {
  return async (meta) => {
    const id = await ottOf(name);
    const { a } = await nodeSpan(meta, id);
    return `&n=${id}${v(a, scale ? scale(meta) : maxScale(meta))}`;
  };
}

/** A node selected by id and on the anchor, at `scale`. */
function nodeAt(id: string, scale: (meta: MetaLite) => number): State['query'] {
  return async (meta) => `&n=${id}${v((await nodeSpan(meta, id)).a, scale(meta))}`;
}

/** The first (largest) child of a named node: e.g. a species of a genus. */
async function firstChild(name: string): Promise<string> {
  const n = (await (await fetch(`${BASE}/api/nodes/${await ottOf(name)}`)).json()) as {
    children: { top: { nodeId: string }[] };
  };
  const c = n.children.top[0];
  if (!c) throw new Error(`${name} has no children`);
  return c.nodeId;
}

/** The midpoint of a group's largest run on the anchor, at view level λ. */
function groupAt(group: number, lambda: number): State['query'] {
  return (meta) => {
    const runs = meta.runs.filter((r) => r.group === group);
    const run = runs.sort((x, y) => y.angleHi - y.angleLo - (x.angleHi - x.angleLo))[0];
    const a = run ? (run.angleLo + run.angleHi) / 2 : 0;
    return v(a, scaleForLambda(meta, lambda));
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

/** The unnamed Xylariales clade of the reference composition (docs: the user's image 2). */
const XYLARIALES_MRCA = 'mrcaott68082ott105382';

const STATES: State[] = [
  { name: 'overview', width: 1440, height: 900, query: () => '' },
  // The animals' largest run on the anchor at λ ≈ 5, then Mammalia at mid zoom.
  { name: 'animals', width: 1440, height: 900, query: groupAt(0, 5) },
  {
    name: 'mammals',
    width: 1440,
    height: 900,
    query: async (meta, w) => {
      const { span } = await nodeSpan(meta, 'ott244265');
      return `&n=ott244265${v((await nodeSpan(meta, 'ott244265')).a, w / (4 * span * (TAU / TWO_32)))}`;
    },
  },
  // Max zoom at Homo sapiens as in docs/reference/1.png: the rim vertical at the anchor.
  { name: 'deep-homo', width: 1440, height: 900, query: deepAt('Homo sapiens') },
  // The kingdom key: selects the fungi and flies there.
  { name: 'key-fungi', width: 1440, height: 900, query: () => '', click: '.kingdom-key li:nth-child(2) button' },
  // Max zoom on Pan (review P1-1: the Pan bracket).
  { name: 'crumb-fly', width: 1440, height: 900, query: nodeAt('ott417957', maxScale) },
  // The locked view (DESIGN.md §4): SHOT_OUT=../screens/locked pnpm -C web shot locked
  { name: 'locked-min-2000', width: 2000, height: 1030, query: () => '' },
  { name: 'locked-clade-min-2000', width: 2000, height: 1030, query: nodeAt(XYLARIALES_MRCA, () => MIN_SCALE) },
  { name: 'locked-mid-2000', width: 2000, height: 1030, query: () => '&n=ott563159' },
  {
    name: 'locked-max-tetramerium-2000',
    width: 2000,
    height: 1030,
    query: async (meta) => {
      const id = await firstChild('Tetramerium');
      return `&n=${id}${v((await nodeSpan(meta, id)).a, maxScale(meta))}`;
    },
  },
  { name: 'locked-clade-mid-2000', width: 2000, height: 1030, query: () => `&n=${XYLARIALES_MRCA}` },
  // The user's image 4: the clade selected, then turned and zoomed away so it is off screen (the leader points at it).
  {
    name: 'locked-offscreen-clade-2000',
    width: 2000,
    height: 1030,
    query: async (meta) => {
      const { a } = await nodeSpan(meta, XYLARIALES_MRCA);
      const slot = TWO_32 / meta.tipCount;
      return `&n=${XYLARIALES_MRCA}${v((a + 30_000 * slot) % TWO_32, (0.06 * meta.tipCount) / TAU)}`;
    },
  },
  // The user's image 6: mid zoom (~33k species in view) on E. coli UMEA 3323-1; the anchor has already slid a little left.
  { name: 'locked-mid-ecoli-2000', width: 2000, height: 1030, query: nodeAt('ott950808', (meta) => (0.034 * meta.tipCount) / TAU) },
  // The slide's progression: Homo sapiens from minimum zoom to names, evenly in log zoom.
  ...[MIN_SCALE, 0.004, 0.04, 0.4, 20].map((spacing, i) => ({
    name: `locked-zoomstep-${i + 1}`,
    width: 2000,
    height: 1030,
    query: nodeAt('ott770315', (meta: MetaLite) => (i === 0 ? MIN_SCALE : (spacing * meta.tipCount) / TAU)),
  })),
  // The idle tour's first hop (?shot keeps the wheel still; ?tour=6 turns the tour on with a 6 s dwell).
  {
    name: 'locked-tour-hop',
    width: 2000,
    height: 1030,
    query: () => '&tour=6',
    act: async (page) => {
      await page.waitForFunction(() => !document.querySelector('#panel-title')?.textContent?.includes('Homo sapiens'), null, {
        timeout: 60_000,
      });
      await page.waitForFunction(() => window.__scene?.flight.active() === false, null, { timeout: 60_000 });
    },
  },
  // The user's image 5: the clade near maximum zoom (the anchor has drifted left; rows beside the card keep their names).
  { name: 'locked-near-max-clade-2000', width: 2000, height: 1030, query: nodeAt(XYLARIALES_MRCA, (meta) => (37 * meta.tipCount) / TAU) },
  { name: 'locked-laptop-min', width: 1440, height: 900, query: () => '' },
  { name: 'locked-laptop-deep', width: 1440, height: 900, query: deepAt('Homo sapiens') },
  { name: 'locked-mobile-min', width: 390, height: 844, dpr: 2, query: () => '' },
  { name: 'locked-mobile-deep', width: 390, height: 844, dpr: 2, query: deepAt('Homo sapiens') },
  { name: 'locked-mobile-clade', width: 390, height: 844, dpr: 2, query: () => '&n=ott563159' },
  { name: 'locked-old-link', width: 1440, height: 900, query: () => '&n=ott770315&v=1780855860,0.99999,24.1,-149.3' },
  { name: 'locked-1280', width: 1280, height: 800, query: () => '' },
  // Free view (DESIGN.md §4.1): the padlock pressed on the default view, then
  // the inner tree round Rhabditophora (a class at r 0.71), turned so the rim
  // is up and at an arbitrary rotation, and deep zooms off and on the rim.
  { name: 'free-button-2000', width: 2000, height: 1030, query: () => '', act: (page) => page.keyboard.press('f') },
  { name: 'free-mobile', width: 390, height: 844, dpr: 2, query: () => '', act: (page) => page.click('.zoom-free') },
  {
    name: 'free-mid-rhabditophora-2000',
    width: 2000,
    height: 1030,
    query: async () => {
      const n = await nodePoint('ott3669734');
      // The node's connector fills about a third of the width, a quarter of the height below the centre.
      const scale = 2000 / (3 * n.r * n.span * (TAU / TWO_32));
      return `&n=ott3669734${fv(n.a, n.r + 260 / scale, scale, rimUp(n.a))}`;
    },
  },
  {
    name: 'free-mid-rhabditophora-turned-2000',
    width: 2000,
    height: 1030,
    query: async () => {
      // Rhabditophora's node and its children's (Seriata, r 0.75) along the
      // screen, the rim off to the lower right: clade names on their arcs.
      const n = await nodePoint('ott3669734');
      return `&n=ott3669734${fv(n.a, 0.745, 25000, rimUp(n.a) - 115)}`;
    },
  },
  {
    name: 'free-deep-inner-2000',
    width: 2000,
    height: 1030,
    query: async () => {
      const n = await nodePoint('ott3669734');
      // Deep among the inner branches, well inside the rim (no tips on screen).
      return `&n=ott3669734${fv(n.a, 0.93, 1e7, rimUp(n.a))}`;
    },
  },
  {
    name: 'free-deep-rim-turned-2000',
    width: 2000,
    height: 1030,
    query: async () => {
      const n = await nodePoint('ott3669734');
      // Tip names at deep zoom with the rim across the middle at 30°, not at the anchor.
      return `&n=ott3669734${fv(n.a, 1, 2e6, rimUp(n.a) - 60)}`;
    },
  },
  {
    name: 'free-precision-mid',
    width: 1440,
    height: 900,
    query: async () => {
      const n = await nodePoint('ott3669734');
      return `&debug=precision${fv(n.a, 0.93, 1e7, 0)}`;
    },
    precision: true,
  },
  {
    name: 'locked-search',
    width: 1440,
    height: 900,
    query: () => '',
    act: chooseSearch('Panthera onca'),
  },
  // Extra states from the P7 review (SHOT_OUT=../screens/review-fixed).
  { name: 'hidpi-overview', width: 2560, height: 1440, dpr: 2, query: () => '' },
  { name: 'reduced', width: 1440, height: 900, query: () => '&reduced' },
  { name: 'mobile-overview', width: 390, height: 844, dpr: 2, query: () => '' },
  { name: 'desktop-1280-overview', width: 1280, height: 800, query: () => '' },
  { name: 'mid-l4.5-animals', width: 1440, height: 900, query: groupAt(0, 4.5) },
  { name: 'mid-l6.5-protists', width: 1440, height: 900, query: groupAt(3, 6.5) },
  { name: 'mid-archaea', width: 1440, height: 900, query: groupAt(5, 10) },
  { name: 'deep-archaea', width: 1440, height: 900, query: deepAt('Halobacterium salinarum') },
  { name: 'deep-quercus', width: 1440, height: 900, query: deepAt('Quercus petraea') },
  { name: 'deep-amanita', width: 1440, height: 900, query: deepAt('Amanita muscaria') },
  { name: 'deep-ecoli', width: 1440, height: 900, query: deepAt('Escherichia coli') },
  // The user's tip-bar report: species branches run straight into their names.
  { name: 'deep-tetramerium', width: 1440, height: 900, query: deepAt('Tetramerium') },
  // Tip bars as they fade in at the rim (λ 13–15.5: 0.9–5 px between tips).
  { name: 'rim-l13', width: 1440, height: 900, query: groupAt(0, 13) },
  { name: 'rim-l14', width: 1440, height: 900, query: groupAt(0, 14) },
  { name: 'rim-l15.5', width: 1440, height: 900, query: groupAt(0, 15.5) },
  { name: 'hidpi-deep-homo', width: 1440, height: 900, dpr: 2, query: deepAt('Homo sapiens') },
  { name: 'mobile-deep-homo', width: 390, height: 844, dpr: 2, query: deepAt('Homo sapiens') },
  // P8: the card, hover and the phone card. No `v`: the view cuts to the
  // node, zoomed to suit it.
  { name: 'panel-homo', width: 1440, height: 900, query: () => '&n=ott770315' },
  { name: 'panel-felidae', width: 1440, height: 900, query: () => '&n=ott563159' },
  { name: 'panel-mrca', width: 1440, height: 900, query: () => '&n=mrcaott54737ott660452' },
  {
    name: 'hover-path',
    width: 1440,
    height: 900,
    query: async (meta, w) => {
      const { a, span } = await nodeSpan(meta, 'ott244265');
      return v(a, w / (4 * span * (TAU / TWO_32)));
    },
    act: hoverNear(0.45, 0.35),
  },
  { name: 'hover-overview', width: 1440, height: 900, query: () => '', act: hoverNear(0.42, 0.42) },
  { name: 'mobile-card', width: 390, height: 844, dpr: 2, query: () => '&n=ott770315' },
  // P10: the about section (needs the live APIs or a warm cache.db), the credits dialog.
  { name: 'panel-homo-about', width: 1440, height: 900, query: () => '&n=ott770315' },
  { name: 'panel-onca', width: 1440, height: 900, query: () => '&n=ott42322' },
  { name: 'panel-onca-lower', width: 1440, height: 900, query: () => '&n=ott42322', act: showTab('tree') },
  { name: 'panel-coelacanth', width: 1440, height: 900, query: () => '&n=ott773491' },
  { name: 'panel-coelacanth-lower', width: 1440, height: 900, query: () => '&n=ott773491', act: showTab('tree') },
  { name: 'panel-beetle', width: 1440, height: 900, query: () => '&n=ott3349025' },
  { name: 'panel-beetle-lower', width: 1440, height: 900, query: () => '&n=ott3349025', act: showTab('tree') },
  { name: 'mobile-card-onca', width: 390, height: 844, dpr: 2, query: () => '&n=ott42322' },
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
  png: string;
  precision: PrecisionLite | undefined;
}

async function shoot(browser: Browser, s: State, meta: MetaLite): Promise<Shot> {
  const page = await browser.newPage({
    viewport: { width: s.width, height: s.height },
    deviceScaleFactor: s.dpr ?? 1,
  });
  const tag = s.name;
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`  [${tag}] ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`  [${tag}] page error: ${e.message}`));
  const url = `${BASE}/?shot${await s.query(meta, s.width, s.height)}${EXTRA_QUERY}`;
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
    const file = new URL(`${s.name}.png`, OUT);
    await page.screenshot({ path: file.pathname });
    const backend = await page.evaluate(() => window.__renderer);
    const stats = await page.evaluate(() => window.__stats);
    // SwiftShader is slow (hundreds of ms a frame), so 3 frames there.
    const frames = GPU ? 60 : 3;
    const frameMs = await page.evaluate((n) => window.__bench?.(n), frames);
    const precision = await page.evaluate(() => window.__precision);
    await writeFile(new URL(`${s.name}.json`, OUT), `${JSON.stringify({ url, backend, stats, frameMs, frames, precision }, null, 2)}\n`);
    console.log(`${s.name} ${s.width}x${s.height}: ${file.pathname} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    console.log(`  url ${url}`);
    const where = GPU ? 'GPU' : 'SwiftShader';
    console.log(`  renderer ${backend} stats ${JSON.stringify(stats)} frame ${frameMs?.toFixed(2)} ms (${where})`);
    if (precision) console.log(`  precision ${JSON.stringify(precision)}`);
    // The fallback page has no renderer; everything else must draw with WebGL2.
    const expected = url.includes('nowebgl') ? 'none' : 'webgl2';
    if (backend !== expected) throw new Error(`window.__renderer is ${backend}, expected ${expected}`);
    return { state: s, png: file.pathname, precision };
  } finally {
    await page.close();
  }
}

interface Row {
  state: string;
  /** What was compared with what, e.g. "ours vs baseline". */
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
  console.log(`\ndiff (tol ${TOL}; over% ≤ ${MAX_OVER_PCT}, meanAbs ≤ ${MAX_MEAN_ABS})`);
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
  // A name picks that state; a prefix such as `locked` picks every `locked-…` state.
  const wanted = only.length > 0 ? only : DEFAULTS;
  const states = STATES.filter((s) => wanted.some((w) => s.name === w || s.name.startsWith(`${w}-`)));
  const meta = (await (await fetch(`${BASE}/api/meta`)).json()) as MetaLite;

  const shots: Shot[] = [];
  /** Shots that could not be taken or drew with the wrong renderer; they fail the table too. */
  const failures: Row[] = [];
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ args: GPU ? GPU_ARGS : SWIFTSHADER_ARGS });
  try {
    for (const s of states) {
      try {
        shots.push(await shoot(browser, s, meta));
      } catch (err) {
        // A failed state fails the run but should not hide the other states.
        const note = err instanceof Error ? err.message : String(err);
        console.error(`  FAIL ${s.name}: ${note}`);
        failures.push({ state: s.name, pair: 'shot', pass: false, note });
      }
    }
  } finally {
    await browser.close();
  }

  if (!COMPARE) {
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
      const pair = `ours vs ${decodeURIComponent(COMPARE.pathname.replace(/\/$/, '').split('/').pop() ?? '')}`;
      rows.push(await compare(page, ours, new URL(`${name}.png`, COMPARE).pathname, new URL(`${name}.json`, COMPARE).pathname, pair, `${name}.png`));
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
