// Branches and arcs (PLAN §7.3). With `cmd.halfW` = 0 they are
// 1-device-px hairlines drawn as a `line-list` (every 2 vertices make one
// line); wider than a device px (deep zoom, style.ts LINE_WIDTH_SPACING)
// the same entry points run in a `triangle-list` pipeline (gpu/pipelines.ts
// `wide`): every 6 vertices make one quad, widened in screen px, its edge
// antialiased in fs_line. Port of branches.vert, arcs.vert and line.frag.
// There are no vertex buffers: each instance is one node, read from the tile
// storage buffer (tile.wgsl) by `instance_index`, and `vertex_index` says
// which end (and side) of which line this vertex is.
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
  // px from the centre line (quads only).
  @location(5) across: f32,
}

// Which line (or chord), which end and which side a vertex is: 2 vertices
// per line as hairlines, 6 per quad as two triangles (0,−) (1,−) (0,+) /
// (0,+) (1,−) (1,+).
struct Corner {
  line: u32,
  end: u32,
  side: f32,
}

fn corner(vid: u32) -> Corner {
  if (cmd.halfW <= 0.0) {
    return Corner(vid / 2u, vid % 2u, 0.0);
  }
  let c = vid % 6u;
  var end = 0u;
  if (c == 1u || c == 4u || c == 5u) {
    end = 1u;
  }
  var side = -1.0;
  if (c == 2u || c == 3u || c == 5u) {
    side = 1.0;
  }
  return Corner(vid / 6u, end, side);
}

// A quad's corner: `p` at the end, pushed `side` across by the half width
// plus a px of antialiasing (device px from the screen centre → clip space).
fn quadCorner(p: vec2f, dir: vec2f, side: f32) -> vec4f {
  let nrm = vec2f(-dir.y, dir.x);
  let q = p + nrm * side * (cmd.halfW + 1.0);
  return vec4f(q / frame.half, 0.0, 1.0);
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
  let cn = corner(vid);
  let ext = cn.line == 1u;
  var r0 = tileParentR(i);
  var r1 = nodeR;
  if (ext) {
    r0 = nodeR;
    r1 = 1.0;
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
  let ra = clamp(r0, frame.rWin.x, frame.rWin.y);
  let rb = clamp(r1, frame.rWin.x, frame.rWin.y);
  let r = select(ra, rb, cn.end == 1u);
  let home = isHome(tileFlags(i), parent);

  var o: LineOut;
  o.across = 0.0;
  if (r1 <= r0 || alpha <= 0.0) {
    o.pos = OFF_SCREEN;
    alpha = 0.0;
  } else if (cmd.halfW > 0.0) {
    let p0 = polarToClip(angle, ra).xy * frame.half;
    let p1 = polarToClip(angle, rb).xy * frame.half;
    let d = p1 - p0;
    let len = length(d);
    if (len < 1e-3) {
      o.pos = OFF_SCREEN;
      alpha = 0.0;
    } else {
      o.pos = quadCorner(select(p0, p1, cn.end == 1u), d / len, cn.side);
      o.across = cn.side * (cmd.halfW + 1.0);
    }
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
  let cn = corner(vid);
  let seg = i32(cn.line);
  let p = clampedPoint(lo, span, seg, seg + i32(cn.end), cmd.k);
  let alpha = cmd.fade * childFade(tileChildLevel(i), frame.lambdaExt);
  let home = (tileFlags(i) & 8u) != 0u;

  var o: LineOut;
  o.r = nodeR;
  o.hue = kingdomColour(p.a);
  o.alpha = alpha * select(cmd.alpha, cmd.homeAlpha, home);
  o.extT = 1.0;
  o.home = select(0.0, 1.0, home);
  o.across = 0.0;
  if (!p.ok || span == 0u || nodeR < frame.rWin.x || nodeR > frame.rWin.y || alpha <= 0.0) {
    o.pos = OFF_SCREEN;
    o.alpha = 0.0;
    return o;
  }
  if (cmd.halfW <= 0.0) {
    o.pos = polarToClip(p.a, nodeR);
    return o;
  }
  let q0 = clampedPoint(lo, span, seg, seg, cmd.k);
  let q1 = clampedPoint(lo, span, seg, seg + 1, cmd.k);
  let p0 = polarToClip(q0.a, nodeR).xy * frame.half;
  let p1 = polarToClip(q1.a, nodeR).xy * frame.half;
  let d = p1 - p0;
  let len = length(d);
  if (!q0.ok || !q1.ok || len < 1e-3) {
    o.pos = OFF_SCREEN;
    o.alpha = 0.0;
    return o;
  }
  let dir = d / len;
  var q = select(p0, p1, cn.end == 1u);
  // The arc's own ends (not the joints between its chords) run on by half a
  // width, so its corners with the children's branches close.
  if (cn.end == 0u && seg == 0) {
    q -= dir * cmd.halfW;
  }
  if (cn.end == 1u && seg == cmd.k - 1) {
    q += dir * cmd.halfW;
  }
  o.pos = quadCorner(q, dir, cn.side);
  o.across = cn.side * (cmd.halfW + 1.0);
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
  var cov = 1.0;
  if (cmd.halfW > 0.0) {
    cov = clamp(cmd.halfW + 0.5 - abs(v.across), 0.0, 1.0);
  }
  let a = v.alpha * ext * rimBoost(v.r) * revealMask(v.r) * cov;
  let c = mix(tint(v.hue, v.r), vec3f(1.0), v.home);
  return vec4f(c * a, a);
}
