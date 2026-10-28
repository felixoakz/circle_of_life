// The home leader bar's length (DESIGN.md §5): HOME_LEADER_LEN_PX, shortened
// so its far end stops at the 16 px gutter instead of running off the screen
// (on a phone the label plus a 280 px bar is wider than the window). The
// renderer draws it and the labels keep clear of it, so both use this.

import { toRad } from './angle';
import type { Camera } from './camera';
import * as S from './style';

/** Room (CSS px) from a screen point along a unit direction to the gutter; Infinity if it never leaves. */
export function roomToEdge(x: number, y: number, ux: number, uy: number, w: number, h: number, gutter: number): number {
  let t = Infinity;
  if (ux > 1e-9) t = Math.min(t, (w - gutter - x) / ux);
  if (ux < -1e-9) t = Math.min(t, (x - gutter) / -ux);
  if (uy > 1e-9) t = Math.min(t, (h - gutter - y) / uy);
  if (uy < -1e-9) t = Math.min(t, (y - gutter) / -uy);
  return t;
}

/**
 * Length (CSS px) of the leader bar that starts `gap` px outside the rim at
 * u32 angle `angle`: the full length where it fits, less where the screen
 * edge comes first, never negative. Off-screen rims keep the full length.
 */
export function leaderLength(cam: Camera, angle: number, gap: number): number {
  const theta = toRad(angle);
  const dpr = cam.dpr;
  const p = cam.polarToScreen(theta, 1);
  const x = p.x / dpr;
  const y = p.y / dpr;
  const w = cam.width / dpr;
  const h = cam.height / dpr;
  if (x < 0 || y < 0 || x > w || y > h) return S.HOME_LEADER_LEN_PX;
  // Outward on screen: the direction of the world point a little further out.
  const q = cam.polarToScreen(theta, 1 + 1 / cam.scale);
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const len = Math.hypot(dx, dy) || 1;
  const room = roomToEdge(x, y, dx / len, dy / len, w, h, S.GUTTER_PX);
  return Math.max(0, Math.min(S.HOME_LEADER_LEN_PX, room - gap));
}
