## Circle of Life: visual/UX review (after P7)

**How I reviewed it.** I read DESIGN.md and PLAN.md §7 and §9, the 5 reference frames and the 6 screenshots. I also built the app, ran it on :3091 with a real GPU (ANGLE gl), and took 23 extra shots plus 5 crops. They are in `/home/felix/projects/species/screens/review/`. I checked suspected data and bracket problems against `/api/search` and `/api/nodes`. My server is stopped, and the Vite server on :5173 was not touched. I edited no project source files.

The bracket question has an answer. The **Mesopithecus bracket is correct data**. OTT's `Mesopithecus` (ott3607643, leafCount 2) contains exactly two tips: ott3607642 "Semnopithecus monspessulanus" (an old combination, filed under Mesopithecus in OTT) and *M. pentelicus*. But checking it exposed a **real extent bug** elsewhere (P1-1 below).

### P1: must fix

1. **Clade bars cut short for clades whose last or first child has an odd number of children** (crumb-fly.png). The "Pan" bar covers 4 tips and leaves out *P. t. verus* and *P. t. troglodytes*, but Pan (ott417957) has leafCount 6.
   - **Data:** Pan has arcLo 1780824357 and arcHi 1780829758. The arcHi is *Pan troglodytes*' midpoint, which is the same angle as its middle child, the tip *schweinfurthii*.
   - **Cause:** `labels.ts` `indexAngles()` keeps only the deepest node at each angle (the max-r tip, whose `hi == angle`). So `tipExtent()` stops at the tip and never reaches *P. troglodytes*' arcHi of 1780833358. Any species with 1, 3, 5… children sitting at an extent end hits this.
   - **Same cause, probably:** the missing Gorilla genus bar, and possibly the missing Homo bar.
   - **Fix:** merge per angle as `lo = min(old.lo, arcLo)` and `hi = max(old.hi, arcHi)` instead of keeping the max-r node. Better: emit `firstTip` in the tiles (tips are contiguous), so the extent is exactly `[firstTip, firstTip + leafCount − 1]` with no tile walk. Add a test using the Pan case.

2. **Italics are wrong for rank markers, strains and informal names.** The ship gate requires correct italics.
   - **Where:** deep-quercus ("Quercus petraea *subsp.* petraea" with subsp. in italic), deep-amanita ("var.", "Koide BX008"), deep-ecoli and deep-archaea ("Pantoea sp. NCCP-140", "E. coli KTE178", "(strain Shark)"). The breadcrumb has the same problem.
   - **Fix:** one shared formatter that returns runs: italic for the genus and lowercase epithets; roman for `subsp. var. f. sp. spp. cf. aff. nr.`, for anything after `sp.`, and for tokens with digits, capitals or parentheses. Use it in the label draw in `labels.ts`, in the hud crumbs, and later in the panel and search (P8/P9).

3. **Straight-edged brightness step about 140 px inside the rim.** Clearly visible in mid-l4.5-animals (see crop-l4.5-band-x3.png), mid-archaea, animals.png and the overview's lower interior.
   - **Cause:** the rim annulus ends at `RING_REACH_IN_PX = 140`, where the inner halo is still `0.4·e^(−140/55) ≈ 3%`. At mid zoom the `uK` chords are coarse, so the edge reads as a polygon.
   - **Fix:** in `rim.frag`, subtract the tail (`halo − halo(reach)`, clamped), or multiply by `smoothstep(reach, reach·0.7, −d)`. Also check the chord count when only part of the ring is visible.

4. **Kingdom labels disappear at overview on large and HiDPI screens** (hidpi-overview.png, 2560×1440 at DPR 2).
   - **What happens:** the whole wheel is visible but λ reaches level 4. The group labels (Animals, Fungi…) fade out and clade bars (Protostomia, Nucletmycea, Chloroplastida, SAR, Bacteria) take their place. One bar ("Nucletmycea") also reads upside down.
   - **Fix:** gate group labels versus clade bars on "whole wheel in view" or wheel radius in CSS px, not on λ. That covers `GROUP` fade and `CLADE_RIM_FADE` in `style.ts`.

5. **Archaea never gets its own colour, even deep inside Archaea** (deep-archaea, mid-archaea: Halobacterium renders in the Bacteria indigo).
   - **Cause:** the Archaea run is 0.087% of the circle, under 2 LUT texels. The blend window (`BLEND = ±0.4%` in `palette.ts`) is about 9× wider than the run, so Archaea is averaged away. The small Protist and Plant slivers in the meta runs are lost the same way.
   - **Fix:** clamp the blend to ≤ ¼ of the shorter neighbouring run, and blend over a few screen px rather than a fixed angle. Or drive colour from the per-node group plus position in the run (tiles already know the group) instead of a 2048-texel angle LUT.

