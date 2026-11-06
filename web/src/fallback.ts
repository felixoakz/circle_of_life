// No GPU drawing, no WebGL2 (DESIGN.md §7): a still image of the wheel and one sentence in
// place of the canvas, with search, the card and Data & credits still
// working, since they need only the API. Choosing a search result shows it
// in the card; lineage and children links in the card show theirs.

import { fetchAbout } from './api';
import { FLAG_HOME } from './tiles/decode';
import { cardHeight, layoutFor } from './layout';
import { NodeStore } from './nodes';
import type { Meta } from './types';
import { Credits } from './ui/credits';
import { Obstacles } from './ui/obstacles';
import { Panel } from './ui/panel';
import { SearchPalette } from './ui/search';

const NO_GPU_TEXT = 'Your browser can’t draw the interactive tree (no WebGL2). Search still works.';

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing`);
  return el;
}

/** Replaces the canvases with the still image and wires search and the card. */
export function mountFallback(meta: Meta): void {
  document.body.classList.add('no-webgl');
  const figure = document.createElement('figure');
  figure.className = 'fallback';
  const img = document.createElement('img');
  img.src = '/fallback.webp';
  img.alt = 'The tree of life drawn as a wheel: animals, fungi, plants, protists, bacteria and archaea around the rim.';
  img.width = 1200;
  img.height = 1200;
  const caption = document.createElement('figcaption');
  caption.textContent = NO_GPU_TEXT;
  figure.append(img, caption);
  document.body.append(figure);

  const obstacles = new Obstacles();
  const store = new NodeStore();
  const credits = new Credits(meta);
  const show = async (ref: number | string): Promise<void> => {
    panel.loading(true);
    try {
      panel.show(await store.get(ref), true);
    } catch (err) {
      console.warn('select', err);
      panel.showError(() => void show(ref));
    } finally {
      panel.loading(false);
    }
  };
  const panel = new Panel(byId('panel'), obstacles, meta.dataVersion, {
    select: (id) => void show(id),
    node: (ref) => store.get(ref),
    moved: () => {},
    about: (ref, retry, signal) => fetchAbout(ref, retry, signal),
    credits: () => credits.open(),
    home: (n) => (n.flags & FLAG_HOME) !== 0,
  });
  const place = (): void => {
    const layout = layoutFor(window.innerWidth, window.innerHeight);
    panel.place(layout.card, cardHeight(layout), layout.compact);
  };
  place();
  window.addEventListener('resize', place);
  new SearchPalette({
    slot: byId('search-slot'),
    obstacles,
    speciesCount: meta.speciesCount,
    home: meta.home,
    tipCount: meta.tipCount,
    choose: (hit) => void show(hit.id),
    prefetch: (hit) => void store.get(hit.id).catch(() => undefined),
    redraw: () => {},
  });
  // Nothing animates here; screenshot scripts wait on this (scene.ts).
  window.__renderIdle = true;
}
