// Bootstrap: fonts → meta → scene (renderer, tiles, input) → URL view,
// then the label overlay, the HUD, hover, the selection panel and the search
// palette.
//
// URL parameters understood so far:
//   ?n=ott770315       selected node (see url.ts); reload restores it
//   ?v=a,r,z,rot       camera (see url.ts)
//   ?shot              screenshot mode: hides the cursor, skips the intro
//   ?reduced           force reduced motion (no intro, no inertia, cuts)
//   ?debug             debug HUD;  ?debug=precision  max-zoom jitter test
//   ?nowebgl           the no-WebGL2 fallback (still image, search, panel)

// Self-hosted fonts (no runtime requests to Google). Each file declares
// @font-face rules with unicode-range, so the browser fetches only the
// subsets it needs (latin, plus latin-ext for Portuguese diacritics).
import '@fontsource-variable/hanken-grotesk';
import '@fontsource-variable/source-serif-4/wght-italic.css';
import '@fontsource/spline-sans-mono/400.css';
import './styles.css';

import { fetchMeta } from './api';
import { mountDebugHud, precisionCamera, precisionGlide, runPrecisionTest } from './debug';
import { mountFallback } from './fallback';
import { createGL, fitCanvas, treeDpr } from './gl/context';
import { Labels } from './labels';
import { Scene } from './scene';
import { FONT_SANS, FONT_SERIF, MAX_BACKING_PX } from './style';
import { Hover, pickAt } from './hover';
import { NodeStore } from './nodes';
import { TileIndex } from './picking';
import { Selection } from './selection';
import { Credits, mountWordmarkMenu } from './ui/credits';
import { Hud } from './ui/hud';
import { SearchPalette } from './ui/search';
import { levelFade } from './lod';
import { applyView, parseLink } from './url';

declare global {
  interface Window {
    /** ?shot only: average frame time over n synchronous frames (scripts/shot.ts). */
    __bench?: (n: number) => number;
    /** ?shot / ?debug: label counts of the last layout. */
    __labels?: { candidates: number; shown: number; drawn: number; layoutMs: number; paintMs: number };
    __labelDump?: () => unknown;
  }
}

function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`#${id} is missing or not a ${type.name}`);
  return el;
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const debug = params.get('debug');
  const shot = params.has('shot');
  if (shot) document.documentElement.classList.add('shot');

  const treeCanvas = byId('tree', HTMLCanvasElement);
  const overlayCanvas = byId('overlay', HTMLCanvasElement);
  // `?nowebgl` shows the fallback on purpose (the smoke test and screenshots).
  const gl = params.has('nowebgl') ? null : createGL(treeCanvas);
  const meta = await fetchMeta();
  if (!gl) {
    mountFallback(meta);
    return;
  }

  const scene = new Scene(gl, treeCanvas, meta);
  scene.cache.onStale = () => location.reload(); // re-ingested: start over with new meta
  const reduced = params.has('reduced') || matchMedia('(prefers-reduced-motion: reduce)').matches;
  scene.input.reducedMotion = reduced;
  scene.orient.reducedMotion = reduced;
  scene.flight.reducedMotion = reduced;
  if (debug !== null) mountDebugHud(scene);
  if (shot) {
    window.__bench = (n: number) => scene.bench(n);
    window.__scene = scene; // flight timing in screenshot scripts
  }

  // Size the canvases, then place the camera once the viewport is known.
  // The tree canvas's DPR is capped (PLAN §7.12); the overlay keeps the full one.
  const screenDpr = (): number => window.devicePixelRatio || 1;
  const dpr = (): number =>
    treeDpr(treeCanvas.clientWidth, treeCanvas.clientHeight, screenDpr(), MAX_BACKING_PX);
  fitCanvas(treeCanvas, dpr());
  fitCanvas(overlayCanvas, screenDpr());
  scene.camera.setViewport(treeCanvas.width, treeCanvas.height, dpr());
  scene.camera.rot = scene.orient.baseRot; // the default composition (orient.ts)
  scene.camera.fit();
  const link = parseLink(location.search);
  const view = link.v;
  if (view) applyView(scene.camera, view);
  else if (debug === 'precision') precisionCamera(scene, meta);
  // The precision test pans at a fixed rotation.
  if (debug === 'precision') scene.orient.enabled = false;
  scene.orient.prime();
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

  // Hover (mouse only) and selection: click or tap selects and flies.
  const index = new TileIndex();
  const hover = new Hover(scene, meta, store, index, treeCanvas);
  // Data & credits: from the wordmark menu and the panel footer.
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
  selection.panel.reducedMotion = reduced;
  hud.selected = () => selection.selected();
  scene.input.onTap = (x, y, touch) => {
    const hit = pickAt(scene, meta, x, y, touch);
    if (hit) void selection.select(hit.id, { fly: true, history: 'push' });
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
  if (shot || debug !== null) {
    window.__labels = labels.stats;
    window.__labelDump = () => labels.dump();
  }
  // Search: choosing a result selects it and flies there (selection.ts).
  const search = new SearchPalette({
    slot: byId('search-slot', HTMLElement),
    obstacles: scene.obstacles,
    speciesCount: meta.speciesCount,
    home: meta.home,
    tipCount: meta.tipCount,
    choose: (hit) => void selection.select(hit.id, { fly: true, history: 'push' }),
    prefetch: (hit) => void store.get(hit.id).catch(() => undefined),
    redraw: () => scene.requestRender(),
  });
  scene.busy = () => hud.busy() || selection.busy() || search.busy();
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
    hover.frame(now);
    selection.frame();
    return fading;
  };

  // The one intro (DESIGN.md §6): only when landing on the whole wheel.
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
    // Keep the same world point centred and the same zoom relative to the
    // window's shorter side, so resizing feels like scaling the picture.
    const old = scene.camera.fitScale();
    scene.camera.setViewport(treeCanvas.width, treeCanvas.height, dpr());
    scene.camera.scale = scene.camera.clampScale((scene.camera.scale * scene.camera.fitScale()) / old);
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

  // A deep link's selection: with a camera in the URL it is restored as is,
  // without one the view flies there (PLAN §7.11).
  if (link.n) void selection.select(link.n, { fly: !view, history: 'none' });

  if (debug === 'precision') {
    window.__precision = await runPrecisionTest(scene, gl);
    console.info('precision test', window.__precision);
    if (!shot) precisionGlide(scene);
    else scene.requestRender();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  document.body.classList.add('failed');
});
