// Darkened plates (the HUD, the whole tree behind a hover): one quad per
// rectangle, grown by the soft edge, multiplying what is drawn by
// 1 − amount and easing to nothing over the edge. Blend (zero, one − src
// alpha): the source colour is ignored, only its alpha darkens. Port of
// dim.vert and dim.frag.
//
// New WGSL idea: in a fragment shader `@builtin(position)` is the pixel's
// framebuffer position, x right and **y down**, pixel centres at .5. GLSL's
// gl_FragCoord is y up, so dim.frag flipped it (viewport.y − y) to compare
// with the y-down rectangle; here no flip is needed.

@group(1) @binding(0) var<uniform> cmd: DimDraw;

@vertex
fn vs_dim(@builtin(vertex_index) vid: u32) -> @builtin(position) vec4f {
  var CORNER = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));
  let c = CORNER[vid];
  let lo = cmd.rect.xy - cmd.soft;
  let hi = cmd.rect.zw + cmd.soft;
  let p = mix(lo, hi, c);
  // Device px (y down) → clip space (y up).
  return vec4f(p.x / cmd.viewport.x * 2.0 - 1.0, 1.0 - p.y / cmd.viewport.y * 2.0, 0.0, 1.0);
}

@fragment
fn fs_dim(@builtin(position) fragPos: vec4f) -> @location(0) vec4f {
  let p = fragPos.xy;
  let d = max(max(cmd.rect.xy - p, p - cmd.rect.zw), vec2f(0.0));
  let a = cmd.amount * (1.0 - ss(0.0, max(cmd.soft, 1e-3), length(d)));
  return vec4f(0.0, 0.0, 0.0, a);
}
