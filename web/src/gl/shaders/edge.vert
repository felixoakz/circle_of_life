// Rim edge (DESIGN.md §5): a thin annulus just outside r = 1, cut into K
// steps over the visible part of the circle (6 vertices per step), as the
// rim ring (rim.vert). edge.frag draws a crisp line in it.
uniform int uK;
uniform vec2 uReach; // px inside, px outside the rim

out float vDelta; // px from the rim, + outward
out float vUnits; // absolute angle, u32 units

const int STEP[6] = int[6](0, 1, 0, 1, 1, 0);
const int OUTER[6] = int[6](0, 0, 1, 0, 1, 1);

void main() {
  int seg = gl_VertexID / 6;
  int corner = gl_VertexID % 6;
  uint a;
  bool visible = clampedPoint(0u, 0xffffffffu, seg, seg + STEP[corner], uK, a);
  vDelta = OUTER[corner] == 1 ? uReach.y : -uReach.x;
  vUnits = float(a);
  bool onScreen = uRWin.x <= 1.0 + uReach.y / uScale && uRWin.y >= 1.0 - uReach.x / uScale;
  gl_Position = (visible && onScreen) ? polarToClipOffset(a, 1.0, vec2(vDelta, 0.0)) : OFF_SCREEN;
}
