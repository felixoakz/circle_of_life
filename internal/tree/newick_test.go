// Tests for the Newick parser (newick.go).
//
// Concepts introduced here:
// - the `testing` package: `go test` runs every `func TestXxx(t *testing.T)`
//   in the package's _test.go files
// - `t.Helper()` for small helpers that fail the test
// - table-driven tests: one loop over a slice of cases, with `t.Run`

package tree

import (
	"slices"
	"strings"
	"testing"

	"species/internal/testutil"
)

// parseStr parses text, failing the test if that fails.
func parseStr(t *testing.T, text string) *Tree {
	// LEARN: `t.Helper()` marks this function as a test helper: when the
	// t.Fatalf below fires, Go reports the line in the test that called
	// parseStr, not this line, which is where you want to look.
	t.Helper()
	tr, err := ParseNewick([]byte(text))
	if err != nil {
		// LEARN: a test fails by calling methods on t. `t.Errorf` records a
		// failure and carries on (so one run reports every wrong value);
		// `t.Fatalf` records it and stops this test at once, for when
		// nothing after it can work. Go has no assert macros: a test is
		// ordinary code with `if` statements. Files ending in _test.go are
		// only compiled by `go test`, and every `func TestXxx(t
		// *testing.T)` in them is a test.
		t.Fatalf("ParseNewick(%q): %v", text, err)
	}
	return tr
}

func TestOttAndMrcaLabels(t *testing.T) {
	tr := parseStr(t, "((ott1,ott2)mrcaott1ott2,ott3)ott93302;")
	wantLabels := []Label{
		OttLabel(93302),
		MrcaLabel("mrcaott1ott2"),
		OttLabel(1),
		OttLabel(2),
		OttLabel(3),
	}
	if !slices.Equal(tr.Label, wantLabels) {
		t.Errorf("Label = %v, want %v", tr.Label, wantLabels)
	}
	// Pre-order: every parent index is smaller than its child's.
	if want := []uint32{NoParent, 0, 1, 1, 0}; !slices.Equal(tr.Parent, want) {
		t.Errorf("Parent = %v, want %v", tr.Parent, want)
	}
	if want := []uint32{1, 4}; !slices.Equal(tr.Children[0], want) {
		t.Errorf("Children[0] = %v, want %v", tr.Children[0], want)
	}
	if tr.TipCount() != 3 {
		t.Errorf("TipCount() = %d, want 3", tr.TipCount())
	}
	if tr.MrcaCount() != 1 {
		t.Errorf("MrcaCount() = %d, want 1", tr.MrcaCount())
	}
}

func TestQuotedLabel(t *testing.T) {
	tr := parseStr(t, "('ott5',ott6)'ott7';")
	if tr.Label[0] != OttLabel(7) {
		t.Errorf("Label[0] = %v, want ott7", tr.Label[0])
	}
	if tr.Label[1] != OttLabel(5) {
		t.Errorf("Label[1] = %v, want ott5", tr.Label[1])
	}
	// '' inside quotes is one quote, which makes this an unknown label.
	_, err := ParseNewick([]byte("('ott''5',ott6)ott7;"))
	if err == nil {
		t.Fatal("ParseNewick accepted ott'5")
	}
	if !strings.Contains(err.Error(), "ott'5") {
		t.Errorf("error %q does not mention ott'5", err)
	}
}

func TestUnlabelledNodes(t *testing.T) {
	tr := parseStr(t, "((,ott2),);")
	if tr.Len() != 5 {
		t.Fatalf("Len() = %d, want 5", tr.Len())
	}
	want := []Label{{}, {}, {}, OttLabel(2), {}}
	if !slices.Equal(tr.Label, want) {
		t.Errorf("Label = %v, want %v", tr.Label, want)
	}
	if tr.TipCount() != 3 {
		t.Errorf("TipCount() = %d, want 3", tr.TipCount())
	}
}

func TestPolytomy(t *testing.T) {
	tr := parseStr(t, "(ott1,ott2,ott3,ott4,ott5,ott6,ott7,ott8)ott9;")
	if want := []uint32{1, 2, 3, 4, 5, 6, 7, 8}; !slices.Equal(tr.Children[0], want) {
		t.Errorf("Children[0] = %v, want %v", tr.Children[0], want)
	}
}

func TestTrailingSemicolon(t *testing.T) {
	// Whitespace and a final newline are fine…
	if n := parseStr(t, " ( ott1 , ott2 ) ott3 ;\n").Len(); n != 3 {
		t.Errorf("Len() = %d, want 3", n)
	}
	// …a missing ';' or data after it is not.
	for _, text := range []string{"(ott1,ott2)ott3", "(ott1,ott2)ott3;ott4"} {
		if _, err := ParseNewick([]byte(text)); err == nil {
			t.Errorf("ParseNewick(%q) succeeded, want an error", text)
		}
	}
}

func TestMalformedInputIsAnError(t *testing.T) {
	// LEARN: a table-driven test lists its cases as data, here a slice of
	// structs, and runs the same checks over each. `t.Run` makes each case
	// a named subtest: failures name the case, and `go test -run
	// 'TestMalformedInputIsAnError/branch_length'` reruns just one.
	cases := []struct {
		name string
		text string
	}{
		{"unclosed paren", "(ott1,ott2;"},
		{"unopened paren", "ott1)ott2;"},
		{"two roots", "(ott1)ott2,(ott3)ott4;"},
		{"branch length", "(ott1:0.5)ott2;"},
		{"plain name", "(Homo_sapiens)ott2;"},
		{"no tree", ";"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := ParseNewick([]byte(c.text)); err == nil {
				t.Errorf("ParseNewick(%q) succeeded, want an error", c.text)
			}
		})
	}
}

func TestNewickMiniFixture(t *testing.T) {
	tr, err := ParseNewickFile(testutil.Fixture("mini.tre"))
	if err != nil {
		t.Fatal(err)
	}
	if tr.Len() != 57 {
		t.Errorf("Len() = %d, want 57", tr.Len())
	}
	if tr.TipCount() != 30 {
		t.Errorf("TipCount() = %d, want 30", tr.TipCount())
	}
	if tr.MrcaCount() != 1 {
		t.Errorf("MrcaCount() = %d, want 1", tr.MrcaCount())
	}
	if tr.Label[0] != OttLabel(93302) {
		t.Errorf("Label[0] = %v, want ott93302", tr.Label[0])
	}
	// The root has three children: Eukaryota, Bacteria, Archaea.
	var rootChildren []Label
	for _, child := range tr.Children[0] {
		rootChildren = append(rootChildren, tr.Label[child])
	}
	want := []Label{OttLabel(304358), OttLabel(844192), OttLabel(996421)}
	if !slices.Equal(rootChildren, want) {
		t.Errorf("root children = %v, want %v", rootChildren, want)
	}
	// Homo sapiens hangs under Homo.
	index := tr.OttIndex()
	human := index[770315]
	if tr.Parent[human] != index[770309] {
		t.Errorf("parent of Homo sapiens = %d, want Homo (%d)", tr.Parent[human], index[770309])
	}
}
