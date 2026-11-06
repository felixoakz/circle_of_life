# Circle of Life: design system

This document governs everything visual and binds every implementing agent. It is merged from the UI-craft brief, the reference-site study and the supervisor's overrides.

## 1. Concept
**A scientific instrument at night: a herbarium plate under a lightbox.** The tree is the specimen, and the interface is a calibrated readout around it.

- There is no hero, no marketing copy and no landing page. The tree *is* the page, from the first frame.
- All colour and all light come from the data, inside the canvas. The DOM chrome is achromatic and quiet: what floats over the wheel (the card, search, menus, dialogs) is one smoked-glass material (§2.3) that lets the wheel's light through, blurred; HUD text stays flat.
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
| `--surface` | `oklch(0.16 0 0)` | `#0d0d0d` | the opaque fallback for glass (§2.3) |
| `--surface-2` | `oklch(0.20 0 0)` | `#161616` | reserved (hover rows are `--glass-hover` now) |
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

### 2.3 Glass (the floating surfaces)
Everything that floats over the wheel is **smoked glass**: a dark neutral fill over the wheel blurred, darkened and slightly saturated, so a bright rim behind a card or menu shows as a soft, dim bloom of its kingdom hue and the text on top stays legible. Think macOS / visionOS materials at their most restrained: no colour of its own, no gradients, no glow, no drop shadow. The tokens live in `styles.css` (`:root`) and the material is applied in one block there ("Glass").

| Token | Value | Use |
|---|---|---|
| `--glass-fill` | `oklch(0.18 0 0 / 0.56)` | card, search bar, zoom reset |
| `--glass-fill-dense` | `oklch(0.16 0 0 / 0.70)` | text-dense layers that open over anything: search palette, dialogs, tooltip; the search bar and reset on hover |
| `--glass-filter` | `blur(24px) saturate(1.6) brightness(0.7)` | the backdrop of large surfaces |
| `--glass-filter-small` | `blur(12px) saturate(1.6) brightness(0.7)` | the tooltip and the reset button |
| `--glass-edge` | `oklch(1 0 0 / 0.11)` | the 1 px border of every glass surface |
| `--glass-edge-strong` | `oklch(1 0 0 / 0.20)` | the search bar at rest (`/ 0.32` on hover), the reset button on hover |
| `--glass-highlight` | `inset 0 1px 0 0 oklch(1 0 0 / 0.06)` | a 1 px inner top highlight: the only `box-shadow` allowed |
| `--glass-hover` / `--glass-active` | `oklch(1 0 0 / 0.06)` / `/ 0.10` | hover rows and buttons / the active tab and search row |
| `--glass-text-3` | `oklch(0.65 0 0)` | `--text-3` inside glass (set on each glass surface) |
| `--glass-dim` | `oklch(0 0 0 / 0.45)` | a dialog's `::backdrop`: a flat dim, never a full-screen blur |
| `--radius-l` / `-m` / `-s` / `-media` | 14 / 10 / 6 / 8 px | card, palette, dialogs / search bar, menu, tooltip, tab track / rows, buttons, reset / the photo and the Range map |

**Rules**
- **One layer deep.** Glass never sits on glass, except the docked search palette over the card while it is open. HUD text (breadcrumb, readout, key, zoom strip ticks) gets no plate: the renderer darkens the tree behind it instead (§4.1).
- **Few blurred boxes.** `backdrop-filter` re-blurs its area every frame the canvas changes (the wheel turns all the time), so it goes only on the card, the search bar, the palette, the menu, the dialogs, the tooltip and the reset button: at most three at once in practice. Blur radii stay at 24 px and 12 px.
- **Legibility.** The fill and the backdrop's `brightness(0.7)` keep text over the brightest blurred rim at AA: `--text-1` and `--text-2` comfortably; `--text-3` is lifted to `--glass-text-3` on glass so 11 px meta stays at about 4.5:1 there too.
- **Fallbacks.** Without `backdrop-filter` (`@supports not`), under `prefers-reduced-transparency: reduce` and under `prefers-contrast: more` the fills become opaque `--surface`; more contrast also brightens the edges to `--text-3` / `--text-2`. Shapes and radii stay.
- **Edges and corners.** A 1 px `--glass-edge` border plus the inner top highlight; no gradient borders. Radii are concentric-ish: 14 px outside, 6–10 px for what sits inside, 8 px for media.

## 3. Typography
| Role | Face | Sizes / weights | Notes |
|---|---|---|---|
| UI sans | **Hanken Grotesk** (variable) | 400 / 500 / 600 | everything that is not a taxon name or an id |
| Taxon names | **Source Serif 4 Italic** (variable, wght axis; no optical sizing, see Loading) | 400, 600 for the card title | **italic only for genus, species and infraspecific names** (nomenclatural convention). Higher ranks (Felidae, Mammalia) and authorities (Linnaeus, 1758) are set in Hanken Grotesk roman |
| Identifiers | **Spline Sans Mono** | 400 | **only** for real ids: OTT, GBIF, NCBI, and coordinates in the debug HUD |

