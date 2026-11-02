// Tests for the tree arena (tree.go).
//
// Concepts introduced here:
// - (none beyond the package's)

package tree

import (
	"slices"
	"testing"
)

func TestAddNodeLinksParentAndChild(t *testing.T) {
	tr := &Tree{}
	root := tr.AddNode(NoParent)
	a := tr.AddNode(root)
	b := tr.AddNode(root)
	tr.Label[a] = OttLabel(1)

	if tr.Len() != 3 {
		t.Errorf("Len() = %d, want 3", tr.Len())
	}
	if want := []uint32{NoParent, 0, 0}; !slices.Equal(tr.Parent, want) {
		t.Errorf("Parent = %v, want %v", tr.Parent, want)
	}
	if want := []uint32{a, b}; !slices.Equal(tr.Children[0], want) {
		t.Errorf("Children[0] = %v, want %v", tr.Children[0], want)
	}
	if tr.TipCount() != 2 {
		t.Errorf("TipCount() = %d, want 2", tr.TipCount())
	}
	node, ok := tr.OttIndex()[1]
	if !ok || node != a {
		t.Errorf("OttIndex()[1] = %d, %v; want %d, true", node, ok, a)
	}
}
