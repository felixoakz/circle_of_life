// Branches and arcs (PLAN §7.3): 1-device-px hairlines drawn as a
// `line-list` (every 2 vertices make one line). Port of branches.vert,
// arcs.vert and line.frag. There are no vertex buffers: each instance is one
// node, read from the tile storage buffer (tile.wgsl) by `instance_index`,
// and `vertex_index` says which end of which line this vertex is.
//
// `cmd` (group 1) is this draw's slot in the per-draw uniform buffer,
// picked with a dynamic offset; `LinesDraw` is generated from
// gpu/uniforms.ts LINES_FIELDS.

@group(1) @binding(0) var<uniform> cmd: LinesDraw;

// What the vertex shader hands the fragment shader. `@builtin(position)` is
// the clip-space position; `@location(n)` values are interpolated along the
// line (WebGL's `out`/`in` varyings).
struct LineOut {
  @builtin(position) pos: vec4f,
  @location(0) r: f32,
  @location(1) hue: vec3f,
  @location(2) alpha: f32,
  // 0 at an extension's node, 1 at the rim; exactly 1 for ordinary lines.
  @location(3) extT: f32,
  @location(4) home: f32,
}

// Radial branch segments: 4 vertices per node.
//   0–1: the node's own segment, parent_r → r
//   2–3: the frontier extension, r → 1, shown while the node's children are
//        not drawn yet, so every lineage reaches the rim.
@vertex
fn vs_branches(@builtin(vertex_index) vid: u32, @builtin(instance_index) i: u32) -> LineOut {
  let nodeR = tileR(i);
  let childLevel = tileChildLevel(i);
  let parent = tileParent(i);
  let ext = vid >= 2u;
  var r0 = tileParentR(i);
  var r1 = nodeR;
  if (ext) {
    r0 = nodeR;
    r1 = 1.0;
  }
  // A tip's hairline ends where its bar begins, rather than running through it.
  if (!ext && childLevel == 255u && cmd.tipCut > 0.0) {
    r1 = max(r0, 1.0 - cmd.tipCut / frame.scale);
  }
  var angle = tileAngle(i);
  if (isHomeChildTip(childLevel, parent)) {
    angle = frame.homeAngle;
  }
  var alpha = cmd.fade;
  if (ext) {
    alpha = cmd.fade * (1.0 - childFade(childLevel, frame.lambdaExt));
  }
  // Clamping to the visible radii keeps far endpoints near the screen, so
  // line clipping never works with huge coordinates.
  var rEnd = r1;
  if (vid % 2u == 0u) {
    rEnd = r0;
  }
  let r = clamp(rEnd, frame.rWin.x, frame.rWin.y);
  let home = isHome(tileFlags(i), parent);

  var o: LineOut;
  if (r1 <= r0 || alpha <= 0.0) {
    o.pos = OFF_SCREEN;
    alpha = 0.0;
  } else {
    o.pos = polarToClip(angle, r);
  }
  o.r = r;
  o.hue = kingdomColour(angle);
  o.alpha = alpha * select(cmd.alpha, cmd.homeAlpha, home);
  // Linear in r, so interpolating it along the line stays exact.
  o.extT = 1.0;
  if (ext) {
    o.extT = clamp((r - nodeR) / max(1.0 - nodeR, 1e-6), 0.0, 1.0);
  }
  o.home = select(0.0, 1.0, home);
  return o;
}

// Arcs joining a node's children: 2K vertices per internal node, K chords
// along the arc at radius r, clamped to the visible window (clampedPoint).
@vertex
fn vs_arcs(@builtin(vertex_index) vid: u32, @builtin(instance_index) i: u32) -> LineOut {
  let lo = tileArcLo(i);
  let span = tileArcHi(i) - lo;
  let nodeR = tileR(i);
  let seg = i32(vid / 2u);
  let p = clampedPoint(lo, span, seg, seg + i32(vid % 2u), cmd.k);
  let alpha = cmd.fade * childFade(tileChildLevel(i), frame.lambdaExt);
  let home = (tileFlags(i) & 8u) != 0u;

  var o: LineOut;
  o.r = nodeR;
  o.hue = kingdomColour(p.a);
  o.alpha = alpha * select(cmd.alpha, cmd.homeAlpha, home);
  o.extT = 1.0;
  o.home = select(0.0, 1.0, home);
  if (!p.ok || span == 0u || nodeR < frame.rWin.x || nodeR > frame.rWin.y || alpha <= 0.0) {
    o.pos = OFF_SCREEN;
    o.alpha = 0.0;
  } else {
    o.pos = polarToClip(p.a, nodeR);
  }
  return o;
}

// Grey hairlines taking the kingdom colour towards the rim; extensions start
// faint at their node and build up towards the rim.
@fragment
fn fs_line(v: LineOut) -> @location(0) vec4f {
  var ext = 1.0;
  if (v.extT < 1.0) {
    ext = extRamp(v.extT, v.r);
  }
  let a = v.alpha * ext * rimBoost(v.r) * revealMask(v.r);
  let c = mix(tint(v.hue, v.r), vec3f(1.0), v.home);
  return vec4f(c * a, a);
}