- **Loading.** Fonts are self-hosted via Fontsource (`@fontsource-variable/hanken-grotesk`, `@fontsource-variable/source-serif-4/wght-italic.css`, `@fontsource/spline-sans-mono/400.css`), subset to latin + latin-ext so Portuguese diacritics work. Source Serif uses the `wght-italic` file (about 52 KB latin) rather than `opsz-italic` (130 KB): optical sizing is dropped to keep fonts within the 120 KB budget (ARCHITECTURE §7.12). `font-display: swap`. Canvas labels wait for `document.fonts.load()`.
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
  - Tip labels: Source Serif 4 Italic, 12–22 px from 11 px between tips, scaling with tip spacing. Zooming out they do not vanish at a threshold: below 11 px they keep shrinking with the rows (12/11 of the spacing, so rows never touch) and fade out as tips close from 8 to 5 px apart (the last text is about 6 px). Under them the names are **greeked**: one low-alpha stroke per word, about an x-height thick and as long as the word would be, in the label's colour (α 0.45 at most), taking over as the text fades, so the column still reads as a block of names that resolves into text as you zoom in. The greeking thins out in turn as rows close from 3 to 1.5 px apart, where it would only be noise. Greeked names keep off the HUD and the card like text, and hairlines cost them nothing either: the leader is cut 1.5 px round each stroke it crosses.
  - Within a name only the Latin is italic: rank markers (subsp., var., f.), qualifiers (cf., aff.), *Candidatus* and informal parts (strain codes, "sp. NCCP-140", "(strain Shark)") are Hanken Grotesk roman (`names.ts`, shared by canvas and DOM). OTT placeholders ("h2007-2", "… incertae sedis") get no label or breadcrumb segment.
  - Group labels: Hanken Grotesk 500, 13 px, `--text-2`, sentence case ("Animals").
  - No glow and no shadow on any text.

## 4. Layout