6. **The boundary blend runs through other kingdoms' hues** (the reported teal seam: crop-seam-protists-plants.png, mid-l6.5-protists, key-fungi).
   - **Cause:** `mixOklch` takes the circular hue mean, which sits midway between the two hues. Violet 300° plus green 145° gives about 222° (Animals cyan), and cyan 205° plus yellow 95° gives about 150° (Plants green). So every seam shows a sliver of a third kingdom's colour, which is semantically wrong.
   - **Fix:** a short seam (1–3 px at any zoom, per item 5). Within it, interpolate in OKLab a/b and accept a brief chroma dip, or use a hard cut with a 1 px dark gap. The old "white streak" reason for the circular mean came from additive clipping, which the saturating blend has since fixed.

7. **The opaque black HUD plates read as redaction boxes** (animals and key-fungi wordmark; mammals breadcrumb and key; crumb-fly, where a branch line runs out of both ends of the breadcrumb plate like a strikethrough; deep-ecoli; deep-homo-1024).
   - **Cause:** the plate hugs the text with 6 px side padding and 0 px vertical padding, and cuts glowing content with hard edges.
   - **Fix:** keep the DOM flat, but have the renderer darken a soft-edged rect behind each HUD box. These are canvas-side uniforms, like the search dimming, using the obstacle rects `labels.ts` already has. Then drop `background` from `.wordmark`, `.breadcrumb`, `.readout` and `.kingdom-key` in `styles.css`. Failing that, use a deliberate plate with 8 px padding on all sides, aligned to the grid.

8. **A tip label collides with the breadcrumb** (deep-amanita: "Amanita muscaria 'ces robustus"). The breadcrumb is wider than the obstacle the label layout used, either stale or measured before the crumbs re-rendered.
   - **Fix:** re-read `getBoundingClientRect()` after `renderCrumbs()` and call `requestOverlay()`, or reserve the full possible breadcrumb width (its `max-width`) as the obstacle.

### P2: should fix

1. **Half-faded labels freeze on screen** (mid-l4.5-animals "Animals" and "Adephaga"; key-fungi ghost bar labels such as "Dothideomyceta"). Fading on λ (`CLADE_RIM_FADE` 4.2–4.8, group fade) leaves labels at partial alpha whenever the zoom rests in the band, which looks broken.
   - **Fix:** a hysteresis threshold in λ, plus the 150 ms time fade that labels already use.

2. **Bracket labels are rotated 90° at deep zoom** (Mesopithecus, Colobus, Pan, Quercus robur). They are hard to read in 11 px text-3 italic and unlike printed cladograms. When auto-oriented, set the bar label horizontally, centred beside the bracket.
   - **Nested clades:** the brackets compete for one lane (Gorilla versus Gorilla gorilla). Stack them outward in lanes.
   - **Edges:** brackets also run into the screen edge (mobile-deep-homo, where "Mesopithecus" sits about 4 px from the edge) and into the HUD band (Colobus in hidpi-deep-homo). Clip each bracket to the 16 px gutter.

3. **The home composition doesn't match 1.png** (deep-homo, hidpi-deep-homo).
   - **The label row has no bar:** the "Homo sapiens" label sits between two unlabeled white subspecies bars. Merge them into one white bar on the label row, or label the node at its bar.
   - **The leader bar is rough:** its left fade shows two visible steps (grey block, then white), and its halo is clipped to a rectangle with a hard right end. Use one smooth falloff, and pad the quad by the halo width.
   - **A grey box between the bars:** the halos of the two white bars overlap into a solid grey rectangle.

4. **Deep-zoom rhythm is sparser than 1.png.** At 48 px spacing, bars clamp at 18 px, which looks like piano keys rather than the packed glowing ladder. Options:
   - raise the bar clamp to about 0.55–0.6 of the spacing, or cap max zoom at about 32 px spacing;
   - let tip labels reach about 22 px.

   Also, a 1 px branch hairline shows through the middle of each bar (Quercus, E. coli). End the branch where the bar starts.

5. **Fans at max zoom turn into noisy hatching** (deep-amanita: horizontal yellow dither between the bars). Fade fans out once tips resolve, as the ring does at λ 11.5–13.

