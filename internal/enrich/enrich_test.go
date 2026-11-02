// Unit tests of the document assembly helpers: the generated sentence,
// fallbacks, HTML stripping, number formatting, common-name dedupe, the
// minimal document, and the document's JSON shape.
//
// Concepts introduced here:
// - (none beyond the package's)

package enrich

import (
	"bytes"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"
)

func testAncestor(name, rank string, ott uint32) Ancestor {
	return Ancestor{
		NodeID: fmt.Sprintf("ott%d", ott),
		Ott:    new(ott),
		Name:   name,
		Rank:   new(rank),
	}
}

func testBeetle() Taxon {
	return Taxon{
		NodeID:    "ott3349025",
		Ott:       new(uint32(3349025)),
		Name:      "Pselaphus heisei",
		Rank:      new("species"),
		GBIF:      new(int64(4440809)),
		LeafCount: 1,
		Ancestors: []Ancestor{
			testAncestor("Pselaphus", "genus", 3349021),
			testAncestor("Pselaphinae", "subfamily", 1),
			testAncestor("Staphylinidae", "family", 2),
			testAncestor("Coleoptera", "order", 3),
		},
	}
}

func TestGeneratedSentenceForASpecies(t *testing.T) {
	occ := Occurrences{Total: 1881, Countries: []CountryCount{}, CountryTotal: 24}
	gbif := SpeciesInfo{Authorship: new("Herbst, 1791")}
	got := GeneratedSentence(testBeetle(), &gbif, &occ)
	want := "Pselaphus heisei Herbst, 1791 is a species in the family Staphylinidae. " +
		"GBIF has 1,881 occurrence records of it from 24 countries."
	if got != want {
		t.Errorf("got  %q\nwant %q", got, want)
	}
}

func TestGeneratedSentenceFillsTreeGapsFromGBIF(t *testing.T) {
	// The synth lineage of the coelacanth has no ranked family, and OTT
	// gives the species itself "no rank"; GBIF knows both.
	taxon := testBeetle()
	taxon.Name = "Latimeria chalumnae"
	taxon.Rank = new("no rank")
	taxon.LeafCount = 2
	taxon.Ancestors = []Ancestor{testAncestor("Vertebrata", "subphylum", 1)}
	gbif := SpeciesInfo{
		Authorship: new("Smith, 1939"),
		Rank:       new("species"),
		Family:     new("Latimeriidae"),
	}
	got := GeneratedSentence(taxon, &gbif, nil)
	want := "Latimeria chalumnae Smith, 1939 is a species in the family Latimeriidae."
	if got != want {
		t.Errorf("got  %q\nwant %q", got, want)
	}
}

func TestGeneratedSentenceForACladeWithoutData(t *testing.T) {
	taxon := testBeetle()
	taxon.Name = "Staphylinidae"
	taxon.Rank = new("family")
	taxon.LeafCount = 64_000
	taxon.Ancestors = []Ancestor{testAncestor("Coleoptera", "order", 3)}
	none := Occurrences{Total: 0, Countries: []CountryCount{}, CountryTotal: 0}
	got := GeneratedSentence(taxon, nil, &none)
	want := "Staphylinidae is a family in the order Coleoptera, with 64,000 species in the " +
		"Open Tree synthesis. GBIF has no occurrence records of it."
	if got != want {
		t.Errorf("got  %q\nwant %q", got, want)
	}

	taxon.Rank = new("no rank")
	taxon.Ancestors = []Ancestor{testAncestor("Polyphaga", "suborder", 4)}
	got = GeneratedSentence(taxon, nil, nil)
	want = "Staphylinidae is a taxon in Polyphaga, with 64,000 species in the Open Tree synthesis."
	if got != want {
		t.Errorf("got  %q\nwant %q", got, want)
	}
}

func TestFallbacksAreGenusFamilyOrderOnly(t *testing.T) {
	var names []string
	for _, a := range testBeetle().Fallbacks() {
		names = append(names, a.Name)
	}
	if want := []string{"Pselaphus", "Staphylinidae", "Coleoptera"}; !slices.Equal(names, want) {
		t.Errorf("fallbacks = %v, want %v", names, want)
	}
}

func TestStripHTMLKeepsTextOnly(t *testing.T) {
	tests := []struct{ html, want string }{
		{`<a href="//commons.wikimedia.org/wiki/User:T" title="User:T">Thiago &amp; Co</a>`, "Thiago & Co"},
		{"Smith (1939). <em>Nature (London).</em> v. 143", "Smith (1939). Nature (London). v. 143"},
		{"<span>Jane</span>, <i>2001</i>", "Jane, 2001"},
	}
	for _, tt := range tests {
		if got := StripHTML(tt.html); got != tt.want {
			t.Errorf("StripHTML(%q) = %q, want %q", tt.html, got, tt.want)
		}
	}
}

