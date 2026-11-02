// The radial layout: where every node sits on the wheel (PLAN §3.2 steps
// 3–6, §3.3, §3.4), plus its group and LOD level.
//
// ComputeLayout takes the parsed Tree and returns a Layout. Leaf counts and
// heights come from one backward walk over the arena; ladderizing (smallest
// clade first, ties by CompareLabels) and renumbering is one explicit-stack
// depth-first walk handing out final ids in visit order, so a clade is the
// id range id .. id+subtree size. Tips are spaced evenly in visit order and
// every internal node sits in the middle of its children's arc.
//
// Every slice in Layout is indexed by the final id. The tree is not
// reordered: Layout.Node[id] is the node's index in the Tree arena (and in
// the Taxonomy), where its label, name and rank live.
//
// Concepts introduced here:
// - sorting with a comparison function (`slices.SortStableFunc`)
// - closures that capture local variables
// - a stack of small structs for a depth-first walk without recursion

package tree

import (
	"cmp"
	"errors"
	"fmt"
	"math"
	"slices"
)

// R0 is the radius of the root; the rim (every tip) is at 1.0.
const R0 = 0.08

// GroupRun is a contiguous run of tips (in angle order) in the same group
// (§3.3).
type GroupRun struct {
	Group uint8
	// AngleLo is the angle of the first tip in the run.
	AngleLo uint32
	// AngleHi is the angle of the last tip in the run (inclusive).
	AngleHi uint32
	// Tips is the number of tips in the run.
	Tips uint32
}

// Layout is the finished layout. Every slice is indexed by the final
// pre-order id; id 0 is the root. Only flat number slices, no pointers.
type Layout struct {
	// Node maps final id → index in the original Tree arena.
	Node []uint32
	// Parent is the final id of the parent, or NoParent for the root.
	Parent []uint32
	// Depth is edges from the root (root = 0).
	Depth []uint32
	// Height is the longest path down to a tip (0 means "tip").
	Height []uint32
	// LeafCount is tips in the clade (a tip counts itself).
	LeafCount []uint32
	// FirstTip is the rank (0-based, in angle order) of the clade's first
	// tip; its tips are ranks FirstTip .. FirstTip+LeafCount-1.
	FirstTip []uint32
	// Angle is uint32 fixed point: angle / 2^32 of a full turn.
	Angle []uint32
	// ArcLo is the angle of the first child (== Angle for a tip).
	ArcLo []uint32
	// ArcHi is the angle of the last child (== Angle for a tip).
	ArcHi []uint32
	// R is the radius: R0 at the root, exactly 1.0 at every tip.
	R []float32
	// Group is 0..5 or Mixed.
	Group []uint8
	// Level is the LOD level at which the node appears.
	Level []uint8
	// ChildLevel is the lowest level among the children; NoChildLevel for
	// a tip.
	ChildLevel []uint8
	// TipCount is N, the number of tips.
	TipCount uint32
	// MaxLevel is Lmax, the level of every tip.
	MaxLevel uint8
	// GroupRuns are the tip runs by group, in angle order.
	GroupRuns []GroupRun
}

// Len is the number of nodes.
func (l *Layout) Len() int {
	return len(l.Node)
}

// IsTip reports whether final id is a tip.
func (l *Layout) IsTip(id int) bool {
	return l.Height[id] == 0
}

