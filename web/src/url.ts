// Deep-link parameters (PLAN §7.11).
//
//   n = an OpenTree node id: ott770315 or mrcaott42ott4130 (the selection;
//       without it the selection is Homo sapiens, the "You are here" node)
//
//   v = a,z   the view (rig.ts): there is no pan, only rotation and zoom
//     a    the world angle at the anchor, in u32 units (the same fixed point
//          as the API's `angle` fields), decimals allowed for sub-unit
//          precision
//     z    log2 of the zoom in CSS px per world unit (DPR-independent),
//          clamped to the window's range on load
//
// Example: ?n=ott770315&v=1780855860,24.1 is Homo sapiens on the anchor at
// maximum zoom.
//
// A plain visit (no `n`, no `v`) always opens on Homo sapiens at minimum
// zoom: nothing is restored from storage. Motion flags (main.ts):
//
//   still          no ambient turn, no fling, no idle tour (also implied by
//                  `shot` and by reduced motion), so screenshots and tests
//                  are deterministic
//   tour=<s>       the idle tour's dwell in seconds (default 10); with
//                  `still` or `shot` it turns the tour on by itself
//
// Older links carried the pan as well, `v=a,r,z` or `v=a,r,z,rot` (the
// angle and radius of the screen centre, and the screen rotation). They
// still parse: `a` becomes the angle at the anchor, `z` the zoom, and r and
// rot are ignored.

import { TWO_32, fromRad, toRad } from './angle';
import type { Pose } from './rig';

export interface ViewParam {
  a: number;
  z: number;
}

export function parseView(s: string | null): ViewParam | null {
  if (!s) return null;
  const parts = s.split(',').map(Number);
  if (parts.length < 2 || parts.length > 4 || parts.some((x) => !Number.isFinite(x))) return null;
  // Two parts: a,z. Three or four: the old a,r,z[,rot]; the pan is dropped.
  const a = parts[0] ?? 0;
  const z = (parts.length === 2 ? parts[1] : parts[2]) ?? 0;
  if (a < 0 || a >= TWO_32) return null;
  if (parts.length > 2 && (parts[1] ?? 0) < 0) return null;
  return { a, z };
}

export function formatView(v: ViewParam): string {
  // Enough digits to keep a deep zoom within a fraction of a pixel.
  return [+v.a.toFixed(3), +v.z.toFixed(4)].join(',');
}

/** The pose a view parameter asks for, at `dpr` device px per CSS px (the rig clamps the zoom). */
export function viewPose(v: ViewParam, dpr: number): Pose {
  return { theta: toRad(v.a), scale: 2 ** v.z * dpr };
}

export function viewOf(p: Pose, dpr: number): ViewParam {
  return { a: fromRad(p.theta), z: Math.log2(p.scale / dpr) };
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