func TestThousandsSeparators(t *testing.T) {
	tests := []struct {
		n    uint64
		want string
	}{
		{0, "0"},
		{999, "999"},
		{1000, "1,000"},
		{146_418, "146,418"},
		{1_234_567, "1,234,567"},
	}
	for _, tt := range tests {
		if got := Thousands(tt.n); got != tt.want {
			t.Errorf("Thousands(%d) = %q, want %q", tt.n, got, tt.want)
		}
	}
}

func TestCommonNamesAreDeduplicated(t *testing.T) {
	var names []string
	names = pushName(names, "jaguar", "Panthera onca")
	names = pushName(names, "Jaguar", "Panthera onca")
	names = pushName(names, "Panthera onca", "Panthera onca")
	if want := []string{"jaguar"}; !slices.Equal(names, want) {
		t.Errorf("names = %v, want %v", names, want)
	}
}

func TestMinimalDocumentForUnnamedClades(t *testing.T) {
	doc := Minimal("mrcaott1ott2", "Felidae", 12, 5)
	if !doc.Complete {
		t.Error("minimal document is not complete")
	}
	want := "An unnamed clade within Felidae, with 12 species in the Open Tree synthesis."
	if doc.Generated != want {
		t.Errorf("Generated = %q, want %q", doc.Generated, want)
	}
	if !strings.HasSuffix(doc.Links.Opentree, "@mrcaott1ott2") {
		t.Errorf("Links.Opentree = %q", doc.Links.Opentree)
	}
}

// topLevelKeys are the keys of a JSON object, in order.
func topLevelKeys(t *testing.T, data []byte) []string {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader(data))
	if _, err := dec.Token(); err != nil { // the opening {
		t.Fatal(err)
	}
	var keys []string
	for dec.More() {
		key, err := dec.Token()
		if err != nil {
			t.Fatal(err)
		}
		keys = append(keys, key.(string))
		var skip json.RawMessage
		if err := dec.Decode(&skip); err != nil {
			t.Fatal(err)
		}
	}
	return keys
}

func TestMinimalDocumentShapeMatchesTheFullOne(t *testing.T) {
	// The client reads both with one type: same keys either way.
	minimal, err := json.Marshal(Minimal("mrcaott1ott2", "", 3, 0))
	if err != nil {
		t.Fatal(err)
	}
	full, err := json.Marshal(About{})
	if err != nil {
		t.Fatal(err)
	}
	if a, b := topLevelKeys(t, minimal), topLevelKeys(t, full); !slices.Equal(a, b) {
		t.Errorf("minimal keys %v\nfull keys    %v", a, b)
	}
	// The minimal document's lists are [], never null.
	for _, field := range []string{`"commonNames":[]`, `"failed":[]`} {
		if !bytes.Contains(minimal, []byte(field)) {
			t.Errorf("minimal document lacks %s: %s", field, minimal)
		}
	}
}

// A country count is a two-element array in JSON, ["BR", 120], both ways
// (cached documents are read back).
func TestCountryCountJSONRoundTrip(t *testing.T) {
	countries := []CountryCount{{Code: "BR", Count: 120}, {Code: "AR", Count: 3}}
	data, err := json.Marshal(countries)
	if err != nil {
		t.Fatal(err)
	}
	if want := `[["BR",120],["AR",3]]`; string(data) != want {
		t.Errorf("marshal = %s, want %s", data, want)
	}
	var back []CountryCount
	if err := json.Unmarshal(data, &back); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(back, countries) {
		t.Errorf("round trip = %v, want %v", back, countries)
	}

	dist := Distribution{Occurrences: 123, Countries: countries[:1], CountryTotal: 1, GBIFKey: 5219426}
	data, err = json.Marshal(dist)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"occurrences":123,"countries":[["BR",120]],"countryTotal":1,"gbifKey":5219426,"bbox":null}`
	if string(data) != want {
		t.Errorf("distribution = %s\nwant           %s", data, want)
	}

	var bad CountryCount
	for _, input := range []string{`{"code":"BR"}`, `["BR"]`, `["BR",-1]`, `[120,"BR"]`} {
		if err := json.Unmarshal([]byte(input), &bad); err == nil {
			t.Errorf("unmarshal %s: want an error, got %v", input, bad)
		}
	}
}
