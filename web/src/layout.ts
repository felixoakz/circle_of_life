// Screen composition per viewport (DESIGN.md §4): where the selection card
// sits, and where the wheel sits at minimum zoom. Pure functions of the
// window size, CSS px, y down.
//
// Desktop (landscape, ≥ 720 px wide): the card is a fixed rectangle at the
// top right, from 62% of the width to the gutter and from under the search
// trigger to 40% of the height. The anchor (the point zoom scales about, and
// where the selection sits) is just below the card's bottom-left corner, a
// short leader away from it. The wheel at minimum zoom passes through the
// anchor at the focus angle (30°, upper right) and its top sits under the
// header, so its centre falls low on the left and the rim fills the left and
// the top (docs/reference composition).
//
// Zooming in, the anchor drifts left (rig.ts): at deep zoom it sits at
// `deepX`, so the rim and the column of names beyond it end well clear of
// the card's left edge and the rows beside the card keep their names. At
// minimum zoom it is where the composition above puts it.
//
// Compact (phones, and any portrait window): the card spans the top, full
// width less the gutters. The anchor sits a little under it, the focus angle
// is steeper (60°), and the wheel's centre is low near the left edge, so the
// rim fills the space under the card.

import type { Box } from './labelLayout';

export interface Point {
  x: number;
  y: number;
}

export interface Layout {
  /** Phone or portrait: the card on top, the wheel below. */
  compact: boolean;
  /**
   * The selection card's nominal box: the composition (the anchor) is built
   * round it. The card itself is as tall as its content, from its top, at
   * least `cardMinH` and at most down to `cardMax.y1` (ui/panel.ts).
   */
  card: Box;
  /** The card's largest box (desktop: taller than the nominal one, for long content). */
  cardMax: Box;
  /** The card's least height, CSS px. */
  cardMinH: number;
  /** The anchor at minimum zoom: the rim point at the focus angle; zoom scales about it. */
  anchor: Point;
  /** The anchor's x at deep zoom, once tips resolve (it drifts there as the focus angle eases to 0°). */
  deepX: number;
  /** Screen angle (radians, counter-clockwise from +x) from the wheel's centre to the anchor, at minimum zoom. */
  focus: number;
  /** Rim radius at minimum zoom. */
  radius: number;
}

/** Edge gutter (desktop) and the card's side gutter on a phone. */
const GUTTER = 16;
const COMPACT_GUTTER = 12;
/** The card's top: under the search bar (ui/search.ts `placeTrigger`: 12 + 40 + 8). */
const CARD_TOP = 60;
const COMPACT_CARD_TOP = 64;
/** Desktop card: left edge at this share of the width, bottom at this share of the height. */
const CARD_LEFT = 0.62;
const CARD_BOTTOM = 0.4;
const CARD_MIN_W = 340;
const CARD_MIN_H = 240;
/** Desktop: the card's fixed box reaches down to this share of the height, keeps this far above the bottom, and is at most CARD_MAX_H tall. */
const CARD_MAX_BOTTOM = 0.6;
const CARD_MAX_BOTTOM_ROOM = 152;
const CARD_MAX_H = 560;
/** Phone card height: this share of the height, within bounds. */
const COMPACT_CARD_H = 0.36;
const COMPACT_CARD_MIN_H = 248;
const COMPACT_CARD_MAX_H = 348;
/** Room between the anchor and the card: the leader runs here. */
const ANCHOR_LEFT = 72;
const ANCHOR_BELOW = 28;
const COMPACT_ANCHOR_BELOW = 88;
/** Focus angles at minimum zoom. */
const FOCUS = Math.PI / 6;
const COMPACT_FOCUS = Math.PI / 3;
/** Desktop: the rim's top at minimum zoom (room above it for group labels). */
const RIM_TOP = 64;
/** Phone: the wheel's centre height, and the rim's right edge inside the gutter. */
const COMPACT_CENTRE_Y = 0.86;
const COMPACT_RIM_RIGHT = 20;
/** Deep zoom: the anchor at this share of the width at most, and this far left of the card (room for names). */
const DEEP_X = 0.33;
const DEEP_NAME_ROOM = 360;
const COMPACT_DEEP_X = 0.3;
/** Narrower than this, or portrait, is compact. */
const COMPACT_MAX_W = 719;