// ComputeLayout lays out t. It needs node 0 to be the root and every parent
// index to be smaller than its children's, as ParseNewick produces.
func ComputeLayout(t *Tree) (*Layout, error) {
	if t.Len() == 0 {
		return nil, errors.New("cannot lay out an empty tree")
	}
	for node := range t.Len() {
		parent := t.Parent[node]
		if (node == 0) != (parent == NoParent) || (parent != NoParent && parent >= uint32(node)) {
			return nil, fmt.Errorf("node %d: the root must be node 0 and parents must come before children", node)
		}
	}

	// Steps 1–2 work in arena order…
	arenaLeafCount, arenaHeight := leafCountsAndHeights(t)
	arenaGroup, err := AssignGroups(t)
	if err != nil {
		return nil, err
	}

	// …step 3 gives the final order, and the per-node values follow along.
	// (The arena-order slices are garbage after this loop; the collector
	// can free them before the remaining slices are allocated.)
	node, parent, depth := ladderizedPreorder(t, arenaLeafCount)
	n := len(node)
	leafCount := make([]uint32, 0, n)
	height := make([]uint32, 0, n)
	group := make([]uint8, 0, n)
	for _, v := range node {
		leafCount = append(leafCount, arenaLeafCount[v])
		height = append(height, arenaHeight[v])
		group = append(group, arenaGroup[v])
	}

	tipCount := leafCount[0]
	angle, arcLo, arcHi := angles(parent, height, tipCount)
	firstTip := firstTips(height)
	r := radii(depth, height)

	level := make([]uint8, 0, n)
	for _, count := range leafCount {
		level = append(level, IntroLevel(count, tipCount))
	}
	childLevel := childLevels(parent, level)
	runs := groupRuns(angle, height, group)

	return &Layout{
		Node:       node,
		Parent:     parent,
		Depth:      depth,
		Height:     height,
		LeafCount:  leafCount,
		FirstTip:   firstTip,
		Angle:      angle,
		ArcLo:      arcLo,
		ArcHi:      arcHi,
		R:          r,
		Group:      group,
		Level:      level,
		ChildLevel: childLevel,
		TipCount:   tipCount,
		MaxLevel:   MaxLevel(tipCount),
		GroupRuns:  runs,
	}, nil
}

// leafCountsAndHeights gives the leaf count and height of every node, in
// arena order (§3.2 step 3).
func leafCountsAndHeights(t *Tree) (leafCount, height []uint32) {
	n := t.Len()
	leafCount = make([]uint32, n)
	height = make([]uint32, n)
	// Children have larger indices than their parent, so walking backwards
	// finishes every child before its parent: a post-order without
	// recursion.
	for node := n - 1; node >= 0; node-- {
		if len(t.Children[node]) == 0 {
			leafCount[node] = 1
		}
		parent := t.Parent[node]
		if parent != NoParent {
			leafCount[parent] += leafCount[node]
			height[parent] = max(height[parent], height[node]+1)
		}
	}
	return leafCount, height
}

// ladderizedPreorder ladderizes and renumbers (§3.2 steps 5–6). It returns,
// by final id: the arena index, the parent's final id and the depth.
func ladderizedPreorder(t *Tree, leafCount []uint32) (node, parent, depth []uint32) {
	n := t.Len()
	node = make([]uint32, 0, n)
	parent = make([]uint32, 0, n)
	depth = make([]uint32, 0, n)

	// visit is a node waiting on the stack: its arena index and its
	// parent's final id.
	type visit struct {
		v        uint32
		parentID uint32
	}
	stack := []visit{{0, NoParent}}
	// Reused for every node, so sorting allocates nothing after warm-up.
	var sorted []uint32

	// LEARN: a closure is a function literal that uses variables from the
	// code around it; here it reads leafCount and t. slices.SortStableFunc
	// calls it to compare two items: negative means a sorts first, positive
	// b, zero "equal". cmp.Compare gives exactly that for ordered values.
	bySizeThenLabel := func(a, b uint32) int {
		if c := cmp.Compare(leafCount[a], leafCount[b]); c != 0 {
			return c
		}
		return CompareLabels(t.Label[a], t.Label[b])
	}

	for len(stack) > 0 {
		top := stack[len(stack)-1]
		stack = stack[:len(stack)-1]

		id := uint32(len(node))
		node = append(node, top.v)
		parent = append(parent, top.parentID)
		if top.parentID == NoParent {
			depth = append(depth, 0)
		} else {
			depth = append(depth, depth[top.parentID]+1)
		}

		// Ladderize: smallest clade first; ties broken by label (OTT ids
		// ascending, then mrca text), so the order is deterministic.
		sorted = append(sorted[:0], t.Children[top.v]...)
		// LEARN: `slices.SortStableFunc` sorts with a comparison function
		// and keeps items that compare equal in their original order.
		// Stability matters here: the same input must give byte-identical
		// tiles (and dataVersion) every time, and plain `slices.SortFunc`
		// may reorder equal items.
		slices.SortStableFunc(sorted, bySizeThenLabel)
		// A stack pops the last item first, so push the children in
		// reverse to visit them in sorted order.
		for i := len(sorted) - 1; i >= 0; i-- {
			stack = append(stack, visit{sorted[i], id})
		}
	}
	return node, parent, depth
}

