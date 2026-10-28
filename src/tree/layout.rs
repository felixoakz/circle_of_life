//! The radial layout: where every node sits on the wheel (PLAN §3.2 steps
//! 3–6, §3.3, §3.4), plus its group and LOD level.
//!
//! [`compute`] takes the parsed [`Tree`] and returns a [`Layout`]. The steps:
//!
//! 1. Leaf counts and heights, by walking the arena backwards (step 3).
//! 2. Groups, in `groups.rs` (step 4).
//! 3. Ladderize and renumber (steps 5–6): one explicit-stack depth-first walk
//!    that visits each node's children smallest clade first and hands out
//!    new ids in visit order. These **final ids** are a pre-order of the
//!    ladderized tree, so a clade is the id range `id .. id + subtree size`.
//! 4. Angles (§3.3): tips evenly spaced in visit order, each internal node in
//!    the middle of its children.
//! 5. Radius (§3.4) and LOD levels (§3.6, `lod.rs`).
//!
//! ## What P3 (the tile writer) consumes
//! Every `Vec` in [`Layout`] is indexed by the final id. The tree itself is
//! not reordered: `layout.node[id]` is the node's index in the original
//! [`Tree`] arena (and in `Taxonomy::taxa`), which is where its label, name
//! and rank live. So, for final id `id`:
//! - geometry: `angle[id]`, `arc_lo[id]`, `arc_hi[id]`, `r[id]`, and
//!   `r[parent[id]]` for `parent_r`
//! - LOD: `level[id]` and `sector_of(angle[id], level[id])` pick the tile
//! - names: `tree.label[node[id]]`, `taxonomy.taxa[node[id]]`
//!
//! Concepts introduced here:
//! - sorting with a comparison function (`sort_by`, `Ordering::then_with`)
//! - a stack of tuples for a depth-first walk without recursion
//! - `u64` intermediate math for `u32` fixed-point values

use anyhow::ensure;

use super::{NO_PARENT, Tree, groups, lod};

/// Radius of the root; the rim (every tip) is at 1.0.
pub const R0: f64 = 0.08;

/// A contiguous run of tips (in angle order) in the same group (§3.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupRun {
    pub group: u8,
    /// Angle of the first tip in the run.
    pub angle_lo: u32,
    /// Angle of the last tip in the run (inclusive).
    pub angle_hi: u32,
    /// Number of tips in the run.
    pub tips: u32,
}

/// The finished layout. Every `Vec` is indexed by the final pre-order id
/// (see the module docs); id 0 is the root.
#[derive(Debug)]
pub struct Layout {
    /// Final id → index in the original `Tree` arena.
    pub node: Vec<u32>,
    /// Final id of the parent, or [`NO_PARENT`] for the root.
    pub parent: Vec<u32>,
    /// Edges from the root (root = 0).
    pub depth: Vec<u32>,
    /// Longest path down to a tip (tip = 0, so `height == 0` means "tip").
    pub height: Vec<u32>,
    /// Tips in the clade (a tip counts itself).
    pub leaf_count: Vec<u32>,
    /// Rank (0-based, in angle order) of the clade's first tip. A clade's
    /// tips are contiguous, so they are ranks `first_tip .. first_tip +
    /// leaf_count`; for a tip it is its own rank.
    pub first_tip: Vec<u32>,
    /// u32 fixed point: `angle / 2^32` of a full turn.
    pub angle: Vec<u32>,
    /// Angle of the first child (== `angle` for a tip).
    pub arc_lo: Vec<u32>,
    /// Angle of the last child (== `angle` for a tip).
    pub arc_hi: Vec<u32>,
    /// Radius: [`R0`] at the root, exactly 1.0 at every tip.
    pub r: Vec<f32>,
    /// 0..=5, or [`groups::MIXED`].
    pub group: Vec<u8>,
    /// LOD level at which the node appears.
    pub level: Vec<u8>,
    /// Lowest level among the children; [`lod::NO_CHILD_LEVEL`] for a tip.
    pub child_level: Vec<u8>,
    /// Number of tips (`N`).
    pub tip_count: u32,
    /// `Lmax`, the level of every tip.
    pub max_level: u8,
    /// Tip runs by group, in angle order.
    pub group_runs: Vec<GroupRun>,
}

