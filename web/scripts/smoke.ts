// End-to-end smoke test (ARCHITECTURE §9.3): load the app,
// expect the card on Homo sapiens (the default selection), search "panthera
// onca", choose the first result, and expect the card to show the jaguar,
// with the selection in the URL. Runs:
//
//   default             draws with WebGL2
//   ?nowebgl            the fallback page, where search and the card still work
//   interactions        the locked view (DESIGN.md §4, §8): the wheel zooms
//                       about the anchor, a drag turns the wheel and never
//                       zooms, Esc keeps the selection, a click selects and
//                       turns the node onto the anchor, an old pan link parses
//   card and chrome     the card's head (common name lead, no copy glyph in
//                       the heading), the "i" button's Data & credits,
//                       the empty search palette's Try rows, the announcer
//   boot failure        /api/meta failing shows "Couldn’t load the tree. Reload"
//   card tabs           the tabs pattern (roles, roving tabindex, ←/→/Home/End
//                       without walking the tree), the picked tab kept for the
//                       next selection, no tab that scrolls for a few rich
//                       species and a clade at 2000×1030, 1440×900, 1280×720
//                       and 390×844, and the search bar's size and place
//   motion              without reduced motion (?tour=1.5: 1.5 s dwell): a
//                       plain visit opens Homo sapiens, the idle tour hops
//                       to another species without adding history (with the
//                       mouse resting on the wheel), an input
//                       stops it, and a fling decays
//
// Every other run uses ?reduced, which (like ?still and ?shot) turns the
// ambient turn, the fling and the tour off, so the scene can go idle.
//
// Every drawn run uses reduced motion, so choosing the result is a cut with
// a crossfade; the snapshot of the tree canvas must not be black (it is
// taken in the task that drew the frame).
//
//   make smoke                                        # builds, starts a server, runs this
//   SMOKE_BASE=http://localhost:3000 pnpm -C web test:e2e   # against a running server
//
// Headless Chromium draws WebGL2 through SwiftShader, so no GPU is needed.

