// Soft-edged rim marks: a crisp core (antialiased over one px) plus an
// exponential halo across the width, so each mark glows without any blur
// pass. Spikes fade outward; tip bars soften at their inner end only (the
// rim end stays crisp); the leader softens at both ends.

uniform vec2 uTipHalo; // amount, decay px

in vec2 vQuad;
in float vHalfW;
in float vHaloPx;
in float vKind;
in vec3 vColour;
in float vAlpha;
in float vLenPx;
out vec4 outColour;

// The home leader: one smooth fade-in from its outer end, and a crisp inner
// end whose halo rounds off past it (a capsule), not a clipped rectangle.
vec4 leader(float x) {
  float beyond = (vQuad.y - 1.0) * vLenPx; // px past the inner end (≤ 0 along the bar)
  float core = (1.0 - smoothstep(vHalfW - 0.5, vHalfW + 0.5, x)) * (1.0 - smoothstep(-0.5, 0.5, beyond));
  float dist = length(vec2(max(x - vHalfW, 0.0), max(beyond, 0.0)));
  float halo = uTipHalo.x * exp(-dist / max(vHaloPx, 1e-3));
  float fadeIn = smoothstep(0.0, 0.55, vQuad.y);
  float a = vAlpha * max(core, halo) * fadeIn * fadeIn * revealMask(1.0);
  return vec4(vColour * a, a);
}

void main() {
  float x = abs(vQuad.x);
  if (vKind > 1.5) {
    outColour = leader(x);
    return;
  }
  float core = 1.0 - smoothstep(vHalfW - 0.5, vHalfW + 0.5, x);
  float halo = vHaloPx > 0.0 ? uTipHalo.x * exp(-max(x - vHalfW, 0.0) / vHaloPx) : 0.0;
  float across = max(core, halo);
  float y = vQuad.y;
  float lengthwise = vKind < 0.5 ? exp(-3.0 * y)
      : vKind < 1.5 ? smoothstep(0.0, 0.15, y)
      : smoothstep(0.0, 0.3, y) * smoothstep(1.0, 0.97, y);
  float a = vAlpha * across * lengthwise * revealMask(1.0);
  outColour = vec4(vColour * a, a);
}
