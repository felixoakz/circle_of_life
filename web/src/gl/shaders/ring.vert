// The selection ring (DESIGN.md §5): a hairline circle of uRadius px round
// the selected node's point, a screen-aligned quad around it.
uniform uint uA;
uniform float uR;
uniform float uRadius; // device px

out vec2 vOff; // px from the centre

void main() {
  int corner = gl_VertexID;
  vec2 c = vec2((corner & 1) == 0 ? -1.0 : 1.0, (corner & 2) == 0 ? -1.0 : 1.0);
  float ext = uRadius + 2.0;
  vOff = c * ext;
  vec4 centre = polarToClip(uA, uR);
  gl_Position = vec4(centre.xy + vOff / uHalf, 0.0, 1.0);
}
