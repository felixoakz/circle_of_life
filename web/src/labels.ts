// Canvas2D label overlay (PLAN §7.7, DESIGN.md §3 and §5), drawn over the
// tree canvas. At most MAX_LABELS per frame, from what the loaded tiles say:
//
//   - group labels (Animals, Plants…) outside the rim at each group's largest
//     run, 13 px text-2 beside a 2 px rule in the group's hue (on the side
//     nearest the rim), while the whole wheel is in view;
//   - "You are here": a hairline from just outside the rim at Homo sapiens
//     and an 11 px text-1 label; it fades out as the home label fades in;
//   - clade labels: named internal nodes, glyph by glyph along the inner side
//     of their arc (the wedge between the parent's arc and the node's own arc
//     holds nothing but the node's own stem; a 4 px knockout parts the stem
//     where it crosses the text). Shown when the arc's visible part is at
//     least the text width + 24 px and the stem can hold the text height;
//   - clade bars, once the wheel is no longer whole on screen: a hairline
//     over a clade's tips outside the rim with its name beside it, nested
//     clades stacked outward in lanes, set horizontally at deep zoom;
//   - tip labels: just outside the rim along the radius (horizontal once
//     auto-orient turns the rim vertical), in the kingdom hue mixed halfway
//     to text-1; full size from 11 px between tips, shrinking and fading
//     below that, then "greeked" (a faint stroke per word) until the rows
//     are too dense (style.ts TIP_TEXT_FADE, TIP_GREEK_SPACING);
//   - the home label, "Homo sapiens" in white, between the rim and the
//     renderer's short leader bar (bar → label → rim). The bar starts
//     HOME_LEADER_PAD_PX past the measured label (`leaderGap`), and is an
//     obstacle for other labels; neither is there while Homo sapiens is the
//     selection. Its two subspecies share its row;
//   - the selection's leader to the card (callout.ts): a hairline in text-1,
//     drawn under the names. It costs no label: where it passes behind one
//     it is cut round the glyphs (HAIRLINE_KNOCK_PX), and a clade bar's name
//     slides off it where it can. While Homo sapiens is the selection, the
//     leader takes the place of "You are here" (the card says it).
//
// Names are set in runs (names.ts): the Latin parts in serif italic, rank
// markers and informal parts in sans roman. OTT placeholders get no label.
// Collision culling, hysteresis and fades live in labelLayout.ts. The layout
// is rebuilt only when the camera, the tile set or the HUD obstacles change;
// fade frames just repaint. mrca nodes have no name and get no label.

import { type AngleRange, RAD_PER_UNIT, TAU, TWO_32, cladeRim, toRad } from './angle';
import type { Camera } from './camera';
import { smoothstep } from './ease';
import { type Arc, circleInRect } from './inview';
import {
  type Box,
  type Candidate,
  type LabelKey,
  type Placement,
  CollisionGrid,
  Fader,
  arcTextDirection,
  cull,
  greekKnocks,
  greekWords,
  inflate,
  outsideBox,
  radialText,
  rotatedBox,
} from './labelLayout';
import { type Leader, leaderBoxes } from './callout';
import { leaderLength } from './leader';
import { type NameRun, abbreviateGenus, isPlaceholderName, italicName, nameRuns } from './names';
import type { RunPalette } from './palette';
import * as S from './style';
import { FLAG_HOME, FLAG_NAMED, FLAG_SPECIES, type Tile, tileName } from './tiles/decode';
import type { Meta } from './types';
import type { Obstacles } from './ui/obstacles';

export interface LabelFrame {
  now: number;
  camera: Camera;
  /** Drawable tiles (CPU side), lowest level first. */
  tiles: readonly Tile[];
  lambda: number;
  /** Visible angular range (lod.ts), or null off the rim. */
  range: AngleRange | null;
  /** Per-level fade-in, as the renderer uses it. */
  fade: (level: number) => number;
}

interface Item extends Candidate {
  /** The label's text (for `dump`). */
  text: string;
  /** Extra opacity besides the fade (the tile's own fade-in for tip labels). */
  alpha: number;
  /** Which family it belongs to, so a family can finish fading after its mode ends. */
  kind?: 'group' | 'bar';
  /** Paints the label; `alt` is the text alternative it won (see Candidate.alts). */
  draw: (ctx: CanvasRenderingContext2D, alt: number) => void;
  /** Strokes a halo round the text's glyphs, to cut a hairline that passes behind it (frame). */
  knock?: (ctx: CanvasRenderingContext2D, alt: number) => void;
}

interface RimPoint {
  x: number;
  y: number;
  /** Outward unit vector on screen (y down). */
  ux: number;
  uy: number;
}

/** A name measured for drawing: its runs with their fonts and widths. */
interface StyledText {
  text: string;
  runs: { text: string; font: string; w: number }[];
  width: number;
  size: number;
}

/** A greeked tip name: where it starts, its words as [start, length] px, its colour. */
interface GreekRow {
  p: RimPoint;
  /** Its text box (for the hairline test). */
  box: Box;
  /** A hairline crosses it: cut the line round its strokes. */
  knock: boolean;
  words: [number, number][];
  width: number;
  colour: string;
  /** The tile's fade-in. */
  alpha: number;
}

/** A clade bar candidate, before lanes are known. */
interface Bar {
  key: string;
  leaves: number;
  /** Its tips, as ranks [first, end). */
  first: number;
  end: number;
  /** Pre-order id: the outer of two clades with the same tips has the smaller one. */
  id: number;
  text: StyledText;
  /** Extent on the rim: world angle of its start and its length, radians. */
  lo: number;
  span: number;
  /** Horizontal name beside a vertical bar (deep zoom, auto-oriented). */
  flat: boolean;
  lane: number;
  /** The selected clade's own bar: always offered, drawn in text-1. */
  sel: boolean;
}

const NO_PARENT = 0xffffffff;
const HOME_NAME = 'Homo sapiens';
/** Labels whose anchor is further than this off screen are not built. */
const SCREEN_MARGIN = 40;
/** Text is measured at this size and scaled (`styled`). */
const MEASURE_PX = 16;
/** Name cache cap (names are decoded lazily from tile bytes). */
const NAME_CACHE = 50_000;
/** Ink for a knockout halo (drawn with destination-out, so only its alpha counts). */
const KNOCK = '#000';

const sansFont = (px: number, weight = 500): string => `${weight} ${px}px ${S.FONT_SANS}`;
const serifFont = (px: number): string => `italic 400 ${px}px ${S.FONT_SERIF}`;

