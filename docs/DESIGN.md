# Circle of Life: design system

This document governs everything visual and binds every implementing agent. It is merged from the UI-craft brief, the reference-site study and the supervisor's overrides.

## 1. Concept
**A scientific instrument at night: a herbarium plate under a lightbox.** The tree is the specimen, and the interface is a calibrated readout around it.

- There is no hero, no marketing copy and no landing page. The tree *is* the page, from the first frame.
- All colour and all light come from the data, inside the canvas. The DOM chrome is achromatic, opaque, flat and quiet.
- One signature moment, the radial reveal on load. After that the motion is calm and purposeful.

**Reference frames** (`docs/reference/1-5.png`)
- **5.png:** the overview wheel.
- **4.png:** grey interior branches turning to kingdom colour near a glowing furry rim.
- **3.png:** a group label and a "You are here" leader.
- **1.png and 2.png:** deep zoom, rotated to horizontal. Glowing terminal bars, species names outside the rim, and *Homo sapiens* in white with a long leader bar.

We reproduce the *feel* of the video, not its typography; its text overlays are video captions and are not part of the UI.

## 2. Colour tokens
Colours are defined in OKLCH and generated into `styles.css` and `palette.ts`. Each hex value below is the sRGB fallback, computed from the OKLCH value. CSS uses `oklch()` directly, since every target browser supports it; the hex values serve the canvas LUT tests and documentation.

### 2.1 Neutrals (DOM and canvas)
| Token | OKLCH | Hex | Use |
|---|---|---|---|
| `--bg` | `oklch(0 0 0)` | `#000000` | page and canvas background: true black, never a tinted #0b0b0b |
| `--surface` | `oklch(0.16 0 0)` | `#0d0d0d` | card, search palette (opaque) |
| `--surface-2` | `oklch(0.20 0 0)` | `#161616` | hover row, pressed button |
| `--hairline` | `oklch(1 0 0 / 0.10)` | `#ffffff1a` | 1px borders and dividers |
| `--hairline-solid` | `oklch(0.27 0 0)` | `#262626` | borders where alpha is impractical |
| `--text-1` | `oklch(0.93 0.005 90)` | `#e9e8e4` | primary text, selected path |
| `--text-2` | `oklch(0.70 0 0)` | `#9e9e9e` | secondary text, clade labels |
| `--text-3` | `oklch(0.58 0 0)` | `#7a7a7a` | the minimum for any text (≈4.9:1 on black, ≈4.6:1 on surface) |
| `--focus` | `oklch(0.93 0.005 90)` | `#e9e8e4` | 1px focus ring + 2px offset |
| `--danger` | `oklch(0.70 0.15 25)` | `#ed756e` | error text only |
| `--branch` | `oklch(0.60 0 0 / α)` | `#808080` @ α | interior branches. α is 0.35 at overview, rising to 0.85 at deep zoom (λ 12.5 → 15.5), multiplied by the level fade (canvas only) |

### 2.2 Kingdom hues (canvas glow and tiny UI swatches)
These follow the reference video. Lightness stays around 0.60–0.86 with chroma 0.13–0.19, adjusted per hue so they read at similar brightness on black. Each group's colour is exact along its run of tips; neighbouring groups meet in a short seam of `SEAM_PX` (2 px on screen at any zoom, and never more than a quarter of the shorter run), mixed straight across rather than around the hue circle, so a seam never shows a third kingdom's hue.

| Group | Ramp start → end (along its arc, counter-clockwise) | Hex |
|---|---|---|
| Animals | `oklch(0.82 0.13 205)` cyan → `oklch(0.70 0.14 258)` blue | `#36dcec` → `#659ff4` |
| Plants | `oklch(0.80 0.19 145)` green → `oklch(0.85 0.17 125)` yellow-green | `#61dc6b` → `#b5e058` |
| Fungi | `oklch(0.76 0.16 66)` amber → `oklch(0.86 0.16 95)` yellow | `#f49923` → `#f2cf3b` |
| Protists | `oklch(0.76 0.15 305)` violet (flat) | `#c797fd` |
| Bacteria | `oklch(0.60 0.17 275)` indigo (flat) | `#6572e4` |
| Archaea | `oklch(0.66 0.18 345)` magenta-rose (flat) | `#db5dab` |
| Home (*Homo sapiens*) | `oklch(1 0 0)` | `#ffffff` |