### 4.1 Desktop (landscape, ≥ 720 px)
```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Circle of Life                        [ ⌕  Search 2.3M species            / ]│
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
**The locked view** (the default; free view, below, is the one way out). The wheel never pans. The view is a zoom and a rotation, nothing else, and every viewport has one composition (`layout.ts`):
- **The anchor** is a fixed screen point on the rim at the **focus angle**, the upper right of the rim, just below and left of the card. The selection sits on it. Zoom scales the picture about it, so whatever is at the anchor stays put from minimum to maximum zoom.
- **Minimum zoom** (the reference composition, docs: the user's frame at 2000×1030): the anchor is 72 px left of the card and 28 px below it, at 30° from the wheel's centre; the rim's top sits 64 px from the top, under the header. So the centre falls low on the left (about 26% w, 79% h), the rim fills the left and the top, and its right edge is near the card's left edge (about 63% w).
- **Zooming in, the wheel slides left.** Over the whole zoom, from minimum zoom to the point where tips are 4 px apart, the anchor drifts left, slowly and evenly (smoothstep in log zoom; about 15 px per wheel notch at most on a 2000 px screen), from its minimum-zoom place to at most 33% of the width and at least 360 px left of the card. By mid zoom it has already moved a little; at deep zoom the rim sits at about a third of the width. What sits at the anchor stays on it while the anchor glides.
- **Deep zoom:** as tips spread from 0.25 to 4 px apart the focus angle eases from 30° to 0°, so the rim runs vertically through the anchor, each branch runs into its species name and names read left to right (1.png). The column of names ends well clear of the card: the rows beside the card keep their full names (a genus is abbreviated, "P. leo", only as a last resort).

**Free view** (opt-in; the locked view stays the default). The padlock beside the zoom strip's reset button lets go of the composition so any part of the wheel, the inner branches too, can be reached (`freeview.ts`, `rig.ts`):
- Nothing moves on the way in: the free view starts from the picture as it is. Drag pans (the point under the pointer stays under it; no fling). The wheel, a pinch and double-click zoom about the cursor or the fingers' midpoint, to the same maximum zoom; `+`/`-` and the strip zoom about the screen centre. Shift + drag turns the picture about the point where the drag began (right is clockwise); two fingers twisting turn it about their midpoint. The screen centre stays within half a screen of the rim, so the wheel cannot be lost.
- No anchor and no motion of its own: the ambient turn, the idle tour, auto-orient's easing and the anchor's drift are all off. Hover, click to select (the view stays put), the card, labels and the leader work as ever; an off-screen selection's leader points from the screen centre.
- The way back: the padlock again, or `Esc` (once no search or dialog is open: they close first) flies back to the locked view (the fly-to path; a cut under reduced motion). With the selection free view began with, it returns to the very pose it left; with a new one, to the zoom that suits it, as search would. Search, the breadcrumb, the key, the arrow keys, `H` and reset fly back the same way. Any input during the flight back stops it, still free.
- The padlock: the reset button's glass, 40 px with a 20 px icon, 4 px to its right; shut while locked, open in `--text-1` with the `--glass-edge-strong` edge while free. A toggle button labelled "Free view" (`aria-pressed`). On the canvas the cursor is the move cursor while free.

**Placement**
- **Margins** are 16 px at the edges, on an 8 px grid.
- **No wordmark or menu.** The name is the page's `h1`, visually hidden (screen readers keep it); the top-left corner is empty. Data & credits opens from an "i" button at the right of the card's head (24 px target, a 16 px circled-i icon in 1 px strokes, `--text-3`, `--text-1` on hover), the copy button sitting beside the title. The dialog is a dense-glass sheet up to 960 px wide (88% of the height at most): a 22 px title with a one-line subtitle, a row of three figures between hairlines (tips, species, the OpenTree release; 26 px tabular numbers over 11 px `--text-3` labels), then the sources in two columns at 14 px `--text-2` under 11 px uppercase tracked headings (one column, 13 px, on a phone). Links are `--text-1`, underlined in `--text-3`. Auto-orient and the idle tour are always on (the tour off under reduced motion and `?still`); there are no switches for them.
- **Top-right: the search bar**, the way in that newcomers must not miss: exactly as wide as the card and aligned to its edges, 40 px tall, 8 px above it (12 px from the top). A glass field (§2.3) with a 1 px `--glass-edge-strong` border, radius 10 px: a 16 px magnifier, "Search 2.3M species" at 15 px in `--text-2`, and the `/` key hint (a 4 px-radius hairline keycap) at the right. Hover and focus brighten the border, densen the fill and turn the text `--text-1` (plus the focus ring).
- **Right: the card**, from 62% of the width to the 16 px gutter, its top at 60 px (under the search bar). A fixed box, down to min(60% of the height, height − 152 px, top + 560 px). The composition (the anchor) is built round its nominal box, down to 40% of the height (at least 340 × 240 px); the leader and the labels follow the card's real box. **Nothing in it scrolls:** under its head are tabs, and each tab's content is fitted to the tab area (§4.2).
  - Glass (§2.3): `--glass-fill`, a 1 px `--glass-edge` border, the inner top highlight, radius 14 px, no drop shadow. It fades in once (200 ms) with the first selection and never closes: there is always a selection, *Homo sapiens* to begin with, and no close button. The leader meets its straight left (or bottom) edge at least 24 px from a corner, clear of the rounding.
  - The same content as before (§4.2). Long content scrolls inside the card. The about image floats right at 40% of the card's width, so the head and summary share the first screenful.
  - **The leader**: a 1 px `--text-1` hairline, like the "You are here" callout, from the selection up at 60° to an elbow, then horizontally into the card's left edge (24 px of square run). It is never hidden, and never crosses the card: a start below the card's left edge enters its bottom edge, one above the card its top edge. It never costs a label: it runs under the names, cut by a 1.5 px gap round each glyph it crosses, and a clade bar's name slides off it where it can. It is drawn on the label canvas, not by the renderer.
    - It starts just outside the selection's ring. Once tip names show, it leaves from just past the selection's own name (for a clade, and for a species whose subspecies are the tips, past the column of names). A tip's leader then runs straight on along its own row to 24 px past the end of the whole name column (never closer to the card than its square run), and only then rises, so it crosses no neighbour's name and none is abbreviated for it.
    - For a clade zoomed in past its node, the start slides along the clade's stem to the rim, where its tips are, as the node leaves the screen.
    - When the selection is off screen (turned or zoomed away, or behind the card), the leader starts where the ray from the anchor (in free view, the screen centre) towards it leaves the screen (above the bottom HUD band), with a small open arrowhead (8 px) pointing that way; the arrowhead fades in over its first 24 px of distance. Every step is continuous, so the start glides while the wheel turns or flies.
- **Bottom-left: the persistent HUD.**
  - Line 1 is the breadcrumb: the selection's lineage, at 13 px in `--text-2`. Segments are clickable (they select that clade), the current one is `--text-1`, and the separator is "›". Long trails are middle-truncated as "Eukaryota › … › Felidae".
  - Line 2 is the readout, at 11 px in `--text-3` with tabular numbers: "6,495 species in view · OpenTree 16.1" (below 720 px just the count). The LOD level is debug information and lives in `?debug`. In its place, in this order:
    - while the first view loads: "Loading tree · 9 / 15 tiles", with " · slow connection" after 8 s;
    - in free view: "Free view · 6,495 species in view · Esc to return" (the count only while some of the rim is on screen; no "Esc to return" on touch screens, where the open padlock is the way back);
    - while the idle tour runs: "Touring · 6,495 species in view" (any input stops it);
    - on a first visit (once per session, not for `?shot`), until the first input: "Drag to turn · scroll or use the strip to zoom · click a branch" ("pinch … tap" on touch screens).
  - Breadcrumb segments and key entries are at least 24 px tall to hit (WCAG 2.5.8), with no change to the text.
- **No plates.** HUD text and its text controls are flat DOM with no background (the zoom strip's reset and padlock are the glass buttons). The renderer darkens the tree behind each HUD box (85%, 8 px padding, a 20 px soft edge), so the text reads over bright bars without boxes cutting the glow. The boxes come from one shared registry (`ui/obstacles.ts`) that the card and search use too.
- **Left edge: the zoom strip.** A slim vertical scale, 16 px from the left edge, two thirds of the window's height, centred on it (or as near as the header and the bottom HUD allow, with room for the "+" above and the "−" and reset button below), like the side of a scroll wheel: 1 px ticks every 8 px in `--hairline-solid`, every fifth one longer in `--text-3`; a 2 px `--text-1` thumb; the reading beside it at 11 px in `--text-2`, tabular, shown only while the strip is hovered, focused or dragged (150 ms fade; the focus ring goes round the reading, not the whole scale). A "+" above the top tick and a "−" below the bottom one (11 px `--text-3`, `--text-1` on hover) step it by 20% and say which end is which. The tree behind it darkens to 60% (lighter than the text's 85%: it is mostly ticks). The top is 100% (maximum zoom), the bottom 2% (minimum zoom, the composition a plain visit opens on); in between it is logarithmic in zoom, so every step feels the same. Drag it to zoom about the anchor, click a point to fly there, scroll over it to zoom; it is a slider for the keyboard (↑/↓ 5%, Page Up/Down 20%, Home/End). It follows every other zoom live. The reset button (40 px with a 20 px icon, glass with the small blur, radius 6 px, the ⟲ icon) sits under it and returns to minimum zoom, keeping the selection (from free view, in the locked view); the free view padlock sits beside it (§4.1 "Free view"). Its value text reads "2%, minimum zoom" at the bottom. Flat, no plate: the tree is darkened behind it like the rest of the HUD.
- **Bottom-right: the kingdom key:** a 6 px swatch plus the name at 11 px, in clockwise order round the default view (Animals, Fungi, Plants, Protists, Bacteria, Archaea). Clicking an entry selects that group and flies to it.
- **While dragging,** the chrome drops to 40% opacity over 150 ms.

### 4.2 Card content: a head and tabs
```
Panthera onca ⧉                                          ← serif italic 22/600 (higher ranks: sans 22/600); ⧉ a 24 px button beside it, text-3: a 14 px icon of two offset squares in 1 px strokes, like the padlock
Jaguar                                                   ← the common name, sentence case: 15 text-1 (13 on a phone); none, no line
species · in Felidae · Linnaeus, 1758                    ← 13 text-2 (authority roman, once the about section loads)
You are here                                             ← 13 text-2, Homo sapiens only
( Overview | Range | Tree )                              ← segmented: 13 text-2; the active tab text-1 on a --glass-active plate
Overview: the extract (15 text-1) and "From Wikipedia,  │ [ image, 3:2, cover ]   ← 40% of the width (36% on a phone),
CC BY-SA 4.0 · Read on Wikipedia" (11 text-3), the      │ Image: … · licence     shrinking to the tab's height
IUCN status (13 text-1), notices                        │
Range:    [ GBIF density map, as large as fits, 2:1 ]
          1,204 records from 32 countries · Brazil 1,204 · Mexico 880 · …   ← one line each, ellipsis; credit line
