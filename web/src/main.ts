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
import { afterName, leaderPath, leaderStart } from './callout';
import { layoutFor } from './layout';
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
import { Selection } from './selection';
import { Credits, mountWordmarkMenu } from './ui/credits';
import { Hud } from './ui/hud';
import { ZoomStrip } from './ui/zoomstrip';
import { SearchPalette } from './ui/search';
import { levelFade } from './lod';
import { FLAG_HOME } from './tiles/decode';
import { DWELL_MS, POINTER_HOLD_MS, Tour } from './tour';
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
    if (e.key !== 'r' && e.key !== 'R') return;
    scene.orient.toggle(performance.now());
    scene.requestRender();
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
  mountWordmarkMenu(byId('wordmark', HTMLElement), credits);
  const selection = new Selection(
    scene,
    meta,
    store,
    byId('panel', HTMLElement),
    byId('announcer', HTMLElement),
    () => credits.open(),
  );
  selection.panel.place(layout.card, layout.compact);
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
    let start = leaderStart(t.node, t.rim, anchor, layout.card, w, h);
    // Leave from past the names: a tip's own, or the column beside a clade's tips.
    const spacing = scene.camera.tipSpacingPx() / scene.camera.dpr;
    const run = t.tip ? labels.nameRun(t.n.name ?? '', spacing) : labels.columnRun(spacing) * start.atRim;
    start = afterName(start, t.out, run, layout.card, w, h);
    return leaderPath(start, layout.card, layout.compact);
  };
  labels.selectedId = () => selection.selected()?.id ?? -1;
  labels.hideHere = () => ((selection.selected()?.flags ?? 0) & FLAG_HOME) !== 0;
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
    choose: (hit) => void selection.select(hit.id, { motion: 'fly', history: 'push' }),
    prefetch: (hit) => void store.get(hit.id).catch(() => undefined),
    redraw: () => scene.requestRender(),
  });
  scene.busy = () => selection.busy() || search.busy();

  // Ambient turn and idle tour pause while the user is looking at
  // something: the card under the pointer, search, a focused input, a
  // hidden tab, the intro.
  let overCard = false;
  const card = byId('panel', HTMLElement);
  card.addEventListener('pointerenter', () => (overCard = true));
  card.addEventListener('pointerleave', () => {
    overCard = false;
    scene.requestRender();
  });
  const looking = (): boolean =>
    overCard ||
    document.querySelector('.search-layer.open') !== null ||
    document.activeElement instanceof HTMLInputElement ||
    document.hidden ||
    scene.introPlaying();
  scene.spin.blocked = () => looking() || scene.input.dragging() || scene.flight.active();
  document.addEventListener('visibilitychange', () => scene.requestRender());
  const dwell = tourParam !== null && Number(tourParam) > 0 ? Number(tourParam) * 1000 : DWELL_MS;
  const tour = new Tour(performance.now(), dwell);
  tour.enabled = !reduced && (!still || tourParam !== null);
  // A pointer moving over the page in the last few seconds also holds the
  // tour's countdown (someone is exploring); a pointer resting on the wheel
  // does not, so "not touching anything" moves on. Resting on the card does
  // hold it (looking(): people read there).
  let lastMove = -Infinity;
  window.addEventListener('pointermove', () => (lastMove = performance.now()), { passive: true });
  tour.held = () =>
    looking() || performance.now() - lastMove < POINTER_HOLD_MS || scene.flight.active() || selection.busy();
  tour.go = (id) => void selection.select(id, { motion: 'tour', history: 'replace', announce: false });
  tour.wake = () => scene.requestRender();
  scene.tour = tour;
  // Any real input stops the tour (and the ambient turn): pointer, wheel, keys, anywhere on the page.
  const interact = (): void => {
    const now = performance.now();
    tour.interact(now);
    scene.spin.interact(now);
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
    selection.panel.place(layout.card, layout.compact);
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

main().catch((err: unknown) => {
  console.error(err);
  document.body.classList.add('failed');
});