impl Layout {
    /// Number of nodes.
    pub fn len(&self) -> usize {
        self.node.len()
    }

    /// True when there are no nodes (never, for a parsed tree).
    pub fn is_empty(&self) -> bool {
        self.node.is_empty()
    }

    /// True for a tip.
    pub fn is_tip(&self, id: usize) -> bool {
        self.height[id] == 0
    }
}

/// Lays out `tree`. Needs node 0 to be the root and every parent index to be
/// smaller than its children's, as the Newick parser produces.
pub fn compute(tree: &Tree) -> anyhow::Result<Layout> {
    ensure!(!tree.is_empty(), "cannot lay out an empty tree");
    for node in 0..tree.len() {
        let parent = tree.parent[node];
        ensure!(
            (node == 0) == (parent == NO_PARENT) && (parent == NO_PARENT || parent < node as u32),
            "node {node}: the root must be node 0 and parents must come before children"
        );
    }

    // Steps 1–2 work in arena order…
    let (arena_leaf_count, arena_height) = leaf_counts_and_heights(tree);
    let arena_group = groups::assign(tree)?;

    // …step 3 gives the final order, and the per-node values follow along.
    let (node, parent, depth) = ladderized_preorder(tree, &arena_leaf_count);
    let n = node.len();
    let mut leaf_count = Vec::with_capacity(n);
    let mut height = Vec::with_capacity(n);
    let mut group = Vec::with_capacity(n);
    for &v in &node {
        leaf_count.push(arena_leaf_count[v as usize]);
        height.push(arena_height[v as usize]);
        group.push(arena_group[v as usize]);
    }
    // The arena-order copies are no longer needed; free them before the
    // remaining Vecs are allocated, to keep the peak lower.
    drop(arena_leaf_count);
    drop(arena_height);
    drop(arena_group);

    let tip_count = leaf_count[0];
    let (angle, arc_lo, arc_hi) = angles(&parent, &height, tip_count);
    let first_tip = first_tips(&height);
    let r = radii(&depth, &height);

    let mut level = Vec::with_capacity(n);
    for &count in &leaf_count {
        level.push(lod::intro_level(count, tip_count));
    }
    let child_level = child_levels(&parent, &level);
    let group_runs = group_runs(&angle, &height, &group);

    Ok(Layout {
        node,
        parent,
        depth,
        height,
        leaf_count,
        first_tip,
        angle,
        arc_lo,
        arc_hi,
        r,
        group,
        level,
        child_level,
        tip_count,
        max_level: lod::max_level(tip_count),
        group_runs,
    })
}

/// Leaf count and height of every node, in arena order (§3.2 step 3).
fn leaf_counts_and_heights(tree: &Tree) -> (Vec<u32>, Vec<u32>) {
    let n = tree.len();
    let mut leaf_count = vec![0u32; n];
    let mut height = vec![0u32; n];
    // Children have larger indices than their parent, so walking backwards
    // finishes every child before its parent: a post-order without recursion.
    for node in (0..n).rev() {
        if tree.children[node].is_empty() {
            leaf_count[node] = 1;
        }
        let parent = tree.parent[node];
        if parent != NO_PARENT {
            let parent = parent as usize;
            leaf_count[parent] += leaf_count[node];
            height[parent] = height[parent].max(height[node] + 1);
        }
    }
    (leaf_count, height)
}