export function isCompact(w: number, h: number): boolean {
  return w <= COMPACT_MAX_W || w <= h;
}

/** The composition for a window of w × h CSS px. */
export function layoutFor(w: number, h: number): Layout {
  return isCompact(w, h) ? compactLayout(w, h) : desktopLayout(w, h);
}

function desktopLayout(w: number, h: number): Layout {
  const right = w - GUTTER;
  const left = Math.round(Math.min(w * CARD_LEFT, right - CARD_MIN_W));
  const bottom = Math.round(Math.max(h * CARD_BOTTOM, CARD_TOP + CARD_MIN_H));
  const card = { x0: left, y0: CARD_TOP, x1: right, y1: bottom };
  const anchor = { x: left - ANCHOR_LEFT, y: bottom + ANCHOR_BELOW };
  // The rim passes through the anchor at the focus angle and its top is at
  // RIM_TOP: centre.y = anchor.y + R sin φ and centre.y − R = RIM_TOP.
  const radius = Math.max(anchor.y - RIM_TOP, 1) / (1 - Math.sin(FOCUS));
  const deepX = Math.max(GUTTER, Math.min(anchor.x, w * DEEP_X, left - DEEP_NAME_ROOM));
  const maxBottom = Math.round(Math.max(bottom, Math.min(h * CARD_MAX_BOTTOM, h - CARD_MAX_BOTTOM_ROOM, CARD_TOP + CARD_MAX_H)));
  const cardMax = { ...card, y1: maxBottom };
  return { compact: false, card, cardMax, cardMinH: CARD_MIN_H, anchor, deepX, focus: FOCUS, radius };
}

function compactLayout(w: number, h: number): Layout {
  const cardH = Math.round(Math.min(COMPACT_CARD_MAX_H, Math.max(COMPACT_CARD_MIN_H, h * COMPACT_CARD_H)));
  const card = { x0: COMPACT_GUTTER, y0: COMPACT_CARD_TOP, x1: w - COMPACT_GUTTER, y1: COMPACT_CARD_TOP + cardH };
  const ay = card.y1 + COMPACT_ANCHOR_BELOW;
  // The centre sits at COMPACT_CENTRE_Y of the height; the rim reaches the
  // anchor at the focus angle and its right edge stops inside the gutter.
  const radius = Math.max(h * COMPACT_CENTRE_Y - ay, 1) / Math.sin(COMPACT_FOCUS);
  const ax = w - COMPACT_RIM_RIGHT - radius * (1 - Math.cos(COMPACT_FOCUS));
  const deepX = Math.max(COMPACT_GUTTER, Math.min(ax, w * COMPACT_DEEP_X));
  // A phone's card never grows past its nominal box: the wheel's focus is right under it.
  return { compact: true, card, cardMax: card, cardMinH: COMPACT_CARD_MIN_H, anchor: { x: ax, y: ay }, deepX, focus: COMPACT_FOCUS, radius };
}

/** The wheel's centre at minimum zoom (the anchor, back along the focus angle by the radius). */
export function wheelCentre(l: Layout): Point {
  return { x: l.anchor.x - l.radius * Math.cos(l.focus), y: l.anchor.y + l.radius * Math.sin(l.focus) };
}

/** The card's height, CSS px: its fixed box, down to `cardMax` (taller than the nominal box on desktop, which the anchor is built on). */
export function cardHeight(l: Layout): number {
  return l.cardMax.y1 - l.card.y0;
}

/** The bottom HUD band (breadcrumb, readout) that a fitted clade keeps clear of, CSS px. */
const HUD_ROOM = 96;
/** A fitted clade keeps this far under the card on a phone, CSS px. */
const UNDER_CARD = 8;

/**
 * The height a clade can fill when it is centred on the anchor (selection.ts
 * `suitPose`), CSS px: twice the smaller of the room above the anchor (to
 * the header, or to the card on a phone) and below it (to the bottom HUD).
 */
export function suitSpan(l: Layout, h: number): number {
  const top = l.compact ? l.card.y1 + UNDER_CARD : CARD_TOP;
  const bottom = h - HUD_ROOM;
  return Math.max(1, 2 * Math.min(l.anchor.y - top, bottom - l.anchor.y));
}