All values are in the sRGB gamut; this was checked when converting. Never use raw `#0ff`, `#f0f` or `#0f0`.

Around the wheel (counter-clockwise from angle 0) the groups run Archaea, Bacteria, Protists, Plants, Fungi, Animals. The Fungi ramp runs amber → yellow so that its amber meets the Plants' yellow-green (a yellow-green/yellow seam all but vanishes under red-green colour blindness) and its yellow meets the Animals' cyan.

**Rules**
- **Colour is never the only cue.** Group names appear in the key, the tooltip and the card.
- **CVD check** (`palette.test.ts`, Machado 2009 deuteranopia and protanopia). Every pair of neighbouring groups, and every pair in the purple family (Protists violet, Bacteria indigo, Archaea magenta-rose), stays at least 0.08 apart in OKLab under normal vision and both simulations. The purple family is spread in hue and lightness so it holds together as a family but its members stay distinct; labels and position still back colour up.
- **In the DOM, a kingdom hue appears only as** a 6×6 px square swatch or a 2px vertical rule. Never as text colour, background, border or button.
- **In the canvas,** hues drive the rim, rim marks, the near-rim branch tint and the tip labels (hue mixed 50% toward `--text-1` for legibility).

## 3. Typography
| Role | Face | Sizes / weights | Notes |
|---|---|---|---|
| UI sans | **Hanken Grotesk** (variable) | 400 / 500 / 600 | everything that is not a taxon name or an id |
| Taxon names | **Source Serif 4 Italic** (variable, wght axis; no optical sizing, see Loading) | 400, 600 for the card title | **italic only for genus, species and infraspecific names** (nomenclatural convention). Higher ranks (Felidae, Mammalia) and authorities (Linnaeus, 1758) are set in Hanken Grotesk roman |
| Identifiers | **Spline Sans Mono** | 400 | **only** for real ids: OTT, GBIF, NCBI, and coordinates in the debug HUD |

- **Loading.** Fonts are self-hosted via Fontsource (`@fontsource-variable/hanken-grotesk`, `@fontsource-variable/source-serif-4/wght-italic.css`, `@fontsource/spline-sans-mono/400.css`), subset to latin + latin-ext so Portuguese diacritics work. Source Serif uses the `wght-italic` file (about 52 KB latin) rather than `opsz-italic` (130 KB): optical sizing is dropped to keep fonts within the 120 KB budget (PLAN §7.12). `font-display: swap`. Canvas labels wait for `document.fonts.load()`.
- **Never** Inter, Geist, Space Grotesk, Roboto, JetBrains Mono, or system-ui as the design face.
- **Scale (px):** 11 · 13 · 15 · 22 · 40.
  - 11: meta, credits, the readout
  - 13: body, list rows
  - 15: the card lead (13 on a phone)
  - 22: the card title (18 on a phone)
  - 40: reserved for the empty / no-WebGL page
- **Line height** is 1.45 for body and 1.15 for titles.
- **Numbers** use `font-variant-numeric: tabular-nums` for counts. Thousands separators come from `Intl.NumberFormat` (`2,385,875`).
- **No weight below 400** on black. No all-caps eyebrow labels, small-caps rank labels, or letter-spaced uppercase kickers. A rank is written as a plain word ("species", "family") in `--text-2`, before or after the name.
- **Canvas labels:**
  - Clade labels: Hanken Grotesk 500, 11–13 px, `--text-2`, following the arc.
  - Tip labels: Source Serif 4 Italic, 12–22 px, scaling with tip spacing.
  - Within a name only the Latin is italic: rank markers (subsp., var., f.), qualifiers (cf., aff.), *Candidatus* and informal parts (strain codes, "sp. NCCP-140", "(strain Shark)") are Hanken Grotesk roman (`names.ts`, shared by canvas and DOM). OTT placeholders ("h2007-2", "… incertae sedis") get no label or breadcrumb segment.
  - Group labels: Hanken Grotesk 500, 13 px, `--text-2`, sentence case ("Animals").
  - No glow and no shadow on any text.