6. **Purple-family kingdoms can't be told apart.**
   - Protists (300°, L 0.72) and Archaea (305°, L 0.60) differ only in lightness. Bacteria (280°, L 0.62) and Archaea have nearly the same L. The 6 px key swatches look identical.
   - Under deuteranopia all three collapse to blue.
   - **Fix:** spread them, keeping the "purple family" feel. For example: Bacteria indigo 275° at L 0.60, Protists violet 305° at L 0.76, Archaea magenta-rose about 345° at L 0.66. Update DESIGN §2.2 first, then check with a CVD simulator.

7. **Mobile overview** (mobile-overview.png):
   - "Fungi" is clipped at the right edge, and "Animals" sits about 5 px from the left (no gutter).
   - Protists and Archaea labels are culled entirely.
   - The readout wraps to 2–3 lines, leaving "OpenTree 16.1" on its own line.
   - About 400 px of empty black sits above and below the wheel.
   - **Fix:** on narrow screens, fit the wheel to (width − 2×gutter − label room) and clamp group labels inside the gutter. Shorten the readout below 720 px to "2,385,875 species in view". Nudge the wheel up toward the visual centre above the HUD.

8. **The bottom band is crowded at overview** (overview, desktop-1280). The Archaea and Bacteria labels sit on the same baseline as the kingdom key, so they read as a second legend. Bias the wheel's fit upward by the HUD band height, or treat the HUD as a hard obstacle for group labels too.

9. **The ⟲ glyph is not in Hanken Grotesk** and falls back to a system font. Its stroke weight differs and it will vary by OS (possible tofu on some Android builds). The minus also reads optically short next to +. Use an inline SVG with a 1 px stroke, or CSS hairlines, for −, + and ⟲ in `hud.ts` `buildControls()`.

10. **Junk node names in the breadcrumb and labels:** "h2007-2 › h2007-1" (key-fungi) and "BD1-5". Filter OTT placeholder names at ingest or display, e.g. `/^h\d{4}-\d+$/`, "incertae sedis", "unclassified …".

11. **The readout copy says "level N"**, which is an internal LOD tile level and reads like debug output. Drop it from the public readout (it stays in `?debug`) and amend the DESIGN example. This also frees width on mobile.

### P3: nice to have

1. Group-label rules sit left of the text on both sides. On the left side, put the rule nearest the rim, or always nearest the rim.
2. "You are here" crosses the Mammalia bracket (mammals.png). Treat the bracket hairline as a hard obstacle for the leader, or break the bracket around it.
3. Overview centre: the empty, lumpy "keyhole" void (crop-overview-centre.png) is less crafted than 5.png's clean centre ring. Consider drawing the r0 circle as a faint hairline, or easing the tightest arcs.
4. Kingdom key order (Animals, Plants, Fungi…) doesn't match the clockwise order on screen (Animals, Fungi, Plants, Protists…). Ordering by position helps scanning.
5. The intro reveal at 500 ms already shows the whole wheel dimly, with no clear radial sweep (intro-500.png). Check that `uReveal` actually clips the fans and ring in non-shot mode.

### Things to anticipate for P8–P12

- Factor the name-styling runs from P1-2 now, because the panel, search rows and tooltips all need them.
- Move the HUD obstacle rects into one shared source that the panel can also register (the panel covers 380 px of the canvas).
- Brackets that clip at the gutter will matter once the panel takes the right side.
- The plate-darkening uniform from P1-7 can also serve the search-palette 50% dim.

### Already excellent (don't regress)

- The overview rim: crisp core, soft halo and the fine "fur". It reads as the video wheel. Saturating blend keeps dense areas in hue rather than white.
- The grey interior turning to kingdom colour near the rim, as in 4.png.
- The mid-zoom rim bands with clade bars hugging the arc (mammals, mid-l10-plants), which look like a printed plate.
- Deep-zoom typography: Source Serif italic at about 20 px, hue mixed toward text-1, right-aligned against the bars, *Homo sapiens* in white. Auto-orient composition works on mobile too.
- The HUD is minimal and none of the §9 banned tells appear: no gradients, blur, shadows, pills, emoji or AI copy.
  - The breadcrumb middle-truncation, italic genus segments and the clear current segment are good.
  - Tabular numbers and Intl separators are in place.
  - The focus ring shows correctly (focus-tab2.png).
  - The chrome dims to 40% while dragging.
- Truthful loading copy and the hairline progress line.
