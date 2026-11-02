// Tests for reading GBIF common names: language codes, name cleaning,
// header columns and the full read of tests/fixtures/vernacular.tsv.
//
// Concepts introduced here:
// - (none beyond the package's)

package vernacular

import (
	"slices"
	"testing"

	"species/internal/testutil"
)

func TestLanguageCodes(t *testing.T) {
	cases := []struct {
		code string
		want string
		ok   bool
	}{
		{"en", "en", true},
		{"eng", "en", true},
		{"EN", "en", true},
		{"por", "pt", true},
		{"pt-BR", "pt", true},
		{" pt ", "pt", true},
		{"ger", "de", true},
		{"xx", "", false},
		{"", "", false},
	}
	for _, c := range cases {
		got, ok := LangCode(c.code)
		if got != c.want || ok != c.ok {
			t.Errorf("LangCode(%q) = %q, %v; want %q, %v", c.code, got, ok, c.want, c.ok)
		}
	}

	langs, err := ParseLangs("en, por")
	if err != nil {
		t.Fatalf(`ParseLangs("en, por"): %v`, err)
	}
	if !slices.Equal(langs, []string{"en", "pt"}) {
		t.Errorf(`ParseLangs("en, por") = %q, want ["en" "pt"]`, langs)
	}
	for _, bad := range []string{"en,klingon", " , "} {
		if _, err := ParseLangs(bad); err == nil {
			t.Errorf("ParseLangs(%q) succeeded, want an error", bad)
		}
	}
}

func TestCleansNames(t *testing.T) {
	cases := []struct{ raw, want string }{
		{"  Onça \t pintada  ", "Onça pintada"},
		{"   ", ""},
	}
	for _, c := range cases {
		if got := Clean(c.raw); got != c.want {
			t.Errorf("Clean(%q) = %q, want %q", c.raw, got, c.want)
		}
	}
}

func TestHeaderColumnsByName(t *testing.T) {
	cols, err := columnsFromHeader("language\tvernacularName\ttaxonID")
	if err != nil {
		t.Fatal(err)
	}
	if cols.taxon != 2 || cols.name != 1 || cols.lang != 0 {
		t.Errorf("columns = %+v, want taxon 2, name 1, lang 0", cols)
	}
	if _, err := columnsFromHeader("taxonID\tname"); err == nil {
		t.Error("a header without vernacularName and language was accepted")
	}
}

// The fixture has a header and rows in en, eng, pt, por, pt-BR and other
// languages, with repeats, stray spaces and an unknown key.
func TestReadsTheFixture(t *testing.T) {
	path := testutil.Fixture("vernacular.tsv")
	// GBIF key → node id, as ingest builds it from OTT sourceinfo.
	nodeOfGBIF := map[uint32]uint32{
		5219426: 10, // Panthera onca
		5219404: 11, // Panthera leo
		2436436: 12, // Homo sapiens
	}
	scientific := make([]string, 13)
	scientific[10] = "Panthera onca"
	v, err := Read(path, "en,pt", nodeOfGBIF, scientific)
	if err != nil {
		t.Fatal(err)
	}

	want := []CommonName{
		// "jaguar" twice beats "Jaguar" once.
		{10, "en", "jaguar", 3},
		// Two rows agree on it ("onca  pintada" folds the same), and the
		// accented spelling is kept.
		{10, "pt", "Onça-pintada", 2},
		{10, "pt", "Onca", 1},
		{11, "en", "Lion", 2},
		{11, "en", "African lion", 1},
		{11, "pt", "Leão", 1},
		{12, "en", "Human", 1},
		{12, "pt", "Ser humano", 1},
	}
	if !slices.Equal(v.Names, want) {
		t.Errorf("names:\n got %+v\nwant %+v", v.Names, want)
	}

	if v.RowsRead != 19 {
		t.Errorf("RowsRead = %d, want 19", v.RowsRead)
	}
	// Not counted: es, de (twice), a blank code, and an empty name.
	if v.RowsInLangs != 14 {
		t.Errorf("RowsInLangs = %d, want 14", v.RowsInLangs)
	}
	if v.Unmatched != 1 {
		t.Errorf("Unmatched = %d, want 1", v.Unmatched)
	}
	// "jaguar" twice, "onca  pintada", "LION" and the scientific name.
	if v.Duplicates != 5 {
		t.Errorf("Duplicates = %d, want 5", v.Duplicates)
	}
	if got := v.Count("en"); got != 4 {
		t.Errorf(`Count("en") = %d, want 4`, got)
	}
	if got := v.Count("pt"); got != 4 {
		t.Errorf(`Count("pt") = %d, want 4`, got)
	}
	if got := v.NodesCovered(); got != 3 {
		t.Errorf("NodesCovered() = %d, want 3", got)
	}

	// Every row with a known key counts, whatever its language.
	rows := map[uint32]uint32{10: 8, 11: 6, 12: 4}
	for node, want := range rows {
		if got := v.RowsPerNode[node]; got != want {
			t.Errorf("RowsPerNode[%d] = %d, want %d", node, got, want)
		}
	}

	best := v.BestNames()
	if best[10] != "jaguar" {
		t.Errorf("BestNames()[10] = %q, want jaguar", best[10])
	}
	if best[11] != "Lion" {
		t.Errorf("BestNames()[11] = %q, want Lion", best[11])
	}
}