## 4. Layout

### 4.1 Desktop (landscape, ≥ 720 px)
```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Circle of Life                                      [ Search 2.3M species / ]│
│          . · ' ' ' · .                    ┌─────────────────────────────────┐│
│     . '                ' .                │ Panthera onca                 ⧉ ││
│   '                       '               │ species · in Felidae            ││
│  '         the wheel        '      ╱──────┤ summary …            [image]    ││
│ '                            '    ╱       └─────────────────────────────────┘│
│ '                             ◯  ← anchor: the selection; zoom about it      │
│ '        ● centre             '                                              │
│ Eukaryota › Animals › Chordata › Mammalia                       − + ⟲        │
│ 6,495 species in view · OpenTree 16.1                  ■ Animals ■ Fungi …   │
└──────────────────────────────────────────────────────────────────────────────┘
```
**The locked view.** The wheel never pans. The view is a zoom and a rotation, nothing else, and every viewport has one composition (`layout.ts`):
- **The anchor** is a fixed screen point on the rim at the **focus angle**, the upper right of the rim, just below and left of the card. The selection sits on it. Zoom scales the picture about it, so whatever is at the anchor stays put from minimum to maximum zoom.
- **Minimum zoom** (the reference composition, docs: the user's frame at 2000×1030): the anchor is 72 px left of the card and 28 px below it, at 30° from the wheel's centre; the rim's top sits 64 px from the top, under the header. So the centre falls low on the left (about 26% w, 79% h), the rim fills the left and the top, and its right edge is near the card's left edge (about 63% w).
- **Zooming in, the wheel slides left.** Over the whole zoom, from minimum zoom to the point where tips are 4 px apart, the anchor drifts left, slowly and evenly (smoothstep in log zoom; about 15 px per wheel notch at most on a 2000 px screen), from its minimum-zoom place to at most 33% of the width and at least 360 px left of the card. By mid zoom it has already moved a little; at deep zoom the rim sits at about a third of the width. What sits at the anchor stays on it while the anchor glides.
- **Deep zoom:** as tips spread from 0.25 to 4 px apart the focus angle eases from 30° to 0°, so the rim runs vertically through the anchor, each branch runs into its species name and names read left to right (1.png). The column of names ends well clear of the card: the rows beside the card keep their full names (a genus is abbreviated, "P. leo", only as a last resort).

**Placement**
- **Margins** are 16 px at the edges, on an 8 px grid.
- **Top-left: the wordmark** "Circle of Life", Hanken Grotesk 500 at 13 px in `--text-1`. Clicking it opens a text-row menu: "Data & credits", "Keyboard", "Auto-orient: on".
- **Top-right: the search trigger.** An opaque `--surface` field with a hairline border and radius 2 px, at 13 px in `--text-3`, with a `/` key hint. It sits above the card.
- **Right: the card**, a fixed rectangle from 62% of the width to the 16 px gutter, and from 56 px (under the search trigger) to 40% of the height; at least 340 × 240 px.
  - `--surface` with a 1 px `--hairline` border, radius 0, no shadow. It fades in once (200 ms) with the first selection and never closes: there is always a selection, *Homo sapiens* to begin with, and no close button.
  - The same content as before (§4.2). Long content scrolls inside the card. The about image floats right at 40% of the card's width, so the head and summary share the first screenful.
  - **The leader**: a 1 px `--text-1` hairline, like the "You are here" callout, from the selection up at 60° to an elbow, then horizontally into the card's left edge (24 px of square run). It is never hidden, and never crosses the card: a start below the card's left edge enters its bottom edge, one above the card its top edge. Text keeps clear of it. It is drawn on the label canvas, not by the renderer.
    - It starts just outside the selection's ring. Once tip names show, it leaves from just past the selection's own name (for a clade, past the column of names), so it never cuts through the neighbours' names.
    - For a clade zoomed in past its node, the start slides along the clade's stem to the rim, where its tips are, as the node leaves the screen.
    - When the selection is off screen (turned or zoomed away, or behind the card), the leader starts where the ray from the anchor towards it leaves the screen (above the bottom HUD band), with a small open arrowhead (8 px) pointing that way; the arrowhead fades in over its first 24 px of distance. Every step is continuous, so the start glides while the wheel turns or flies.
- **Bottom-left: the persistent HUD.**
  - Line 1 is the breadcrumb: the selection's lineage, at 13 px in `--text-2`. Segments are clickable (they select that clade), the current one is `--text-1`, and the separator is "›". Long trails are middle-truncated as "Eukaryota › … › Felidae".
  - Line 2 is the readout, at 11 px in `--text-3` with tabular numbers: "6,495 species in view · OpenTree 16.1" (below 720 px just the count). The LOD level is debug information and lives in `?debug`.
- **No plates.** HUD text and controls are flat DOM with no background. The renderer darkens the tree behind each HUD box (85%, 8 px padding, a 20 px soft edge), so the text reads over bright bars without boxes cutting the glow. The boxes come from one shared registry (`ui/obstacles.ts`) that the card and search use too.
- **Left edge: the zoom strip.** A slim vertical scale, 16 px from the left edge, centred between the header and the bottom HUD (at most 300 px long), like the side of a scroll wheel: 1 px ticks every 6 px in `--hairline-solid`, every fifth one longer in `--text-3`; a 2 px `--text-1` thumb; the reading beside it at 11 px in `--text-2`, tabular. The top is 100% (maximum zoom), the bottom 2% (minimum zoom, the composition a plain visit opens on); in between it is logarithmic in zoom, so every step feels the same. Drag it to zoom about the anchor, click a point to fly there, scroll over it to zoom; it is a slider for the keyboard (↑/↓ 5%, Page Up/Down 20%, Home/End). It follows every other zoom live. The reset button (28 px, hairline, the ⟲ icon) sits under it and returns to minimum zoom, keeping the selection. It replaces the − and + buttons. Flat, no plate: the tree is darkened behind it like the rest of the HUD.
- **Bottom-right: the kingdom key:** a 6 px swatch plus the name at 11 px, in clockwise order round the default view (Animals, Fungi, Plants, Protists, Bacteria, Archaea). Clicking an entry selects that group and flies to it.
- **While dragging,** the chrome drops to 40% opacity over 150 ms.

### 4.2 Card content (top → bottom)
```
Panthera onca                              ⧉ copy        ← serif italic 22/600 (higher ranks: sans 22/600)
species · in Felidae                                     ← 13 text-2
Linnaeus, 1758                                           ← 13 text-2 (authority roman)
─────────────────────────────────────────────── hairline
[ image, 3:2, cover, no radius ]                         ← floated right at 40% of the card (36% on a phone)
Image: Jane Doe · CC BY-SA 4.0 · Wikimedia Commons       ← 11 text-3, links underlined on hover
The jaguar is a large cat species … (Wikipedia)          ← 15 text-1, max 6 lines + "Read on Wikipedia"
Near Threatened (NT) · IUCN via Wikidata                 ← 13 text-1, plain text, no badge
─────────────────────────────────────────────── 
Where it lives        [GBIF density map, dark, 380×190]
                      Brazil 1,204 · Mexico 880 · …      ← 11 text-2 tabular
─────────────────────────────────────────────── 
Lineage  Eukaryota › Animals › Chordata › Mammalia › Carnivora › Felidae › Panthera
Counts   1 species · 0 direct descendants
         (or: "412 direct descendants · relationships unresolved")
IDs      OTT 42324 · GBIF 5219426 · NCBI 9690             ← mono 11
Links    GBIF · Wikidata · iNaturalist · Open Tree
─────────────────────────────────────────────── 
Text: Wikipedia (CC BY-SA 4.0) · Image: … · Data: GBIF.org, Open Tree of Life    ← 11 text-3
```
**Content rules**
- An ancestor fallback carries a plain label line: "About the genus *Panthera*" (13 px, `--text-2`) above the borrowed text or image.
- An unnamed node is titled "Unnamed clade", with "within *Felidae*" underneath.
- *Homo sapiens* carries a "You are here" line under its rank (13 px, `--text-2`); while it is the selection, its leader replaces the canvas callout.

### 4.3 Mobile (< 720 px, and any portrait window)
```
┌──────────────────────────┐
│ Circle of Life       [/] │
│┌────────────────────────┐│
││ Homo sapiens         ⧉ ││  ← the card: full width less 12 px gutters,
││ species · in Homininae ││    30% of the height (200–300 px), compact
││ summary …     [image]  ││
│└────────┬───────────────┘│
│         │  leader        │
│    ' ' ◯  anchor         │
│ '          '             │
│   the wheel  '           │
│ ● centre, low left       │
│ Mammalia › Primates  − + │
│ 214 species in view      │
└──────────────────────────┘
```
- **The card spans the top**, under the header, full width less 12 px gutters, 30% of the height (200–300 px). It is compact: 12 px padding, an 18 px title, 13 px body text, the image floated right at 36%.
- **The wheel sits below.** The anchor is 88 px under the card, at 60° from the wheel's centre; the centre sits low near the left edge (86% of the height) and the rim's right edge stops 20 px inside the screen, so the rim fills the space under the card and its focus area is just below it. At deep zoom the rim turns vertical at the anchor, as on desktop, and the anchor drifts left to 30% of the width, so names running right fit without abbreviation.
- **The leader** runs up at 60° from the selection to an elbow 20 px under the card, then vertically into the card's bottom edge.
- The kingdom key is reachable from the wordmark menu. Touch targets are at least 40 px. The bottom HUD (breadcrumb, readout) stays at the bottom.
- **The zoom strip** runs down the left edge from 24 px under the card (at most 260 px), with a 40 px wide touch target and the 40 px reset button under it, clear of the bottom HUD. Touches on it zoom; the wheel's own drag and pinch work everywhere else.

### 4.4 Search palette
```
            ┌───────────────────────────────────────────────┐
            │ homo sap▌                                 esc │  ← 15 text-1, hairline bottom
            ├───────────────────────────────────────────────┤
            │ ■ Homo sapiens          Mammalia › Primates   │  ← active row: --surface-2 + 2px left rule in --text-1
            │ ■ Homo sapiens idaltu   Mammalia › Primates   │
            │ ■ Homo                  genus · Hominidae     │
            └───────────────────────────────────────────────┘
```
**Layout and style**
- Width min(560 px, 100% − 32 px), positioned 12vh from the top.
- `--surface`, hairline border, radius 2 px.
- **No backdrop blur and no dimming gradient.** The canvas stays visible, dimmed to 50% by the renderer (a uniform, not CSS).

**Rows**
- Each row: a 6 px swatch, then the name in its correct style. The part that matched is weight 600; the rest is 400.
- Then the muted lineage or matched common name (`--text-3`).
- Common-name matches show as "jaguar · *Panthera onca*".

**States**
- Empty: "No taxon matches “xyz”. Try a genus or a common name."
- Error: "Search is unavailable right now." with a "Retry" link.

## 5. Canvas visual spec
| Element | Spec |
|---|---|
| Background | `#000` |
| Interior branches | 1 device px hairlines, `--branch` α 0.35 (0.85 deep). Colour mixes toward the kingdom hue as r goes 0.55 → 1, squared so it concentrates near the rim. Within 120 px of the rim lines brighten (the luminous rim band) |
| Frontier extensions and fans | stand for unresolved subtrees: faint at their node, building up towards the rim and dimming far from the rim band on screen. Fans are drawn as hashed fine strands (never flat polygons); fans under 1.5 px wide are left to their extension line |
| Arcs | same as branches |
| Centre | empty disc of r0 = 0.08, no ring drawn beyond the root arc |
| Rim ring | analytic glow: a crisp core (σ ≈ 1.2 px) plus a soft halo (decay ≈ 10 px outside, ≈ 55 px inside, at overview), kingdom LUT colour, additive. Fades out as tips resolve (λ 11.5 → 13) |
| Rim spikes ("fur") | one per frontier clade, outward, length 3–14 px ∝ log2(tips), soft-edged, additive; plus the ring's own fine fur, outward strokes up to 9 px of hashed length per ~1.5 px column, so the rim is furry even where every clade is large |
| Tip bars (as tips resolve) | the last ≤ 120 px of each tip's hairline, brightened in the kingdom colour: one device px wide like the hairline, no halo, soft inner end. They fade in with λ 12 → 13.5, keeping the rim's glow as the ring fades, and fade out again as tips spread 2 → 6 px apart, so at deep zoom each branch runs into its species name as one even line. *Homo sapiens* and its two subspecies share one white line on the label's row, and the home node gets a long white outward leader bar (0.7 × tip spacing wide, ≤ 28 px; 280 px long) past its label, fading in smoothly from its far end, with a rounded halo at its near end |
| Hover path | 2 px, `--text-1` at 60% (an opaque grey of that brightness, so it reads over bright bars); the rest of the tree dims to 60%. It follows what is drawn: a frontier node's path runs on to the rim |
| Selection | 2 px white path plus a 6 px (radius) hairline ring at the node; a tip's (and Homo sapiens') ring sits at the rim. Always present (*Homo sapiens* by default) |
| Selection leader | 1 px `--text-1` hairline on the label canvas from the selection (past its name once names show) to the card (§4.1, §4.3): 60° up to an elbow, then square into the card. Never hidden; off screen it starts at the screen edge towards the selection with an 8 px open arrowhead. Labels keep clear of it |
| "You are here" | hairline leader from the home tip outward plus the 11 px label "You are here", `--text-1`; hidden while *Homo sapiens* is the selection (the selection leader and the card say it) |
| Labels | see §3. Fade 150 ms, hysteresis 1.0× / 0.85× fit |
| Clade bars | where a clade's own arc cannot hold its name, once the wheel is no longer whole on screen (group labels show until then): a 1 px `--text-3` hairline arc outside the rim over its tips, 5 px end ticks towards the rim, name in `--text-2` just beyond (Latin in serif italic). Nested clades stack outward in lanes. Bars stay inside the 16 px gutter and above the HUD band. At deep zoom they sit past the tip-label column, names at 13 px set horizontally beside the bar |
| Dense glow | saturating additive blending: dense areas converge on their kingdom hue and never wash to white |

