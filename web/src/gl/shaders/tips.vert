// Tip dots (DESIGN.md §5): a small filled dot where each tip's line meets
// the rim, one screen-aligned quad per node (TRIANGLE_STRIP, 4 vertices),
// sized in device px so it keeps its size at any zoom. Internal nodes are
// moved off screen. The quad is placed with polarToClipOffset, exact at max
// zoom. tips.frag draws the antialiased disc.
layout(location = 0) in uint aAngle;
layout(location = 5) in uint aChildLevel;
layout(location = 6) in uint aFlags;
layout(location = 7) in uint aParent;

uniform float uAlpha;  // tile fade × the frame's fade-in
uniform float uRadius; // device px
uniform float uLift;   // kingdom colour lifted this far toward white

out vec2 vOff; // px from the dot's centre
out vec3 vColour;
out float vAlpha;

void main() {
  vec2 c = vec2((gl_VertexID & 1) == 0 ? -1.0 : 1.0, (gl_VertexID & 2) == 0 ? -1.0 : 1.0);
  float ext = uRadius + 1.0; // room for antialiasing
  bool tip = aChildLevel == 255u;
  uint angle = aAngle;
  bool show = tip;
  if (isHomeChildTip(aChildLevel, aParent)) {
    // One dot for Homo sapiens' row, as with its bar (marks.vert).
    angle = uHomeAngle;
    show = aAngle <= uHomeAngle;
  }
  bool near = uRWin.x < 1.0 + ext / uScale && uRWin.y > 1.0 - ext / uScale;
  vOff = c * ext;
  vColour = isHome(aFlags, aParent) ? vec3(1.0) : mix(kingdomColour(angle), vec3(1.0), uLift);
  vAlpha = uAlpha;
  gl_Position = (show && near) ? polarToClipOffset(angle, 1.0, vOff) : OFF_SCREEN;
}
