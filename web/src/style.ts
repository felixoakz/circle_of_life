// Canvas look: every tuning constant of lines, fans, glow, rim marks,
// orientation and the intro, kept in one place (DESIGN.md §5–§6,
// PLAN §7.3–§7.5). Pixel sizes are CSS px; the renderer multiplies by the DPR.
//
// λ is the continuous view level (PLAN §3.6): about 3.4 for the whole wheel
// on a 1440×900 screen, 12 where tips are 0.44 px apart, 15.2 at 4 px and
// 18.8 at the 48 px maximum.

import { smoothstep } from './ease';

/** Screen edge gutter (DESIGN.md §4.1), CSS px: labels and clade bars stay inside it. */
export const GUTTER_PX = 16;
/**
 * Height of the bottom HUD band (breadcrumb, readout, controls), CSS px.
 * Clade bars stop at it.
 */
export const HUD_BAND_PX = 56;

/** Kingdom colours meet in a seam this wide on screen (palette.ts, DESIGN.md §2.2). */
export const SEAM_PX = 2;

/** Branch hairline alpha at overview (DESIGN.md §2.1 `--branch`). */
export const BRANCH_ALPHA = 0.35;
/** …rising to this at deep zoom, so single terminal branches read clearly. */
export const BRANCH_ALPHA_DEEP = 0.85;
/** λ range over which branch alpha rises from overview to deep. */
export const BRANCH_ALPHA_RAMP: readonly [number, number] = [12.5, 15.5];
/**
 * Line width (branches, arcs, tip bars, the home bar), CSS px: the hairline
 * thickens to LINE_DEEP_PX as tips spread over LINE_WIDTH_SPACING (px between
 * tips), where each branch reads as its own line running into its name.
 * Below one device px the lines stay native hairlines, so the overview and
 * mid zoom are drawn exactly as before (render/plan.ts).
 */
export const LINE_DEEP_PX = 1.75;
export const LINE_WIDTH_SPACING: readonly [number, number] = [8, 32];
/** Highlighted paths are at least this many times the line width, so the selection stays heavier. */
export const PATH_LINE_RATIO = 2;

/**
 * Lines take the kingdom colour as r goes 0.55 → 1 (DESIGN.md §5); raising
 * the blend to this power keeps the interior grey and concentrates the
 * colour towards the rim, as in 5.png.
 */
export const TINT_POWER = 2;
/**
 * Lines brighten within RIM_BAND_PX of the rim, by up to RIM_BOOST × glow
 * (the luminous band of 5.png). The band is in screen px, so zooming into
 * it does not turn the whole screen into band: on the whole wheel it is the
 * outer ~14% of the radius.
 */
export const RIM_BAND_PX = 120;
export const RIM_BOOST = 2.2;

/**
 * A frontier extension (and a fan) stands for a whole unresolved subtree.
 * Its lineages multiply towards the rim, so it starts faint at its node and
 * builds up: alpha × mix(EXT_INNER, 1, t^EXT_POWER), t = 0 at the node, 1 at the rim.
 */
export const EXT_INNER = 0.04;
export const EXT_POWER = 4;
/** …and on screen: beyond ~3 rim bands from the rim they dim to this. */
export const EXT_FAR = 0.3;

/**
 * Fans: overall alpha, and the width of one fine line of their striation.
 * Fans narrower than FAN_MIN_PX on screen are skipped: their node's
 * extension line already stands for them, and thousands of 1 px slivers are
 * the most expensive thing to rasterise.
 */
export const FAN_ALPHA = 0.32;
export const FAN_LINE_PX = 2;
export const FAN_MIN_PX = 1.5;
/** Fans fade out over this λ range once tips resolve, as the ring does (no hatching between bars). */
export const FAN_FADE: readonly [number, number] = [12.5, 13.5];

/**
 * Glow strength over zoom: 1 up to λ GLOW_RAMP[0], then easing to
 * GLOW_DEEP by GLOW_RAMP[1]. Glow is loudest on the whole wheel.
 */
export const GLOW_RAMP: readonly [number, number] = [4, 11];
export const GLOW_DEEP = 0.45;

/**
 * Rim ring (PLAN §7.3 pass 3): an analytic glow around r = 1 with a crisp
 * core (Gaussian, σ px), a halo decaying outward and a wider one inward (px),
 * and the "fur": short outward strokes, one per FUR_LINE_PX column, of
 * hashed length up to FUR_PX. The ring fades out as tips resolve.
 */
