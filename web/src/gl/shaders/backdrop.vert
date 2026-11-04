// The backdrop (DESIGN.md §5.1): a grid of uCells quads covering the screen
// (about 64 px each). Each vertex works out the blurred kingdom hue under
// it; backdrop.frag draws the lines and streamers per pixel.

uniform float uCamRPx; // R·scale, device px
uniform vec4 uWash;    // alpha, decay px, blur px, tint
uniform vec2 uCells;   // columns, rows

out vec3 vHue;

const float TAU = 6.283185307179586;
const float TWO_32 = 4294967296.0;
const ivec2 CORNER[6] = ivec2[6](ivec2(0, 0), ivec2(1, 0), ivec2(0, 1), ivec2(1, 0), ivec2(1, 1), ivec2(0, 1));

// The kingdom colour averaged over [t − h, t + h] turns: each run's overlap
// with the window, at the colour of the overlap's middle (runs are linear
// ramps). Each run is taken at its copy nearest t (moved by a whole turn
// across 0), and the sum is divided by the width covered, so the window
// needs no splitting.
vec3 kingdomBlur(float t, float h) {
  vec3 acc = vec3(0.0);
  float covered = 0.0;
  for (int i = 0; i < MAX_RUNS; i++) {
    if (i >= uRunCount) break;
    float s = float(uRunStart[i]) / TWO_32;
    float e = i + 1 < uRunCount ? float(uRunStart[i + 1]) / TWO_32 : 1.0;
    float turn = floor(t - 0.5 * (s + e) + 0.5);
    float lo = max(t - h, s + turn);
    float hi = min(t + h, e + turn);
    if (hi > lo) {
      float mid = 0.5 * (lo + hi) - turn;
      acc += (hi - lo) * mix(uRunRgb0[i], uRunRgb1[i], (mid - s) / max(e - s, 1e-9));
      covered += hi - lo;
    }
  }
  return acc / max(covered, 1e-9);
}

void main() {
  int cols = int(uCells.x);
  int cell = gl_VertexID / 6;
  ivec2 c = ivec2(cell % cols, cell / cols) + CORNER[gl_VertexID % 6];
  vec2 clip = vec2(c) / uCells * 2.0 - 1.0;
  // As backdrop.frag: into the camera's local frame, device px.
  vec2 s = clip * uHalf;
  vec2 l = vec2(s.x * uRotCS.x + s.y * uRotCS.y, -s.x * uRotCS.y + s.y * uRotCS.x);
  float ax = uCamRPx + l.x;
  float rho = length(vec2(ax, l.y));
  float phi = atan(l.y, ax);
  float t = fract((float(uCamA) + uCamFrac) / TWO_32 + phi / TAU);
  vHue = kingdomBlur(t, min(0.25, 0.5 * uWash.z / (TAU * max(rho, 1.0))));
  gl_Position = vec4(clip, 0.0, 1.0);
}
