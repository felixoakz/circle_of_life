// Major groups: Animals, Fungi, Plants, Protists, Bacteria, Archaea
// (ARCHITECTURE §2.2, §3.2 step 4). The group picks a node's colour on the wheel.
//
// Groups are defined by the OTT ids of their root clades, never by name
// (there is a genus called "Archaea" too). A forward pass inherits the
// nearest root clade's group; a backward pass gives an internal node its
// children's group when they all agree, and Mixed otherwise.
//
// Concepts introduced here:
// - an array of structs as a small lookup table
// - looping backwards over indices

package tree

import "fmt"

// Group numbers, stored per node in tiles and tree.db.
const (
	Animals  uint8 = 0
	Fungi    uint8 = 1
	Plants   uint8 = 2
	Protists uint8 = 3
	Bacteria uint8 = 4
	Archaea  uint8 = 5
	// Mixed is an internal node whose descendants are in more than one
	// group, or a node outside every root clade (the root of the tree).
	Mixed uint8 = 255
)

// GroupCount is the number of real groups (0..GroupCount-1).
const GroupCount = 6

// Root is one root clade of a group.
type Root struct {
	Ott   uint32
	Group uint8
}

// Roots maps root clade OTT ids to groups (ARCHITECTURE §2.2). Archaeplastida
// (5268475) is broken in the synth tree, so Plants has three roots.
// Treat it as read-only.
var Roots = [8]Root{
	{691846, Animals},  // Metazoa
	{352914, Fungi},    // Fungi
	{361838, Plants},   // Chloroplastida
	{878953, Plants},   // Rhodophyta
	{664970, Plants},   // Glaucophyta
	{304358, Protists}, // Eukaryota: whatever the roots above leave over
	{844192, Bacteria}, // Bacteria
	{996421, Archaea},  // Archaea (not the homonym genus 3573640)
}

// GroupName is a group's display name ("Animals"), "mixed" for anything else.
func GroupName(group uint8) string {
	switch group {
	case Animals:
		return "Animals"
	case Fungi:
		return "Fungi"
	case Plants:
		return "Plants"
	case Protists:
		return "Protists"
	case Bacteria:
		return "Bacteria"
	case Archaea:
		return "Archaea"
	}
	return "mixed"
}

// AssignGroups gives the group of every node, by arena index. It fails if a
// root id from Roots is not in the tree (the colours would be wrong).
func AssignGroups(t *Tree) ([]uint8, error) {
	n := t.Len()
	group := make([]uint8, n)
	for i := range group {
		group[i] = Mixed
	}

	// Mark the root clades themselves: one scan over all labels, checking
	// the 8-entry table for each OTT label.
	// LEARN: `[8]bool` is an array: its length is part of the type, fixed at
	// compile time, and it is a value (copied on assignment), unlike a slice
	// `[]bool`, which is a view onto an array. `len(Roots)` is a constant
	// because Roots is an array, so it can size another array. For a table
	// of eight entries, a loop over it is simpler (and as fast) as a map.
	var found [len(Roots)]bool
	for node, label := range t.Label {
		if label.Kind != LabelOtt {
			continue
		}
		for i, root := range Roots {
			if label.Ott == root.Ott {
				group[node] = root.Group
				found[i] = true
			}
		}
	}
	for i, root := range Roots {
		if !found[i] {
			return nil, fmt.Errorf("group root ott%d (%s) is not in the tree; ARCHITECTURE §2.2 lists the root ids",
				root.Ott, GroupName(root.Group))
		}
	}

	// Pass 1, forward: inherit from the parent unless this node is a root
	// clade itself (then it keeps its own group from the scan above). So
	// the nearest root wins: Metazoa, inside Eukaryota, restarts as Animals.
	// LEARN: `for i := range n` (n an integer) counts i from 0 to n-1.
	for node := range n {
		parent := t.Parent[node]
		if parent != NoParent && !isRootClade(t.Label[node]) {
			group[node] = group[parent]
		}
	}

	// Pass 2, backward: recompute internal nodes from their children.
	// Clear them first; a child always comes after its parent, so walking
	// indices from high to low finishes every child before its parent.
	const unset uint8 = 254
	for node, children := range t.Children {
		if len(children) > 0 {
			group[node] = unset
		}
	}
	// Node 0 (the root) has no parent to merge into, so stop at 1.
	for node := n - 1; node >= 1; node-- {
		parent := t.Parent[node]
		childGroup := group[node]
		if group[parent] == unset {
			group[parent] = childGroup
		} else if group[parent] != childGroup {
			group[parent] = Mixed
		}
	}
	return group, nil
}

// isRootClade reports whether label is one of the Roots.
func isRootClade(label Label) bool {
	if label.Kind != LabelOtt {
		return false
	}
	for _, root := range Roots {
		if label.Ott == root.Ott {
			return true
		}
	}
	return false
}