Glow exists **only** in the canvas. It comes from additive blending and soft-edged geometry; v1 has no post-processing bloom. It is strongest on the whole wheel and eases to 45% by mid zoom. **Glow never pulses or animates on its own.** All of these numbers live in `web/src/style.ts`.

## 6. Motion
| What | Duration | Easing |
|---|---|---|
| Intro radial reveal (once, only when landing on the default view (no `n`, no `v`); not for deep links, `?shot` or `?debug`) | 900 ms, starting once the coarse tiles are in, then labels/HUD fade 200 ms | `cubic-bezier(0.2, 0, 0, 1)` |
| Fly-to (van Wijk–Nuij along the rim, ρ 1.4): search, lineage, keys | 600–2000 ms ∝ path length | built-in smooth; skippable by any input |
| Turn to a clicked node (zoom kept) | 250–900 ms ∝ distance on screen | smoothstep; skippable by any input |
| Auto-orient | follows the zoom (no tween); toggling it eases 400 ms | ease-in-out |
| Card (first show) / palette | 160–220 ms, opacity (palette + 8 px translate) | `cubic-bezier(0.2, 0, 0, 1)` |
| Label fade | 150 ms | linear |
| Chrome dim while dragging | 150 ms | linear |
| Ambient turn (idle) | 20 CSS px/s at the anchor at every zoom, clockwise (about one turn in 4 min at minimum zoom); stops on any input, eases back in 3 s after the last one (0.8 s after a flight, card hover or search ends) over 2 s | friction, τ 400 ms |
| Fling (release of a turning drag or a two-finger twist) | spins on at the release speed, decays into the ambient turn | friction, τ 400 ms |
| Idle tour | after 10 s on a selection, the next species from a curated list (shuffled, no repeats until all are seen), a ≥ 2.4 s turn at the same zoom; any input stops it, it resumes after 30 s without input; pointer movement in the last 3 s, the pointer resting on the card, search, a flight or a hidden tab hold its countdown (a pointer resting on the wheel does not) | fly-to path |
| Wheel zoom | immediate, anchored at the anchor (not the cursor) | — |
| −, + and double-click zoom | 220 ms, about the anchor | ease-out cubic |