/// Ladderizes and renumbers (§3.2 steps 5–6). Returns, by final id: the
/// arena index, the parent's final id, and the depth.
fn ladderized_preorder(tree: &Tree, leaf_count: &[u32]) -> (Vec<u32>, Vec<u32>, Vec<u32>) {
    let n = tree.len();
    let mut node = Vec::with_capacity(n);
    let mut parent: Vec<u32> = Vec::with_capacity(n);
    let mut depth: Vec<u32> = Vec::with_capacity(n);

    // LEARN: the stack holds tuples `(arena index, parent's final id)`. A
    // tuple groups a few values without declaring a struct, and the pattern
    // in `while let Some((v, parent_id))` takes it apart again.
    let mut stack: Vec<(u32, u32)> = vec![(0, NO_PARENT)];
    // Reused for every node, so sorting allocates nothing after warm-up.
    let mut sorted: Vec<u32> = Vec::new();

    while let Some((v, parent_id)) = stack.pop() {
        let id = node.len() as u32;
        node.push(v);
        parent.push(parent_id);
        if parent_id == NO_PARENT {
            depth.push(0);
        } else {
            depth.push(depth[parent_id as usize] + 1);
        }

        // Ladderize: smallest clade first; ties broken by label (OTT ids
        // ascending, then `mrca…` text), so the order is deterministic.
        sorted.clear();
        sorted.extend_from_slice(&tree.children[v as usize]);
        // LEARN: `sort_by` takes a function that compares two items and
        // returns an `Ordering` (Less, Equal or Greater). `a.cmp(&b)` gives
        // one; `.then_with(…)` is only consulted when the first is `Equal`.
        sorted.sort_by(|&a, &b| {
            let (a, b) = (a as usize, b as usize);
            leaf_count[a]
                .cmp(&leaf_count[b])
                .then_with(|| tree.label[a].cmp(&tree.label[b]))
        });
        // A stack pops the last item first, so push the children in reverse
        // to visit them in sorted order.
        for &child in sorted.iter().rev() {
            stack.push((child, id));
        }
    }
    (node, parent, depth)
}

/// The angle of the tip with rank `rank` (0-based, in visit order) out of
/// `tip_count`: the middle of its slot, `(2·rank + 1) · 2^31 / N`.
pub fn tip_angle(rank: u32, tip_count: u32) -> u32 {
    // In u64 the product cannot overflow, and the result is below 2^32
    // because `2·rank + 1 < 2·N`.
    let numerator = (2 * rank as u64 + 1) << 31;
    (numerator / tip_count as u64) as u32
}

/// Angles and arcs by final id (§3.3). Returns `(angle, arc_lo, arc_hi)`.
fn angles(parent: &[u32], height: &[u32], tip_count: u32) -> (Vec<u32>, Vec<u32>, Vec<u32>) {
    let n = parent.len();
    let mut angle = vec![0u32; n];
    // Start each arc "empty" so the first child sets both ends.
    let mut arc_lo = vec![u32::MAX; n];
    let mut arc_hi = vec![0u32; n];

    // Tips, in id order, are the tips in visit order: number them 0..N.
    let mut rank = 0;
    for id in 0..n {
        if height[id] == 0 {
            angle[id] = tip_angle(rank, tip_count);
            rank += 1;
        }
    }

    // Children have larger ids than their parent, so walking backwards
    // finishes each node's angle before it widens its parent's arc.
    for id in (0..n).rev() {
        if height[id] == 0 {
            arc_lo[id] = angle[id];
            arc_hi[id] = angle[id];
        } else {
            // `lo + (hi - lo) / 2` rather than `(lo + hi) / 2`, which could
            // overflow u32.
            angle[id] = arc_lo[id] + (arc_hi[id] - arc_lo[id]) / 2;
        }
        let p = parent[id];
        if p != NO_PARENT {
            let p = p as usize;
            arc_lo[p] = arc_lo[p].min(angle[id]);
            arc_hi[p] = arc_hi[p].max(angle[id]);
        }
    }
    (angle, arc_lo, arc_hi)
}

