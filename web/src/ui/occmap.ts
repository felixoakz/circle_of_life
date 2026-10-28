// The GBIF occurrence density mini-map in the panel (DESIGN.md §4.2 "Where
// it lives"). No map library: a handful of absolutely positioned <img>
// tiles, straight from GBIF (PLAN §6.3, no proxy).
//
// - Base map: GBIF's own dark OpenMapTiles style (`tile.gbif.org`, style
//   `gbif-dark`): black land, near-black sea, no labels, no colour. Same
//   provider, projection and 512 px grid as the density tiles, free to use
//   with the "© OpenMapTiles © OpenStreetMap contributors" credit.
// - Density: hexagon bins in GBIF's `purpleYellow` ramp, whose lightness
//   rises with density; CSS turns it grey (styles.css `.occmap-density`), so
//   the map stays achromatic and the densest places are the brightest.
//
// `mapView` is the pure part (tested): which tiles cover a W×H box framing
// the occurrence bbox.

/** GBIF raster tiles are 512 CSS px at @1x. */
export const TILE = 512;
/** Deepest zoom used: beyond this a few points would fill the map. */
export const MAX_ZOOM = 6;
/** The bbox fills at most this fraction of the box. */
const FILL = 0.7;
/** Web Mercator's latitude limit. */
const MAX_LAT = 85.0511;

/** Longitude to x in [0, 1] (Web Mercator). */
export function mercX(lng: number): number {
  return (lng + 180) / 360;
}

/** Latitude to y in [0, 1], north at 0 (Web Mercator). */
export function mercY(lat: number): number {
  const phi = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  return (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2;
}

export interface MapTile {
  z: number;
  /** Wrapped tile column, for the URL. */
  x: number;
  y: number;
  /** Position and size in the box, CSS px. */
  left: number;
  top: number;
  size: number;
}

export interface MapView {
  z: number;
  /** Displayed tile size, CSS px (between TILE/2 and TILE at z ≥ 1). */
  size: number;
  tiles: MapTile[];
}

/**
 * The tiles that fill a `width`×`height` box centred on `bbox`
 * ([minLng, minLat, maxLng, maxLat]; null for the whole world), zoomed so
 * the bbox fills about 70% of the box, but never so far out that the world
 * is narrower than the box.
 */
export function mapView(bbox: readonly [number, number, number, number] | null, width: number, height: number): MapView {
  const [minLng, minLat, maxLng, maxLat] = bbox ?? [-180, -MAX_LAT, 180, MAX_LAT];
  const x0 = mercX(minLng);
  const x1 = mercX(maxLng);
  const y0 = mercY(maxLat);
  const y1 = mercY(minLat);
  const spanX = Math.max(x1 - x0, 1e-6);
  const spanY = Math.max(y1 - y0, 1e-6);
  // World size in CSS px: fit the bbox, clamp to [box width, deepest zoom].
  let world = Math.min((width * FILL) / spanX, (height * FILL) / spanY);
  world = Math.max(width, Math.min(world, TILE * 2 ** MAX_ZOOM));
  const z = Math.max(0, Math.min(MAX_ZOOM, Math.floor(Math.log2(world / TILE))));
  const n = 2 ** z;
  const size = world / n;

  // Centre on the bbox, but keep the poles' edges inside the box.
  const cx = ((x0 + x1) / 2) * world;
  let cy = ((y0 + y1) / 2) * world;
  if (world >= height) cy = Math.max(height / 2, Math.min(world - height / 2, cy));
  else cy = world / 2;
  const left0 = cx - width / 2;
  const top0 = cy - height / 2;

  const tiles: MapTile[] = [];
  const tyLo = Math.floor(top0 / size);
  const tyHi = Math.floor((top0 + height - 1e-6) / size);
  const txLo = Math.floor(left0 / size);
  const txHi = Math.floor((left0 + width - 1e-6) / size);
  for (let ty = tyLo; ty <= tyHi; ty++) {
    if (ty < 0 || ty >= n) continue; // beyond the poles: black
    for (let tx = txLo; tx <= txHi; tx++) {
      tiles.push({
        z,
        x: ((tx % n) + n) % n, // the world repeats east and west
        y: ty,
        left: tx * size - left0,
        top: ty * size - top0,
        size,
      });
    }
  }
  return { z, size, tiles };
}

export function baseTileUrl(t: MapTile, scale: 1 | 2): string {
  return `https://tile.gbif.org/3857/omt/${t.z}/${t.x}/${t.y}@${scale}x.png?style=gbif-dark`;
}

export function densityTileUrl(t: MapTile, scale: 1 | 2, taxonKey: number): string {
  // hexPerTile is per 512 px tile; ~ 9 px hexagons at full tile size.
  return (
    `https://api.gbif.org/v2/map/occurrence/density/${t.z}/${t.x}/${t.y}@${scale}x.png` +
    `?taxonKey=${taxonKey}&bin=hex&hexPerTile=56&style=purpleYellow.poly`
  );
}

/**
 * Builds the map element. `onSettled` fires once every tile has loaded or
 * failed (screenshots wait for it); failed tiles simply stay black.
 */
export function occurrenceMap(
  taxonKey: number,
  bbox: readonly [number, number, number, number] | null,
  width: number,
  height: number,
  onSettled: () => void,
): HTMLElement {
  const box = document.createElement('div');
  box.className = 'occmap';
  box.style.width = `${width}px`;
  box.style.height = `${height}px`;
  const scale: 1 | 2 = (window.devicePixelRatio || 1) > 1 ? 2 : 1;
  const view = mapView(bbox, width, height);
  let pending = view.tiles.length * 2;
  const done = (): void => {
    pending--;
    if (pending === 0) onSettled();
  };
  if (pending === 0) queueMicrotask(onSettled);
  for (const layer of ['base', 'density'] as const) {
    for (const t of view.tiles) {
      const img = document.createElement('img');
      img.className = layer === 'base' ? 'occmap-base' : 'occmap-density';
      img.alt = '';
      img.decoding = 'async';
      img.style.left = `${t.left}px`;
      img.style.top = `${t.top}px`;
      img.style.width = `${t.size}px`;
      img.style.height = `${t.size}px`;
      img.addEventListener('load', done, { once: true });
      // GBIF answers an empty density tile with 204, which is an image
      // error: hide it, or Chromium draws a broken-image outline.
      img.addEventListener(
        'error',
        () => {
          img.style.visibility = 'hidden';
          done();
        },
        { once: true },
      );
      img.src = layer === 'base' ? baseTileUrl(t, scale) : densityTileUrl(t, scale, taxonKey);
      box.append(img);
    }
  }
  return box;
}
