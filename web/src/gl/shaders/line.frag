// Branches and arcs (ARCHITECTURE §7.3): grey lines taking the kingdom colour
// towards the rim. Frontier extensions start faint at their node and build
// up towards the rim, where their unresolved lineages would be. Hairlines
// are native lines; wider lines are quads whose edge is antialiased here.

uniform float uHalfW;

in float vR;
in vec3 vHue;
in float vAlpha;
in float vExtT; // 0 at an extension's node, 1 at the rim; exactly 1 for ordinary lines
in float vHome;
in float vAcross;
out vec4 outColour;

void main() {
  float ext = vExtT < 1.0 ? extRamp(vExtT, vR) : 1.0;
  float cov = uHalfW > 0.0 ? clamp(uHalfW + 0.5 - abs(vAcross), 0.0, 1.0) : 1.0;
  float a = vAlpha * ext * rimBoost(vR) * revealMask(vR) * cov;
  vec3 c = mix(tint(vHue, vR), vec3(1.0), vHome);
  outColour = vec4(c * a, a);
}