/// Rank of each clade's first tip. Ids are a pre-order, so a clade is the id
/// range starting at its own id, and its first tip is the first tip at or
/// after that id: the number of tips with a smaller id.
fn first_tips(height: &[u32]) -> Vec<u32> {
    let mut first_tip = Vec::with_capacity(height.len());
    let mut tips_before = 0;
    for &h in height {
        first_tip.push(tips_before);
        if h == 0 {
            tips_before += 1;
        }
    }
    first_tip
}

/// `r = r0 + (1 − r0) · d / (d + h)` (§3.4), with tips pinned to exactly 1.0.
fn radii(depth: &[u32], height: &[u32]) -> Vec<f32> {
    let mut r = Vec::with_capacity(depth.len());
    for id in 0..depth.len() {
        if height[id] == 0 {
            // d / (d + 0) is 1 anyway; writing 1.0 avoids any rounding doubt
            // and covers a one-node tree (0 / 0).
            r.push(1.0);
        } else {
            let d = depth[id] as f64;
            let h = height[id] as f64;
            r.push((R0 + (1.0 - R0) * d / (d + h)) as f32);
        }
    }
    r
}

/// The lowest `level` among each node's children (§3.6).
fn child_levels(parent: &[u32], level: &[u8]) -> Vec<u8> {
    let mut child_level = vec![lod::NO_CHILD_LEVEL; parent.len()];
    for id in 1..parent.len() {
        let p = parent[id] as usize;
        child_level[p] = child_level[p].min(level[id]);
    }
    child_level
}