import assert from 'node:assert/strict';
import { type Browser, type Page, chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:3000';
const TIMEOUT = 60_000;
const SWIFTSHADER_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

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

/** The card's title once it reads `name`. */
async function cardShows(page: Page, name: string): Promise<void> {
  await page.waitForFunction((n) => document.querySelector('#panel-title')?.textContent?.includes(n), name, {
    timeout: TIMEOUT,
  });
  const title = (await page.locator('#panel-title').textContent()) ?? '';
  assert.equal(title.trim().startsWith(name), true, `card title "${title}"`);
}

/** The jaguar: its OpenTree id, for the URL checks. */
const JAGUAR = 'ott42322';

async function searchAndOpen(page: Page): Promise<void> {
  await page.keyboard.press('/');
  await page.waitForSelector('.search-layer.open', { timeout: TIMEOUT });
  await page.keyboard.type('panthera onca', { delay: 10 });
  // The first row is the best match: the species itself.
  const first = page.locator('.search-row').first();
  await first.waitFor({ timeout: TIMEOUT });
  assert.match((await first.textContent()) ?? '', /Panthera onca/);
  await page.keyboard.press('Enter');
  await cardShows(page, 'Panthera onca');
}

/** Checks after the cut: selection in the URL, canvas visible, crossfade snapshot not black. */
async function drawnChecks(page: Page): Promise<void> {
  await page.waitForFunction((id) => location.search.includes(`n=${id}`), JAGUAR, { timeout: TIMEOUT });
  assert.equal(await page.locator('#tree').isVisible(), true);
  const lit = await page.evaluate(() => window.__crossfadeLit);
  assert.ok(lit !== undefined, 'the cut made a crossfade snapshot of the tree');
  assert.ok(lit > 0.005, `crossfade snapshot of the tree is not black (lit ${(lit * 100).toFixed(2)}%)`);
  console.log(`     crossfade snapshot of the tree: ${(lit * 100).toFixed(1)}% lit`);
}

/** The rig's pose and the world point at the anchor (needs ?debug for window.__scene). */
async function pose(
  page: Page,
): Promise<{ theta: number; scale: number; minScale: number; atAnchor: { theta: number; r: number } }> {
  return page.evaluate(() => {
    const scene = window.__scene;
    if (!scene) throw new Error('window.__scene missing (needs ?debug)');
    const rig = scene.rig;
    const a = rig.anchor();
    return { theta: rig.theta, scale: rig.scale, minScale: rig.minScale(), atAnchor: scene.camera.screenToPolar(a.x, a.y) };
  });
}

/** The card's title text. */
async function cardTitle(page: Page): Promise<string> {
  return ((await page.locator('#panel-title').textContent()) ?? '').trim();
}

/** The wheel's own motion: default Homo sapiens, the idle tour, input stops it, a fling decays. */
async function motionChecks(browser: Browser): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const t0 = Date.now();
  try {
    await page.goto(`${BASE}/?debug&tour=1.5`);
    await cardShows(page, 'Homo sapiens');
    const start = await pose(page);
    assert.ok(Math.abs(start.scale - start.minScale) < 1e-6 * start.minScale, 'a plain visit opens at minimum zoom');
    const historyBefore = await page.evaluate(() => history.length);

    // Left alone, the tour moves on (dwell 1.5 s, plus the intro and a 2.4 s
    // flight), even with the mouse resting over the wheel (on a node).
    const rest = await anchorCss(page);
    await page.mouse.move(rest.x - 120, rest.y + 60);
    await page.waitForFunction(() => !document.querySelector('#panel-title')?.textContent?.includes('Homo sapiens'), null, {
      timeout: TIMEOUT,
    });
    const hop = await cardTitle(page);
    assert.match(page.url(), /n=ott\d+/, 'the tour step is in the URL');
    assert.equal(await page.evaluate(() => history.length), historyBefore, 'tour steps replace history, not push');
    console.log(`     tour: Homo sapiens → ${hop}`);

    // An input stops it: nothing changes for well over a dwell.
    await page.keyboard.press('Shift');
    await page.waitForFunction(() => window.__scene?.flight.active() === false, null, { timeout: TIMEOUT });
    const stoppedAt = await cardTitle(page);
    assert.equal(await page.evaluate(() => window.__scene?.tour?.isStopped()), true, 'an input stops the tour');
    await page.waitForTimeout(3000);
    assert.equal(await cardTitle(page), stoppedAt, 'no tour step after an input');

    // A fling spins on and decays. Headless SwiftShader frames take ~0.4 s,
    // so a real drag is never fast enough to fling here: release one at a
    // drag-like speed (0.5 px/ms at the anchor) through the same hook the
    // pointer uses, and watch the frame loop decay it.
    await page.evaluate(() => {
      const scene = window.__scene;
      if (!scene) throw new Error('window.__scene missing (needs ?debug)');
      scene.input.onFling(-0.5 / scene.rig.scale);
    });
    const v1 = await page.evaluate(() => Math.abs(window.__scene?.spin.velocity() ?? 0));
    await page.waitForTimeout(1500);
    const v2 = await page.evaluate(() => Math.abs(window.__scene?.spin.velocity() ?? 0));
    assert.ok(v1 > 0, `the release flings the wheel (v ${v1})`);
    assert.ok(v2 < v1 / 5, `the fling decays (${v1.toExponential(2)} → ${v2.toExponential(2)} rad/ms)`);
    console.log(`     fling: ${v1.toExponential(2)} → ${v2.toExponential(2)} rad/ms after 1.5 s`);
    assert.deepEqual(errors, [], 'no uncaught page errors');
    console.log(`ok   motion: default, tour, stop, fling (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } finally {
    await page.close();
  }
}

/** The anchor in CSS px. */
async function anchorCss(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const scene = window.__scene;
    if (!scene) throw new Error('window.__scene missing (needs ?debug)');
    const a = scene.rig.anchor();
    return { x: a.x / scene.camera.dpr, y: a.y / scene.camera.dpr };
  });
}

/** The locked view's interactions (DESIGN.md §4, §8), on the default view of Homo sapiens. */
async function interactionChecks(page: Page): Promise<void> {
  await cardShows(page, 'Homo sapiens');
  assert.equal(await page.locator('.panel-close').count(), 0, 'the card has no close button');
  const anchor = await anchorCss(page);
  const p0 = await pose(page);
  assert.ok(Math.abs(p0.scale - p0.minScale) < 1e-6 * p0.minScale, 'a plain visit opens at minimum zoom');
  // Homo sapiens' rim point sits on the anchor.
  assert.ok(Math.abs(p0.atAnchor.r - 1) < 1e-6, `the rim is at the anchor (r ${p0.atAnchor.r})`);

  // The wheel zooms about the anchor: the world point there stays put.
  await page.mouse.move(300, 600);
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -400);
  await page.waitForFunction(() => window.__renderIdle === true, null, { timeout: TIMEOUT });
  const p1 = await pose(page);
  assert.ok(p1.scale > p0.scale * 2, `zoomed in (${p0.scale} → ${p1.scale})`);
  assert.ok(Math.abs(p1.theta - p0.theta) < 1e-12, 'zooming does not turn the wheel');
  assert.ok(Math.abs(p1.atAnchor.theta - p0.atAnchor.theta) < 1e-9, 'the point at the anchor stays put');
  console.log(`     wheel: zoom ×${(p1.scale / p0.scale).toFixed(1)} about the anchor`);

  // A drag turns the wheel and never zooms or pans.
  await page.mouse.move(anchor.x - 200, anchor.y + 200);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(anchor.x - 200 + i * 15, anchor.y + 200 + i * 10);
  await page.mouse.up();
  await page.waitForFunction(() => window.__renderIdle === true, null, { timeout: TIMEOUT });
  const p2 = await pose(page);
  assert.equal(p2.scale, p1.scale, 'a drag keeps the zoom');
  assert.ok(Math.abs(p2.theta - p1.theta) > 1e-6, 'a drag turns the wheel');
  assert.ok(Math.abs(p2.atAnchor.r - 1) < 1e-6, 'the anchor is still on the rim (no pan)');
  console.log(`     drag: turned ${(((p2.theta - p1.theta) * 180) / Math.PI).toFixed(2)}°`);

  // The zoom strip: dragging it up zooms about the anchor; the slider says so.
  const track = await page.locator('.zoom-track').boundingBox();
  if (!track) throw new Error('no zoom strip');
  const unzoomed = await pose(page);
  await page.mouse.move(track.x + track.width / 2, track.y + track.height - 2);
  await page.mouse.down();
  // Up 60% of the scale, whatever its length (two thirds of the window).
  for (let i = 1; i <= 5; i++) await page.mouse.move(track.x + track.width / 2, track.y + track.height - 2 - i * 0.12 * track.height);
  await page.mouse.up();
  await page.waitForFunction(() => window.__renderIdle === true, null, { timeout: TIMEOUT });
  const zoomed = await pose(page);
  assert.ok(zoomed.scale > unzoomed.scale * 4, `the strip zooms in (${unzoomed.scale.toFixed(0)} → ${zoomed.scale.toFixed(0)})`);
  assert.ok(Math.abs(zoomed.atAnchor.theta - unzoomed.atAnchor.theta) < 1e-9, 'the strip zooms about the anchor');
  const now = Number(await page.locator('.zoom-track').getAttribute('aria-valuenow'));
  assert.ok(now > 2 && now < 100, `the slider reads the zoom (${now}%)`);
  console.log(`     zoom strip: ×${(zoomed.scale / unzoomed.scale).toFixed(1)}, reads ${now}%`);

  // Esc keeps the selection.
  await page.keyboard.press('Escape');
  await cardShows(page, 'Homo sapiens');

  // + zooms about the anchor too; reset goes back to minimum zoom with the selection on the anchor.
  await page.click('.zoom-reset');
  await page.waitForFunction(() => window.__renderIdle === true, null, { timeout: TIMEOUT });
  const p3 = await pose(page);
  assert.ok(Math.abs(p3.scale - p0.scale) < 1e-6 * p0.scale, 'reset: minimum zoom');
  assert.ok(Math.abs(p3.theta - p0.theta) < 1e-9, 'reset: the selection back on the anchor');

  // A click on the wheel selects a node and turns it onto the anchor (zoom kept).
  const before = await page.evaluate(() => location.search);
  // Just inside the rim, a little way round from the anchor: the tips there are picked.
  const target = await page.evaluate(() => {
    const scene = window.__scene;
    if (!scene) throw new Error('window.__scene missing (needs ?debug)');
    const p = scene.camera.polarToScreen(scene.rig.theta - 0.12, 0.995);
    return { x: p.x / scene.camera.dpr, y: p.y / scene.camera.dpr };
  });
  await page.mouse.click(target.x, target.y);
  await page.waitForFunction((b) => location.search !== b && location.search.includes('n='), before, { timeout: TIMEOUT });
  await page.waitForFunction(() => window.__renderIdle === true, null, { timeout: TIMEOUT });
  const p4 = await pose(page);
  assert.ok(Math.abs(p4.scale - p3.scale) < 1e-6 * p3.scale, 'a click keeps the zoom');
  const turned = await page.evaluate(() => {
    const scene = window.__scene;
    const sel = document.querySelector('#panel-title')?.textContent ?? '';
    return { sel, theta: scene?.rig.theta ?? 0 };
  });
  console.log(`     click: selected ${turned.sel.trim()} (${new URL(page.url()).search})`);
}

/** The world point (x, y) under a CSS px screen point, and whether the view is free (needs ?debug). */
async function under(page: Page, x: number, y: number): Promise<{ x: number; y: number; free: boolean }> {
  return page.evaluate(
    ([px, py]) => {
      const scene = window.__scene;
      if (!scene) throw new Error('window.__scene missing (needs ?debug)');
      const dpr = scene.camera.dpr;
      const w = scene.camera.screenToWorld(px * dpr, py * dpr);
      return { x: w.x, y: w.y, free: scene.rig.isFree() };
    },
    [x, y] as const,
  );
}

/** Free view (DESIGN.md §4.1): F, pan, zoom about the cursor, the URL, Esc back, the padlock (reduced motion: cuts). */
async function freeViewChecks(page: Page): Promise<void> {
  await cardShows(page, 'Homo sapiens');
  const button = page.locator('.zoom-free');
  assert.equal(await button.getAttribute('aria-pressed'), 'false', 'the padlock starts shut');
  assert.equal(await button.getAttribute('aria-label'), 'Free view');
  const p0 = await pose(page);

  await button.click();
  await page.waitForFunction(() => window.__scene?.rig.isFree() === true, null, { timeout: TIMEOUT });
  // The padlock follows the mode on the next frame.
  await page.waitForFunction(() => document.querySelector('.zoom-free')?.getAttribute('aria-pressed') === 'true', null, { timeout: TIMEOUT });
  assert.equal(await button.getAttribute('aria-pressed'), 'true', 'the padlock opens');
  await page.waitForFunction(() => document.querySelector('.readout')?.textContent?.startsWith('Free view'), null, {
    timeout: TIMEOUT,
  });

  // A drag pans: the world point under the pointer follows it.
  const a = await under(page, 500, 400);
  await page.mouse.move(500, 400);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(500 + i * 20, 400 + i * 10);
  await page.mouse.up();
  await page.waitForFunction(() => window.__renderIdle === true, null, { timeout: TIMEOUT });
  const b = await under(page, 620, 460);
  assert.ok(b.free, 'still free after a drag');
  const moved = await page.evaluate(
    ([wx, wy]) => {
      const scene = window.__scene;
      if (!scene) throw new Error('no scene');
      const p = scene.camera.worldToScreen(wx, wy);
      return { x: p.x / scene.camera.dpr, y: p.y / scene.camera.dpr };
    },
    [a.x, a.y] as const,
  );
  assert.ok(Math.hypot(moved.x - 620, moved.y - 460) < 1, `a drag pans with the pointer (${moved.x}, ${moved.y})`);

  // The wheel zooms about the cursor, mid-wheel.
  const c = await under(page, 400, 500);
  await page.mouse.move(400, 500);
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -400);
  await page.waitForFunction(() => window.__renderIdle === true, null, { timeout: TIMEOUT });
  const p1 = await pose(page);
  assert.ok(p1.scale > p0.scale * 2, `zoomed in (${p0.scale} → ${p1.scale})`);
  const at = await page.evaluate(
    ([wx, wy]) => {
      const scene = window.__scene;
      if (!scene) throw new Error('no scene');
      const p = scene.camera.worldToScreen(wx, wy);
      return { x: p.x / scene.camera.dpr, y: p.y / scene.camera.dpr };
    },
    [c.x, c.y] as const,
  );
  assert.ok(Math.hypot(at.x - 400, at.y - 500) < 0.5, `the wheel zooms about the cursor (${at.x}, ${at.y})`);

  // The URL carries the pan: v=a,r,z,rot.
  await page.waitForFunction(() => /[?&]v=[^&,]+,[^&,]+,[^&,]+,[^&,]+(&|$)/.test(location.search), null, { timeout: TIMEOUT });
  console.log(`     free: pan, zoom ×${(p1.scale / p0.scale).toFixed(1)} about the cursor (${new URL(page.url()).search})`);

  // Esc goes back to the locked pose it left (a cut under reduced motion).
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__scene?.rig.isFree() === false, null, { timeout: TIMEOUT });
  await page.waitForFunction(() => window.__renderIdle === true, null, { timeout: TIMEOUT });
  const p2 = await pose(page);
  assert.equal(await button.getAttribute('aria-pressed'), 'false', 'Esc shuts the padlock');
  assert.ok(Math.abs(p2.scale - p0.scale) < 1e-6 * p0.scale, 'back at the zoom it left');
  assert.ok(Math.abs(p2.theta - p0.theta) < 1e-9, 'back at the rotation it left');
  assert.ok(Math.abs(p2.atAnchor.r - 1) < 1e-6, 'the rim is on the anchor again');
  await page.waitForFunction(() => /[?&]v=[^&,]+,[^&,]+(&|$)/.test(location.search), null, { timeout: TIMEOUT });

  // The padlock does the same.
  await button.click();
  await page.waitForFunction(() => window.__scene?.rig.isFree() === true, null, { timeout: TIMEOUT });
  await button.click();
  await page.waitForFunction(() => window.__scene?.rig.isFree() === false, null, { timeout: TIMEOUT });
  console.log('     free: Esc and the padlock return to the locked view');
}

/** The card's head, the wordmark menu, the empty palette and the live region (DESIGN.md §4.1, §4.2, §4.4, §8). */
async function chromeChecks(page: Page): Promise<void> {
  await cardShows(page, 'Homo sapiens');
  assert.equal((await page.locator('#panel-title').textContent())?.trim(), 'Homo sapiens', 'the heading is the name alone');
  await page.waitForFunction(() => document.querySelector('.panel-lead')?.textContent === 'Human', null, { timeout: TIMEOUT });
  assert.match((await page.locator('#announcer').textContent()) ?? '', /^Homo sapiens, species, \d+ subspecies\. You are here\.$/);
  // Tab reaches the card before the breadcrumb.
  const order = await page.evaluate(() => {
    const all = [...document.querySelectorAll('button, [tabindex="0"]')];
    const card = all.findIndex((e) => e.closest('#panel'));
    const crumb = all.findIndex((e) => e.classList.contains('crumb'));
    return { card, crumb };
  });
  assert.ok(order.card >= 0 && order.card < order.crumb, 'the card comes before the breadcrumb in Tab order');

  // The card's "i" opens Data & credits; Esc closes it.
  await page.click('.panel-info');
  await page.waitForSelector('dialog.credits[open]');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('dialog.credits[open]'));

  // The empty palette offers species to try.
  await page.keyboard.press('/');
  await page.waitForSelector('.search-layer.open');
  await page.waitForSelector('.search-heading');
  const heads = await page.locator('.search-heading').allTextContents();
  assert.ok(heads.includes('Try'), `the empty palette shows Try (${heads.join(', ')})`);
  assert.ok((await page.locator('.search-row').count()) >= 3, 'with a few rows');
  await page.keyboard.press('Escape');
  await cardShows(page, 'Homo sapiens');
}

/** The API down at start: one line, and a way to try again (DESIGN.md §7). */
async function bootFailureCheck(browser: Browser): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.route('**/api/meta', (r) => r.fulfill({ status: 500, body: 'down' }));
    await page.goto(`${BASE}/`);
    await page.waitForSelector('.boot-error', { timeout: TIMEOUT });
    assert.match((await page.locator('.boot-error').textContent()) ?? '', /Couldn’t load the tree\. Reload/);
    console.log('ok   boot failure: says so, offers Reload');
  } finally {
    await page.close();
  }
}

/** The first search hit's OpenTree id for a scientific name. */
async function ottOf(name: string): Promise<string> {
  const hits = (await (await fetch(`${BASE}/api/search?q=${encodeURIComponent(name)}`)).json()) as { nodeId: string; name: string }[];
  const hit = hits.find((h) => h.name === name) ?? hits[0];
  if (!hit) throw new Error(`no node named ${name}`);
  return hit.nodeId;
}

/** Waits until the card is idle (its /about, image and map answered) and the scene too. */
async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__renderIdle === true, null, { timeout: TIMEOUT });
}

/** The card's tabs (DESIGN.md §4.2): ARIA, keys, persistence, nothing scrolls; and the search bar (§4.1). */
async function cardTabChecks(browser: Browser): Promise<void> {
  const t0 = Date.now();
  const species = ['Apis mellifera', 'Homo sapiens', 'Panthera leo', 'Felidae'];
  const ids = await Promise.all(species.map(ottOf));
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${BASE}/?reduced&n=${ids[0]}`);
    await cardShows(page, 'Apis mellifera');
    await settled(page);
    // The tabs pattern: one tablist, tabs controlling tabpanels, one tab in the Tab order.
    const aria = await page.evaluate(() => {
      const tabs = [...document.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"]:not([hidden])')];
      return {
        lists: document.querySelectorAll('#panel [role="tablist"]').length,
        names: tabs.map((t) => t.textContent),
        roving: tabs.filter((t) => t.tabIndex === 0).length,
        panels: tabs.every((t) => document.getElementById(t.getAttribute('aria-controls') ?? '')?.getAttribute('role') === 'tabpanel'),
        selected: tabs.filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.textContent),
      };
    });
    assert.equal(aria.lists, 1, 'one tablist');
    assert.deepEqual(aria.names, ['Overview', 'Range', 'Tree'], 'a species with a range has three tabs');
    assert.equal(aria.roving, 1, 'one tab in the Tab order');
    assert.ok(aria.panels, 'each tab controls a tabpanel');
    assert.deepEqual(aria.selected, ['Overview'], 'Overview first');
    // Keys move between tabs (and do not walk the tree).
    const before = await page.evaluate(() => location.search);
    await page.focus('[role="tab"][aria-selected="true"]');
    const at = async (): Promise<string | null> =>
      page.evaluate(() => (document.activeElement?.getAttribute('aria-selected') === 'true' ? document.activeElement.textContent : null));
    await page.keyboard.press('ArrowRight');
    assert.equal(await at(), 'Range', '→ moves to and selects the next tab');
    await page.keyboard.press('End');
    assert.equal(await at(), 'Tree', 'End: the last tab');
    await page.keyboard.press('Home');
    assert.equal(await at(), 'Overview', 'Home: the first tab');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await at(), 'Tree', '← wraps round');
    assert.equal(await page.evaluate(() => location.search), before, 'tab keys leave the selection alone');
    // The picked tab is kept for the next selection that has it.
    await page.click('#panel-tab-range');
    await page.keyboard.press('/');
    await page.waitForSelector('.search-layer.open');
    await page.keyboard.type('panthera leo', { delay: 10 });
    await page.waitForFunction(() => document.querySelector('.search-row')?.textContent?.includes('Panthera leo'), null, { timeout: TIMEOUT });
    await page.keyboard.press('Enter');
    await cardShows(page, 'Panthera leo');
    await settled(page);
    assert.equal(await page.getAttribute('[role="tab"][aria-selected="true"]', 'id'), 'panel-tab-range', 'Range kept for the next species');

    // The search bar: 40 px, as wide as the card, right above it.
    const bar = await page.evaluate(() => {
      const t = document.querySelector('.search-trigger')?.getBoundingClientRect();
      const c = document.querySelector('#panel')?.getBoundingClientRect();
      return t && c ? { h: t.height, w: t.width, cw: c.width, gap: c.top - t.bottom, left: t.left - c.left } : null;
    });
    assert.ok(bar && bar.h >= 38, `the search bar is tall enough (${bar?.h})`);
    assert.ok(bar && Math.abs(bar.w - bar.cw) <= 1 && Math.abs(bar.left) <= 1, 'as wide as the card, aligned with it');
    assert.ok(bar && bar.gap >= 4 && bar.gap <= 16, `right above the card (gap ${bar?.gap})`);
  } finally {
    await page.close();
  }

  // No tab scrolls, at the four sizes.
  for (const [w, h] of [
    [2000, 1030],
    [1440, 900],
    [1280, 720],
    [390, 844],
  ] as const) {
    const p = await browser.newPage({ viewport: { width: w, height: h } });
    try {
      for (const [i, id] of ids.entries()) {
        await p.goto(`${BASE}/?reduced&n=${id}`);
        await cardShows(p, species[i] ?? '');
        await settled(p);
        const tabs = await p.$$eval('[role="tab"]:not([hidden])', (els) => els.map((e) => e.id));
        if (tabs.length === 0) tabs.push('');
        for (const tab of tabs) {
          if (tab) await p.click(`#${tab}`);
          const over = await p.evaluate(() => {
            const out: string[] = [];
            const check = (e: Element | null, what: string): void => {
              if (e instanceof HTMLElement && e.scrollHeight > e.clientHeight + 1) out.push(`${what} ${e.scrollHeight}>${e.clientHeight}`);
            };
            check(document.querySelector('.panel-body'), 'card');
            const pane = document.querySelector('[role="tabpanel"]:not([hidden])');
            check(pane, 'tab');
            check(pane?.querySelector('.ov-text') ?? null, 'overview text');
            return out;
          });
          assert.deepEqual(over, [], `${species[i]} ${tab || 'card'} at ${w}×${h} fits without scrolling`);
        }
      }
      if (w < 720) {
        // Phone: the search bar fills the top row.
        const row = await p.evaluate(() => {
          const t = document.querySelector('.search-trigger')?.getBoundingClientRect();
          const c = document.querySelector('#panel')?.getBoundingClientRect();
          return t && c ? { h: t.height, left: t.left, right: innerWidth - t.right, above: c.top - t.bottom } : null;
        });
        assert.ok(row && row.h >= 38 && row.left <= 20 && row.right <= 20 && row.above >= 4, `phone search bar ${JSON.stringify(row)}`);
      }
    } finally {
      await p.close();
    }
  }
  console.log(`ok   card tabs and search bar (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

/** Opens `query`, waits for idle, searches, then runs `check`. */
async function run(
  browser: Browser,
  name: string,
  query: string,
  check: (page: Page) => Promise<void>,
  search = true,
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
    if (search) await searchAndOpen(page);
    await check(page);
    assert.deepEqual(errors, [], 'no uncaught page errors');
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`ok   ${name} [${renderer}] (${secs} s)`);
  } finally {
    await page.close();
  }
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ args: SWIFTSHADER_ARGS });
  try {
    await run(browser, 'default → search → card', '?reduced', async (page) => {
      assert.equal(await page.evaluate(() => window.__renderer), 'webgl2');
      await drawnChecks(page);
    });
    await run(browser, 'interactions: zoom, turn, select', '?reduced&debug', interactionChecks, false);
    await run(browser, 'free view: padlock, pan, zoom about the cursor, Esc', '?reduced&debug', freeViewChecks, false);
    await run(browser, 'card head, credits, empty palette, live region', '?reduced', chromeChecks, false);
    await bootFailureCheck(browser);
    await cardTabChecks(browser);
    await run(
      browser,
      'pan link → free view at its pan and zoom',
      '?reduced&debug&n=ott770315&v=1780855860,0.99999,24.1,-149.3',
      async (page) => {
        await cardShows(page, 'Homo sapiens');
        const p = await pose(page);
        assert.ok(Math.abs(Math.log2(p.scale) - 24.1) < 1e-6, `zoom from the link (${Math.log2(p.scale)})`);
        const cam = await page.evaluate(() => {
          const scene = window.__scene;
          if (!scene) throw new Error('no scene');
          return { free: scene.rig.isFree(), r: scene.camera.r, rot: (scene.camera.rot * 180) / Math.PI };
        });
        assert.ok(cam.free, 'a link with the pan opens in free view');
        assert.ok(Math.abs(cam.r - 0.99999) < 1e-9, `the pan from the link (r ${cam.r})`);
        assert.ok(Math.abs(cam.rot + 149.3) < 1e-6, `the rotation from the link (${cam.rot}°)`);
        assert.equal(await page.locator('.zoom-free').getAttribute('aria-pressed'), 'true');
      },
      false,
    );
    await motionChecks(browser);
    await run(browser, 'no GPU: fallback → search → card', '?nowebgl', async (page) => {
      assert.equal(await page.locator('.fallback img').isVisible(), true);
      assert.match((await page.locator('.fallback figcaption').textContent()) ?? '', /no WebGL2/);
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
