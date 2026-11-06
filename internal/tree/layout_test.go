// Tests for the radial layout (layout.go): property checks on the mini tree
// and on random trees, plus a few exact values. Same package as layout.go,
// so the unexported steps (leafCountsAndHeights, angles, …) are testable.
//
// Concepts introduced here:
// - (none beyond the package's)

package tree

import (
	"fmt"
	"slices"
	"testing"

	"species/internal/testutil"
)

// lcg is a tiny linear congruential generator: deterministic "random"
// numbers without a dependency. Constants from Knuth's MMIX.
type lcg struct{ state uint64 }

// below is a number in 0..bound-1. Unsigned overflow wraps in Go (modulo
// 2^64), which is exactly what an LCG needs.
func (r *lcg) below(bound int) int {
	r.state = r.state*6364136223846793005 + 1442695040888963407
	// The high bits of an LCG are the most random ones.
	return int((r.state >> 33) % uint64(bound))
}

// addOtt appends a node labelled ott under parent.
func addOtt(tr *Tree, parent uint32, ott uint32) uint32 {
	node := tr.AddNode(parent)
	tr.Label[node] = OttLabel(ott)
	return node
}

// randomTree is a random tree of size nodes that contains every group root,
// so the groups step works. Parents always come before children, as in a
// parsed tree, but children of one node are not contiguous.
func randomTree(size int, seed uint64) *Tree {
	rng := &lcg{seed}
	tr := &Tree{}
	root := addOtt(tr, NoParent, 93302)
	eukaryota := addOtt(tr, root, 304358)
	addOtt(tr, root, 844192) // Bacteria
	addOtt(tr, root, 996421) // Archaea
	for _, ott := range []uint32{691846, 352914, 361838, 878953, 664970} {
		addOtt(tr, eukaryota, ott)
	}
	for tr.Len() < size {
		n := tr.Len()
		// Mostly attach near the newest nodes (deep chains), sometimes
		// anywhere (wide polytomies). Never under the root itself, so every
		// tip is inside a group root.
		var parent int
		if rng.below(4) == 0 {
			parent = 1 + rng.below(n-1)
		} else {
			parent = n - 1 - rng.below(8)
		}
		node := tr.AddNode(uint32(parent))
		// A few mrca labels to exercise the tie-break.
		if rng.below(10) == 0 {
			tr.Label[node] = MrcaLabel(fmt.Sprintf("mrcaott%dott%d", n, n+1))
		} else {
			tr.Label[node] = OttLabel(10_000_000 + uint32(n))
		}
	}
	return tr
}

