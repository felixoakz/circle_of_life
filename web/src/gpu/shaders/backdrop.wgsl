// The backdrop (DESIGN.md §5.1): a polar graticule in the wheel's own frame
// over a soft wash of the kingdom hues, beyond the rim, shaded per pixel
// from the camera; the blurred hue per vertex of a coarse grid. Port of
// backdrop.vert and backdrop.frag, which explain the precision tricks.
//
// New WGSL idea: `<<` on a u32 shifts in zeros and drops the bits that fall
// off the top, so `camA << k` is camA·2^k mod 2^32, exactly: the phase of
// 2^k spokes, with no float in sight.

@group(1) @binding(0) var<uniform> cmd: BackdropDraw;

const TAU: f32 = 6.283185307179586;
const TWO_32: f32 = 4294967296.0;


// Coverage of a hairline `w` px wide at `dist` px from its centre.
fn hairline(dist: f32, w: f32) -> f32 {
  return clamp(0.5 * w + 0.5 - dist, 0.0, 1.0);
}

// Distance (px) to the nearest of 2^k spokes, at radius rho px.
fn spokeDist(k: i32, phi: f32, rho: f32) -> f32 {
  let n = exp2(f32(k));
  let u = f32(frame.camA << u32(k)) / TWO_32 + frame.camFrac * n / TWO_32 + phi * n / TAU;
  let f = fract(u);
  return min(f, 1.0 - f) * TAU * rho / n;
}

// The kingdom colour averaged over [t − h, t + h] turns, each run at its
// copy nearest t (backdrop.frag).
fn kingdomBlur(t: f32, h: f32) -> vec3f {
  var acc = vec3f(0.0);
  var covered = 0.0;
  for (var i = 0; i < MAX_RUNS; i++) {
    if (i >= palette.count) {
      break;
    }
    let s = f32(runStart(i)) / TWO_32;
    var e = 1.0;
    if (i + 1 < palette.count) {
      e = f32(runStart(i + 1)) / TWO_32;
    }
    let turn = floor(t - 0.5 * (s + e) + 0.5);
    let lo = max(t - h, s + turn);
    let hi = min(t + h, e + turn);
    if (hi > lo) {
      let mid = 0.5 * (lo + hi) - turn;
      acc += (hi - lo) * mix(palette.rgb0[i].xyz, palette.rgb1[i].xyz, (mid - s) / max(e - s, 1e-9));
      covered += hi - lo;
    }
  }
  return acc / max(covered, 1e-9);
}

struct BackdropOut {
  @builtin(position) pos: vec4f,
  @location(0) hue: vec3f,
}

// A grid of cmd.cells quads over the screen; each vertex works out the
// blurred kingdom hue under it (backdrop.vert).
@vertex
fn vs_backdrop(@builtin(vertex_index) vid: u32) -> BackdropOut {
  var CORNER = array<vec2u, 6>(vec2u(0u, 0u), vec2u(1u, 0u), vec2u(0u, 1u), vec2u(1u, 0u), vec2u(1u, 1u), vec2u(0u, 1u));
  let cols = u32(cmd.cells.x);
  let cell = vid / 6u;
  let c = vec2u(cell % cols, cell / cols) + CORNER[vid % 6u];
  let clip = vec2f(c) / cmd.cells * 2.0 - 1.0;
  let s = clip * frame.half;
  let rot = frame.rotCS;
  let l = vec2f(s.x * rot.x + s.y * rot.y, -s.x * rot.y + s.y * rot.x);
  let ax = cmd.camRPx + l.x;
  let rho = length(vec2f(ax, l.y));
  let phi = atan2(l.y, ax);
  let t = fract((f32(frame.camA) + frame.camFrac) / TWO_32 + phi / TAU);
  var o: BackdropOut;
  o.hue = kingdomBlur(t, min(0.25, 0.5 * cmd.wash.z / (TAU * max(rho, 1.0))));
  o.pos = vec4f(clip, 0.0, 1.0);
  return o;
}

// Brightness of the soft streamers at world angle `a` (u32 units): value
// noise over 2^k angular cells, hashed per cell (backdrop.frag).
fn streamer(a: u32, k: i32) -> f32 {
  let i = a >> u32(32 - k);
  // The position within the cell is the bits below it, moved to the top.
  let f = f32(a << u32(k)) / TWO_32;
  let mask = (1u << u32(k)) - 1u;
  let h0 = hash(i ^ (u32(k) << 27u));
  let h1 = hash(((i + 1u) & mask) ^ (u32(k) << 27u));
  let h = mix(h0, h1, ss(0.0, 1.0, f));
  return h * h;
}

@fragment
fn fs_backdrop(@builtin(position) fragPos: vec4f, @location(0) vHue: vec3f) -> @location(0) vec4f {
  // Framebuffer y runs down; the camera frame is y up.
  let s = vec2f(fragPos.x - frame.half.x, frame.half.y - fragPos.y);
  let rot = frame.rotCS;
  let l = vec2f(s.x * rot.x + s.y * rot.y, -s.x * rot.y + s.y * rot.x);
  let ax = cmd.camRPx + l.x;
  let rho = length(vec2f(ax, l.y));
  let d = (2.0 * cmd.camRPx * l.x + dot(l, l)) / max(rho + cmd.camRPx, 1e-6) + cmd.rimOff;
  let fade = cmd.strength * ss(cmd.fade.x, cmd.fade.x + cmd.fade.y, d);
  if (fade <= 0.0) {
    return vec4f(0.0);
  }
  let phi = atan2(l.y, ax);

  let lv = log2(TAU * rho / cmd.grid.z);
  let k = i32(clamp(floor(lv), 2.0, 30.0));
  let kf = clamp(lv - f32(k), 0.0, 1.0);
  let spokes = max(hairline(spokeDist(k, phi, rho), cmd.grid.y), kf * hairline(spokeDist(k + 1, phi, rho), cmd.grid.y));
  let v = d / cmd.grid.w;
  let v1 = 2.0 * v;
  let rings = max(
    hairline(abs(v - floor(v + 0.5)) * cmd.grid.w, cmd.grid.y),
    cmd.ringFade * hairline(abs(v1 - floor(v1 + 0.5)) * 0.5 * cmd.grid.w, cmd.grid.y),
  );

  let hue = vHue;
  let gridA = cmd.grid.x * max(spokes, rings);
  var washA = cmd.wash.x * exp(-max(d, 0.0) / cmd.wash.y);
  if (cmd.corona.x > 0.0) {
    // The pixel's world angle, u32 units (the offset is small next to a cell).
    let du = phi / RAD_PER_UNIT;
    var a = frame.camA + u32(du);
    if (du < 0.0) {
      a = frame.camA - u32(-du);
    }
    let lc = log2(TAU * rho / cmd.corona.y);
    let kc = i32(clamp(floor(lc), 2.0, 29.0));
    let kcf = clamp(lc - f32(kc), 0.0, 1.0);
    let st = mix(streamer(a, kc), streamer(a, kc + 1), kcf);
    washA *= mix(1.0, 2.2 * st, cmd.corona.x);
  }
  let c = mix(frame.branch, hue, cmd.wash.w) * gridA + hue * washA;
  let a = min(gridA + washA, 1.0);
  return vec4f(c, a) * fade;
}