**`prefers-reduced-motion` (or `?reduced`):** no intro, cuts plus a 120 ms crossfade instead of flights and turns, no fling, no ambient turn and no idle tour (the selection stays manual; a plain visit still opens on *Homo sapiens*), zoom buttons cut, and toggling auto-orient cuts.

**`?still`** (implied by `?shot`): no ambient turn, no fling and no tour, so screenshots and tests are deterministic; `?tour=<seconds>` turns the tour on by itself with that dwell. A hidden tab pauses everything.

**Opening:** a plain visit always opens on *Homo sapiens* at minimum zoom (nothing is restored from storage), and the tour starts from it. A deep link (`?n=`) opens on its node and the tour waits 30 s before moving on.

## 7. States and copy
**Loading**
- Shows the coarse tree first: level 0–3 tiles render as they arrive.
- A 1 px hairline progress bar at the top, with a truthful label in the readout: "Loading tree · 9 / 15 tiles".
- No spinners, no shimmer and no skeletons.

**Panel about-section loading:** a hairline progress line under the title and the text "Fetching from Wikipedia, GBIF…". Core data shows immediately.

**Missing data:**
- "No photo on Wikimedia Commons or iNaturalist."
- "No Wikipedia article. About the genus *X*:"
- "No occurrence records on GBIF."

