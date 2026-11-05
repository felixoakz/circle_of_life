// The rim edge: a line of uWidth px from the rim outward, antialiased, in
// the kingdom colour lifted toward white, opaque over the glow ("over").
uniform float uAlpha;
uniform float uWidth; // device px
uniform float uLift;

in float vDelta;
in float vUnits;
out vec4 outColour;

void main() {
  float cov = clamp(0.5 + min(vDelta, uWidth - vDelta), 0.0, 1.0);
  float a = uAlpha * cov * revealMask(1.0);
  vec3 c = mix(kingdomColour(uint(min(vUnits, 4294967040.0))), vec3(1.0), uLift);
  outColour = vec4(c * a, a);
}
