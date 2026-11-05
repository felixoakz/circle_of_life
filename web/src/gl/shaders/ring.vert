// The selection marker (DESIGN.md §5): a ring of uRadius px round the
// selected node's point, a dot at its centre and a dark disc under both, on
// a screen-aligned quad around it.
uniform uint uA;
uniform float uR;
uniform float uRadius; // device px
uniform vec2 uKnock;   // px past the ring, opacity

out vec2 vOff; // px from the centre

void main() {
  int corner = gl_VertexID;
  vec2 c = vec2((corner & 1) == 0 ? -1.0 : 1.0, (corner & 2) == 0 ? -1.0 : 1.0);
  float ext = uRadius + uKnock.x + 2.0;
  vOff = c * ext;
  vec4 centre = polarToClip(uA, uR);
  gl_Position = vec4(centre.xy + vOff / uHalf, 0.0, 1.0);
}