/// Contiguous runs of tips with the same group, in angle order (§3.3).
fn group_runs(angle: &[u32], height: &[u32], group: &[u8]) -> Vec<GroupRun> {
    let mut runs: Vec<GroupRun> = Vec::new();
    for id in 0..angle.len() {
        if height[id] != 0 {
            continue;
        }
        // LEARN: `last_mut()` borrows the last element mutably (if any), so
        // we can extend the current run in place.
        match runs.last_mut() {
            Some(run) if run.group == group[id] => {
                run.angle_hi = angle[id];
                run.tips += 1;
            }
            _ => runs.push(GroupRun {
                group: group[id],
                angle_lo: angle[id],
                angle_hi: angle[id],
                tips: 1,
            }),
        }
    }
    runs
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tree::{Label, newick};

    /// A tiny linear congruential generator: deterministic "random" numbers
    /// without a crate. Constants from Knuth's MMIX.
    struct Lcg(u64);

    impl Lcg {
        fn below(&mut self, bound: usize) -> usize {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            // The high bits of an LCG are the most random ones.
            ((self.0 >> 33) % bound as u64) as usize
        }
    }

    fn add(tree: &mut Tree, parent: u32, ott: u32) -> u32 {
        let node = tree.add_node(parent);
        tree.label[node as usize] = Label::Ott(ott);
        node
    }

    /// A random tree of `size` nodes that contains every group root, so the
    /// groups step works. Parents always come before children, as in a
    /// parsed tree, but children of one node are not contiguous.
    fn random_tree(size: usize, seed: u64) -> Tree {
        let mut rng = Lcg(seed);
        let mut tree = Tree::default();
        let root = tree.add_node(NO_PARENT);
        tree.label[root as usize] = Label::Ott(93302);
        let eukaryota = add(&mut tree, root, 304358);
        add(&mut tree, root, 844192); // Bacteria
        add(&mut tree, root, 996421); // Archaea
        for ott in [691846, 352914, 361838, 878953, 664970] {
            add(&mut tree, eukaryota, ott);
        }
        while tree.len() < size {
            let n = tree.len();
            // Mostly attach near the newest nodes (deep chains), sometimes
            // anywhere (wide polytomies). Never under the root itself, so
            // every tip is inside a group root.
            let parent = if rng.below(4) == 0 {
                1 + rng.below(n - 1)
            } else {
                n - 1 - rng.below(8)
            };
            let node = tree.add_node(parent as u32);
            // A few mrca labels to exercise the tie-break.
            tree.label[node as usize] = if rng.below(10) == 0 {
                Label::Mrca(format!("mrcaott{n}ott{}", n + 1))
            } else {
                Label::Ott(10_000_000 + n as u32)
            };
        }
        tree
    }

    fn mini_tree() -> Tree {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mini.tre");
        newick::parse_file(&path).unwrap()
    }

    /// The P2 property tests (PLAN §9), on any tree.
    fn check_properties(tree: &Tree, layout: &Layout) {
        let n = layout.len();
        assert_eq!(n, tree.len());
        assert_eq!(layout.tip_count as usize, tree.tip_count());
        assert_eq!(layout.parent[0], NO_PARENT);
        assert_eq!(layout.r[0], R0 as f32);

        let mut previous_tip_angle: Option<u32> = None;
        for id in 0..n {
            if layout.is_tip(id) {
                // Tip angles strictly increase, tips are on the rim, in a
                // real group, at the deepest level.
                if let Some(previous) = previous_tip_angle {
                    assert!(layout.angle[id] > previous, "tip {id}");
                }
                previous_tip_angle = Some(layout.angle[id]);
                assert_eq!(layout.r[id], 1.0);
                assert!((layout.group[id] as usize) < groups::GROUP_COUNT);
                assert_eq!(layout.level[id], layout.max_level);
                assert_eq!(layout.child_level[id], lod::NO_CHILD_LEVEL);
                assert_eq!(layout.arc_lo[id], layout.angle[id]);
                assert_eq!(layout.arc_hi[id], layout.angle[id]);
            } else {
                assert!(layout.child_level[id] >= layout.level[id]);
            }

            // The clade's tips are ranks first_tip .. first_tip + leaf_count,
            // and they bracket its arc.
            let first = tip_angle(layout.first_tip[id], layout.tip_count);
            let last = tip_angle(
                layout.first_tip[id] + layout.leaf_count[id] - 1,
                layout.tip_count,
            );
            assert!(first <= layout.arc_lo[id] && layout.arc_hi[id] <= last);
            if layout.is_tip(id) {
                assert_eq!(first, layout.angle[id]);
            }

            // Span bound: arc_hi − arc_lo < 2·W_L/P for L ≥ 1.
            let level = layout.level[id];
            if level >= 1 {
                let span = (layout.arc_hi[id] - layout.arc_lo[id]) as u64;
                assert!(span * lod::P < 2 * lod::sector_width(level), "node {id}");
            }

            if id == 0 {
                continue;
            }
            let p = layout.parent[id] as usize;
            assert!(p < id, "pre-order: parent before child");
            assert_eq!(layout.depth[id], layout.depth[p] + 1);
            // The original tree agrees on who the parent is.
            assert_eq!(tree.parent[layout.node[id] as usize], layout.node[p]);
            assert!(layout.arc_lo[p] <= layout.angle[id]);
            assert!(layout.angle[id] <= layout.arc_hi[p]);
            assert!(layout.r[id] > layout.r[p], "node {id}");
            assert!(layout.level[id] >= layout.level[p]);
            assert!(layout.child_level[p] <= layout.level[id]);
        }

        // Every arena node appears exactly once.
        let mut seen = vec![false; n];
        for &v in &layout.node {
            assert!(!seen[v as usize]);
            seen[v as usize] = true;
        }

        // Ladderized: siblings come in ascending leaf count. Siblings share
        // a parent; consecutive siblings are the previous child seen.
        let mut last_child: Vec<Option<usize>> = vec![None; n];
        for id in 1..n {
            let p = layout.parent[id] as usize;
            if let Some(previous) = last_child[p] {
                assert!(layout.leaf_count[previous] <= layout.leaf_count[id]);
            }
            last_child[p] = Some(id);
        }

        // Runs cover every tip once, and neighbours differ in group.
        let mut tips = 0;
        for (i, run) in layout.group_runs.iter().enumerate() {
            tips += run.tips;
            assert!(run.angle_lo <= run.angle_hi);
            if i > 0 {
                assert_ne!(layout.group_runs[i - 1].group, run.group);
            }
        }
        assert_eq!(tips, layout.tip_count);
    }

    #[test]
    fn mini_fixture_properties() {
        let tree = mini_tree();
        let layout = compute(&tree).unwrap();
        check_properties(&tree, &layout);
        // Root children ladderized: Bacteria (2 tips), Archaea (3), Eukaryota.
        assert_eq!(tree.label[layout.node[1] as usize], Label::Ott(844192));
        assert_eq!(layout.group[1], groups::BACTERIA);
        // 30 tips need no LOD at all: 1 · 512 ≥ 30.
        assert_eq!(layout.max_level, 0);
    }

    #[test]
    fn random_tree_properties() {
        for seed in [1, 2, 3] {
            let tree = random_tree(10_000, seed);
            let layout = compute(&tree).unwrap();
            check_properties(&tree, &layout);
            // Big enough for several LOD levels.
            assert!(layout.max_level >= 2, "seed {seed}");
        }
    }

    /// Regression (review P1-1): Pan is (paniscus, troglodytes with five
    /// subspecies). Its arc ends at troglodytes' midpoint, which is the
    /// angle of the middle subspecies, so the arc alone hides the last two
    /// tips; first_tip and leaf_count give all six.
    #[test]
    fn first_tip_covers_a_clade_whose_arc_stops_short() {
        let tree =
            newick::parse(b"((ott1,(ott2,ott3,ott4,ott5,ott6)ott7)ott8,ott9)ott10;").unwrap();
        let (arena_leaf_count, arena_height) = leaf_counts_and_heights(&tree);
        let (node, parent, _) = ladderized_preorder(&tree, &arena_leaf_count);
        let mut height = Vec::new();
        for &v in &node {
            height.push(arena_height[v as usize]);
        }
        let (_, _, arc_hi) = angles(&parent, &height, 7);
        let first_tip = first_tips(&height);
        // Ladderized: ott9 (1 tip) first, then Pan (ott8, 6 tips).
        let pan = (0..node.len())
            .find(|&id| tree.label[node[id] as usize] == Label::Ott(8))
            .unwrap();
        assert_eq!(arena_leaf_count[node[pan] as usize], 6);
        assert_eq!(first_tip[pan], 1);
        // The arc stops at the middle subspecies, Pan's 4th tip (rank 4)…
        assert_eq!(arc_hi[pan], tip_angle(4, 7));
        // …while the tip range reaches the last one, rank 1 + 6 − 1 = 6.
        assert!(tip_angle(first_tip[pan] + 6 - 1, 7) > arc_hi[pan]);
    }

    #[test]
    fn tip_angles_fill_the_circle_evenly() {
        // Two tips: a quarter and three quarters of a turn.
        assert_eq!(tip_angle(0, 2), 1 << 30);
        assert_eq!(tip_angle(1, 2), 3 << 30);
        // The last of the full tree's tips stays below 2^32.
        let n = 2_385_875;
        assert!(tip_angle(n - 1, n) > tip_angle(n - 2, n));
    }

    #[test]
    fn radius_of_a_simple_chain() {
        // root → a → tip: depths 0, 1, 2; heights 2, 1, 0.
        let tree = newick::parse(b"((ott1)ott2)ott3;").unwrap();
        let r = radii(&[0, 1, 2], &[2, 1, 0]);
        assert_eq!(r[0], R0 as f32);
        assert_eq!(r[1], (R0 + (1.0 - R0) * 0.5) as f32);
        assert_eq!(r[2], 1.0);
        assert_eq!(
            leaf_counts_and_heights(&tree),
            (vec![1, 1, 1], vec![2, 1, 0])
        );
    }
}