**Errors:**
- "Couldn’t reach Wikidata. Retry"
- "Tile failed to load. Retrying…", retried automatically 3× with backoff.

**No GPU drawing (neither WebGPU nor WebGL2):** a static fallback image of the wheel and the sentence "Your browser can’t draw the interactive tree (no WebGPU or WebGL2). Search still works.", with search and the card still functional (the card appears once a result is chosen).

**Polytomy:** "412 direct descendants · relationships unresolved". This wording is honest about synth fans.

**Credits dialog:** this is where the full source list lives (see data-sources.md). It also states: "No dates: branch lengths are not available, so the rings are not time."

## 8. Interaction checklist
- **Hover:** highlights the root→node path, dims the rest and shows a tooltip.
  - Tooltip content: the name in its correct style, then "species · 1" or "family · 3,214 species" in `--text-2`.
  - Tooltip style: `--surface`, hairline border, radius 2 px, 8 px offset.
- **Click or tap** selects the node: the card shows it, the URL gets `?n=ott…`, and the wheel turns so the node lands on the anchor, at the same zoom. There is no empty state; nothing deselects.
- **Left alone**, the wheel turns slowly and, after 10 s, the idle tour moves the selection to another species every 10 s (§6). Any input stops the tour for 30 s; a released drag flings the wheel.
- **Drag** turns the wheel about its centre (never pans). **Wheel**, **pinch**, `+`/`-` and the buttons zoom about the anchor; **two fingers twisting** turn the wheel.
- **Search, lineage, breadcrumb, kingdom key and the arrow keys** select and fly: turn the node onto the anchor and zoom to suit it.
- **Keys:**
  - `/` or `⌘K` search
  - `Esc` closes the topmost layer (search, dialog, menu); it never clears the selection
  - `↑`/`Backspace` parent, `↓` largest child, `←`/`→` siblings
  - `H` "You are here"
  - `R` auto-orient
  - `+`/`-` zoom; on the zoom strip, `↑`/`↓`, `Page Up`/`Page Down`, `Home`/`End`