export const RING_CORE = 0.6;
export const RING_CORE_SIGMA_PX = 1.2;
export const RING_HALO = 0.35;
export const RING_HALO_OUT_PX = 10;
export const RING_HALO_IN = 0.4;
export const RING_HALO_IN_PX = 55;
export const RING_FUR = 0.55;
export const RING_FUR_PX = 9;
export const RING_FUR_LINE_PX = 1.5;
/** Annulus drawn: px inside and outside the rim (enough for the halos). */
export const RING_REACH_IN_PX = 140;
export const RING_REACH_OUT_PX = 48;
/** λ over which the ring fades out as tip bars take over. */
export const RING_FADE: readonly [number, number] = [11.5, 13];

/**
 * Clade spikes (PLAN §7.3 pass 4): outward from the rim for each frontier
 * node, length clamp(3 + 2·log2(leaves), 3, 14) px, at most SPIKE_MAX_W wide.
 */
export const SPIKE_ALPHA = 0.5;
export const SPIKE_MAX_W_PX = 2.5;

/**
 * Tip bars: the last TIP_BAR_MAX_LEN_PX of each tip's branch, inward from the
 * rim, brightened in the kingdom colour as tips resolve (λ TIP_BAR_RAMP), so
 * the rim keeps glowing as the ring fades. A bar is one device px wide, like
 * the hairline it lies on, and fades out again as tips spread apart
 * (TIP_BAR_FADE_SPACING, px between tips), so by the time species labels show
 * each branch runs into its name as one even line. The bar adds to its
 * hairline rather than replacing it, hence the lower alpha.
 */
export const TIP_BAR_RAMP: readonly [number, number] = [12, 13.5];
export const TIP_BAR_FADE_SPACING: readonly [number, number] = [2, 6];
export const TIP_BAR_ALPHA = 0.6;
export const TIP_BAR_MAX_LEN_PX = 120;

/**
 * Home (Homo sapiens): its subtree is white, and a short outward leader bar
 * sits past its label (bar → label → rim), once tips are this far apart
 * (px). It is drawn like a tip bar: one device px wide, no halo, fading in
 * from its far end, HOME_LEADER_LEN_PX long. It is not drawn while Homo
 * sapiens is the selection: the selection leader and the card say "you are
 * here" then (scene.ts `homeLeader`). The bar starts HOME_LEADER_PAD_PX
 * beyond the end of the label (labels.ts measures it); HOME_LEADER_GAP_PX is
 * the fallback before fonts load.
 */
export const HOME_LEADER_SPACING: readonly [number, number] = [8, 11];
export const HOME_LEADER_GAP_PX = 190;
export const HOME_LEADER_PAD_PX = 28;
export const HOME_LEADER_LEN_PX = 120;
/** The bar's width, device px (like the hairline it continues). */
export const HOME_LEADER_WIDTH_DEVICE_PX = 1;
/** Home lines are drawn this much stronger than ordinary branches. */
export const HOME_LINE_ALPHA = 1;

/**
 * Auto-orient (rig.ts): the focus angle eases to 0° (the rim vertical at the
 * anchor) as tips spread over this range of spacing, CSS px (log scale).
 * Toggling it (R) eases over ORIENT_MS.
 */
export const TURN_SPACING: readonly [number, number] = [0.25, 4];
export const ORIENT_MS = 400;

/** Intro reveal (DESIGN.md §6): 900 ms, cubic-bezier(0.2, 0, 0, 1), r 0 → REVEAL_END. */
export const INTRO_MS = 900;
export const INTRO_EASE: readonly [number, number, number, number] = [0.2, 0, 0, 1];
export const REVEAL_END = 1.05;
/** Soft edge of the reveal front, in world radius. */
export const REVEAL_SOFT = 0.04;

/**
 * The tree is darkened behind HUD text and controls (ui/obstacles.ts): by
 * DIM_HUD over the text's own box, easing to nothing over DIM_PAD_PX +
 * DIM_SOFT_PX around it (still about 70% at the pad), so the flat DOM text
 * reads over bright glow. The ease starts at the text, not at the padded
 * box: a flat 85% block with a short fringe read as a blurred redaction box
 * where bright tip bars run behind the wordmark (P12 review).
 */