export class Labels {
  /** False until the intro has finished; then labels fade in. */
  private shownAt: number | null = null;
  private fontsReady = false;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly meta: Meta;
  private readonly palette: RunPalette;
  private readonly hud: Obstacles;
  private readonly fader = new Fader();
  private readonly colours = new Map<number, string>();
  /** Text widths by font, then text (no key strings to build per lookup). */
  private readonly widths = new Map<string, Map<string, number>>();
  private readonly names = new Map<number, string>();
  /** Genus names: the first word of every binomial seen in the tiles. */
  private readonly genusNames = new Set<string>();
  private readonly scanned = new WeakSet<Tile>();
  private homeName = HOME_NAME;
  /** Widest tip label on screen in the last layout, CSS px (rim labels go beyond). */
  private tipColumn = 0;
  /** Greeked tip names (tipLabels), painted under the text while they show. */
  private greek: GreekRow[] = [];
  /** Tip spacing of the last layout, CSS px. */
  private spacing = 0;
  /** Whether tip labels are on (with the labels' hysteresis). */
  private tipsOn = false;
  /**
   * Whole-wheel mode: group labels show and clade bars do not. Switched on
   * how much of the rim is on screen, with hysteresis, rather than on λ, so a
   * big screen showing the whole wheel at a deeper level still gets group
   * labels and a resting zoom never leaves either family half faded.
   */
  private wheelOn = true;
  /** Whether any group label / clade bar was still visible at the last paint. */
  private groupsShown = false;
  private barsShown = false;
  private sig = '';
  private items: Item[] = [];
  private obstacles: Box[] = [];
  /**
   * Hairlines (the selection's leader, "You are here"): a clade bar's name
   * slides off them where it can and the bar breaks round them; they never
   * cost a label.
   */
  private soft: Box[] = [];
  /** The same hairlines, for the paint to find the names they pass behind. */
  private hairlines = new CollisionGrid();
  private winners: Placement = new Map();
  private hadContent = false;
  /** Last layout's numbers (debug HUD, screenshot report). */
  stats = { candidates: 0, shown: 0, drawn: 0, layoutMs: 0, paintMs: 0 };
  /** The selection's leader this frame, CSS px (main.ts: selection.ts + callout.ts), or null. */
  callout: () => Leader | null = () => null;
  /** True while "You are here" should not show (Homo sapiens is selected). */
  hideHere: () => boolean = () => false;
  /** The selected node's pre-order id: its tip name wins over its neighbours'. */
  selectedId: () => number = () => -1;
  private leader: Leader | null = null;
  /** The selected clade's tips as ranks [first, end) in this layout, or null (not in the loaded tiles). */
  private selTips: [number, number] | null = null;