- **Focus:** a visible 1 px `--focus` ring with 2 px offset on every interactive element. No `outline: none` without a replacement.
- **Deep links** restore the selection (`n`, default *Homo sapiens*) and the view (`v=a,z`: rotation and zoom). Old links with a pan (`v=a,r,z,rot`) still open, without the pan.

## 9. Banned tells (ship-gate: all must be absent)
- [ ] gradients in the DOM (`linear-gradient`, `radial-gradient`, `conic-gradient`) and gradient text
- [ ] glassmorphism, `backdrop-filter`, blur
- [ ] glow, `box-shadow` or `text-shadow` on any UI or text
- [ ] radius > 4 px; rounded-2xl cards; drop shadows
- [ ] emoji, ✨, decorative icons (at most 5 text-size glyphs: ›, ⧉, −, +, ⟲)
- [ ] pill badges, eyebrow kickers, small-caps or tracked-uppercase rank labels
- [ ] hero stats or big-number vanity tiles
- [ ] pulsing, bouncing, fade-up-on-everything; more than one intro animation
- [ ] "→" appended to links
- [ ] monospace for anything but real ids
- [ ] text below `--text-3` contrast; weights below 400
- [ ] tinted near-black instead of `#000`
- [ ] Inter / Geist / Space Grotesk / Roboto / JetBrains Mono
- [ ] saturated colour in the DOM beyond 6 px swatches and 2 px rules
- [ ] generic AI copy ("Explore the wonders of…", "Unleash…")

