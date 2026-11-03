// Bootstrap: fonts → meta → scene (renderer, tiles, input) → layout and URL
// view, then the label overlay, the HUD, hover, the selection card and the
// search palette.
//
// URL parameters understood so far:
//   ?n=ott770315       selected node (see url.ts; default Homo sapiens)
//   ?v=a,z             view: rotation and zoom (see url.ts; old a,r,z,rot links still parse)
//   ?shot              screenshot mode: hides the cursor, skips the intro
//   ?reduced           force reduced motion (no intro, no fling, cuts; no ambient turn, no tour)
//   ?still             no ambient turn, no fling, no idle tour (implied by ?shot and reduced motion)
//   ?tour=<seconds>    the idle tour's dwell (default 10; resumes after 3 dwells); with ?still or
//                      ?shot it turns the tour on by itself (tests, screenshots)
//   ?debug             debug HUD;  ?debug=precision  max-zoom jitter test
//   ?debug=parity      WGSL vs TS compute check (gpu/parity.ts, window.__gpuParity)
//   ?nowebgl           the no-GPU fallback (still image, search, panel)
//   ?renderer=webgl|webgpu   force a backend (render/select.ts; default: WebGPU, else WebGL2)
//   ?passes=branches,arcs    draw only these passes (debug, render/plan.ts)

// Self-hosted fonts (no runtime requests to Google). Each file declares
// @font-face rules with unicode-range, so the browser fetches only the
// subsets it needs (latin, plus latin-ext for Portuguese diacritics).
import '@fontsource-variable/hanken-grotesk';
import '@fontsource-variable/source-serif-4/wght-italic.css';
import '@fontsource/spline-sans-mono/400.css';
import './styles.css';

import { fetchMeta } from './api';
import { toRad } from './angle';
import { afterName, columnLead, leaderPath, leaderStart } from './callout';
import { cardHeight, layoutFor } from './layout';
import { mountFallback } from './fallback';
import { Labels } from './labels';
import { RunPalette } from './palette';
import { fitCanvas, treeDpr } from './render/canvas';
import {
  FACTORIES,
  backendOrder,
  createRenderer,
  rememberWebGpuLoss,
  rendererOptions,
  webglReloadUrl,
  webgpuFailedBefore,
} from './render/select';
import type { BackendKind } from './render/types';
import { type BenchResult, Scene } from './scene';
import { FONT_SANS, FONT_SERIF, MAX_BACKING_PX } from './style';
import { Hover, pickAt } from './hover';
import { NodeStore } from './nodes';
import { TileIndex } from './picking';
import { Selection, atRim } from './selection';
import { Credits, type MenuItem, mountWordmarkMenu } from './ui/credits';
import { Hud, groupSwatch } from './ui/hud';
import { KeysDialog } from './ui/keys';
import { ZoomStrip } from './ui/zoomstrip';
import { SearchPalette, suggestion } from './ui/search';
import { levelFade } from './lod';
import { FLAG_HOME } from './tiles/decode';
import { DWELL_MS, FIRST_MS, POINTER_HOLD_MS, TOUCH_HOLD_MS, TOUR, Tour } from './tour';
import type { NodeInfo } from './types';
import { formatView, parseLink, viewOf, viewPose } from './url';

declare global {
  interface Window {
    /** ?shot only: average frame time over n frames, waiting for the GPU after each, plus GPU time where measured (scripts/shot.ts). */
    __bench?: (n: number) => Promise<BenchResult>;
    /** The backend drawing the tree, or 'none' on the fallback page; harnesses assert it. */
    __renderer?: BackendKind | 'none';
    /** ?shot / ?debug: label counts of the last layout. */
    __labels?: { candidates: number; shown: number; drawn: number; layoutMs: number; paintMs: number };
    __labelDump?: () => unknown;
    /** ?debug, WebGPU only: simulate a GPU device loss (the renderer recovers once, then reloads). */
    __loseDevice?: () => void;
  }
}

function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`#${id} is missing or not a ${type.name}`);
  return el;
}

