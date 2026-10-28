// Highlighted paths and the selection ring: an opaque flat colour with an
// antialiased edge, drawn over the tree (ONE, ONE_MINUS_SRC_ALPHA). Alpha
// scales the brightness, not the opacity, so "text-1 at 60%" stays a
// solid grey that reads over bright tip bars, and overlapping steps do not
// add up.
precision highp float;

uniform vec4 uColour; // rgb, alpha
uniform float uHalfW;

in float vAcross;
out vec4 outColour;

void main() {
  float cov = clamp(uHalfW + 0.5 - abs(vAcross), 0.0, 1.0);
  outColour = vec4(uColour.rgb * uColour.a * cov, cov);
}
