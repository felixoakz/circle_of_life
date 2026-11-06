// Rim marks (ARCHITECTURE §7.3 pass 4): one quad per node (TRIANGLE_STRIP, 4
// vertices), sized in device px around the node's point on the rim:
//   - a frontier clade gets a short outward spike (the overview "fur"),
//   - a tip gets a bright bar inward from the rim, one device px wide like
//     its hairline (the rim's glow once tips resolve),
//   - the home node gets a long outward leader bar past its label.
// Anything else is moved off screen. marks.frag gives the soft edges.
layout(location = 0) in uint aAngle;
layout(location = 1) in uint aArcLo;
layout(location = 2) in uint aArcHi;
layout(location = 4) in float aParentR;
layout(location = 5) in uint aChildLevel;
layout(location = 6) in uint aFlags;
layout(location = 7) in uint aParent;
layout(location = 8) in uint aLeafCount;

uniform float uFade;       // this tile's level fade-in
uniform float uLambdaExt;
uniform float uPx;         // device px per CSS px
uniform vec2 uSpike;       // alpha (× glow), max width px
uniform vec4 uTipBar;      // alpha (0: off), max length px, half width px
uniform vec2 uLeaderHalo;  // amount, decay px
uniform vec4 uLeader;      // alpha (0: off), gap px, length px, width px

out vec2 vQuad;    // x: px across from the centre line; y: 0 → 1 along the mark
out float vHalfW;  // half width of the solid part, px
out float vHaloPx; // halo decay, px (0: no halo)
out float vKind;   // 0 spike (fades outward), 1 tip bar (soft far end, crisp at the rim), 2 leader (soft both ends)
out vec3 vColour;
out float vAlpha;
out float vLenPx;  // the mark's length, px (the leader's rounded inner end)

void main() {
  int along = gl_VertexID & 1;
  float side = (gl_VertexID & 2) == 0 ? -1.0 : 1.0;
  bool tip = aChildLevel == 255u;
  bool home = isHome(aFlags, aParent);
  vec3 lut = kingdomColour(aAngle);

  float alpha = 0.0;
  float halfW = 0.5;
  float halo = 0.0;
  float r0 = 0.0; // radial offsets of the mark's two ends, px
  float r1 = 0.0;
  vKind = 1.0;
  vColour = home ? vec3(1.0) : lut;
  uint angle = aAngle;
  float pad = 0.0; // the leader's quad runs on past its inner end, for the halo
  if (tip && isHomeChildTip(aChildLevel, aParent)) {
    // One bar for Homo sapiens' row: the lower subspecies draws it at the
    // species' angle, the other draws nothing.
    angle = uHomeAngle;
    if (aAngle > uHomeAngle) alpha = -1.0;
  }
  if (tip && alpha < 0.0) {
    alpha = 0.0;
  } else if (tip) {
    // Inward bar over the hairline, as thin as it and without a halo, so
    // the branch reads as one line; never longer than the terminal branch.
    alpha = uFade * uTipBar.x;
    halfW = uTipBar.z;
    r0 = -min(uTipBar.y, (1.0 - aParentR) * uScale);
    r1 = 0.0;
  } else if ((aFlags & 8u) != 0u) {
    alpha = uFade * uLeader.x;
    halfW = 0.5 * uLeader.w;
    halo = uLeaderHalo.y;
    r0 = uLeader.y + uLeader.z;
    r1 = uLeader.y;
    vKind = 2.0;
    pad = 3.0 * halo + 1.0;
  } else {
    // Frontier clade: shown while its children are not (like its extension).
    alpha = uFade * (1.0 - childFade(aChildLevel, uLambdaExt)) * uSpike.x;
    float spanPx = float(aArcHi - aArcLo) * RAD_PER_UNIT * uScale;
    halfW = 0.5 * clamp(spanPx, uPx, uSpike.y);
    float len = clamp(3.0 + 2.0 * log2(float(max(aLeafCount, 1u))), 3.0, 14.0) * uPx;
    r0 = 0.0;
    r1 = len;
    vKind = 0.0;
    vColour = lut;
  }

  vHalfW = halfW;
  vHaloPx = halo;
  vAlpha = alpha;
  float w = halfW + 3.0 * halo + 1.0; // room for the halo and antialiasing
  float len = abs(r1 - r0);
  vLenPx = len;
  vQuad = vec2(side * w, along == 0 ? 0.0 : 1.0 + pad / max(len, 1.0));
  float rEnd = r1 + sign(r1 - r0) * pad;
  bool near = uRWin.x < 1.0 + (max(r0, rEnd) + w) / uScale && uRWin.y > 1.0 + (min(r0, rEnd) - w) / uScale;
  gl_Position = (alpha > 0.0 && near)
      ? polarToClipOffset(angle, 1.0, vec2(along == 0 ? r0 : rEnd, side * w))
      : OFF_SCREEN;
}