export const DIM_HUD = 0.85;
export const DIM_PAD_PX = 8;
export const DIM_SOFT_PX = 20;

// ---- Labels (Canvas2D overlay, PLAN §7.7, DESIGN.md §3) ----

/** Canvas text colours: `--text-1`, `--text-2` and the home white (DESIGN.md §2). */
export const TEXT_1 = '#e9e8e4';
export const TEXT_2 = '#9e9e9e';
export const TEXT_3 = '#7a7a7a';
export const HOME_WHITE = '#ffffff';
export const FONT_SANS = '"Hanken Grotesk Variable", sans-serif';
export const FONT_SERIF = '"Source Serif 4 Variable", serif';

/** At most this many labels per frame. */
export const MAX_LABELS = 300;
/** Hysteresis: a label shows at fit ≥ 1 and hides below this (DESIGN.md §5). */
export const LABEL_HIDE_FIT = 0.85;
/** In a collision, a label already shown beats a new one unless that has this many times its priority. */
export const LABEL_STICKY = 2;
export const LABEL_FADE_MS = 150;
/** Labels and HUD fade in after the intro (DESIGN.md §6). */
export const LABEL_INTRO_FADE_MS = 200;

/**
 * Group labels (Animals, Plants…): 13 px, GROUP_GAP_PX outside the rim at
 * the midpoint of the group's largest run. They show while the wheel is
 * whole on screen: on once at least WHEEL_SHARE[1] of the rim is in view,
 * off below WHEEL_SHARE[0] (then clade bars take over), each family fading
 * over LABEL_FADE_MS.
 */
export const GROUP_FONT_PX = 13;
export const GROUP_GAP_PX = 26;
export const WHEEL_SHARE: readonly [number, number] = [0.8, 0.92];

/**
 * "You are here": a hairline from just outside the rim, then an 11 px label.
 * The hairline runs from HERE_LEADER[0] to [1] px past the rim on the whole
 * wheel, and out to [2] once clade bars sit outside the rim.
 */
export const HERE_FONT_PX = 11;
export const HERE_LEADER: readonly [number, number, number] = [6, 40, 58];

/**
 * Clade labels follow their arc on its inner side, where only the clade's
 * own stem runs. Shown when the visible arc is at least the text width plus
 * CLADE_PAD_PX, and when the stem is long enough to hold the text.
 */
export const CLADE_PAD_PX = 24;
export const CLADE_INSET_PX = 3;
export const CLADE_MIN_ARC_PX = 40;
/**
 * Otherwise a clade bar outside the rim: a hairline arc CLADE_RIM_GAP_PX out
 * (past the fur and spikes; at deep zoom past the tip labels too) with
 * CLADE_TICK_PX end ticks, and the name CLADE_BAR_TEXT_PX beyond it. Only
 * for clades with at least CLADE_RIM_COVERAGE of their extent on screen
 * and taking at most CLADE_RIM_MAX_SHARE of the rim in view (bigger ones
 * are the context, which the breadcrumb shows). They show once the group
 * labels go (WHEEL_SHARE).
 */
export const CLADE_RIM_GAP_PX = 22;
export const CLADE_TICK_PX = 5;
export const CLADE_BAR_TEXT_PX = 4;
export const CLADE_RIM_COVERAGE = 0.9;
/** …and at most this share of the rim on screen. */
export const CLADE_RIM_MAX_SHARE = 0.6;
/** Nested bars stack outward in lanes, each this far past the names of the lane inside. */
export const CLADE_LANE_GAP_PX = 8;
/** Nested clade bars stack outward in at most this many lanes (labels.ts). */
export const CLADE_MAX_LANES = 3;
/**
 * At deep zoom bar names are CLADE_DEEP_FONT_PX and, where the bar runs
 * within ~37° of vertical (|cos φ| above this), set horizontally beside it.
 */
export const CLADE_DEEP_FONT_PX = 13;
export const CLADE_FLAT_COS = 0.8;

/**
 * A hairline (the selection's leader, "You are here") passes behind names
 * rather than costing them: it is cut by a halo this wide (CSS px, so about
 * 1.5 px each side) round each glyph it crosses.
 */
export const HAIRLINE_KNOCK_PX = 3;

/**
 * Tip labels: shown once tips are TIP_LABEL_SPACING px apart, set
 * TIP_GAP_PX outside the rim, 12–22 px, growing with the tip spacing.
 */
