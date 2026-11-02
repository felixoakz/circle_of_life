// Rim marks (PLAN §7.3 pass 4): one quad per node, sized in device px
// around the node's point on the rim. Port of marks.vert and marks.frag.
//   - a frontier clade gets a short outward spike (the overview "fur"),
//   - a tip gets a bright bar inward from the rim, one device px wide like
//     its hairline (the rim's glow once tips resolve),
//   - the home node gets a long outward leader bar past its label.
// Anything else is moved off screen. fs_marks gives the soft edges.
//
// New WebGPU idea here: the `triangle-strip` topology. 4 vertices make 2
// triangles (0-1-2, 1-2-3). With instancing, each instance is its own
// strip, so the quads of different nodes are never joined. Blending is
// plain additive (one, one): marks sit on their own terminal branch, which
// has used up most of the saturating blend's room.

@group(1) @binding(0) var<uniform> cmd: MarksDraw;

struct MarkOut {
  @builtin(position) pos: vec4f,
  @location(0) quad: vec2f,   // x: px across from the centre line; y: 0 → 1 along the mark
  @location(1) halfW: f32,    // half width of the solid part, px
  @location(2) haloPx: f32,   // halo decay, px (0: no halo)
  @location(3) kind: f32,     // 0 spike, 1 tip bar, 2 leader
  @location(4) colour: vec3f,
  @location(5) alpha: f32,
  @location(6) lenPx: f32,    // the mark's length, px (the leader's rounded inner end)
}

@vertex
fn vs_marks(@builtin(vertex_index) vid: u32, @builtin(instance_index) i: u32) -> MarkOut {
  let along = vid & 1u;
  var side = 1.0;
  if ((vid & 2u) == 0u) {
    side = -1.0;
  }
  let nodeAngle = tileAngle(i);
  let childLevel = tileChildLevel(i);
  let flags = tileFlags(i);
  let parent = tileParent(i);
  let tip = childLevel == 255u;
  let home = isHome(flags, parent);
  let lut = kingdomColour(nodeAngle);

  var o: MarkOut;
  var alpha = 0.0;
  var halfW = 0.5;
  var halo = 0.0;
  var r0 = 0.0; // radial offsets of the mark's two ends, px
  var r1 = 0.0;
  o.kind = 1.0;
  o.colour = select(lut, vec3f(1.0), home);
  var angle = nodeAngle;
  var pad = 0.0; // the leader's quad runs on past its inner end, for the halo
  if (tip && isHomeChildTip(childLevel, parent)) {
    // One bar for Homo sapiens' row: the lower subspecies draws it at the
    // species' angle, the other draws nothing.
    angle = frame.homeAngle;
    if (nodeAngle > frame.homeAngle) {
      alpha = -1.0;
    }
  }
  if (tip && alpha < 0.0) {
    alpha = 0.0;
  } else if (tip) {
    // Inward bar over the hairline, as thin as it and without a halo, so
    // the branch reads as one line; never longer than the terminal branch.
    alpha = cmd.fade * cmd.tipBar.x;
    r0 = -min(cmd.tipBar.y, (1.0 - tileParentR(i)) * frame.scale);
    r1 = 0.0;
  } else if ((flags & 8u) != 0u) {
    alpha = cmd.fade * cmd.leader.x;
    halfW = 0.5 * cmd.leader.w;
    halo = cmd.leaderHalo.y;
    r0 = cmd.leader.y + cmd.leader.z;
    r1 = cmd.leader.y;
    o.kind = 2.0;
    pad = 3.0 * halo + 1.0;
  } else {
    // Frontier clade: shown while its children are not (like its extension).
    alpha = cmd.fade * (1.0 - childFade(childLevel, frame.lambdaExt)) * cmd.spike.x;
    let spanPx = f32(tileArcHi(i) - tileArcLo(i)) * RAD_PER_UNIT * frame.scale;
    halfW = 0.5 * clamp(spanPx, cmd.px, cmd.spike.y);
    let len = clamp(3.0 + 2.0 * log2(f32(max(tileLeafCount(i), 1u))), 3.0, 14.0) * cmd.px;
    r0 = 0.0;
    r1 = len;
    o.kind = 0.0;
    o.colour = lut;
  }

  o.halfW = halfW;
  o.haloPx = halo;
  o.alpha = alpha;
  let w = halfW + 3.0 * halo + 1.0; // room for the halo and antialiasing
  let len = abs(r1 - r0);
  o.lenPx = len;
  var y = 0.0;
  if (along == 1u) {
    y = 1.0 + pad / max(len, 1.0);
  }
  o.quad = vec2f(side * w, y);
  let rEnd = r1 + sign(r1 - r0) * pad;
  let near = frame.rWin.x < 1.0 + (max(r0, rEnd) + w) / frame.scale && frame.rWin.y > 1.0 + (min(r0, rEnd) - w) / frame.scale;
  if (alpha > 0.0 && near) {
    o.pos = polarToClipOffset(angle, 1.0, vec2f(select(r0, rEnd, along == 1u), side * w));
  } else {
    o.pos = OFF_SCREEN;
  }
  return o;
}

// The home leader: one smooth fade-in from its outer end, and a crisp inner
// end whose halo rounds off past it (a capsule), not a clipped rectangle.
fn leader(v: MarkOut, x: f32) -> vec4f {
  let beyond = (v.quad.y - 1.0) * v.lenPx; // px past the inner end (≤ 0 along the bar)
  let core = (1.0 - ss(v.halfW - 0.5, v.halfW + 0.5, x)) * (1.0 - ss(-0.5, 0.5, beyond));
  let dist = length(vec2f(max(x - v.halfW, 0.0), max(beyond, 0.0)));
  let halo = cmd.leaderHalo.x * exp(-dist / max(v.haloPx, 1e-3));
  let fadeIn = ss(0.0, 0.55, v.quad.y);
  let a = v.alpha * max(core, halo) * fadeIn * fadeIn * revealMask(1.0);
  return vec4f(v.colour * a, a);
}

// Soft-edged marks: a crisp core, antialiased over one px. Spikes fade
// outward; tip bars soften at their inner end only; the leader (above)
// adds a halo.
@fragment
fn fs_marks(v: MarkOut) -> @location(0) vec4f {
  let x = abs(v.quad.x);
  if (v.kind > 1.5) {
    return leader(v, x);
  }
  let core = 1.0 - ss(v.halfW - 0.5, v.halfW + 0.5, x);
  let y = v.quad.y;
  var lengthwise = ss(0.0, 0.15, y);
  if (v.kind < 0.5) {
    lengthwise = exp(-3.0 * y);
  }
  let a = v.alpha * core * lengthwise * revealMask(1.0);
  return vec4f(v.colour * a, a);
}