// TipAngle is the angle of the tip with rank (0-based, in visit order) out
// of tipCount: the middle of its slot, (2·rank + 1) · 2^31 / N.
func TipAngle(rank, tipCount uint32) uint32 {
	// In uint64 the product cannot overflow, and the result is below 2^32
	// because 2·rank + 1 < 2·N.
	numerator := (2*uint64(rank) + 1) << 31
	return uint32(numerator / uint64(tipCount))
}

// angles gives angles and arcs by final id (§3.3).
func angles(parent, height []uint32, tipCount uint32) (angle, arcLo, arcHi []uint32) {
	n := len(parent)
	angle = make([]uint32, n)
	// Start each arc "empty" so the first child sets both ends.
	arcLo = make([]uint32, n)
	for i := range arcLo {
		arcLo[i] = math.MaxUint32
	}
	arcHi = make([]uint32, n)

	// Tips, in id order, are the tips in visit order: number them 0..N.
	var rank uint32
	for id := range n {
		if height[id] == 0 {
			angle[id] = TipAngle(rank, tipCount)
			rank++
		}
	}

	// Children have larger ids than their parent, so walking backwards
	// finishes each node's angle before it widens its parent's arc.
	for id := n - 1; id >= 0; id-- {
		if height[id] == 0 {
			arcLo[id] = angle[id]
			arcHi[id] = angle[id]
		} else {
			// lo + (hi-lo)/2 rather than (lo+hi)/2, which could overflow.
			angle[id] = arcLo[id] + (arcHi[id]-arcLo[id])/2
		}
		p := parent[id]
		if p != NoParent {
			arcLo[p] = min(arcLo[p], angle[id])
			arcHi[p] = max(arcHi[p], angle[id])
		}
	}
	return angle, arcLo, arcHi
}

// firstTips gives the rank of each clade's first tip: the number of tips
// with a smaller id.
func firstTips(height []uint32) []uint32 {
	// Ids are a pre-order, so a clade is the id range starting at its own
	// id, and its first tip is the first tip at or after that id.
	firstTip := make([]uint32, 0, len(height))
	var tipsBefore uint32
	for _, h := range height {
		firstTip = append(firstTip, tipsBefore)
		if h == 0 {
			tipsBefore++
		}
	}
	return firstTip
}

// radii gives r = r0 + (1 − r0) · d / (d + h) (§3.4), tips pinned to 1.0.
func radii(depth, height []uint32) []float32 {
	// A float64 variable, so 1 − r0 is computed at run time in float64
	// (Go would fold the untyped constant 1 − R0 exactly; both happen to
	// round to the same float64, but this way the rounding is explicit).
	r0 := float64(R0)
	r := make([]float32, 0, len(depth))
	for id := range depth {
		if height[id] == 0 {
			// d / (d + 0) is 1 anyway; writing 1.0 avoids any rounding
			// doubt and covers a one-node tree (0 / 0).
			r = append(r, 1.0)
			continue
		}
		d := float64(depth[id])
		h := float64(height[id])
		// A fixed operation order: ((1 − r0)·d) / (d + h), plus r0,
		// all in float64, rounded to float32 once at the end. The explicit
		// float64(…) stops a compiler from fusing a multiply and an add into
		// one FMA, which would round differently.
		r = append(r, float32(r0+float64((1.0-r0)*d)/(d+h)))
	}
	return r
}

// childLevels gives the lowest level among each node's children (§3.6).
func childLevels(parent []uint32, level []uint8) []uint8 {
	childLevel := make([]uint8, len(parent))
	for i := range childLevel {
		childLevel[i] = NoChildLevel
	}
	for id := 1; id < len(parent); id++ {
		p := parent[id]
		childLevel[p] = min(childLevel[p], level[id])
	}
	return childLevel
}

// groupRuns gives the contiguous runs of tips with the same group, in angle
// order (§3.3).
func groupRuns(angle, height []uint32, group []uint8) []GroupRun {
	var runs []GroupRun
	for id := range angle {
		if height[id] != 0 {
			continue
		}
		if len(runs) > 0 && runs[len(runs)-1].Group == group[id] {
			// A pointer to the last element extends the run in place.
			run := &runs[len(runs)-1]
			run.AngleHi = angle[id]
			run.Tips++
			continue
		}
		runs = append(runs, GroupRun{
			Group:   group[id],
			AngleLo: angle[id],
			AngleHi: angle[id],
			Tips:    1,
		})
	}
	return runs
}