export const TIP_LABEL_SPACING = 11;
export const TIP_GAP_PX = 10;

export function tipFontPx(tipSpacing: number): number {
  return Math.min(22, Math.max(12, 6.5 + 0.5 * tipSpacing));
}

/** Zoom-dependent strengths for one frame, derived from the constants above. */
export interface Look {
  /** Glow multiplier: 1 on the whole wheel, GLOW_DEEP when deep. */
  glow: number;
  branchAlpha: number;
  /** Rim ring strength (0: not drawn). */
  ring: number;
  /** Tip bar alpha (0: off). */
  tipBar: number;
  /** Home leader bar alpha (0: off). */
  leader: number;
  /** Line width, CSS px (0 while lines are hairlines: see LINE_WIDTH_SPACING). */
  lineWidth: number;
  /** Fan strength (0: not drawn). */
  fans: number;
}

/** `tipSpacing` is the distance between neighbouring tips, CSS px. */
export function frameLook(p: { lambda: number; tipSpacing: number }): Look {
  const glow = 1 - (1 - GLOW_DEEP) * smoothstep(GLOW_RAMP[0], GLOW_RAMP[1], p.lambda);
  const deep = smoothstep(BRANCH_ALPHA_RAMP[0], BRANCH_ALPHA_RAMP[1], p.lambda);
  return {
    glow,
    branchAlpha: BRANCH_ALPHA + (BRANCH_ALPHA_DEEP - BRANCH_ALPHA) * deep,
    ring: glow * (1 - smoothstep(RING_FADE[0], RING_FADE[1], p.lambda)),
    tipBar:
      TIP_BAR_ALPHA *
      smoothstep(TIP_BAR_RAMP[0], TIP_BAR_RAMP[1], p.lambda) *
      (1 - smoothstep(TIP_BAR_FADE_SPACING[0], TIP_BAR_FADE_SPACING[1], p.tipSpacing)),
    leader: smoothstep(HOME_LEADER_SPACING[0], HOME_LEADER_SPACING[1], p.tipSpacing),
    lineWidth: LINE_DEEP_PX * smoothstep(LINE_WIDTH_SPACING[0], LINE_WIDTH_SPACING[1], p.tipSpacing),
    fans: 1 - smoothstep(FAN_FADE[0], FAN_FADE[1], p.lambda),
  };
}

// ---- Hover, selection and picking (DESIGN.md §5, §8; PLAN §7.8) ----

/** Hover: the rest of the tree dims to 60%, the path is text-1 at 60%, 2 px. */
export const HOVER_TREE_DIM = 0.4;
export const HOVER_PATH_ALPHA = 0.6;
/** The dim eases in and out over this long, so sweeping across the tree does not flicker. */
export const HOVER_FADE_MS = 150;
export const PATH_WIDTH_PX = 2;
/** Selection: a white 2 px path and a hairline ring of this radius round the node. */
export const SELECT_RING_PX = 6;
/** Pointer hit tolerance, CSS px (PLAN §7.8: 4 px; fingers get more). */
export const PICK_TOL_MOUSE_PX = 4;
export const PICK_TOL_TOUCH_PX = 12;
/** The rim zone reaches past the rim over the spikes, and over the tip labels once shown. */
export const PICK_RIM_OUT_PX = 14;
export const PICK_LABEL_OUT_PX = 220;
/** …and inside it to the ring's core (overview) or the length of the tip bars. */
export const PICK_RIM_IN_PX = 6;
/** Hover asks the API for the full lineage and rank after the pointer rests this long. */
export const HOVER_FETCH_MS = 90;
/** The tooltip sits this far from the pointer (DESIGN.md §8). */
export const TOOLTIP_OFFSET_PX = 8;

/**
 * Most device pixels the tree canvas's backing store may hold (PLAN §7.12).
 * Measured on the dev machine's AMD iGPU, 5K overview (2560×1440 CSS at
 * DPR 2): uncapped 14.7 Mpx 10.7–12.8 ms, 8.3 Mpx 8.5–9.5 ms, 7 Mpx
 * 7.6–8.4 ms, 6 Mpx 7.0–7.9 ms. Larger canvases render the tree at a lower
 * effective DPR (1.7 on a 1080p DPR-2 laptop); the label overlay keeps the
 * screen's full DPR, so text stays crisp.
 */
export const MAX_BACKING_PX = 6_000_000;
