// Deep-link parameters (PLAN §7.11).
//
//   n = an OpenTree node id: ott770315 or mrcaott42ott4130 (the selection)
//
//   v = a,r,z,rot
//     a    camera angle in u32 units (the same fixed point as the API's
//          `angle` fields), decimals allowed for sub-unit precision
//     r    world radius of the screen centre (0 = centre of the wheel, 1 = rim)
//     z    log2 of the zoom in CSS px per world unit (DPR-independent)
//     rot  screen rotation in degrees, counter-clockwise
//
// Example: ?v=1780855860,0.99999,24.1,-149.3 looks at the rim near Homo
// sapiens, turned so the rim runs vertically.

import { TWO_32, fromRad, toRad } from './angle';
import type { Camera } from './camera';

export interface ViewParam {
  a: number;
  r: number;
  z: number;
  rot: number;
}

export function parseView(s: string | null): ViewParam | null {
  if (!s) return null;
  const parts = s.split(',').map(Number);
  if (parts.length < 3 || parts.length > 4 || parts.some((x) => !Number.isFinite(x))) return null;
  const [a = 0, r = 0, z = 0, rot = 0] = parts;
  if (a < 0 || a >= TWO_32 || r < 0) return null;
  return { a, r, z, rot };
}

export function formatView(v: ViewParam): string {
  // Enough digits to keep a deep zoom within a fraction of a pixel.
  return [+v.a.toFixed(3), +v.r.toFixed(10), +v.z.toFixed(4), +v.rot.toFixed(3)].join(',');
}

export function applyView(cam: Camera, v: ViewParam): void {
  cam.angle = toRad(v.a);
  cam.r = v.r;
  cam.scale = cam.clampScale(2 ** v.z * cam.dpr);
  cam.rot = (v.rot * Math.PI) / 180;
}

export function viewOf(cam: Camera): ViewParam {
  return {
    a: fromRad(cam.angle),
    r: cam.r,
    z: Math.log2(cam.scale / cam.dpr),
    rot: (cam.rot * 180) / Math.PI,
  };
}

/** OpenTree node ids as the API and tree.opentreeoflife.org use them. */
const NODE_ID = /^(?:ott\d+|mrcaott\d+ott\d+)$/;

export function parseNode(s: string | null): string | null {
  return s && NODE_ID.test(s) ? s : null;
}

/** The deep-linkable state: the selected node and the camera. */
export interface DeepLink {
  n: string | null;
  v: ViewParam | null;
}

/** Reads `n` and `v` from a query string (with or without the leading "?"). */
export function parseLink(search: string): DeepLink {
  const params = new URLSearchParams(search);
  return { n: parseNode(params.get('n')), v: parseView(params.get('v')) };
}

/**
 * A query string with `n` and `v` replaced (or removed when null) and every
 * other parameter (`shot`, `debug`, `reduced`) kept as it was. Written by
 * hand rather than with URLSearchParams, which would escape the commas.
 */
export function linkSearch(search: string, link: DeepLink): string {
  const keep = search
    .replace(/^\?/, '')
    .split('&')
    .filter((kv) => kv !== '' && !/^(?:n|v)(?:=|$)/.test(kv));
  if (link.n) keep.push(`n=${link.n}`);
  if (link.v) keep.push(`v=${formatView(link.v)}`);
  return keep.length > 0 ? `?${keep.join('&')}` : '';
}
