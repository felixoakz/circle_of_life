// Radial branch segments: 4 vertices per node (LINES).
//   0–1: the node's own segment, parent_r → r
//   2–3: the frontier extension, r → 1 (PLAN §3.5), shown while the node's
//        children are not drawn yet, so every lineage reaches the rim.
layout(location = 0) in uint aAngle;
layout(location = 3) in float aR;
layout(location = 4) in float aParentR;
layout(location = 5) in uint aChildLevel;
layout(location = 6) in uint aFlags;
layout(location = 7) in uint aParent;

uniform float uFade;      // this tile's level fade-in
uniform float uLambdaExt; // λ, capped at the last fully loaded level
uniform float uAlpha;     // branch alpha for this zoom
uniform float uHomeAlpha;
uniform float uTipCut;    // tips' branches stop this many device px inside the rim, where their bar starts (0: off)

out float vR;
out vec3 vHue;
out float vAlpha;
out float vExtT;
out float vHome;

void main() {
  bool ext = gl_VertexID >= 2;
  float r0 = ext ? aR : aParentR;
  float r1 = ext ? 1.0 : aR;
  // A tip's hairline ends where its bar begins, rather than running through it.
  if (!ext && aChildLevel == 255u && uTipCut > 0.0) r1 = max(r0, 1.0 - uTipCut / uScale);
  uint angle = isHomeChildTip(aChildLevel, aParent) ? uHomeAngle : aAngle;
  float alpha = ext ? uFade * (1.0 - childFade(aChildLevel, uLambdaExt)) : uFade;
  // Clamping to the visible radii keeps far endpoints near the screen, so
  // the GPU's line clipping never works with huge coordinates.
  float r = clamp((gl_VertexID % 2 == 0) ? r0 : r1, uRWin.x, uRWin.y);
  bool home = isHome(aFlags, aParent);
  if (r1 <= r0 || alpha <= 0.0) {
    gl_Position = OFF_SCREEN;
    alpha = 0.0;
  } else {
    gl_Position = polarToClip(angle, r);
  }
  vR = r;
  vHue = kingdomColour(angle);
  vAlpha = alpha * (home ? uHomeAlpha : uAlpha);
  // Linear in r, so interpolating it along the line stays exact.
  vExtT = ext ? clamp((r - aR) / max(1.0 - aR, 1e-6), 0.0, 1.0) : 1.0;
  vHome = home ? 1.0 : 0.0;
}
