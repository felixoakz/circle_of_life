// Deep-link parameters (PLAN §7.11).
//
//   n = an OpenTree node id: ott770315 or mrcaott42ott4130 (the selection;
//       without it the selection is Homo sapiens, the "You are here" node)
//
//   v = a,z   the locked view (rig.ts): there is no pan, only rotation and
//             zoom
//     a    the world angle at the anchor, in u32 units (the same fixed point
//          as the API's `angle` fields), decimals allowed for sub-unit
//          precision
//     z    log2 of the zoom in CSS px per world unit (DPR-independent),
//          clamped to the window's range on load
//
//   v = a,r,z,rot   free view (freeview.ts): the pan as well, and a link
//                   with it opens in free view
//     a    the polar angle of the world point at the screen centre, u32
//          units (decimals allowed)
//     r    its radius (0 = the wheel's centre, 1 = the rim)
//     z    as above
//     rot  the screen rotation in degrees, counter-clockwise
//   `v=a,r,z` (no rot) is the same with rot 0. Links from before the
//   locked view had this form too, so they open in free view.
//
// Examples: ?n=ott770315&v=1780855860,24.1 is Homo sapiens on the anchor at
// maximum zoom; ?v=1780855860,0.99999,24.1,-149.3 looks at the rim beside
// it in free view, turned so the rim runs vertically.
//
// A plain visit (no `n`, no `v`) always opens on Homo sapiens at minimum
// zoom: nothing is restored from storage. Motion flags (main.ts):
//
//   still          no ambient turn, no fling, no idle tour (also implied by
//                  `shot` and by reduced motion), so screenshots and tests
//                  are deterministic
//   tour=<s>       the idle tour's dwell in seconds (default 10); with
//                  `still` or `shot` it turns the tour on by itself

import { TWO_32, fromRad, toRad } from './angle';
import type { FreePose, Pose, Rig } from './rig';

/** The `v` parameter: `a` and `z`, plus the pan in free view. */
export interface ViewParam {
  a: number;
  z: number;
  /** Free view: the screen centre's radius and the rotation in degrees (`a` is then the centre's angle). */
  free?: { r: number; rot: number };
}

export function parseView(s: string | null): ViewParam | null {
  if (!s) return null;
  const parts = s.split(',').map(Number);
  if (parts.length < 2 || parts.length > 4 || parts.some((x) => !Number.isFinite(x))) return null;
  const a = parts[0] ?? 0;
  if (a < 0 || a >= TWO_32) return null;
  if (parts.length === 2) return { a, z: parts[1] ?? 0 };
  // Three or four: a,r,z[,rot], free view.
  const r = parts[1] ?? 0;
  if (r < 0) return null;
  return { a, z: parts[2] ?? 0, free: { r, rot: parts[3] ?? 0 } };
}

export function formatView(v: ViewParam): string {
  // Enough digits to keep a deep zoom within a fraction of a pixel: r to
  // 1e-10 is 0.002 px at maximum zoom.
  if (v.free) return [+v.a.toFixed(3), +v.free.r.toFixed(10), +v.z.toFixed(4), +v.free.rot.toFixed(3)].join(',');
  return [+v.a.toFixed(3), +v.z.toFixed(4)].join(',');
}

/** The locked pose a view parameter asks for, at `dpr` device px per CSS px (the rig clamps the zoom). */
export function viewPose(v: ViewParam, dpr: number): Pose {
  return { theta: toRad(v.a), scale: 2 ** v.z * dpr };
}

export function viewOf(p: Pose, dpr: number): ViewParam {
  return { a: fromRad(p.theta), z: Math.log2(p.scale / dpr) };
}

/** The free pose a free view parameter asks for (its `free` part; a locked one is taken at r 1, rot 0). */
export function viewFreePose(v: ViewParam, dpr: number): FreePose {
  const theta = toRad(v.a);
  const r = v.free?.r ?? 1;
  return { x: r * Math.cos(theta), y: r * Math.sin(theta), scale: 2 ** v.z * dpr, rot: ((v.free?.rot ?? 0) * Math.PI) / 180 };
}

export function freeViewOf(f: FreePose, dpr: number): ViewParam {
  const r = Math.hypot(f.x, f.y);
  const theta = r > 0 ? Math.atan2(f.y, f.x) : 0;
  let deg = (f.rot * 180) / Math.PI;
  deg -= 360 * Math.round(deg / 360);
  return { a: fromRad(theta), z: Math.log2(f.scale / dpr), free: { r, rot: deg } };
}

/** The view parameter for the rig as it is: locked or free. */
export function rigView(rig: Rig): ViewParam {
  const dpr = rig.camera.dpr;
  return rig.free ? freeViewOf(rig.free, dpr) : viewOf(rig.pose(), dpr);
}

/** Puts the rig at a view parameter: free view for one with the pan, else the locked view. */
export function applyView(rig: Rig, v: ViewParam): void {
  if (v.free) rig.setFree(viewFreePose(v, rig.camera.dpr));
  else rig.set(viewPose(v, rig.camera.dpr));
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