// checkProperties runs the layout and LOD property tests (ARCHITECTURE
// §9.3) on any tree. It stops at the first failure: with thousands of
// nodes, later failures are usually the same bug again.
func checkProperties(t *testing.T, tr *Tree, l *Layout) {
	t.Helper()
	n := l.Len()
	if n != tr.Len() {
		t.Fatalf("Len() = %d, want %d", n, tr.Len())
	}
	if int(l.TipCount) != tr.TipCount() {
		t.Fatalf("TipCount = %d, want %d", l.TipCount, tr.TipCount())
	}
	if l.Parent[0] != NoParent {
		t.Fatalf("Parent[0] = %d, want NoParent", l.Parent[0])
	}
	if l.R[0] != float32(R0) {
		t.Fatalf("R[0] = %v, want %v", l.R[0], float32(R0))
	}

	havePrevious := false
	var previousTipAngle uint32
	for id := 0; id < n; id++ {
		if l.IsTip(id) {
			// Tip angles strictly increase, tips are on the rim, in a real
			// group, at the deepest level.
			if havePrevious && l.Angle[id] <= previousTipAngle {
				t.Fatalf("tip %d: angle %d not above the previous tip's %d", id, l.Angle[id], previousTipAngle)
			}
			havePrevious = true
			previousTipAngle = l.Angle[id]
			if l.R[id] != 1.0 {
				t.Fatalf("tip %d: r = %v, want 1", id, l.R[id])
			}
			if l.Group[id] >= GroupCount {
				t.Fatalf("tip %d: group %d", id, l.Group[id])
			}
			if l.Level[id] != l.MaxLevel {
				t.Fatalf("tip %d: level %d, want MaxLevel %d", id, l.Level[id], l.MaxLevel)
			}
			if l.ChildLevel[id] != NoChildLevel {
				t.Fatalf("tip %d: child level %d, want NoChildLevel", id, l.ChildLevel[id])
			}
			if l.ArcLo[id] != l.Angle[id] || l.ArcHi[id] != l.Angle[id] {
				t.Fatalf("tip %d: arc %d..%d, want its angle %d", id, l.ArcLo[id], l.ArcHi[id], l.Angle[id])
			}
		} else if l.ChildLevel[id] < l.Level[id] {
			t.Fatalf("node %d: child level %d below level %d", id, l.ChildLevel[id], l.Level[id])
		}

		// The clade's tips are ranks FirstTip .. FirstTip+LeafCount-1, and
		// they bracket its arc.
		first := TipAngle(l.FirstTip[id], l.TipCount)
		last := TipAngle(l.FirstTip[id]+l.LeafCount[id]-1, l.TipCount)
		if !(first <= l.ArcLo[id] && l.ArcHi[id] <= last) {
			t.Fatalf("node %d: arc %d..%d outside its tips %d..%d", id, l.ArcLo[id], l.ArcHi[id], first, last)
		}
		if l.IsTip(id) && first != l.Angle[id] {
			t.Fatalf("tip %d: first tip angle %d, want its angle %d", id, first, l.Angle[id])
		}

		// Span bound: ArcHi − ArcLo < 2·W_L/P for L ≥ 1.
		level := l.Level[id]
		if level >= 1 {
			span := uint64(l.ArcHi[id] - l.ArcLo[id])
			if span*P >= 2*SectorWidth(level) {
				t.Fatalf("node %d: span %d too wide for level %d", id, span, level)
			}
		}

		if id == 0 {
			continue
		}
		p := int(l.Parent[id])
		if p >= id {
			t.Fatalf("node %d: parent %d not before it (pre-order)", id, p)
		}
		if l.Depth[id] != l.Depth[p]+1 {
			t.Fatalf("node %d: depth %d, parent's %d", id, l.Depth[id], l.Depth[p])
		}
		// The original tree agrees on who the parent is.
		if tr.Parent[l.Node[id]] != l.Node[p] {
			t.Fatalf("node %d: arena parent %d, want %d", id, tr.Parent[l.Node[id]], l.Node[p])
		}
		if !(l.ArcLo[p] <= l.Angle[id] && l.Angle[id] <= l.ArcHi[p]) {
			t.Fatalf("node %d: angle %d outside parent arc %d..%d", id, l.Angle[id], l.ArcLo[p], l.ArcHi[p])
		}
		if l.R[id] <= l.R[p] {
			t.Fatalf("node %d: r %v not above parent's %v", id, l.R[id], l.R[p])
		}
		if l.Level[id] < l.Level[p] {
			t.Fatalf("node %d: level %d below parent's %d", id, l.Level[id], l.Level[p])
		}
		if l.ChildLevel[p] > l.Level[id] {
			t.Fatalf("node %d: parent's child level %d above its level %d", id, l.ChildLevel[p], l.Level[id])
		}
	}

	// Every arena node appears exactly once.
	seen := make([]bool, n)
	for _, v := range l.Node {
		if seen[v] {
			t.Fatalf("arena node %d appears twice", v)
		}
		seen[v] = true
	}

	// Ladderized: siblings come in ascending leaf count. Siblings share a
	// parent; consecutive siblings are the previous child seen.
	lastChild := make([]int, n)
	for i := range lastChild {
		lastChild[i] = -1
	}
	for id := 1; id < n; id++ {
		p := l.Parent[id]
		if previous := lastChild[p]; previous >= 0 && l.LeafCount[previous] > l.LeafCount[id] {
			t.Fatalf("node %d: leaf count %d after sibling %d with %d", id, l.LeafCount[id], previous, l.LeafCount[previous])
		}
		lastChild[p] = id
	}

	// Runs cover every tip once, and neighbours differ in group.
	var tips uint32
	for i, run := range l.GroupRuns {
		tips += run.Tips
		if run.AngleLo > run.AngleHi {
			t.Fatalf("group run %d: %d > %d", i, run.AngleLo, run.AngleHi)
		}
		if i > 0 && l.GroupRuns[i-1].Group == run.Group {
			t.Fatalf("group runs %d and %d are both group %d", i-1, i, run.Group)
		}
	}
	if tips != l.TipCount {
		t.Fatalf("group runs cover %d tips, want %d", tips, l.TipCount)
	}
}

func TestMiniFixtureProperties(t *testing.T) {
	tr, err := ParseNewickFile(testutil.Fixture("mini.tre"))
	if err != nil {
		t.Fatal(err)
	}
	l, err := ComputeLayout(tr)
	if err != nil {
		t.Fatal(err)
	}
	checkProperties(t, tr, l)
	// Root children ladderized: Bacteria (2 tips), Archaea (3), Eukaryota.
	if got := tr.Label[l.Node[1]]; got != OttLabel(844192) {
		t.Errorf("first root child = %v, want Bacteria (ott844192)", got)
	}
	if l.Group[1] != Bacteria {
		t.Errorf("Group[1] = %d, want Bacteria", l.Group[1])
	}
	// 30 tips need no LOD at all: 1 · 512 ≥ 30.
	if l.MaxLevel != 0 {
		t.Errorf("MaxLevel = %d, want 0", l.MaxLevel)
	}
}

