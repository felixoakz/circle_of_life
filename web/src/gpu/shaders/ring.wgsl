// The selection ring (DESIGN.md §5): a 1 px antialiased circle of `radius`
// px round the selected node's point, drawn on a screen-aligned quad (a
// 4-vertex triangle-strip, one per ring). Opaque like path.wgsl. Port of
// ring.vert and ring.frag. No group 2: the node's angle and radius come in
// the per-draw uniforms.

@group(1) @binding(0) var<uniform> cmd: RingDraw;

struct RingOut {
  @builtin(position) pos: vec4f,
  @location(0) off: vec2f, // px from the centre
}

@vertex
fn vs_ring(@builtin(vertex_index) corner: u32) -> RingOut {
  let c = vec2f(select(-1.0, 1.0, (corner & 1u) != 0u), select(-1.0, 1.0, (corner & 2u) != 0u));
  let ext = cmd.radius + 2.0;
  var o: RingOut;
  o.off = c * ext;
  let centre = polarToClip(cmd.angle, cmd.r);
  o.pos = vec4f(centre.xy + o.off / frame.half, 0.0, 1.0);
  return o;
}

@fragment
fn fs_ring(v: RingOut) -> @location(0) vec4f {
  let d = abs(length(v.off) - cmd.radius);
  let cov = clamp(0.5 * cmd.linePx + 0.5 - d, 0.0, 1.0);
  return vec4f(cmd.colour.rgb * cmd.colour.a * cov, cov);
}
