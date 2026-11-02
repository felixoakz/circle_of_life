// Tests for the major groups (groups.go).
//
// Concepts introduced here:
// - (none beyond the package's)

package tree

import (
	"strings"
	"testing"

	"species/internal/testutil"
)

func TestMiniFixtureGroups(t *testing.T) {
	tr, err := ParseNewickFile(testutil.Fixture("mini.tre"))
	if err != nil {
		t.Fatal(err)
	}
	groups, err := AssignGroups(tr)
	if err != nil {
		t.Fatal(err)
	}
	index := tr.OttIndex()

	cases := []struct {
		name  string
		ott   uint32
		group uint8
	}{
		{"Homo sapiens", 770315, Animals},
		{"Amanita", 75257, Fungi},
		{"Arabidopsis", 309263, Plants},
		{"Chondrus (red alga)", 878946, Plants},
		{"Cyanoptyche (glaucophyte)", 801157, Plants},
		{"Plasmodium", 201128, Protists},
		{"E. coli", 474506, Bacteria},
		{"an archaeon", 44033, Archaea},
		// Internal nodes: one group if all children agree, else mixed.
		{"Metazoa", 691846, Animals},
		{"SAR", 5246039, Protists},
		{"Opisthokonta", 332573, Mixed},
		{"Eukaryota", 304358, Mixed},
		{"the root", 93302, Mixed},
	}
	for _, c := range cases {
		if got := groups[index[c.ott]]; got != c.group {
			t.Errorf("%s (ott%d): group %d, want %d", c.name, c.ott, got, c.group)
		}
	}

	// Every tip is in a real group.
	for node, children := range tr.Children {
		if len(children) == 0 && groups[node] >= GroupCount {
			t.Errorf("tip %d has group %d", node, groups[node])
		}
	}
}

func TestMissingRootIsAnError(t *testing.T) {
	tr := parseStr(t, "(ott1,ott2)ott3;")
	_, err := AssignGroups(tr)
	if err == nil {
		t.Fatal("AssignGroups succeeded without the group roots")
	}
	if !strings.Contains(err.Error(), "ott691846") {
		t.Errorf("error %q does not name ott691846", err)
	}
}