  constructor(canvas: HTMLCanvasElement, meta: Meta, palette: RunPalette, hud: Obstacles) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('labels: no 2D context');
    this.canvas = canvas;
    this.ctx = ctx;
    this.meta = meta;
    this.palette = palette;
    this.hud = hud;
  }

  setFontsReady(): void {
    this.fontsReady = true;
    this.widths.clear();
    this.sig = '';
  }

  /** Starts showing labels (after the intro), fading in unless `instant`. */
  show(now: number, instant = false): void {
    if (this.shownAt === null) this.shownAt = instant ? -Infinity : now;
  }

  /**
   * How far past the rim a selected tip's name reaches, CSS px, faded in as
   * the column of tip names (text or greeked) shows (0 for a clade, and before fonts load): the selection's
   * leader leaves from there (callout.ts `afterName`).
   */
  nameRun(name: string, spacing: number): number {
    if (!this.fontsReady || !name) return 0;
    const fade = S.tipColumnAlpha(spacing);
    if (fade <= 0) return 0;
    const text = this.styled(nameRuns(name, 'species', this.genusNames.has(name)), S.tipFontPx(spacing), 400);
    return (S.TIP_GAP_PX + text.width + 4) * fade;
  }

  /** How far past the rim the column of tip names reaches, CSS px, faded in as they show (a clade's leader leaves from there). */
  columnRun(spacing: number): number {
    const fade = S.tipColumnAlpha(spacing);
    return fade > 0 && this.tipColumn > 0 ? (S.TIP_GAP_PX + this.tipColumn + 4) * fade : 0;
  }

  /**
   * Distance from the rim to the start of the home leader bar, CSS px: the
   * tip gap, the home label and a pad (1.png: bar → label → rim).
   */
  leaderGap(tipSpacing: number): number {
    if (!this.fontsReady) return S.HOME_LEADER_GAP_PX;
    const name = this.styled(nameRuns(this.homeName, 'species'), S.tipFontPx(tipSpacing), 400);
    return S.TIP_GAP_PX + name.width + S.HOME_LEADER_PAD_PX;
  }

  /** Lays out (when the view changed) and paints; true while still fading. */
  frame(f: LabelFrame): boolean {
    for (const t of f.tiles) this.scan(t);
    const ctx = this.ctx;
    if (!this.fontsReady || this.shownAt === null) {
      if (this.hadContent) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.hadContent = false;
      }
      return false;
    }
    this.leader = this.callout();
    const leaderKey = this.leader ? this.leader.path.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(';') : '';
    const sig = `${signature(f)}|${this.hud.version}|${leaderKey}|${this.hideHere()}`;
    const t0 = performance.now();
    if (sig !== this.sig) {
      this.sig = sig;
      this.items = this.build(f);
      this.hairlines = new CollisionGrid();
      for (const b of this.soft) this.hairlines.add(b);
      // The first px of the leader too (left out of `soft`), tight to the line.
      if (this.leader) for (const b of leaderBoxes(this.leader.path, 2)) this.hairlines.add(b);
      const knocks = greekKnocks(
        this.greek.map((r) => r.box),
        this.hairlines,
      );
      this.greek.forEach((r, i) => (r.knock = knocks[i] ?? false));
      this.winners = cull(this.items, (k) => this.fader.shown(k), S.MAX_LABELS, this.obstacles, this.soft);
      this.stats.candidates = this.items.length;
      this.stats.shown = this.winners.size;
      this.stats.layoutMs = performance.now() - t0;
    }
    const t1 = performance.now();
    const fading = this.fader.update(
      f.now,
      this.items.map((it) => it.key),
      this.winners,
    );
    const intro = Math.min(1, Math.max(0, (f.now - this.shownAt) / S.LABEL_INTRO_FADE_MS));

    // The overlay keeps the screen's full DPR even when the tree canvas is
    // capped (MAX_BACKING_PX), so text stays crisp; positions are CSS px.
    const dpr = this.canvas.width / Math.max(1, this.canvas.clientWidth);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    let drawn = 0;
    this.groupsShown = false;
    this.barsShown = false;
    // The leader first: names drawn after it cut it round their glyphs.
    if (this.leader) {
      ctx.globalAlpha = intro;
      drawLeader(ctx, this.leader, dpr);
      drawn++;
    }
    // Greeked names under the text they cross-fade with (no culling: a
    // stroke each, cheap; they already keep off the HUD and the leader).
    const greekAlpha = S.tipGreekAlpha(this.spacing) * intro;
    if (greekAlpha > 0.004 && this.greek.length > 0) {
      drawGreek(ctx, this.greek, greekAlpha, this.spacing, dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawn++;
    }
    for (const it of this.items) {
      const a = this.fader.alpha(it.key) * it.alpha * intro;
      if (a <= 0.004) continue;
      if (it.kind === 'group') this.groupsShown = true;
      if (it.kind === 'bar') this.barsShown = true;
      const alt = this.winners.get(it.key) ?? 0;
      ctx.globalAlpha = a;
      // Where a hairline passes behind the name, erase it round the glyphs
      // (only this canvas: the tree beneath is untouched), so the name reads.
      const textBoxes = it.alts?.[alt] ?? it.boxes;
      if (it.knock && textBoxes.some((b) => this.hairlines.hits(b))) {
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        it.knock(ctx, alt);
        ctx.restore();
      }
      it.draw(ctx, alt);
      drawn++;
    }
    ctx.globalAlpha = 1;
    this.hadContent = drawn > 0;
    this.stats.drawn = drawn;
    this.stats.paintMs = performance.now() - t1;
    return fading || intro < 1;
  }

  /** The last layout's candidates, for debugging from the console. */
  dump(): { text: string; key: LabelKey; priority: number; fit: number; y: number; x: number; won: boolean }[] {
    return this.items.map((it) => ({
      text: it.text,
      key: it.key,
      priority: it.priority,
      fit: +it.fit.toFixed(3),
      y: Math.round(((it.boxes[0]?.y0 ?? 0) + (it.boxes[0]?.y1 ?? 0)) / 2),
      x: Math.round(it.boxes[0]?.x0 ?? 0),
      won: this.winners.has(it.key),
    }));
  }

  /** Learns genus names from species names, and the home node's name. */
  private scan(t: Tile): void {
    if (this.scanned.has(t)) return;
    this.scanned.add(t);
    for (let i = 0; i < t.count; i++) {
      const flags = t.flags[i] ?? 0;
      // Species, and tips shaped like binomials (fossil species are often
      // "no rank" in OTT): their first word is a genus.
      if (flags & FLAG_SPECIES || i >= t.internalCount) {
        const name = tileName(t, i);
        const sp = name.indexOf(' ');
        if (sp > 0 && italicName(name, null)) this.genusNames.add(name.slice(0, sp));
      }
      if (flags & FLAG_HOME) this.homeName = tileName(t, i) || HOME_NAME;
    }
  }

  private name(t: Tile, i: number): string {
    const id = t.id[i] ?? 0;
    let n = this.names.get(id);
    if (n === undefined) {
      if (this.names.size > NAME_CACHE) this.names.clear();
      n = tileName(t, i);
      this.names.set(id, n);
    }
    return n;
  }

  /** A tip label's colour at angle `a`, its CSS string cached (hundreds of rows share a few). */
  private tipColour(a: number, seam: number): string {
    const [r, g, b] = this.palette.colourAt(a, seam);
    const key = (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
    let css = this.colours.get(key);
    if (css === undefined) {
      if (this.colours.size > 4096) this.colours.clear(); // seams blend: keep it bounded
      css = tipColour([r, g, b]);
      this.colours.set(key, css);
    }
    return css;
  }

  private measure(font: string, text: string): number {
    let byText = this.widths.get(font);
    if (!byText) {
      byText = new Map();
      this.widths.set(font, byText);
    }
    let w = byText.get(text);
    if (w === undefined) {
      this.ctx.font = font;
      w = this.ctx.measureText(text).width;
      byText.set(text, w);
    }
    return w;
  }

  /**
   * A name's runs with their fonts: italic runs in the serif at `size`,
   * roman runs in the sans a px smaller at `romanWeight` (the serif runs
   * small next to the sans).
   */
  private styled(runs: readonly NameRun[], size: number, romanWeight: number): StyledText {
    const out: StyledText = { text: '', runs: [], width: 0, size };
    for (const r of runs) {
      const font = r.italic ? serifFont(size) : sansFont(size - 1, romanWeight);
      // Measured at one size and scaled: text widths are linear in the size,
      // and the cache stays one entry per name however the zoom moves.
      const ref = r.italic ? serifFont(MEASURE_PX) : sansFont(MEASURE_PX - 1, romanWeight);
      const w = (this.measure(ref, r.text) * (r.italic ? size : size - 1)) / (r.italic ? MEASURE_PX : MEASURE_PX - 1);
      out.runs.push({ text: r.text, font, w });
      out.text += r.text;
      out.width += w;
    }
    return out;
  }

  private build(f: LabelFrame): Item[] {
    const g = new Geometry(f.camera);
    const items: Item[] = [];
    this.obstacles = this.hudObstacles(g);
    this.soft = this.leader ? leaderBoxes(this.leader.path, 3, 16) : [];
    const share = g.rimPx / (TAU * g.radius);
    this.wheelOn = this.wheelOn ? share >= S.WHEEL_SHARE[0] : share >= S.WHEEL_SHARE[1];
    const spacing = f.camera.tipSpacingPx() / f.camera.dpr;
    this.spacing = spacing;
    this.selTips = selectedTips(f.tiles, this.selectedId());
    const homeFade = smoothstep(S.HOME_LEADER_SPACING[0], S.HOME_LEADER_SPACING[1], spacing);
    if (!this.hideHere()) this.hereLabel(g, 1 - homeFade, items);
    if (this.wheelOn || this.groupsShown) this.groupLabels(g, items);
    this.homeLabel(g, spacing, homeFade, items);
    this.tipLabels(f, g, spacing, items);
    this.cladeLabels(f, g, spacing, items);
    return items;
  }

  /**
   * The HUD's boxes (ui/obstacles.ts), reaching to the nearer of the top and
   * bottom screen edges where asked, so a label scrolling past the HUD
   * leaves for good rather than peeking out again in the sliver beyond it.
   */
  private hudObstacles(g: Geometry): Box[] {
    const out: Box[] = [];
    for (const o of this.hud.all()) {
      if (!o.keepClear) continue;
      let b = o.box;
      if (o.toEdge) {
        const bottom = (b.y0 + b.y1) / 2 > g.h / 2;
        b = { ...b, y0: bottom ? b.y0 : -200, y1: bottom ? g.h + 200 : b.y1 };
      }
      out.push(inflate(b, 8));
    }
    return out;
  }

  /**
   * Group labels, biggest group first. Each tries the middle of its largest
   * run, then slides along the run (and, for a narrow run like Archaea's or
   * the Protists', a few degrees past it) until it is on screen inside the
   * gutter and clear of the HUD and of the group labels already placed.
   */
  private groupLabels(g: Geometry, items: Item[]): void {
    const font = sansFont(S.GROUP_FONT_PX);
    const rule = 8; // 2 px rule + 6 px gap
    const taken = new CollisionGrid();
    for (const b of this.obstacles) taken.add(b);
    for (const it of items) for (const b of it.boxes) taken.add(b);
    const groups = [...this.meta.groups].sort((a, b) => b.tipCount - a.tipCount);
    for (const group of groups) {
      let best: { lo: number; hi: number } | null = null;
      for (const run of this.meta.runs) {
        if (run.group !== group.id) continue;
        if (!best || run.angleHi - run.angleLo > best.hi - best.lo) best = { lo: run.angleLo, hi: run.angleHi };
      }
      if (!best) continue;
      const w = rule + this.measure(font, group.name);
      const h = S.GROUP_FONT_PX + 4;
      let placed: { box: Box; ux: number } | null = null;
      for (const a of slidePositions(best.lo, best.hi)) {
        const p = g.rim(toRad(a), S.GROUP_GAP_PX);
        const box = outsideBox(p.x, p.y, p.ux, p.uy, w, h);
        if (g.boxInside(box, S.GUTTER_PX) && !taken.hits(inflate(box, 6))) {
          placed = { box, ux: p.ux };
          break;
        }
      }
      if (!placed) continue;
      const { box, ux } = placed;
      taken.add(inflate(box, 6));
      // The group's own colour, from its run's middle (the label may have slid past the run).
      const [r, gr, b] = this.palette.colourAt((best.lo + best.hi) / 2, 0);
      const hue = rgbCss(r, gr, b);
      const cy = (box.y0 + box.y1) / 2;
      // The rule sits on the side nearest the rim.
      const ruleRight = ux < -0.2;
      items.push({
        key: `group:${group.id}`,
        text: group.name,
        priority: 1e12 + group.tipCount,
        fit: this.wheelOn ? 1 : 0,
        boxes: [inflate(box, 4)],
        alpha: 1,
        kind: 'group',
        draw: (ctx) => {
          ctx.fillStyle = hue;
          ctx.fillRect(ruleRight ? box.x1 - 2 : box.x0, cy - 5, 2, 10);
          ctx.font = font;
          ctx.fillStyle = S.TEXT_2;
          ctx.textAlign = ruleRight ? 'right' : 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(group.name, ruleRight ? box.x1 - rule : box.x0 + rule, cy + 0.5);
        },
      });
    }
  }

  private hereLabel(g: Geometry, alpha: number, items: Item[]): void {
    const home = this.meta.home;
    if (!home || alpha <= 0) return;
    const theta = toRad(home.angle);
    // Once clade bars sit outside the rim, reach past them.
    const reach = this.wheelOn ? S.HERE_LEADER[1] : S.HERE_LEADER[2];
    const p0 = g.rim(theta, S.HERE_LEADER[0]);
    const p1 = g.rim(theta, reach);
    if (!g.onScreen(p0.x, p0.y, 0)) return;
    const font = sansFont(S.HERE_FONT_PX);
    const text = 'You are here';
    const w = this.measure(font, text);
    const h = S.HERE_FONT_PX + 4;
    const box = outsideBox(p1.x + p1.ux * 4, p1.y + p1.uy * 4, p1.ux, p1.uy, w, h);
    // Never over the wordmark, the card or the rest of the HUD, not even
    // while fading out: a callout that would land there is not made at all.
    const line = { x0: Math.min(p0.x, p1.x), y0: Math.min(p0.y, p1.y), x1: Math.max(p0.x, p1.x), y1: Math.max(p0.y, p1.y) };
    if (!g.boxInside(box, S.GUTTER_PX / 2) || this.obstacles.some((o) => overlap(o, inflate(box, 3)) || overlap(o, line))) return;
    // Only the text claims space: the hairline may cross a clade bar (it
    // points into Mammalia, after all), but clade names step aside and the
    // bar breaks around it.
    this.soft.push({
      x0: Math.min(p0.x, p1.x) - 3,
      y0: Math.min(p0.y, p1.y) - 3,
      x1: Math.max(p0.x, p1.x) + 3,
      y1: Math.max(p0.y, p1.y) + 3,
    });
    items.push({
      key: 'here',
      text,
      priority: 1e15,
      fit: 1,
      boxes: [inflate(box, 3)],
      alpha,
      draw: (ctx) => {
        ctx.strokeStyle = S.TEXT_1;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
        ctx.font = font;
        ctx.fillStyle = S.TEXT_1;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, (box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2 + 0.5);
      },
    });
  }

  private homeLabel(g: Geometry, spacing: number, alpha: number, items: Item[]): void {
    const home = this.meta.home;
    if (!home || alpha <= 0) return;
    const theta = toRad(home.angle);
    const p = g.rim(theta, S.TIP_GAP_PX);
    if (!g.onScreen(p.x, p.y, SCREEN_MARGIN)) return;
    const size = S.tipFontPx(spacing);
    const text = this.styled(nameRuns(this.homeName, 'species'), size, 400);
    const psi = Math.atan2(p.uy, p.ux);
    const box = rotatedBox(p.x + (p.ux * text.width) / 2, p.y + (p.uy * text.width) / 2, text.width, size, psi);
    // The renderer's leader bar, beyond the label: other labels keep clear
    // (it is not drawn while Homo sapiens is the selection).
    if (!this.hideHere()) {
      const gap = this.leaderGap(spacing);
      const len = leaderLength(g.camera, home.angle, gap);
      const mid = gap + len / 2;
      this.obstacles.push(
        rotatedBox(p.x + p.ux * (mid - S.TIP_GAP_PX), p.y + p.uy * (mid - S.TIP_GAP_PX), len, 6, psi),
      );
    }
    items.push({
      key: 'home',
      text: text.text,
      priority: 1e16,
      fit: 1,
      boxes: [inflate(box, 2)],
      alpha,
      draw: (ctx) => drawRadial(ctx, p, text, S.HOME_WHITE),
      knock: (ctx) => drawRadial(ctx, p, text, KNOCK, S.HAIRLINE_KNOCK_PX),
    });
  }

  /**
   * Tip names (DESIGN.md §3, §5): text while it can be read, fading out as it
   * shrinks (S.tipTextAlpha), and a greeked stroke per word under it that
   * takes over below that (S.tipGreekAlpha), so zooming out never leaves the
   * column suddenly empty.
   */
  private tipLabels(f: LabelFrame, g: Geometry, spacing: number, items: Item[]): void {
    this.tipColumn = 0;
    this.greek = [];
    if (S.tipColumnAlpha(spacing) <= 0) return;
    // The text's own alpha does the zoom fade, so no hysteresis: a name is
    // a candidate while it shows at all (fit ≥ 1).
    const textAlpha = S.tipTextAlpha(spacing);
    const fit = spacing / S.TIP_TEXT_FADE[0];
    const withText = textAlpha > 0;
    const withGreek = S.tipGreekAlpha(spacing) > 0;
    const size = S.tipFontPx(spacing);
    const homeId = this.meta.home?.id ?? -1;
    const h = 0.85 * size;
    const seam = g.seamUnits;
    for (const t of f.tiles) {
      const tileAlpha = f.fade(t.level);
      for (let i = t.internalCount; i < t.count; i++) {
        // Homo sapiens' subspecies share its bar and its white label.
        if ((t.parent[i] ?? NO_PARENT) === homeId) continue;
        const a = t.angle[i] ?? 0;
        const p = g.rim(toRad(a), S.TIP_GAP_PX);
        if (!g.onScreen(p.x, p.y, SCREEN_MARGIN)) continue;
        const name = this.name(t, i);
        if (!name || isPlaceholderName(name)) continue;
        const species = ((t.flags[i] ?? 0) & FLAG_SPECIES) !== 0;
        const runs = nameRuns(name, species ? 'species' : null, this.genusNames.has(name));
        const psi = Math.atan2(p.uy, p.ux);
        const boxFor = (w: number): Box => rotatedBox(p.x + (p.ux * w) / 2, p.y + (p.uy * w) / 2, w, h, psi);
        // Inside the side gutters, off the card and the HUD. Hairlines (the
        // selection's leader, "You are here") cost no name: they pass behind
        // it, knocked out round its glyphs (frame).
        const fits = (b: Box): boolean =>
          b.x0 >= S.GUTTER_PX / 2 && b.x1 <= g.w - S.GUTTER_PX / 2 && !this.obstacles.some((o) => overlap(o, b));
        let text = this.styled(runs, size, 400);
        let box = boxFor(text.width);
        // A name cut off at the side of the screen or by the card is no use
        // (long names on a phone, rows beside the card): shorten the genus to
        // its initial ("D. ruscinensis"), and drop the label only if even
        // that does not fit.
        if (!fits(box)) {
          const short = abbreviateGenus(runs);
          if (!short) continue;
          text = this.styled(short, size, 400);
          box = boxFor(text.width);
          if (!fits(box)) continue;
        }
        if (g.onScreen(p.x, p.y, 0)) this.tipColumn = Math.max(this.tipColumn, text.width);
        // The selection's names (a tip, or a clade's tips) in text-1, the rest in their kingdom's hue.
        const rank = t.firstTip[i] ?? -1;
        const sel = this.selTips !== null && rank >= this.selTips[0] && rank < this.selTips[1];
        const colour = sel ? S.TEXT_1 : this.tipColour(a, seam);
        // Hairlines cost no greeked name either: the leader is cut round
        // its strokes where it crosses them (frame, drawGreek).
        if (withGreek) {
          this.greek.push({ p, box, words: greekWords(text.text, text.width), width: text.width, colour, alpha: tileAlpha, knock: false });
        }
        if (!withText) continue;
        items.push({
          key: t.id[i] ?? 0,
          text: text.text,
          // Above every clade: species names are what deep zoom is for; the selection's first.
          priority: (t.id[i] ?? 0) === this.selectedId() ? 1e13 : 1e9,
          fit,
          boxes: [box],
          alpha: tileAlpha * textAlpha,
          draw: (ctx) => drawRadial(ctx, p, text, colour),
          knock: (ctx) => drawRadial(ctx, p, text, KNOCK, S.HAIRLINE_KNOCK_PX),
        });
      }
    }
  }

  /**
   * Clade labels. A named clade is labelled on its own arc when the arc can
   * hold the text there; otherwise (the usual case near the rim, where the
   * arcs are off screen or packed a few px apart) by a clade bar outside the
   * rim with the name beside it, as in printed phylogenies. Bars take over
   * from the group labels once the wheel is no longer whole on screen, and
   * step outside the tip-label column at deep zoom, where they bracket genera.
   */
  private cladeLabels(f: LabelFrame, g: Geometry, spacing: number, items: Item[]): void {
    const R = g.radius;
    // Beyond the tip-name column while it shows (same hysteresis);
    // the two places are different labels, so moving between them is a
    // crossfade, not a slide through the tip labels.
    // The column is there (as text or greeked) down to TIP_GREEK_SPACING[0].
    const tipFit = (spacing * S.LABEL_HIDE_FIT) / S.TIP_GREEK_SPACING[0];
    this.tipsOn = tipFit >= 1 || (this.tipsOn && tipFit >= S.LABEL_HIDE_FIT);
    const rimKey = this.tipsOn ? 'far' : 'rim';
    const slot = TWO_32 / this.meta.tipCount;
    const wantBars = !this.wheelOn || this.barsShown;
    const bars: Bar[] = [];
    for (const t of f.tiles) {
      if (f.fade(t.level) < 0.5) continue;
      const size = this.tipsOn ? S.CLADE_DEEP_FONT_PX : t.level <= 2 ? 13 : t.level <= 5 ? 12 : 11;
      for (let i = 0; i < t.internalCount; i++) {
        const flags = t.flags[i] ?? 0;
        if (!(flags & FLAG_NAMED) || flags & FLAG_HOME) continue;
        const parent = t.parent[i] ?? NO_PARENT;
        if (parent === NO_PARENT) continue; // the root is the whole wheel
        const lo = t.arcLo[i] ?? 0;
        const hi = t.arcHi[i] ?? 0;
        // Its tips' extent at the rim is the most room it can ever have.
        const leaves = t.leafCount[i] ?? 1;
        if (leaves * slot * RAD_PER_UNIT * R < S.CLADE_MIN_ARC_PX) continue;
        if (!f.range || !overlapsRange(lo, hi, f.range)) continue;
        const id = t.id[i] ?? 0;
        const name = this.name(t, i);
        if (!name || isPlaceholderName(name)) continue;
        const text = this.styled(nameRuns(name, null, this.genusNames.has(name)), size, 500);

        // 1. On its own arc, in the wedge between the parent's arc and its own.
        const r = t.r[i] ?? 0;
        const rr = r * R;
        const roomy = (r - (t.parentR[i] ?? 0)) * R >= size + S.CLADE_INSET_PX + 3;
        const vis = roomy ? g.visibleArc(rr, toRad(lo), (hi - lo) * RAD_PER_UNIT, S.GUTTER_PX / 2) : null;
        const fit = vis ? (vis.len * rr) / (text.width + S.CLADE_PAD_PX) : 0;
        const rc = rr - S.CLADE_INSET_PX - size / 2;
        if (vis && fit >= S.LABEL_HIDE_FIT * 0.9 && rc > size) {
          // Centre on the stem when the whole arc is in view (steady), else on
          // the middle of the visible part, so a big clade stays labelled.
          const whole = vis.len >= (hi - lo) * RAD_PER_UNIT * 0.999;
          const stemPhi = toRad(t.angle[i] ?? 0) + g.rot;
          const phiC = whole ? stemPhi : vis.lo + vis.len / 2;
          items.push(this.arcItem(g, id, leaves, fit, text, rc, phiC, stemPhi, id === this.selectedId()));
          continue;
        }

        // 2. Otherwise a clade bar outside the rim (laid out below, in lanes).
        if (!wantBars || leaves < 2) continue;
        const first = t.firstTip[i] ?? 0;
        const [rimLo, rimSpan] = cladeRim(first, leaves, this.meta.tipCount);
        const lo2 = toRad(rimLo);
        const span = rimSpan * RAD_PER_UNIT;
        // Horizontal names beside a near-vertical bar (deep zoom, auto-orient).
        const flat = this.tipsOn && Math.abs(Math.cos(lo2 + span / 2 + g.rot)) > S.CLADE_FLAT_COS;
        const sel = id === this.selectedId();
        bars.push({ key: `${rimKey}:${id}`, leaves, first, end: first + leaves, id, text, lo: lo2, span, flat, lane: 0, sel });
      }
    }
    const rimOff = S.CLADE_RIM_GAP_PX + (this.tipsOn ? S.TIP_GAP_PX + this.tipColumn : 0);
    this.placeBars(g, bars, rimOff, items);
  }

  /**
   * Clade bars in lanes. A bar that holds other bars' clades goes one lane
   * further out than the outermost of them (Gorilla outside Gorilla
   * gorilla), and each lane starts past the names of the lane inside it.
   * Each bar is clipped to the screen inside the gutter and above the HUD
   * band.
   */
  private placeBars(g: Geometry, all: Bar[], rimOff: number, items: Item[]): void {
    const R = g.radius;
    // Keep the bars that could show at all: in view, mostly on screen, not
    // so wide that they are really the context (the breadcrumb's job).
    const bars: Bar[] = [];
    for (const b of all) {
      const rv = g.barArc(R + rimOff, b.lo, b.span);
      if (!rv) continue;
      // The selected clade's bar shows however much of it is in view: it says which tips are the selection.
      if (b.sel) {
        bars.push(b);
        continue;
      }
      const coverage = rv.len / b.span;
      if (coverage < S.CLADE_RIM_COVERAGE * S.LABEL_HIDE_FIT * 0.9) continue;
      if (b.span * R > (S.CLADE_RIM_MAX_SHARE * g.rimPx) / (S.LABEL_HIDE_FIT * 0.9)) continue;
      bars.push(b);
    }
    // Lanes, smallest clades first.
    bars.sort((a, b) => a.leaves - b.leaves || b.id - a.id);
    const laneExtent: number[] = [];
    for (let k = 0; k < bars.length; k++) {
      const b = bars[k] as Bar;
      for (let j = 0; j < k; j++) {
        const c = bars[j] as Bar;
        if (c.first >= b.first && c.end <= b.end) b.lane = Math.max(b.lane, c.lane + 1);
      }
      // How far out its name reaches past its bar.
      const ext = S.CLADE_BAR_TEXT_PX + (b.flat ? b.text.width : b.text.size) + S.CLADE_LANE_GAP_PX;
      laneExtent[b.lane] = Math.max(laneExtent[b.lane] ?? 0, ext);
    }
    const laneOff: number[] = [rimOff];
    for (let l = 1; l < laneExtent.length; l++) laneOff[l] = (laneOff[l - 1] ?? 0) + (laneExtent[l - 1] ?? 0);

    for (const b of bars) {
      // At most CLADE_MAX_LANES nested bars: a deeper stack (Glires ›
      // Rodentia › Myomorpha › Muroidea) gets tall and pushes names far
      // from their tips. The innermost, most specific clades stay; the
      // broader ones are the breadcrumb's job.
      if (b.lane >= S.CLADE_MAX_LANES && !b.sel) continue;
      const rb = R + (laneOff[b.lane] ?? rimOff);
      const rv = g.barArc(rb, b.lo, b.span);
      if (!rv) continue;
      const coverage = rv.len / b.span;
      // Room for the text, most of the clade in view, and not too wide.
      const need = b.flat ? b.text.size + 8 : b.text.width + S.CLADE_PAD_PX;
      const fit = Math.min(
        (rv.len * rb) / need,
        coverage / S.CLADE_RIM_COVERAGE,
        (S.CLADE_RIM_MAX_SHARE * g.rimPx) / (b.span * R),
      );
      const shown = this.fader.alpha(b.key) > 0;
      if (fit < S.LABEL_HIDE_FIT * 0.9 && !shown && !b.sel) continue;
      const startPhi = b.lo + g.rot;
      const ends: [boolean, boolean] = [nearAngle(rv.lo, startPhi), nearAngle(rv.lo + rv.len, startPhi + b.span)];
      // A bar is only ever drawn with its name (a bare bracket says nothing).
      const item = this.rimItem(g, b, this.wheelOn ? 0 : b.sel ? Math.max(1, fit) : fit, rb, rv, ends);
      if (item) items.push(item);
    }
  }

  /** A clade label on its own arc (text centred at screen angle `phiC`, radius `rc`). */
  private arcItem(
    g: Geometry,
    id: number,
    leaves: number,
    fit: number,
    t: StyledText,
    rc: number,
    phiC: number,
    stemPhi: number,
    sel: boolean,
  ): Item {
    const { dir, rot } = arcTextDirection(phiC);
    const at = arcPoint(g, rc, phiC, dir);
    const boxes = arcTextBoxes(at, rot, t);
    // Knock the stem out where it crosses the text, if it does.
    const stemS = wrapPi(stemPhi - phiC) * rc * dir;
    const knock = Math.abs(stemS) <= t.width / 2 + 3 ? at(stemS) : null;
    const size = t.size;
    return {
      key: id,
      text: t.text,
      priority: leaves,
      fit,
      boxes,
      alpha: 1,
      draw: (ctx) => {
        if (knock) {
          ctx.save();
          ctx.translate(knock.x, knock.y);
          ctx.rotate(rot(knock.phi));
          ctx.fillStyle = '#000';
          ctx.fillRect(-2, -size / 2 - 2, 4, size + 4);
          ctx.restore();
        }
        drawArcText(ctx, at, rot, t, sel ? S.TEXT_1 : S.TEXT_2);
      },
      knock: (ctx) => drawArcText(ctx, at, rot, t, KNOCK, S.HAIRLINE_KNOCK_PX),
    };
  }

  /**
   * A clade bar outside the rim: a hairline arc at radius `rb` over the
   * clade's visible extent `vis`, with end ticks towards the rim where the
   * clade really ends, and the name just outside it: along the arc, or set
   * horizontally beside a near-vertical bar at deep zoom. The bar breaks
   * where the "You are here" hairline crosses it.
   */
  private rimItem(g: Geometry, b: Bar, fit: number, rb: number, vis: Arc, ends: [boolean, boolean]): Item | null {
    const t = b.text;
    const ink = b.sel ? S.TEXT_1 : S.TEXT_2;
    const phiC = vis.lo + vis.len / 2;
    // The name goes at the middle of the bar, or slides along it to clear
    // a hairline (the selection's leader, "You are here") if it can.
    const half = (vis.len * rb) / 2 - 4;
    // Paints the name at alternative `alt` (a halo when `halo` > 0, see drawRuns).
    let draw: (ctx: CanvasRenderingContext2D, alt: number, colour: string, halo: number) => void;
    let alts: Box[][];
    if (b.flat) {
      const step = t.size + 10;
      const spots: { x: number; y: number; right: boolean }[] = [];
      for (const k of [0, -1, 1, -2, 2]) {
        if (Math.abs(k * step) + t.size / 2 > half && k !== 0) continue;
        const phi = phiC + (k * step) / rb;
        const p = g.circlePoint(rb + S.CLADE_BAR_TEXT_PX, phi);
        const right = Math.cos(phi) < 0;
        // A name cut off by the screen's side is no use: such places are not offered.
        const x0 = right ? p.x - t.width : p.x;
        if (x0 < S.GUTTER_PX / 2 || x0 + t.width > g.w - S.GUTTER_PX / 2) continue;
        spots.push({ ...p, right });
      }
      if (spots.length === 0) return null;
      alts = spots.map((s) => [
        { x0: s.right ? s.x - t.width : s.x, x1: s.right ? s.x : s.x + t.width, y0: s.y - t.size / 2 - 1, y1: s.y + t.size / 2 + 1 },
      ]);
      draw = (ctx, alt, colour, halo) => {
        const s = spots[alt] ?? spots[0];
        if (s) drawRuns(ctx, t, s.right ? s.x - t.width : s.x, s.y + 0.5, colour, halo);
      };
    } else {
      const { dir, rot } = arcTextDirection(phiC);
      const rt = rb + S.CLADE_BAR_TEXT_PX + t.size / 2;
      const step = t.width / 2 + 14;
      const spots: ArcAt[] = [];
      for (const k of [0, -1, 1, -2, 2]) {
        if (Math.abs(k * step) + t.width / 2 > half && k !== 0) continue;
        spots.push(arcPoint(g, rt, phiC + (dir * k * step) / rt, dir));
      }
      if (spots.length === 0) return null;
      alts = spots.map((at) => arcTextBoxes(at, rot, t));
      draw = (ctx, alt, colour, halo) => {
        const at = spots[alt] ?? spots[0];
        if (at) drawArcText(ctx, at, rot, t, colour, halo);
      };
    }
    // Leave a hair between neighbouring bars.
    const trim = 2 / rb;
    const a0 = vis.lo + (ends[0] ? trim : 0);
    const a1 = vis.lo + vis.len - (ends[1] ? trim : 0);
    const steps = Math.max(1, Math.min(96, Math.ceil(((a1 - a0) * rb) / 12)));
    const bar: { x: number; y: number }[] = [];
    for (let k = 0; k <= steps; k++) bar.push(g.circlePoint(rb, a0 + ((a1 - a0) * k) / steps));
    // Segments crossing the "You are here" hairline are left out.
    const gap = bar.map((p, k) => {
      const q = bar[k + 1];
      if (!q) return false;
      const m = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
      return this.soft.some((s) => m.x > s.x0 - 2 && m.x < s.x1 + 2 && m.y > s.y0 - 2 && m.y < s.y1 + 2);
    });
    // The bar's collision boxes stop short of its ends, so neighbouring
    // clades' bars can meet end to end.
    const boxes: Box[] = [];
    const inset = 5 / rb;
    const boxSteps = Math.max(1, Math.ceil(((a1 - a0) * rb) / 24));
    for (let k = 0; k < boxSteps; k++) {
      const u0 = a0 + inset + ((a1 - a0 - 2 * inset) * k) / boxSteps;
      const u1 = a0 + inset + ((a1 - a0 - 2 * inset) * (k + 1)) / boxSteps;
      if (u1 > u0) boxes.push(inflate(boxOf(g.circlePoint(rb, u0), g.circlePoint(rb, u1)), 3));
    }
    const tick = (phi: number): [{ x: number; y: number }, { x: number; y: number }] => [
      g.circlePoint(rb, phi),
      g.circlePoint(rb - S.CLADE_TICK_PX, phi),
    ];
    const ticks = [ends[0] ? tick(a0) : null, ends[1] ? tick(a1) : null];
    return {
      key: b.key,
      text: t.text,
      // The selection's bar before any other clade's.
      priority: b.sel ? 1e14 : b.leaves,
      fit,
      boxes,
      alts,
      alpha: 1,
      kind: 'bar',
      draw: (ctx, alt) => {
        ctx.strokeStyle = b.sel ? S.TEXT_1 : S.TEXT_3;
        ctx.lineWidth = 1;
        ctx.beginPath();
        bar.forEach((p, k) => (k === 0 || gap[k - 1] ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        for (const tk of ticks) {
          if (!tk) continue;
          ctx.moveTo(tk[0].x, tk[0].y);
          ctx.lineTo(tk[1].x, tk[1].y);
        }
        ctx.stroke();
        draw(ctx, alt, ink, 0);
      },
      knock: (ctx, alt) => draw(ctx, alt, KNOCK, S.HAIRLINE_KNOCK_PX),
    };
  }
}

type ArcAt = (s: number) => { x: number; y: number; phi: number };

/** The point `s` px along the text from its centre, on the circle of radius `rc`. */
function arcPoint(g: Geometry, rc: number, phiC: number, dir: 1 | -1): ArcAt {
  return (s) => {
    const phi = phiC + (dir * s) / rc;
    return { ...g.circlePoint(rc, phi), phi };
  };
}

/** Collision shape of arc text: a chain of boxes along it, about one per em. */
function arcTextBoxes(at: ArcAt, rot: (phi: number) => number, t: StyledText): Box[] {
  const boxes: Box[] = [];
  const n = Math.max(1, Math.ceil(t.width / t.size));
  for (let j = 0; j < n; j++) {
    const p = at(-t.width / 2 + ((j + 0.5) * t.width) / n);
    boxes.push(rotatedBox(p.x, p.y, t.width / n + 2, t.size + 2, rot(p.phi)));
  }
  return boxes;
}

/** Text along an arc, glyph by glyph, each run in its own font. */
function drawArcText(
  ctx: CanvasRenderingContext2D,
  at: ArcAt,
  rot: (phi: number) => number,
  t: StyledText,
  colour: string,
  halo = 0,
): void {
  ctx.fillStyle = colour;
  if (halo > 0) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = halo;
    ctx.lineJoin = 'round';
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let s = -t.width / 2;
  for (const run of t.runs) {
    ctx.font = run.font;
    // Glyph advances, scaled so the run keeps its measured width (kerning).
    const chars = [...run.text];
    const widths = chars.map((ch) => ctx.measureText(ch).width);
    const k = run.w / Math.max(1e-6, widths.reduce((a, b) => a + b, 0));
    chars.forEach((ch, j) => {
      const w = (widths[j] ?? 0) * k;
      const p = at(s + w / 2);
      s += w;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(rot(p.phi));
      if (halo > 0) ctx.strokeText(ch, 0, 0);
      else ctx.fillText(ch, 0, 0);
      ctx.restore();
    });
  }
}

/**
 * Runs left to right from `x`, vertically centred on `y` (current
 * transform). With a `halo` width the glyphs are stroked that wide instead
 * of filled (the knockout in `frame`).
 */
function drawRuns(ctx: CanvasRenderingContext2D, t: StyledText, x: number, y: number, colour: string, halo = 0): void {
  ctx.fillStyle = colour;
  if (halo > 0) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = halo;
    ctx.lineJoin = 'round';
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  let cx = x;
  for (const run of t.runs) {
    ctx.font = run.font;
    if (halo > 0) ctx.strokeText(run.text, cx, y);
    else ctx.fillText(run.text, cx, y);
    cx += run.w;
  }
}

function boxOf(p: { x: number; y: number }, q: { x: number; y: number }): Box {
  return { x0: Math.min(p.x, q.x), y0: Math.min(p.y, q.y), x1: Math.max(p.x, q.x), y1: Math.max(p.y, q.y) };
}

/** Whether two screen angles are the same (mod 2π), up to rounding. */
function nearAngle(a: number, b: number): boolean {
  return Math.abs(wrapPi(a - b)) < 1e-10;
}

/** Screen geometry of the wheel for one frame, in CSS px. */
class Geometry {
  readonly radius: number;
  readonly rot: number;
  /** Length of the rim on screen, px. */
  readonly rimPx: number;
  /** A colour seam's width at the rim, u32 units (palette.ts). */
  readonly seamUnits: number;
  readonly w: number;
  readonly h: number;
  readonly camera: Camera;
  private readonly cam: Camera;
  private readonly dpr: number;
  private readonly ox: number;
  private readonly oy: number;

  constructor(cam: Camera) {
    this.cam = cam;
    this.camera = cam;
    this.dpr = cam.dpr;
    this.radius = cam.scale / cam.dpr;
    this.rot = cam.rot;
    const o = cam.worldToScreen(0, 0);
    this.ox = o.x / cam.dpr;
    this.oy = o.y / cam.dpr;
    this.w = cam.width / cam.dpr;
    this.h = cam.height / cam.dpr;
    let rim = 0;
    for (const a of circleInRect(this.ox, this.oy, this.radius, this.w, this.h)) rim += a.len;
    this.rimPx = rim * this.radius;
    this.seamUnits = S.SEAM_PX / (RAD_PER_UNIT * this.radius);
  }

  /** The rim point at world angle `theta`, moved `off` px outward. */
  rim(theta: number, off: number): RimPoint {
    const phi = theta + this.rot;
    const ux = Math.cos(phi);
    const uy = -Math.sin(phi);
    // Through the camera (doubles, camera-relative) rather than o + R·u:
    // at deep zoom R is ~10^7 px.
    const p = this.cam.polarToScreen(theta, 1);
    return { x: p.x / this.dpr + ux * off, y: p.y / this.dpr + uy * off, ux, uy };
  }

  /** The point at screen angle `phi` (y up) on the circle of radius `r` px around the wheel's centre. */
  circlePoint(r: number, phi: number): { x: number; y: number } {
    return { x: this.ox + r * Math.cos(phi), y: this.oy - r * Math.sin(phi) };
  }

  onScreen(x: number, y: number, m: number): boolean {
    return x >= -m && x <= this.w + m && y >= -m && y <= this.h + m;
  }

  /** Whether `b` is on screen at least `m` px inside every edge. */
  boxInside(b: Box, m: number): boolean {
    return b.x0 >= m && b.y0 >= m && b.x1 <= this.w - m && b.y1 <= this.h - m;
  }

  /**
   * The longest on-screen piece (screen angles, y up) of the arc of radius
   * `r` px starting at world angle `lo` with length `len` radians, keeping
   * `m` px clear of the screen edges, and `bottom` px clear of the bottom.
   */
  visibleArc(r: number, lo: number, len: number, m: number, bottom = m): Arc | null {
    const pieces = circleInRect(this.ox - m, this.oy - m, r, this.w - 2 * m, this.h - m - bottom);
    let best: Arc | null = null;
    const a0 = lo + this.rot;
    for (const v of pieces) {
      for (const piece of intersectArcs(v, { lo: a0, len })) {
        if (!best || piece.len > best.len) best = piece;
      }
    }
    return best;
  }

  /** `visibleArc` for a clade bar: inside the gutter and above the HUD band. */
  barArc(r: number, lo: number, len: number): Arc | null {
    return this.visibleArc(r, lo, len, S.GUTTER_PX, S.HUD_BAND_PX);
  }
}

/** The tips (ranks [first, end)) of node `id` if a loaded tile holds it, else null. */
export function selectedTips(tiles: readonly Tile[], id: number): [number, number] | null {
  if (id < 0) return null;
  for (const t of tiles) {
    for (let i = 0; i < t.count; i++) {
      if ((t.id[i] ?? -1) !== id) continue;
      const first = t.firstTip[i] ?? 0;
      return [first, first + (t.leafCount[i] ?? 1)];
    }
  }
  return null;
}

/**
 * Angles (u32 units) to try for a group label: the run's middle, then out
 * towards its ends; a run under 12° (Protists, Archaea) also tries up to
 * 12° past its middle, so its label can step round a neighbour's.
 */
function slidePositions(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (const t of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.1, 0.9]) out.push(lo + (hi - lo) * t);
  const deg = TWO_32 / 360;
  if (hi - lo < 12 * deg) {
    const mid = (lo + hi) / 2;
    for (let k = 1; k <= 8; k++) out.push(mid + 1.5 * k * deg, mid - 1.5 * k * deg);
  }
  return out.map((a) => ((a % TWO_32) + TWO_32) % TWO_32);
}

/** Intersection of two circular intervals (radians). */
export function intersectArcs(a: Arc, b: Arc): Arc[] {
  if (a.len >= TAU) return [{ lo: b.lo, len: b.len }];
  if (b.len >= TAU) return [{ lo: a.lo, len: a.len }];
  const out: Arc[] = [];
  // b's start relative to a's, in [0, 2π); b may also wrap round to a.
  let d = (b.lo - a.lo) % TAU;
  if (d < 0) d += TAU;
  for (const start of [d, d - TAU]) {
    const s = Math.max(0, start);
    const e = Math.min(a.len, start + b.len);
    if (e > s) out.push({ lo: a.lo + s, len: e - s });
  }
  return out;
}

function wrapPi(x: number): number {
  let r = x % TAU;
  if (r > Math.PI) r -= TAU;
  else if (r <= -Math.PI) r += TAU;
  return r;
}

/** Whether the arc [lo, hi] (u32 units, not wrapping) meets the visible range. */
function overlapsRange(lo: number, hi: number, range: AngleRange): boolean {
  if (range.span >= TWO_32 - 1) return true;
  const mod = (x: number): number => ((x % TWO_32) + TWO_32) % TWO_32;
  // Either the arc starts inside the range, or the range starts inside the arc.
  return mod(lo - range.lo) <= range.span || mod(range.lo - lo) <= hi - lo;
}

/** Text laid along the outward ray from `p`, kept upright. */
function drawRadial(ctx: CanvasRenderingContext2D, p: RimPoint, t: StyledText, colour: string, halo = 0): void {
  const { rot, align } = radialText(Math.atan2(p.uy, p.ux));
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(rot);
  drawRuns(ctx, t, align === 'left' ? 0 : -t.width, 0, colour, halo);
  ctx.restore();
}

/**
 * Greeked names: a stroke per word, about an x-height thick, laid out as
 * the text would be (radialText). `alpha` is the frame's greek alpha; the
 * transform is left set.
 */
function drawGreek(ctx: CanvasRenderingContext2D, rows: readonly GreekRow[], alpha: number, spacing: number, dpr: number): void {
  const size = S.tipFontPx(spacing);
  // At least half a px (it fades with the rows anyway), and never into the next row.
  const thick = Math.min(0.6 * spacing, Math.max(0.5, S.TIP_GREEK_THICK * size));
  let fill = '';
  for (const r of rows) {
    const { rot, align } = radialText(Math.atan2(r.p.uy, r.p.ux));
    const c = Math.cos(rot) * dpr;
    const s = Math.sin(rot) * dpr;
    ctx.setTransform(c, s, -s, c, r.p.x * dpr, r.p.y * dpr);
    ctx.globalAlpha = alpha * r.alpha;
    if (r.colour !== fill) {
      fill = r.colour;
      ctx.fillStyle = fill;
    }
    const x0 = align === 'left' ? 0 : -r.width;
    if (r.knock) {
      // Erase the hairline (drawn first, on this canvas) round the strokes,
      // as text is cut round its glyphs (HAIRLINE_KNOCK_PX).
      // (Never into the next row's strokes.)
      const pad = Math.min(S.HAIRLINE_KNOCK_PX / 2, (spacing - thick) / 2);
      ctx.globalCompositeOperation = 'destination-out';
      ctx.globalAlpha = 1;
      for (const [start, len] of r.words) ctx.fillRect(x0 + start - pad, -thick / 2 - pad, len + 2 * pad, thick + 2 * pad);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = alpha * r.alpha;
    }
    for (const [start, len] of r.words) ctx.fillRect(x0 + start, -thick / 2, len, thick);
  }
}

/** Kingdom hue mixed halfway to text-1 (DESIGN.md §2.2), for tip labels. */
function tipColour([r, g, b]: [number, number, number]): string {
  // --text-1 is #e9e8e4.
  return rgbCss((r + 0xe9 / 255) / 2, (g + 0xe8 / 255) / 2, (b + 0xe4 / 255) / 2);
}

function rgbCss(r: number, g: number, b: number): string {
  return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
}

/** Changes whenever the layout could: camera, viewport, tiles. */
function overlap(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/**
 * The selection's leader: a 1 px text-1 hairline, like "You are here". Its
 * square run into the card is snapped to the pixel grid so it stays crisp.
 */
function drawLeader(ctx: CanvasRenderingContext2D, leader: Leader, dpr: number): void {
  const path = leader.path;
  // A 1 CSS px line is dpr device px wide: centre it where it covers whole pixels.
  const snap = (v: number): number => (Math.round(v * dpr - dpr / 2) + dpr / 2) / dpr;
  const pts = path.map((p, i) => {
    const prev = path[i - 1];
    const next = path[i + 1];
    const flatY = (prev && Math.abs(prev.y - p.y) < 0.5) || (next && Math.abs(next.y - p.y) < 0.5);
    const flatX = (prev && Math.abs(prev.x - p.x) < 0.5) || (next && Math.abs(next.x - p.x) < 0.5);
    return { x: flatX ? snap(p.x) : p.x, y: flatY ? snap(p.y) : p.y };
  });
  ctx.strokeStyle = S.TEXT_1;
  ctx.lineWidth = 1;
  ctx.lineJoin = 'miter';
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.stroke();
  // Off screen: an open arrowhead at the start, pointing the way.
  const a = leader.arrow;
  if (a) {
    const back = 8;
    const spread = 0.45;
    const base = ctx.globalAlpha;
    ctx.globalAlpha = base * a.alpha;
    ctx.beginPath();
    for (const s of [spread, -spread]) {
      const c = Math.cos(s);
      const n = Math.sin(s);
      // The arrow's unit vector turned by ±spread, pointing back from the tip.
      const ux = a.ux * c - a.uy * n;
      const uy = a.ux * n + a.uy * c;
      ctx.moveTo(a.x - ux * back, a.y - uy * back);
      ctx.lineTo(a.x, a.y);
    }
    ctx.stroke();
    ctx.globalAlpha = base;
  }
}

function signature(f: LabelFrame): string {
  const c = f.camera;
  let tiles = '';
  for (const t of f.tiles) tiles += `${t.level}/${t.sector},`;
  return `${c.angle},${c.r},${c.scale},${c.rot},${c.width},${c.height},${c.dpr}|${tiles}`;
}