**Ship gate also requires:**
- correct italics on taxon names
- AA contrast
- reduced motion honoured
- hover path, keyboard nav and focus rings working
- deep links working
- truthful loading
- specific empty and error copy
- reviewed screenshots on desktop (1440×900) and mobile (390×844)

## 10. Visual QA workflow
1. **DESIGN.md comes first.** It is the source of truth. `styles.css` tokens and `palette.ts` are generated or hand-copied from §2. The Vitest palette test asserts the OKLCH→hex values in §2 to within ±1 per channel.
2. **Screenshot script.** `web/scripts/shot.ts` drives Playwright Chromium headless with `--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`.
   - **Per state** it opens `?shot&…`, awaits `window.__renderIdle === true`, and saves `screens/<state>@<w>x<h>.png`.
   - **States:** `overview`, `animals`, `mammals`, `deep-homo`, `panel-homo`, `search-open`, `mobile-overview`, `mobile-card`, `reduced`, and the locked-view set `locked-…` (minimum, mid and maximum zoom at 2000×1030, a clade, 1440×900, 1280×800, 390×844 at minimum and deep zoom).
3. **Review rounds** after P6, P7 and P12. A separate reviewer agent compares the screens against `docs/reference/1-5.png` and §9, then lists concrete deltas such as "rim halo too weak at overview; tip labels too saturated; breadcrumb collides with key at 1280 px". The implementer fixes them. 2–3 rounds at most.
4. **Optional:** `make lint-design` greps for banned CSS and font tokens (PLAN §10.2).