Tree:     Lineage  … › Mammalia › Carnivora › Felidae   ← the nearest ancestors that fit 2 lines; "…" titled with the whole trail
          Counts   1 species · 0 direct descendants ("412 … · relationships unresolved"; "6 subspecies")
          Children Panthera onca 1 …  +23 more          ← as many as fit (at most 8); "+N more" pages on
          Links    Wikipedia · GBIF · iNaturalist · Wikidata · Open Tree
          IDs      OTT 42324 · GBIF 5219426 · NCBI 9690  ← mono 11
          Text: Wikipedia (CC BY-SA 4.0) · Image: … · Tree: Open Tree of Life (CC0) · Data & credits   ← 11 text-3
```
**Tabs** (ui/tabs.ts): a small segmented control, as wide as its labels, 14 px under the head: a recessed track (`oklch(0 0 0 / 0.25)`, 1 px `--hairline`, radius 10 px, 2 px padding) holding 28 px tabs (26 px on a phone, 40 px to hit) with 7 px radius; the active one is `--text-1` on a `--glass-active` plate with the glass highlight, the rest `--text-2`. No hairline rules round the row. The WAI-ARIA tabs pattern: `tablist`, `tab`s with `aria-controls` → `tabpanel`s, roving tabindex, ←/→ (wrapping), Home and End move and activate (they never walk the tree). A tab with nothing to show is left out: an unnamed clade has Tree only (and no tab row), most clades no Range. The tab the visitor picks is kept for the next selection that has it, else Overview; the tour never changes tabs. Loading ("Fetching from Wikipedia, GBIF…", "Fetching from GBIF…") and errors sit inside the tab they concern.

**Fitting, never scrolling** (ui/fit.ts): Overview shortens the extract a sentence at a time (down to two lines' worth), then drops the "no photo" note, then cuts to one line; Range sizes the map to the area above its three lines (beside them on a phone); Tree keeps the lineage to two lines, shows as many children as fit, then drops the credit line, links and ids in that order. Whatever still does not fit is left out whole, never cut through a line. On a phone the source line is the one-line "Read on Wikipedia · CC BY-SA 4.0".

**Content rules**
- The photo and the Range map have 8 px corners (`--radius-media`); the copy button, child rows and Retry are text-size controls with 6 px-radius `--glass-hover` plates on hover where they have a box.
- An ancestor fallback carries a plain label line: "About the genus *Panthera*" (13 px, `--text-2`) above the borrowed text or image.
- An unnamed node is titled "Unnamed clade", with "within *Felidae*" underneath.
- *Homo sapiens* carries a "You are here" line under its rank (13 px, `--text-2`); while it is the selection, its leader replaces the canvas callout.
- The lead text is cut to whole sentences that fit the first screen beside the image (a long first sentence is kept whole up to half again that), so it ends on a full stop, not an ellipsis mid-line.
- A source that failed says so where its part would be, in 13 px `--text-3` with "Retry" in `--text-2` (the image's place, under the text, under "Where it lives"). `--danger` is only for the whole about request failing. What is simply missing ("No occurrence records on GBIF.") goes last, at 11 px `--text-3`; a missing image is simply left out, with no note.
- A new selection's content fades in over 200 ms when it arrives part-way through a flight (§6).

### 4.3 Mobile (< 720 px, and any portrait window)
```
┌──────────────────────────┐
│ Circle of Life       [/] │
│┌────────────────────────┐│
││ Homo sapiens         ⧉ ││  ← the card: full width less 12 px gutters,
││ species · in Homininae ││    36% of the height (248–348 px), compact
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
- **The card spans the top**, under the header, full width less 12 px gutters, 36% of the height (248–348 px), a fixed box like the desktop one, with the same head and tabs. It is compact: 10/12 px padding, an 18 px title, 13 px body text with title line height in the head, a 32 px tab row whose tabs are 40 px to hit, the image as a 76 px square in the head beside the name (the tab area is too short for one beside the text), its credit a one-line "Image: licence · author" under the article's source line, the Range map beside its lines.
- **The search bar** takes the whole top row (40 px tall, same style as desktop, no `/` hint), so neither the card nor the wheel moves down for it, and it is the widest, most obvious thing at the top.
- **The wheel sits below.** The anchor is 88 px under the card, at 60° from the wheel's centre; the centre sits low near the left edge (86% of the height) and the rim's right edge stops 20 px inside the screen, so the rim fills the space under the card and its focus area is just below it. At deep zoom the rim turns vertical at the anchor, as on desktop, and the anchor drifts left to 30% of the width, so names running right fit without abbreviation.
- **The leader** runs up at 60° from the selection to an elbow 20 px under the card, then vertically into the card's bottom edge.
- There is no kingdom key on a phone. Touch targets are at least 40 px. The bottom HUD (breadcrumb, readout) stays at the bottom. The card never grows past its 36% box (the wheel's focus is right under it).
- **The zoom strip** runs down the left edge, 20 px in (clear of the system's edge swipe), from 48 px under the card (room for the "+") down to the room the "−" and reset button need just above the breadcrumb (64 px from the bottom: a phone has no kingdom key): all the space there is (about 36% of an 844 px phone; two thirds does not fit under the card), with a 40 px wide touch target, 40 × 24 px "+" and "−" steps and the 40 px reset button under it, clear of the bottom HUD. Touches on it zoom; the wheel's own drag and pinch work everywhere else.

### 4.4 Search palette
```
            ┌───────────────────────────────────────────────┐
            │ homo sap▌                                 esc │  ← 15 text-1, hairline bottom
            ├───────────────────────────────────────────────┤
            │ ■ Homo sapiens          Mammalia › Primates   │  ← active row: an inset --glass-active plate, radius 6 px
            │ ■ Homo sapiens idaltu   Mammalia › Primates   │
            │ ■ Homo                  genus · Hominidae     │
            └───────────────────────────────────────────────┘
```
**Layout and style**
- Desktop: in place of the search bar, over the card: from the card's left edge (at least 400 px wide, growing left) to the 16 px gutter, 12 px from the top (where the bar is). Phone: full width less the gutters, at the top.
- Glass (§2.3) with the dense fill, radius 14 px. Docked over the card it blurs the card's (stepped-back) content away.
- **No dimming gradient and no full-screen blur.** The canvas stays visible, dimmed to 50% by the renderer (a uniform, not CSS); only the palette's own box is blurred.

**Rows**
- Each row: a 6 px swatch, then the name in its correct style. The part that matched is weight 600; the rest is 400.
- Then the muted lineage or matched common name (`--text-3`).
- Common-name matches show as "jaguar · *Panthera onca*".

- Names that are sequencing leftovers ("… environmental sample", "uncultured …", "… metagenome") go to the end of the results.

**States**
- Nothing typed: "Recent" (this visit's own selections, at most 4) then "Try" (the tour's species by common name, "Tiger · *Panthera tigris*"), 6 rows in all, under 11 px `--text-3` headings; ↑/↓ and Enter work on them as on results.
- Empty: "No taxon matches “xyz”. Try a genus or a common name."
- Error: "Search is unavailable right now." with a "Retry" link.

## 5. Canvas visual spec
| Element | Spec |
|---|---|
| Background | `#000`; beyond the rim, the backdrop (§5.1) |
| Interior branches | 1 device px hairlines, thickening to 3 CSS px (antialiased quads) as tips spread from 8 to 32 px apart, where each branch reads as its own solid stroke running into its name, its alpha rising to 1 over the same ramp (a thick line at 0.85 reads as a dim olive); arcs and the frontier extensions follow. Below one device px they stay native hairlines, so the overview and mid zoom are unchanged. `--branch` α 0.35 (0.85 deep). Colour mixes toward the kingdom hue as r goes 0.55 → 1, squared so it concentrates near the rim. Within 120 px of the rim lines brighten (the luminous rim band) |
| Frontier extensions and fans | stand for unresolved subtrees. On the whole wheel: faint at their node, building up towards the rim and dimming far from the rim band on screen. Zoomed in (tips 0.004 → 0.015 px apart) that build-up eases away and an extension runs on to the rim as bright as the stem leading into it, so no lineage seems to end at its node (the faint start read as a dark staircase of clade nodes well inside the rim). Fans are drawn as hashed fine strands (never flat polygons); fans under 1.5 px wide are left to their extension line |
| Arcs | same as branches |
| Centre | empty disc of r0 = 0.08, no ring drawn beyond the root arc |
| Rim ring | analytic glow: a crisp core (σ ≈ 1.2 px) plus a soft halo (decay ≈ 10 px outside, ≈ 55 px inside, at overview), kingdom LUT colour, additive. Fades out as tips resolve (λ 11.5 → 13) |
| Rim spikes ("fur") | one per frontier clade, outward, length 3–14 px ∝ log2(tips), soft-edged, additive; plus the ring's own fine fur, outward strokes up to 9 px of hashed length per ~1.5 px column, so the rim is furry even where every clade is large |
| Tip bars (as tips resolve) | the last ≤ 120 px of each tip's hairline, brightened in the kingdom colour: as wide as its hairline (one device px, more once lines thicken), no halo, soft inner end. They fade in with λ 12 → 13.5, keeping the rim's glow as the ring fades, and fade out again as tips spread 2 → 6 px apart, so at deep zoom each branch runs into its species name as one even line. *Homo sapiens* and its two subspecies share one white line on the label's row, and the home node gets a short white outward bar past its label, drawn like a tip bar: as wide as the lines (one device px at least), 120 px long, no halo, fading in from its far end. It is not drawn while *Homo sapiens* is the selection (the selection leader and the card say "you are here" then) |
| Rim edge | from mid zoom (tips 0.004 → 0.015 px apart, about where the wheel stops fitting the screen) a crisp 1.5 px line from the rim outward, in the kingdom colour lifted 30% toward white, at 90%, opaque over the glow: where the lines end is a clean edge, not a soft gradient. At overview the rim glow is the edge. It hands over to the tip dots, fading out as they fade in |
| Tip dots | every species' line ends in a small filled dot on the rim, a terminal node as in a printed phylogeny, so the end of each line reads even where the names are greeked or a selection leader runs past. Constant on screen: 2 px radius, 1.25× the line width once lines thicken (3.75 px at max zoom, beside 3 px lines). Kingdom colour lifted 30% toward white, opaque over its line; *Homo sapiens'* row gets one white dot. They fade in as tips spread from 4 to 8 px apart (below that they would touch, and the rim glow and tip bars mark the ends), so only what fits on screen is drawn, never the 2.4M at once. Names keep their 10 px gap from the rim (8 px from the dot's edge). The selection's ring and white path draw over its dot; hover dims the dots with the tree. The dot is inside the rim's pick zone, so it picks its species |
| Hover path | 2 px (at least twice the line width as lines thicken, at most 5 px), `--text-1` at 60% (an opaque grey of that brightness, so it reads over bright bars); the rest of the tree dims to 60%. It follows what is drawn: a frontier node's path runs on to the rim |
| Selection | 2 px white path (at least twice the line width, at most 5 px, so it stays the heaviest line without shouting: 5 px beside 3 px lines at max zoom) ending in a marker that reads at every zoom, even in the rim's densest glow: a 6 px (radius) 1.5 px ring at the node with a filled 2.25 px dot at its centre, over a dark disc (85%) reaching 2.5 px past the ring that clears the glow behind them. Constant on screen, no motion; a tip's, *Homo sapiens'* and a species-with-subspecies' ring sits at the rim, the path running on to it. Always present (*Homo sapiens* by default). The selected clade's bar (and its name) is drawn in `--text-1`, whatever its size or lane, and the selection's tip names (a tip's own, a clade's) are `--text-1` instead of their kingdom hue, so a selected clade reads as "these" even as a dense band |
| Selection leader | 1 px `--text-1` hairline on the label canvas from the selection (past its name once names show) to the card (§4.1, §4.3): 60° up to an elbow, then square into the card. Never hidden; off screen it starts at the screen edge towards the selection with an 8 px open arrowhead. Runs under the names, cut 1.5 px round each glyph it crosses; it never hides a label |
| "You are here" | hairline leader from the home tip outward plus the 11 px label "You are here", `--text-1`; hidden while *Homo sapiens* is the selection (the selection leader and the card say it), and never placed over the wordmark, the card or the rest of the HUD |
| Labels | see §3. Fade 150 ms, hysteresis 1.0× / 0.85× fit |
| Clade bars | where a clade's own arc cannot hold its name, once the wheel is no longer whole on screen (group labels show until then): a 1 px `--text-3` hairline arc outside the rim over its tips, 5 px end ticks towards the rim, name in `--text-2` just beyond (Latin in serif italic). Nested clades stack outward in lanes. Bars stay inside the 16 px gutter and above the HUD band. At deep zoom they sit past the tip-name column (readable or greeked), names at 13 px set horizontally beside the bar. A name along an arc never turns more than 100° from upright (within 10° of vertical it reads bottom to top), and a bar whose name has no room is not drawn |
| Dense glow | saturating additive blending: dense areas converge on their kingdom hue and never wash to white |

Glow exists **only** in the canvas. It comes from additive blending and soft-edged geometry; v1 has no post-processing bloom. It is strongest on the whole wheel and eases to 45% by mid zoom. **Glow never pulses or animates on its own.** All of these numbers live in `web/src/style.ts`.

### 5.1 Backdrop (behind the glass)
The empty space beyond the rim is not quite empty: a **polar graticule** in the wheel's own frame over a **soft wash of the kingdom hues**, so the glass card (§2.3) has something of the wheel's to blur. It belongs to the instrument (the calibrated plate the specimen sits on), not to the data: it carries no information, and it never competes with the tree.

| Part | Spec |
|---|---|
| Graticule | hairline spokes and rings (1 px, α 0.12), `--branch` grey mixed halfway to the local wash hue. Spokes are 96–192 px apart at their radius: going outward each gap gains a new spoke halfway, fading in over the octave, so the spokes fork outward like the tree. Rings are 96–192 px apart, counted from the rim, halving as you zoom in (the new ones fade in over the octave). Both are fixed to the world: they turn and scale with the wheel through spin, fling, tour flights and zoom |
| Wash | the rim's colour averaged over 320 px along the circle (neighbouring kingdoms blend softly), α 0.16 at the rim, decaying over 900 px. It gathers into soft **streamers**: hashed brightness per angular cell of about 64 px, subdividing outward like the spokes, like a corona. Streamers are broad enough to survive the card's 24 px blur, where hairlines vanish, so the glass shows drifting kingdom light as the wheel turns behind it. Deep in (λ 10 → 14) the wash eases to 30%, since the names' rows run along the streamers there; the graticule stays |
| Extent | nothing within 24 px of the rim, fading in over the next 160 px, so the rim, its fur and the clade spikes stand on black. Never inside the wheel |
| Layering | drawn after the tree with the saturating blend, so it only fills light the tree left: it stays behind every branch and the rim's glow. The tree dim and the HUD plates darken it like the tree |
| Motion | none of its own. It moves only with the wheel; under reduced motion and `?still` it simply follows the (still) wheel. It fades in at the end of the intro reveal |

One pass over the screen (`?passes=backdrop` draws it alone; leaving it out of the list hides it), shaded analytically per pixel (the blurred hue per vertex of a 64 px grid). It costs about 1 ms of GPU time at 2000×1030 on an integrated GPU; spinning stays at 60 fps. All numbers are the `BACKDROP_*` constants in `web/src/style.ts`.

## 6. Motion
| What | Duration | Easing |
|---|---|---|
| Intro radial reveal (once, only when landing on the default view (no `n`, no `v`); not for deep links, `?shot` or `?debug`) | 900 ms, starting once the coarse tiles are in, then labels/HUD fade 200 ms | `cubic-bezier(0.2, 0, 0, 1)` |
| Fly-to (van Wijk–Nuij along the rim, ρ 1.4): search, lineage, keys | 600–2000 ms ∝ path length | built-in smooth; skippable by any input |
| Turn to a clicked node (zoom kept) | 250–900 ms ∝ distance on screen | smoothstep; skippable by any input |
| Auto-orient | follows the zoom (no tween; always on) | – |
| Card (first show) / palette | 160–220 ms, opacity (palette + 8 px translate) | `cubic-bezier(0.2, 0, 0, 1)` |
| Label fade | 150 ms | linear |
| Chrome dim while dragging | 150 ms | linear |
| Ambient turn (idle) | 20 CSS px/s at the anchor at every zoom, clockwise (about one turn in 4 min at minimum zoom); stops on any input, eases back in 3 s after the last one (0.8 s after a flight, card hover or search ends) over 2 s | friction, τ 400 ms |
| Fling (release of a turning drag or a two-finger twist) | spins on at the release speed, decays into the ambient turn | friction, τ 400 ms |
| Idle tour | 15 s after a plain visit, then after 12 s on each selection, the next species from a curated list (shuffled, no repeats until all are seen), a ≥ 2.4 s turn at the same zoom; any input stops it, it resumes after 36 s without input; pointer movement in the last 3 s, a touch in the last 30 s, the pointer resting on the card, focus in the card, scrolling it, a text selection, search, a dialog, a flight or a hidden tab hold its countdown (a pointer resting on the wheel does not). It runs on phones too. While it runs the readout says "Touring · …"; there is no switch | fly-to path |
| Card on a long flight | a selection whose flight lasts over 600 ms switches the card, the leader and the breadcrumb at 60% of the flight (the wheel mostly there), its content fading in over 200 ms; the leader stays on, following the old selection until then | `cubic-bezier(0.2, 0, 0, 1)` |
| Wheel zoom | immediate, anchored at the anchor (not the cursor); in free view about the cursor | — |
| −, + and double-click zoom | 220 ms, about the anchor (free view: the screen centre; double-click the cursor) | ease-out cubic |
| Free view in / back | in: none (the picture stays); back: the fly-to path from the free camera to the locked one, the rotation eased the short way | as fly-to; skippable (stays free) |

**`prefers-reduced-motion` (or `?reduced`):** no intro, cuts plus a 120 ms crossfade instead of flights and turns (leaving free view too), no fling, no ambient turn and no idle tour (the selection stays manual; a plain visit still opens on *Homo sapiens*), zoom buttons cut, and toggling auto-orient cuts.

**`?still`** (implied by `?shot`): no ambient turn, no fling and no tour, so screenshots and tests are deterministic; `?tour=<seconds>` turns the tour on by itself with that dwell. A hidden tab pauses everything.

**Opening:** a plain visit always opens on *Homo sapiens* at minimum zoom (nothing is restored from storage), and the tour starts from it after 15 s. A deep link (`?n=`) opens on its node and the tour waits 36 s before moving on.

## 7. States and copy
**Loading**
- Shows the coarse tree first: level 0–3 tiles render as they arrive.
- A 1 px hairline progress bar at the top, with a truthful label in the readout: "Loading tree · 9 / 15 tiles" (" · slow connection" after 8 s). The search trigger and the readout show from the first frame; only the breadcrumb, the key, the zoom strip and the card wait for the intro.
- No spinners, no shimmer and no skeletons.

**Panel about-section loading:** a hairline progress line under the title and the text "Fetching from Wikipedia, GBIF…". Core data shows immediately.

**Missing data:**
- "No Wikipedia article. About the genus *X*:"
- "No occurrence records on GBIF."

**Errors:**
- Nothing could load (the API is down at start): one centred 15 px `--text-2` line, "Couldn’t load the tree. Reload".
- "Couldn’t reach Wikidata. Retry"
- "Tile failed to load. Retrying…", retried automatically 3× with backoff.

**No GPU drawing (no WebGL2):** a static fallback image of the wheel and the sentence "Your browser can’t draw the interactive tree (no WebGL2). Search still works.", with search and the card still functional (the card appears once a result is chosen).

**Polytomy:** "412 direct descendants · relationships unresolved". This wording is honest about synth fans.

**Credits dialog:** this is where the full source list lives (see data-sources.md). It also states: "No dates: branch lengths are not available, so the rings are not time."

## 8. Interaction checklist
- **Hover:** highlights the root→node path, dims the rest and shows a tooltip.
  - Tooltip content: the name in its correct style, then "species · 1" or "family · 3,214 species" in `--text-2`.
  - Tooltip style: glass (§2.3), dense fill, small blur, radius 10 px, 8 px offset.
- **Click or tap** selects the node: the card shows it, the URL gets `?n=ott…`, and the wheel turns so the node lands on the anchor, at the same zoom. There is no empty state; nothing deselects.
- **Left alone**, the wheel turns slowly and, after 15 s, the idle tour moves the selection to another species every 12 s (§6), saying so in the readout. Any input stops the tour for 36 s; a released drag flings the wheel.
- **Drag** turns the wheel about its centre (never pans). **Wheel**, **pinch** and the zoom strip zoom about the anchor; **two fingers twisting** turn the wheel.
- **In free view** (§4.1) drag pans, the wheel and a pinch zoom about the cursor, shift + drag and a twist turn about the pointer, and a click selects without moving the view.
- **Search, lineage, breadcrumb and kingdom key** select and fly: turn the node onto the anchor and zoom to suit it (leaving free view).
- **Keys:**
  - `/` or `⌘K` search
  - `Esc` closes the topmost layer (search, dialog); with none open, it leaves free view; it never clears the selection
  - on the zoom strip (a slider), `↑`/`↓`, `Page Up`/`Page Down`, `Home`/`End`; in the card's tabs, `←`/`→`, `Home`/`End`
  - nothing else: no single-letter shortcuts
- **Focus:** a visible 1 px `--focus` ring with 2 px offset on every interactive element. No `outline: none` without a replacement. Tab goes search, the card, then the breadcrumb, the key and the zoom strip.
- **Announcements** (the live region) say the selection in words: "Homo sapiens, species, 2 subspecies. You are here.", "Felidae, family, 91 species."
- **Deep links** restore the selection (`n`, default *Homo sapiens*) and the view (`v=a,z`: rotation and zoom). Free view writes the pan too (`v=a,r,z,rot`: the screen centre's angle and radius, the zoom, the rotation in degrees), and such a link opens in free view; so do old links from before the locked view.

## 9. Banned tells (ship-gate: all must be absent)
- [ ] gradients in the DOM (`linear-gradient`, `radial-gradient`, `conic-gradient`) and gradient text
- [ ] blur or glass beyond the one material of §2.3: `backdrop-filter` only as `var(--glass-filter…)`, no `filter: blur`, no frosted full-screen backdrops, no tinted or coloured glass
- [ ] glow, drop shadows or `text-shadow` on any UI or text (`box-shadow` only as `var(--glass-highlight)`)
- [ ] radius > 16 px; radii outside the §2.3 scale; drop shadows
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
4. **Optional:** `make lint-design` greps for banned CSS and font tokens (ARCHITECTURE §9.2): gradients, `text-shadow`, the banned faces, `filter: blur`, radii over 16 px, and any `backdrop-filter` or `box-shadow` other than the glass tokens.
