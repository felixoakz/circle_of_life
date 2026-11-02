// Tests for the OTT taxonomy reader (taxonomy.go).
//
// Concepts introduced here:
// - (none beyond the package's)

package tree

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"species/internal/testutil"
)

func TestSplitRowStripsTrailingSeparator(t *testing.T) {
	cases := []struct {
		name string
		line string
		want []string
	}{
		{
			"trailing separator and newline",
			"770315\t|\t770309\t|\tHomo sapiens\t|\tspecies\t|\tncbi:9606\t|\t\t|\textinct\t|\t\n",
			[]string{"770315", "770309", "Homo sapiens", "species", "ncbi:9606", "", "extinct"},
		},
		// With Windows line endings the fields come out the same…
		{
			"windows line ending",
			"1\t|\t2\t|\tx\t|\tgenus\t|\t\t|\t\t|\t\t|\t\r\n",
			[]string{"1", "2", "x", "genus", "", "", ""},
		},
		// …and without the trailing separator too.
		{"no trailing separator", "1\t|\t2", []string{"1", "2"}},
	}
	var fields [][]byte
	for _, c := range cases {
		fields = splitRow(fields, []byte(c.line))
		var got []string
		for _, f := range fields {
			got = append(got, string(f))
		}
		if !slices.Equal(got, c.want) {
			t.Errorf("%s: splitRow = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestSourceinfoParsing(t *testing.T) {
	cases := []struct {
		sourceinfo string
		gbif, ncbi uint32
	}{
		{"ncbi:9606,gbif:2436436,irmng:11388931,irmng:10857762", 2436436, 9606},
		// First of two gbif ids; silva ids with "/#" are skipped.
		{"silva:L19345/#3,ncbi:2763,worms:852,gbif:106,gbif:8029077", 106, 2763},
		{"silva:E17133/#2,worms:582419", NoID, NoID},
		{"", NoID, NoID},
		{"study713:361838,ncbi:33090", NoID, 33090},
	}
	for _, c := range cases {
		gbif, ncbi := ParseSourceinfo([]byte(c.sourceinfo))
		if gbif != c.gbif || ncbi != c.ncbi {
			t.Errorf("ParseSourceinfo(%q) = %d, %d; want %d, %d", c.sourceinfo, gbif, ncbi, c.gbif, c.ncbi)
		}
	}
}

// readStr writes contents to a temporary taxonomy file and reads it for tr.
func readStr(t *testing.T, tr *Tree, contents string) *Taxonomy {
	t.Helper()
	path := filepath.Join(t.TempDir(), "taxonomy.tsv")
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}
	x, err := ReadTaxonomy(path, tr)
	if err != nil {
		t.Fatal(err)
	}
	return x
}

// The flags column is read past but not kept (nothing uses it).
func TestHeaderIsSkippedAndRowsAreFiltered(t *testing.T) {
	tr := parseStr(t, "(ott2,ott3)mrcaott2ott3;")
	contents := "uid\t|\tparent_uid\t|\tname\t|\trank\t|\tsourceinfo\t|\tuniqname\t|\tflags\t|\t\n" +
		"1\t|\t\t|\tlife\t|\tno rank\t|\t\t|\t\t|\t\t|\t\n" +
		"2\t|\t1\t|\tAlpha\t|\tspecies\t|\tgbif:7\t|\t\t|\textinct\t|\t\n"
	x := readStr(t, tr, contents)
	if x.RowsRead != 2 {
		t.Errorf("RowsRead = %d, want 2", x.RowsRead)
	}
	// Node 0 is the mrca node, node 1 is ott2, node 2 is ott3 (no row).
	if taxon, ok := x.Taxon(0); ok {
		t.Errorf("Taxon(0) = %+v, want none", taxon)
	}
	want := Taxon{Name: "Alpha", Rank: "species", GBIF: 7, NCBI: NoID}
	if taxon, ok := x.Taxon(1); !ok || taxon != want {
		t.Errorf("Taxon(1) = %+v, %v; want %+v, true", taxon, ok, want)
	}
	if taxon, ok := x.Taxon(2); ok {
		t.Errorf("Taxon(2) = %+v, want none", taxon)
	}
	if x.Missing != 1 {
		t.Errorf("Missing = %d, want 1", x.Missing)
	}
}

func TestShortRowIsAnError(t *testing.T) {
	tr := parseStr(t, "ott2;")
	path := filepath.Join(t.TempDir(), "taxonomy.tsv")
	if err := os.WriteFile(path, []byte("2\t|\t1\t|\tAlpha\t|\t\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadTaxonomy(path, tr); err == nil {
		t.Error("ReadTaxonomy accepted a short row")
	}
}

func TestTaxonomyMiniFixture(t *testing.T) {
	tr, err := ParseNewickFile(testutil.Fixture("mini.tre"))
	if err != nil {
		t.Fatal(err)
	}
	x, err := ReadTaxonomy(testutil.Fixture("mini_taxonomy.tsv"), tr)
	if err != nil {
		t.Fatal(err)
	}
	if x.Missing != 0 {
		t.Errorf("Missing = %d, want 0", x.Missing)
	}
	// Every tree ott id plus "life" (805080), which is not in the tree.
	if x.RowsRead != 57 {
		t.Errorf("RowsRead = %d, want 57", x.RowsRead)
	}

	human := tr.OttIndex()[770315]
	taxon, ok := x.Taxon(int(human))
	want := Taxon{Name: "Homo sapiens", Rank: "species", GBIF: 2436436, NCBI: 9606}
	if !ok || taxon != want {
		t.Errorf("Taxon(human) = %+v, %v; want %+v, true", taxon, ok, want)
	}
	if name, ok := x.Name(int(human)); !ok || name != "Homo sapiens" {
		t.Errorf("Name(human) = %q, %v; want Homo sapiens, true", name, ok)
	}
}