func TestRandomTreeProperties(t *testing.T) {
	for _, seed := range []uint64{1, 2, 3} {
		t.Run(fmt.Sprintf("seed %d", seed), func(t *testing.T) {
			tr := randomTree(10_000, seed)
			l, err := ComputeLayout(tr)
			if err != nil {
				t.Fatal(err)
			}
			checkProperties(t, tr, l)
			// Big enough for several LOD levels.
			if l.MaxLevel < 2 {
				t.Errorf("MaxLevel = %d, want ≥ 2", l.MaxLevel)
			}
		})
	}
}

// Regression (review P1-1): Pan is (paniscus, troglodytes with five
// subspecies). Its arc ends at troglodytes' midpoint, which is the angle of
// the middle subspecies, so the arc alone hides the last two tips;
// FirstTip and LeafCount give all six.
func TestFirstTipCoversACladeWhoseArcStopsShort(t *testing.T) {
	tr := parseStr(t, "((ott1,(ott2,ott3,ott4,ott5,ott6)ott7)ott8,ott9)ott10;")
	arenaLeafCount, arenaHeight := leafCountsAndHeights(tr)
	node, parent, _ := ladderizedPreorder(tr, arenaLeafCount)
	var height []uint32
	for _, v := range node {
		height = append(height, arenaHeight[v])
	}
	_, _, arcHi := angles(parent, height, 7)
	firstTip := firstTips(height)
	// Ladderized: ott9 (1 tip) first, then Pan (ott8, 6 tips).
	pan := slices.IndexFunc(node, func(v uint32) bool { return tr.Label[v] == OttLabel(8) })
	if pan < 0 {
		t.Fatal("ott8 not in the layout")
	}
	if got := arenaLeafCount[node[pan]]; got != 6 {
		t.Errorf("Pan leaf count = %d, want 6", got)
	}
	if firstTip[pan] != 1 {
		t.Errorf("Pan first tip = %d, want 1", firstTip[pan])
	}
	// The arc stops at the middle subspecies, Pan's 4th tip (rank 4)…
	if arcHi[pan] != TipAngle(4, 7) {
		t.Errorf("Pan arc hi = %d, want TipAngle(4, 7) = %d", arcHi[pan], TipAngle(4, 7))
	}
	// …while the tip range reaches the last one, rank 1 + 6 − 1 = 6.
	if TipAngle(firstTip[pan]+6-1, 7) <= arcHi[pan] {
		t.Errorf("last tip angle %d not beyond arc hi %d", TipAngle(firstTip[pan]+6-1, 7), arcHi[pan])
	}
}

func TestTipAnglesFillTheCircleEvenly(t *testing.T) {
	// Two tips: a quarter and three quarters of a turn.
	if got := TipAngle(0, 2); got != 1<<30 {
		t.Errorf("TipAngle(0, 2) = %d, want 2^30", got)
	}
	if got := TipAngle(1, 2); got != 3<<30 {
		t.Errorf("TipAngle(1, 2) = %d, want 3·2^30", got)
	}
	// The last of the full tree's tips stays below 2^32.
	const n = 2_385_875
	if TipAngle(n-1, n) <= TipAngle(n-2, n) {
		t.Errorf("TipAngle(N-1) = %d not above TipAngle(N-2) = %d", TipAngle(n-1, n), TipAngle(n-2, n))
	}
}

func TestRadiusOfASimpleChain(t *testing.T) {
	// root → a → tip: depths 0, 1, 2; heights 2, 1, 0.
	tr := parseStr(t, "((ott1)ott2)ott3;")
	r := radii([]uint32{0, 1, 2}, []uint32{2, 1, 0})
	// Computed in float64, then rounded once, as radii does.
	r0 := float64(R0)
	want := []float32{float32(r0), float32(r0 + (1.0-r0)*0.5), 1.0}
	if !slices.Equal(r, want) {
		t.Errorf("radii = %v, want %v", r, want)
	}
	leafCount, height := leafCountsAndHeights(tr)
	if !slices.Equal(leafCount, []uint32{1, 1, 1}) || !slices.Equal(height, []uint32{2, 1, 0}) {
		t.Errorf("leafCountsAndHeights = %v, %v; want [1 1 1], [2 1 0]", leafCount, height)
	}
}
