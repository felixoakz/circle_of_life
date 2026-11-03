// Radial branch segments, two lines per node:
//   line 0: the node's own segment, parent_r → r
//   line 1: the frontier extension, r → 1 (PLAN §3.5), shown while the node's
//           children are not drawn yet, so every lineage reaches the rim.
// With uHalfW = 0 they are native 1-device-px LINES (4 vertices per node).
// Once tips spread far enough to read as single lines, the plan sets uHalfW
// (half the width, device px) and draws them as TRIANGLES instead: each line
// a quad of 6 vertices widened in screen px, with an antialiased edge
// (line.frag), 12 vertices per node.
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
uniform float uHalfW;     // 0: hairlines; else half the line width, device px

out float vR;
out vec3 vHue;
out float vAlpha;
out float vExtT;
out float vHome;
out float vAcross; // px from the centre line (quads only)

void main() {
  bool wide = uHalfW > 0.0;
  // Which line, which end, which side of it.
  int line = wide ? gl_VertexID / 6 : gl_VertexID / 2;
  int corner = gl_VertexID % 6;
  // Two triangles: (0,−) (1,−) (0,+) / (0,+) (1,−) (1,+).
  int end = wide ? ((corner == 1 || corner == 4 || corner == 5) ? 1 : 0) : gl_VertexID % 2;
  float side = (corner == 2 || corner == 3 || corner == 5) ? 1.0 : -1.0;
  bool ext = line == 1;
  float r0 = ext ? aR : aParentR;
  float r1 = ext ? 1.0 : aR;
  uint angle = isHomeChildTip(aChildLevel, aParent) ? uHomeAngle : aAngle;
  float alpha = ext ? uFade * (1.0 - childFade(aChildLevel, uLambdaExt)) : uFade;
  // Clamping to the visible radii keeps far endpoints near the screen, so
  // the GPU's line clipping never works with huge coordinates.
  float ra = clamp(r0, uRWin.x, uRWin.y);
  float rb = clamp(r1, uRWin.x, uRWin.y);
  float r = end == 0 ? ra : rb;
  bool home = isHome(aFlags, aParent);
  vAcross = 0.0;
  if (r1 <= r0 || alpha <= 0.0) {
    gl_Position = OFF_SCREEN;
    alpha = 0.0;
  } else if (wide) {
    vec2 p0 = polarToClip(angle, ra).xy * uHalf;
    vec2 p1 = polarToClip(angle, rb).xy * uHalf;
    vec2 d = p1 - p0;
    float len = length(d);
    if (len < 1e-3) {
      gl_Position = OFF_SCREEN;
      alpha = 0.0;
    } else {
      vec2 nrm = vec2(-d.y, d.x) / len;
      float w = uHalfW + 1.0; // room for antialiasing
      vec2 p = (end == 0 ? p0 : p1) + nrm * side * w;
      vAcross = side * w;
      gl_Position = vec4(p / uHalf, 0.0, 1.0);
    }
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
