// Canvas2D label overlay (PLAN §7.7, DESIGN.md §3 and §5), drawn over the
// WebGL canvas. At most MAX_LABELS per frame, from what the loaded tiles say:
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
//   - tip labels once tips are ≥ 11 px apart: just outside the rim along the
//     radius (horizontal once auto-orient turns the rim vertical), in the
//     kingdom hue mixed halfway to text-1;
//   - the home label, "Homo sapiens" in white, between the rim and the
//     renderer's leader bar (1.png: bar → label → rim). The bar starts
//     HOME_LEADER_PAD_PX past the measured label (`leaderGap`), and is an
//     obstacle for other labels. Its two subspecies share its bar and row.
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
  inflate,
  outsideBox,
  radialText,
  rotatedBox,
} from './labelLayout';
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
}

const NO_PARENT = 0xffffffff;
const HOME_NAME = 'Homo sapiens';
/** Labels whose anchor is further than this off screen are not built. */
const SCREEN_MARGIN = 40;
/** Name cache cap (names are decoded lazily from tile bytes). */
const NAME_CACHE = 50_000;

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
  private readonly widths = new Map<string, number>();
  private readonly names = new Map<number, string>();
  /** Genus names: the first word of every binomial seen in the tiles. */
  private readonly genusNames = new Set<string>();
  private readonly scanned = new WeakSet<Tile>();
  private homeName = HOME_NAME;
  /** Widest tip label on screen in the last layout, CSS px (rim labels go beyond). */
  private tipColumn = 0;
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
  /** Obstacles only text must avoid (the "You are here" hairline). */
  private soft: Box[] = [];
  private winners: Placement = new Map();
  private hadContent = false;
  /** Last layout's numbers (debug HUD, screenshot report). */
  stats = { candidates: 0, shown: 0, drawn: 0, layoutMs: 0, paintMs: 0 };

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
    const sig = `${signature(f)}|${this.hud.version}`;
    const t0 = performance.now();
    if (sig !== this.sig) {
      this.sig = sig;
      this.items = this.build(f);
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
    for (const it of this.items) {
      const a = this.fader.alpha(it.key) * it.alpha * intro;
      if (a <= 0.004) continue;
      if (it.kind === 'group') this.groupsShown = true;
      if (it.kind === 'bar') this.barsShown = true;
      ctx.globalAlpha = a;
      it.draw(ctx, this.winners.get(it.key) ?? 0);
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

  private measure(font: string, text: string): number {
    const key = `${font}|${text}`;
    let w = this.widths.get(key);
    if (w === undefined) {
      this.ctx.font = font;
      w = this.ctx.measureText(text).width;
      this.widths.set(key, w);
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
      const w = this.measure(font, r.text);
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
    this.soft = [];
    const share = g.rimPx / (TAU * g.radius);
    this.wheelOn = this.wheelOn ? share >= S.WHEEL_SHARE[0] : share >= S.WHEEL_SHARE[1];
    const spacing = f.camera.tipSpacingPx() / f.camera.dpr;
    const homeFade = smoothstep(S.HOME_LEADER_SPACING[0], S.HOME_LEADER_SPACING[1], spacing);
    this.hereLabel(g, 1 - homeFade, items);
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
    // The renderer's leader bar, beyond the label: other labels keep clear.
    const gap = this.leaderGap(spacing);
    const len = leaderLength(g.camera, home.angle, gap);
    const mid = gap + len / 2;
    this.obstacles.push(
      rotatedBox(p.x + p.ux * (mid - S.TIP_GAP_PX), p.y + p.uy * (mid - S.TIP_GAP_PX), len, spacing, psi),
    );
    items.push({
      key: 'home',
      text: text.text,
      priority: 1e16,
      fit: 1,
      boxes: [inflate(box, 2)],
      alpha,
      draw: (ctx) => drawRadial(ctx, p, text, S.HOME_WHITE),
    });
  }

  private tipLabels(f: LabelFrame, g: Geometry, spacing: number, items: Item[]): void {
    const fit = spacing / S.TIP_LABEL_SPACING;
    // Built a little below the hide threshold too, so they fade out.
    if (fit < S.LABEL_HIDE_FIT * 0.8) return;
    const size = S.tipFontPx(spacing);
    const homeId = this.meta.home?.id ?? -1;
    const h = 0.85 * size;
    const seam = g.seamUnits;
    this.tipColumn = 0;
    for (const t of f.tiles) {
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
        const fits = (b: Box): boolean => b.x0 >= S.GUTTER_PX / 2 && b.x1 <= g.w - S.GUTTER_PX / 2;
        let text = this.styled(runs, size, 400);
        let box = boxFor(text.width);
        // A name cut off at the side of the screen is no use (long names on
        // a phone): shorten the genus to its initial ("D. ruscinensis"), and
        // drop the label only if even that does not fit.
        if (!fits(box)) {
          const short = abbreviateGenus(runs);
          if (!short) continue;
          text = this.styled(short, size, 400);
          box = boxFor(text.width);
          if (!fits(box)) continue;
        }
        if (g.onScreen(p.x, p.y, 0)) this.tipColumn = Math.max(this.tipColumn, text.width);
        const colour = tipColour(this.palette.colourAt(a, seam));
        items.push({
          key: t.id[i] ?? 0,
          text: text.text,
          // Above every clade: species names are what deep zoom is for.
          priority: 1e9,
          fit,
          boxes: [box],
          alpha: f.fade(t.level),
          draw: (ctx) => drawRadial(ctx, p, text, colour),
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
    // Beyond the tip-label column while tip labels show (same hysteresis);
    // the two places are different labels, so moving between them is a
    // crossfade, not a slide through the tip labels.
    const tipFit = spacing / S.TIP_LABEL_SPACING;
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
          items.push(this.arcItem(g, id, leaves, fit, text, rc, phiC, stemPhi));
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
        bars.push({ key: `${rimKey}:${id}`, leaves, first, end: first + leaves, id, text, lo: lo2, span, flat, lane: 0 });
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
      if (b.lane >= S.CLADE_MAX_LANES) continue;
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
      if (fit < S.LABEL_HIDE_FIT * 0.9 && !shown) continue;
      const startPhi = b.lo + g.rot;
      const ends: [boolean, boolean] = [nearAngle(rv.lo, startPhi), nearAngle(rv.lo + rv.len, startPhi + b.span)];
      items.push(this.rimItem(g, b, this.wheelOn ? 0 : fit, rb, rv, ends));
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
        drawArcText(ctx, at, rot, t, S.TEXT_2);
      },
    };
  }

  /**
   * A clade bar outside the rim: a hairline arc at radius `rb` over the
   * clade's visible extent `vis`, with end ticks towards the rim where the
   * clade really ends, and the name just outside it: along the arc, or set
   * horizontally beside a near-vertical bar at deep zoom. The bar breaks
   * where the "You are here" hairline crosses it.
   */
  private rimItem(g: Geometry, b: Bar, fit: number, rb: number, vis: Arc, ends: [boolean, boolean]): Item {
    const t = b.text;
    const phiC = vis.lo + vis.len / 2;
    // The name goes at the middle of the bar, or slides along it to clear
    // a "You are here" hairline.
    const half = (vis.len * rb) / 2 - 4;
    let draw: (ctx: CanvasRenderingContext2D, alt: number) => void;
    let alts: Box[][];
    if (b.flat) {
      const step = t.size + 10;
      const spots: { x: number; y: number; right: boolean }[] = [];
      for (const k of [0, -1, 1, -2, 2]) {
        if (Math.abs(k * step) + t.size / 2 > half && k !== 0) continue;
        const phi = phiC + (k * step) / rb;
        const p = g.circlePoint(rb + S.CLADE_BAR_TEXT_PX, phi);
        spots.push({ ...p, right: Math.cos(phi) < 0 });
      }
      alts = spots.map((s) => [
        { x0: s.right ? s.x - t.width : s.x, x1: s.right ? s.x : s.x + t.width, y0: s.y - t.size / 2 - 1, y1: s.y + t.size / 2 + 1 },
      ]);
      draw = (ctx, alt) => {
        const s = spots[alt] ?? spots[0];
        if (s) drawRuns(ctx, t, s.right ? s.x - t.width : s.x, s.y + 0.5, S.TEXT_2);
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
      alts = spots.map((at) => arcTextBoxes(at, rot, t));
      draw = (ctx, alt) => {
        const at = spots[alt] ?? spots[0];
        if (at) drawArcText(ctx, at, rot, t, S.TEXT_2);
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
      priority: b.leaves,
      fit,
      boxes,
      alts,
      alpha: 1,
      kind: 'bar',
      draw: (ctx, alt) => {
        ctx.strokeStyle = S.TEXT_3;
        ctx.lineWidth = 1;
        ctx.beginPath();
        bar.forEach((p, k) => (k === 0 || gap[k - 1] ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        for (const tk of ticks) {
          if (!tk) continue;
          ctx.moveTo(tk[0].x, tk[0].y);
          ctx.lineTo(tk[1].x, tk[1].y);
        }
        ctx.stroke();
        draw(ctx, alt);
      },
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
): void {
  ctx.fillStyle = colour;
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
      ctx.fillText(ch, 0, 0);
      ctx.restore();
    });
  }
}

/** Runs left to right from `x`, vertically centred on `y` (current transform). */
function drawRuns(ctx: CanvasRenderingContext2D, t: StyledText, x: number, y: number, colour: string): void {
  ctx.fillStyle = colour;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  let cx = x;
  for (const run of t.runs) {
    ctx.font = run.font;
    ctx.fillText(run.text, cx, y);
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
function drawRadial(ctx: CanvasRenderingContext2D, p: RimPoint, t: StyledText, colour: string): void {
  const { rot, align } = radialText(Math.atan2(p.uy, p.ux));
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(rot);
  drawRuns(ctx, t, align === 'left' ? 0 : -t.width, 0, colour);
  ctx.restore();
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
function signature(f: LabelFrame): string {
  const c = f.camera;
  let tiles = '';
  for (const t of f.tiles) tiles += `${t.level}/${t.sector},`;
  return `${c.angle},${c.r},${c.scale},${c.rot},${c.width},${c.height},${c.dpr}|${tiles}`;
}