/** sessionStorage, or null where reading it throws (blocked site data). */
function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const debug = params.get('debug');
  const shot = params.has('shot');
  if (shot) document.documentElement.classList.add('shot');

  const treeCanvas = byId('tree', HTMLCanvasElement);
  const overlayCanvas = byId('overlay', HTMLCanvasElement);
  const meta = await fetchMeta();
  // The backend is chosen before any getContext: a canvas that gave one
  // kind of context never gives the other. `?nowebgl` tries none, showing
  // the fallback on purpose (the smoke test and screenshots).
  const order = backendOrder(params, {
    hasGpu: 'gpu' in navigator,
    webgpuFailedBefore: webgpuFailedBefore(sessionStore()),
  });
  const palette = new RunPalette(meta.runs, meta.tipCount);
  const renderer = await createRenderer(treeCanvas, palette, order, FACTORIES, rendererOptions(params));
  window.__renderer = renderer?.kind ?? 'none';
  if (!renderer) {
    mountFallback(meta);
    return;
  }

  const scene = new Scene(renderer, treeCanvas, meta, palette);
  // The GPU was lost and could not come back (plan §2.4): remember it for
  // this session and reload into WebGL2 at the same place.
  renderer.onLost = (reason) => {
    console.warn(`GPU lost (${reason}); reloading with WebGL2`);
    rememberWebGpuLoss(sessionStore());
    location.replace(webglReloadUrl(location.search, formatView(viewOf(scene.rig.pose(), scene.camera.dpr))));
  };
  scene.cache.onStale = () => location.reload(); // re-ingested: start over with new meta
  const reduced = params.has('reduced') || matchMedia('(prefers-reduced-motion: reduce)').matches;
  scene.input.reducedMotion = reduced;
  scene.orient.reducedMotion = reduced;
  scene.flight.reducedMotion = reduced;
  // The wheel's own motion (spin.ts, tour.ts): never under reduced motion;
  // `?still` (and `?shot`) keep screenshots and tests deterministic.
  const still = reduced || shot || params.has('still');
  const tourParam = params.get('tour');
  scene.spin.enabled = !still;
  // Debug aids are a separate chunk: ordinary visits never download them.
  const dbg = debug !== null ? await import('./debug') : null;
  if (dbg) {
    dbg.mountDebugHud(scene);
    if (renderer.loseDevice) window.__loseDevice = renderer.loseDevice.bind(renderer);
  }
  if (shot) {
    window.__bench = (n: number) => scene.bench(n);
    window.__scene = scene; // flight timing in screenshot scripts
  }

  // Size the canvases, then place the view once the viewport is known.
  // The tree canvas's DPR is capped (PLAN §7.12); the overlay keeps the full one.
  const screenDpr = (): number => window.devicePixelRatio || 1;
  const dpr = (): number =>
    treeDpr(treeCanvas.clientWidth, treeCanvas.clientHeight, screenDpr(), MAX_BACKING_PX);
  fitCanvas(treeCanvas, dpr());
  fitCanvas(overlayCanvas, screenDpr());
  scene.camera.setViewport(treeCanvas.width, treeCanvas.height, dpr());
  // The composition for this window (layout.ts): the card, the anchor and
  // the wheel at minimum zoom.
  let layout = layoutFor(treeCanvas.clientWidth, treeCanvas.clientHeight);
  scene.rig.setLayout(layout);
  const link = parseLink(location.search);
  const view = link.v;
  // Without a view: minimum zoom, Homo sapiens (the default selection) on
  // the anchor; a deep link's own selection turns onto it once it loads.
  if (view) scene.rig.set(viewPose(view, scene.camera.dpr));
  else scene.rig.set({ theta: toRad(meta.home?.angle ?? 0), scale: scene.rig.minScale() });
  if (debug === 'precision') dbg?.precisionCamera(scene, meta);
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    if (e.key === 'r' || e.key === 'R') {
      scene.orient.toggle(performance.now());
      scene.requestRender();
    } else if ((e.key === 'h' || e.key === 'H') && meta.home) {
      // "You are here" (DESIGN.md §8): back to Homo sapiens.
      void selection.select(meta.home.nodeId, { motion: 'fly', history: 'push' });
    }
  });

  // Labels (Canvas2D overlay) and the HUD, repainted after every frame.
  const labels = new Labels(overlayCanvas, meta, scene.palette, scene.obstacles);
  const store = new NodeStore();
  const hud = new Hud(scene, meta, store);

  // Hover (mouse only) and selection: click or tap selects and turns it onto the anchor.
  const index = new TileIndex();
  const hover = new Hover(scene, meta, store, index, treeCanvas);
  // Data & credits: from the wordmark menu and the card's footer.
  const credits = new Credits(meta);
  const selection = new Selection(
    scene,
    meta,
    store,
    byId('panel', HTMLElement),
    byId('announcer', HTMLElement),
    () => credits.open(),
  );
  selection.panel.place(layout.card, cardHeight(layout), layout.compact);
  // Zoom: the scale on the left edge, with the reset button (ui/zoomstrip.ts).
  const strip = new ZoomStrip(scene, byId('zoom-strip', HTMLElement), () => hud.reset());
  strip.place(layout, treeCanvas.clientHeight);
  hud.selected = () => selection.selected();
  hud.select = (ref) => void selection.select(ref, { motion: 'fly', history: 'push' });
  scene.input.onTap = (x, y, touch) => {
    const hit = pickAt(scene, meta, x, y, touch);
    if (hit) void selection.select(hit.id, { motion: 'turn', history: 'push' });
  };
  scene.highlight = (now) => {
    const h = hover.draw(now);
    const sel = selection.draw();
    const paths = [];
    if (h.path) paths.push(h.path);
    if (sel) paths.push(sel.path);
    return {
      draw: { treeDim: h.treeDim, paths, rings: sel ? [sel.ring] : [] },
      animating: h.animating,
    };
  };
  scene.leaderGap = (spacing) => labels.leaderGap(spacing);
  // The leader from the selection to the card (callout.ts).
  // Never hidden: off screen it starts at the edge and points the way.
  labels.callout = () => {
    const t = selection.leaderTarget();
    if (!t) return null;
    const w = treeCanvas.clientWidth;
    const h = treeCanvas.clientHeight;
    const a = scene.rig.anchor();
    const anchor = { x: a.x / scene.camera.dpr, y: a.y / scene.camera.dpr };
    // The card as it is (it is as tall as its content), not its nominal box.
    const card = selection.panel.box() ?? layout.card;
    let start = leaderStart(t.node, t.rim, anchor, card, w, h);
    // Leave from past the names: a tip's own, or the column beside a clade's
    // tips (a species with subspecies too: its names are that column).
    const spacing = scene.camera.tipSpacingPx() / scene.camera.dpr;
    // Homo sapiens is drawn as one row (its subspecies share it), so its own name counts.
    const ownName = t.tip && (!atRim(t.n) || (t.n.flags & FLAG_HOME) !== 0);
    const column = labels.columnRun(spacing);
    const run = ownName ? labels.nameRun(t.n.name ?? '', spacing) : column * start.atRim;
    start = afterName(start, t.out, run, card, w, h);
    // A tip's leader then runs on along its own row past the column before
    // it rises, so it never crosses (and shortens) a neighbour's name.
    const lead = ownName ? columnLead(start, t.out, column - run, card, layout.compact, w, h) : null;
    return leaderPath(start, card, layout.compact, lead);
  };
  labels.selectedId = () => selection.selected()?.id ?? -1;
  labels.hideHere = () => ((selection.selected()?.flags ?? 0) & FLAG_HOME) !== 0;
  // While Homo sapiens is the selection, its leader and the card say "you
  // are here"; the white home bar would only compete with them.
  scene.homeLeader = () => !labels.hideHere();
  if (shot || debug !== null) {
    window.__labels = labels.stats;
    window.__labelDump = () => labels.dump();
  }
  // Search: choosing a result selects it, turns it onto the anchor and zooms to suit it (selection.ts).
  const search = new SearchPalette({
    slot: byId('search-slot', HTMLElement),
    obstacles: scene.obstacles,
    speciesCount: meta.speciesCount,
    home: meta.home,
    tipCount: meta.tipCount,
    choose: (hit) => void selection.select(hit.nodeId, { motion: 'fly', history: 'push' }),
    prefetch: (hit) => void store.get(hit.nodeId).catch(() => undefined),
    redraw: () => scene.requestRender(),
    tryList: TOUR.map((t) => suggestion({ nodeId: t.id, name: t.name, rank: 'species', group: t.group, common: t.common })),
  });
  search.place(layout.compact ? null : layout.card);
  // The visitor's own selections are the empty palette's "Recent".
  selection.onChosen = (n: NodeInfo) => search.remember(recentHit(n));
  scene.busy = () => selection.busy() || search.busy();

  // Ambient turn and idle tour pause while the user is looking at
  // something: the card under the pointer, search, a focused input, a
  // hidden tab, the intro.
  let overCard = false;
  let cardScrolled = -Infinity;
  const card = byId('panel', HTMLElement);
  card.addEventListener('pointerenter', () => (overCard = true));
  card.addEventListener('pointerleave', () => {
    overCard = false;
    scene.requestRender();
  });
  card.addEventListener('scroll', () => (cardScrolled = performance.now()), { capture: true, passive: true });
  const selecting = (): boolean => {
    const sel = document.getSelection();
    return sel !== null && !sel.isCollapsed && sel.toString().trim() !== '';
  };
  const looking = (): boolean =>
    overCard ||
    card.contains(document.activeElement) ||
    performance.now() - cardScrolled < POINTER_HOLD_MS ||
    selecting() ||
    document.querySelector('.search-layer.open') !== null ||
    document.querySelector('dialog[open]') !== null ||
    document.activeElement instanceof HTMLInputElement ||
    document.hidden ||
    scene.introPlaying();
  scene.spin.blocked = () => looking() || scene.input.dragging() || scene.flight.active();
  document.addEventListener('visibilitychange', () => scene.requestRender());
  const custom = tourParam !== null && Number(tourParam) > 0;
  const dwell = custom ? Number(tourParam) * 1000 : DWELL_MS;
  const tour = new Tour(performance.now(), dwell, Math.random, custom ? dwell : FIRST_MS);
  tour.enabled = !reduced && (!still || tourParam !== null);
  // A pointer moving over the page in the last few seconds also holds the
  // tour's countdown (someone is exploring); a pointer resting on the wheel
  // does not, so "not touching anything" moves on. Resting on the card does
  // hold it (looking(): people read there), and so does a touch in the last
  // TOUCH_HOLD_MS: a phone reader's thumb rests between scrolls.
  let lastMove = -Infinity;
  let lastTouch = -Infinity;
  window.addEventListener('pointermove', () => (lastMove = performance.now()), { passive: true });
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') lastTouch = performance.now();
  }, { capture: true, passive: true });
  tour.held = () =>
    looking() ||
    performance.now() - lastMove < POINTER_HOLD_MS ||
    performance.now() - lastTouch < TOUCH_HOLD_MS ||
    scene.flight.active() ||
    selection.busy();
  tour.go = (id) => void selection.select(id, { motion: 'tour', history: 'replace', announce: false });
  tour.wake = () => scene.requestRender();
  scene.tour = tour;
  hud.touring = () => tour.touring();
  hud.stopTour = () => {
    tour.setEnabled(false, performance.now());
    scene.requestRender();
  };

  // The wordmark menu (DESIGN.md §4.1): Data & credits, Keyboard,
  // Auto-orient, the tour, and on a phone the kingdoms (the key's place).
  const keys = new KeysDialog();
  const menu: MenuItem[] = [
    { label: () => 'Keyboard', run: () => keys.open() },
    {
      label: () => `Auto-orient: ${scene.orient.enabled ? 'on' : 'off'}`,
      run: () => {
        scene.orient.toggle(performance.now());
        scene.requestRender();
      },
    },
  ];
  if (!reduced) {
    menu.push({
      label: () => `Tour: ${tour.enabled ? 'on' : 'off'}`,
      run: () => {
        tour.setEnabled(!tour.enabled, performance.now());
        scene.requestRender();
      },
    });
  }
  for (const g of meta.groups) {
    const swatch = groupSwatch(g.id);
    menu.push({ label: () => g.name, run: () => hud.goToGroup(g.id), compactOnly: true, ...(swatch ? { swatch } : {}) });
  }
  mountWordmarkMenu(byId('wordmark', HTMLElement), credits, menu);

  // A first visit's hint, in the readout until the first input (DESIGN.md §4.1).
  const store2 = sessionStore();
  const touch = matchMedia('(pointer: coarse)').matches;
  if (!shot && debug === null && store2?.getItem('col-hinted') !== '1') {
    hud.hint = touch
      ? 'Drag to turn · pinch or use the strip to zoom · tap a branch'
      : 'Drag to turn · scroll or use the strip to zoom · click a branch';
    try {
      store2?.setItem('col-hinted', '1');
    } catch {
      // Blocked site data: the hint shows again next time, no harm.
    }
  }
  // Any real input stops the tour (and the ambient turn): pointer, wheel, keys, anywhere on the page.
  const interact = (): void => {
    const now = performance.now();
    tour.interact(now);
    scene.spin.interact(now);
    if (hud.hint) {
      hud.hint = null;
      scene.requestOverlay();
    }
  };
  scene.onInteract = () => tour.interact(performance.now());
  for (const type of ['pointerdown', 'keydown', 'wheel'] as const) {
    window.addEventListener(type, interact, { capture: true, passive: true });
  }
  // A deep link stays put for a while before the tour moves on.
  if (link.n || view) tour.interact(performance.now());
  scene.overlay = (now) => {
    const v = scene.lastView;
    if (!v) return false;
    const fading = labels.frame({
      now,
      camera: scene.camera,
      tiles: scene.lastTiles,
      lambda: v.lambda,
      range: v.range,
      fade: (level) => levelFade(level, v.lambda),
    });
    hud.frame(now);
    strip.frame();
    hover.frame(now);
    selection.frame();
    return fading;
  };

  // The one intro (DESIGN.md §6): only when landing on the default view.
  // Labels and HUD fade in once it is over.
  if (!shot && !reduced && !view && !link.n && debug === null) {
    const root = document.documentElement;
    root.classList.add('intro');
    scene.onIntroDone = () => {
      root.classList.remove('intro');
      labels.show(performance.now());
      scene.requestOverlay();
    };
    scene.playIntro();
  } else {
    labels.show(performance.now(), shot);
  }

  const resize = (): void => {
    const changed = fitCanvas(treeCanvas, dpr());
    fitCanvas(overlayCanvas, screenDpr());
    if (!changed) return;
    // A new composition; the same rotation and the same zoom relative to the
    // minimum, so resizing feels like scaling the picture.
    const rig = scene.rig;
    const zoom = rig.scale / rig.minScale();
    scene.camera.setViewport(treeCanvas.width, treeCanvas.height, dpr());
    layout = layoutFor(treeCanvas.clientWidth, treeCanvas.clientHeight);
    rig.setLayout(layout);
    rig.set({ theta: rig.theta, scale: zoom * rig.minScale() });
    selection.panel.place(layout.card, cardHeight(layout), layout.compact);
    search.place(layout.compact ? null : layout.card);
    strip.place(layout, treeCanvas.clientHeight);
    scene.requestRender();
  };
  new ResizeObserver(resize).observe(treeCanvas);
  // Moving the window to a screen with another DPR does not change the CSS
  // size, so watch the DPR separately.
  const watchDpr = (): void => {
    matchMedia(`(resolution: ${screenDpr()}dppx)`).addEventListener(
      'change',
      () => {
        resize();
        watchDpr();
      },
      { once: true },
    );
  };
  watchDpr();

  // Canvas text cannot wait for CSS to ask for a face, so load the label
  // faces explicitly before the first label draw (PLAN §7.7).
  void Promise.all([
    document.fonts.load(`500 13px ${FONT_SANS}`),
    document.fonts.load(`400 13px ${FONT_SANS}`),
    document.fonts.load(`italic 400 16px ${FONT_SERIF}`),
  ])
    .catch((err: unknown) => console.warn('fonts', err))
    .then(() => document.fonts.ready)
    .then(() => {
      labels.setFontsReady();
      scene.fontsReady = true;
      scene.requestRender();
    });
  scene.requestRender();

  // The selection: the link's, else Homo sapiens. With a view in the URL the
  // view is restored as is; a link with only a node cuts to it, zoomed to
  // suit (PLAN §7.11).
  void selection.select(link.n ?? selection.defaultRef(), { motion: !view && link.n ? 'cut' : 'none', history: 'none' });

  if (dbg && debug === 'precision') {
    window.__precision = await dbg.runPrecisionTest(scene, renderer);
    console.info('precision test', window.__precision);
    if (!shot) dbg.precisionGlide(scene);
    else scene.requestRender();
  }
  if (debug === 'parity') {
    // Its own device (any adapter, software included): it checks the WGSL
    // maths, whichever backend draws the tree.
    const { runGpuParity } = await import('./gpu/parity');
    window.__gpuParity = await runGpuParity(palette, meta.tipCount);
    console.info('gpu parity', window.__gpuParity);
    scene.requestRender();
  }
}

/** A search row for a selection, for the empty palette's "Recent". */
function recentHit(n: NodeInfo): ReturnType<typeof suggestion> {
  const names = n.lineage.filter((a) => a.id !== 0 && a.name && a.rank !== 'genus').map((a) => a.name ?? '');
  return suggestion({
    id: n.id,
    nodeId: n.nodeId,
    name: n.name ?? 'Unnamed clade',
    rank: n.rank,
    group: n.group,
    flags: n.flags,
    common: n.commonName,
    lineage: names.slice(-3),
  });
}

/** Nothing could start (the API is down): say so, with a way to try again (DESIGN.md §7). */
function showBootError(): void {
  document.body.classList.add('failed');
  const again = document.createElement('button');
  again.type = 'button';
  again.className = 'text-button';
  again.textContent = 'Reload';
  again.addEventListener('click', () => location.reload());
  const p = document.createElement('p');
  p.className = 'boot-error';
  p.setAttribute('role', 'alert');
  p.append('Couldn’t load the tree. ', again);
  document.body.append(p);
}

main().catch((err: unknown) => {
  console.error(err);
  showBootError();
});
