// Package tree holds the synth tree in memory and everything computed from
// it during ingest: parsing (newick.go), the OTT taxonomy (taxonomy.go),
// major groups (groups.go), the radial layout (layout.go) and the level of
// detail (lod.go).
//
// The tree is an arena: parallel slices indexed by node number, where node
// 0 is the root and every parent's index is smaller than its children's
// (the Newick parser guarantees this). No pointers between nodes, so 2.7M
// nodes cost the garbage collector almost nothing to scan.
//
// Concepts introduced here:
// - an arena of parallel slices instead of a pointer-linked tree
// - a small "enum" built from a named integer type and `iota`
package tree

import (
	"cmp"
	"math"
	"strconv"
)

// NoParent is the parent of the root.
const NoParent uint32 = math.MaxUint32

// NoID marks an absent numeric id (a taxon without a GBIF or NCBI id).
const NoID uint32 = math.MaxUint32

// LabelKind says which of the three label shapes a Label has.
type LabelKind uint8

// The zero value is LabelNone, so a fresh Label is "unlabelled". Labels
// order Ott < Mrca < None (see CompareLabels); that order is not the
// numeric order of these constants.
const (
	LabelNone LabelKind = iota
	LabelOtt
	LabelMrca
)

// Label is a node's Newick label: an OTT taxon ("ott770315"), an unnamed
// clade OpenTree calls by two of its tips ("mrcaott1ott2"), or nothing.
type Label struct {
	Kind LabelKind
	// Ott is the taxon id when Kind is LabelOtt, else 0.
	Ott uint32
	// Mrca is the full text ("mrcaott1ott2") when Kind is LabelMrca, else "".
	Mrca string
}

// OttLabel is the label "ott<ott>".
func OttLabel(ott uint32) Label {
	return Label{Kind: LabelOtt, Ott: ott}
}

// MrcaLabel is the label of an unnamed clade, e.g. "mrcaott1ott2".
func MrcaLabel(text string) Label {
	return Label{Kind: LabelMrca, Mrca: text}
}

// CompareLabels orders labels: all Ott labels (by id) before all Mrca
// labels (by text) before None.
// It returns -1, 0 or +1, the shape slices.SortFunc and cmp.Compare use.
func CompareLabels(a, b Label) int {
	if a.Kind != b.Kind {
		return cmp.Compare(kindOrder(a.Kind), kindOrder(b.Kind))
	}
	switch a.Kind {
	case LabelOtt:
		return cmp.Compare(a.Ott, b.Ott)
	case LabelMrca:
		// Go compares strings byte by byte, which for the ASCII mrca text
		// is plain alphabetical order.
		return cmp.Compare(a.Mrca, b.Mrca)
	}
	return 0
}

// kindOrder is the rank of a label kind in the label order, compared
// before the id or text.
func kindOrder(kind LabelKind) int {
	switch kind {
	case LabelOtt:
		return 0
	case LabelMrca:
		return 1
	}
	return 2
}

// NodeID is OpenTree's id for the node ("ott770315" or the mrca text), and
// false for an unlabelled node.
func (l Label) NodeID() (string, bool) {
	switch l.Kind {
	case LabelOtt:
		return "ott" + strconv.FormatUint(uint64(l.Ott), 10), true
	case LabelMrca:
		return l.Mrca, true
	}
	return "", false
}

// Tree is the synth tree as an arena: entry i of every slice belongs to
// node i.
type Tree struct {
	Label  []Label
	Parent []uint32 // NoParent for the root
	// Children in Newick order. Tips have nil slices (2.39M of them), so
	// only the ~340k internal nodes allocate.
	Children [][]uint32
}

// Len is the number of nodes.
func (t *Tree) Len() int {
	return len(t.Label)
}

// AddNode appends an unlabelled node under parent (NoParent for the root)
// and returns its index.
func (t *Tree) AddNode(parent uint32) uint32 {
	// Indices are stored as uint32 to halve the memory; 2.7M nodes is far
	// below 4.29 billion.
	node := uint32(t.Len())
	t.Label = append(t.Label, Label{})
	t.Parent = append(t.Parent, parent)
	// LEARN: a nil slice is a valid empty slice: len is 0, `range` runs
	// zero times and `append` allocates on first use. So a tip costs no
	// allocation for its (empty) children list.
	t.Children = append(t.Children, nil)
	if parent != NoParent {
		t.Children[parent] = append(t.Children[parent], node)
	}
	return node
}

// TipCount is the number of nodes without children.
func (t *Tree) TipCount() int {
	count := 0
	for _, children := range t.Children {
		if len(children) == 0 {
			count++
		}
	}
	return count
}

// MrcaCount is the number of nodes with an mrca label.
func (t *Tree) MrcaCount() int {
	count := 0
	for _, label := range t.Label {
		if label.Kind == LabelMrca {
			count++
		}
	}
	return count
}

// OttIndex maps every OTT id in the tree to its node index.
func (t *Tree) OttIndex() map[uint32]uint32 {
	// LEARN: `make(map[K]V, n)` creates a hash map with room for about n
	// entries, so it does not have to grow (and rehash) while filling.
	// A map with no pointers in its keys or values (here two uint32s) is
	// one the garbage collector never has to scan.
	index := make(map[uint32]uint32, t.Len())
	for node, label := range t.Label {
		if label.Kind == LabelOtt {
			index[label.Ott] = uint32(node)
		}
	}
	return index
}
