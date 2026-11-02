// Unit tests of the Wikipedia URL builders and the path-segment escaper.
//
// The expected strings follow the WHATWG URL path-segment rules (see
// wikipedia.go), which differ from Go's url.PathEscape.
//
// Concepts introduced here:
// - (none beyond the package's)

package enrich

import "testing"

func TestSummaryURLEncodesTheTitleAsOneSegment(t *testing.T) {
	got, err := SummaryURL("https://en.wikipedia.org/api/rest_v1", "AC/DC band")
	if err != nil {
		t.Fatal(err)
	}
	if want := "https://en.wikipedia.org/api/rest_v1/page/summary/AC%2FDC_band"; got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}

func TestPortugueseURL(t *testing.T) {
	if got, want := PtURL("Onça-pintada"), "https://pt.wikipedia.org/wiki/On%C3%A7a-pintada"; got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}

// SummaryURL and PtURL keep `()!*'` as they are (Go's url.PathEscape
// would encode them).
func TestSummaryURLKeepsSafePunctuation(t *testing.T) {
	const base = "https://en.wikipedia.org/api/rest_v1"
	tests := []struct{ title, want string }{
		{"Felis (genus)", base + "/page/summary/Felis_(genus)"},
		{"Hello!*'()", base + "/page/summary/Hello!*'()"},
		{"x;y,z=w:@&$+[]|^~", base + "/page/summary/x;y,z=w:@&$+[]|^~"},
		{"a\"b#c<d>e?f`g{h}i\\j%k", base + "/page/summary/a%22b%23c%3Cd%3Ee%3Ff%60g%7Bh%7Di%5Cj%25k"},
		{"Ελληνικά", base + "/page/summary/%CE%95%CE%BB%CE%BB%CE%B7%CE%BD%CE%B9%CE%BA%CE%AC"},
		{"a\x7fb", base + "/page/summary/a%7Fb"},
	}
	for _, tt := range tests {
		got, err := SummaryURL(base, tt.title)
		if err != nil {
			t.Errorf("SummaryURL(%q): %v", tt.title, err)
			continue
		}
		if got != tt.want {
			t.Errorf("SummaryURL(%q)\ngot  %s\nwant %s", tt.title, got, tt.want)
		}
	}
	if got, want := PtURL("Onça pintada (felino)"), "https://pt.wikipedia.org/wiki/On%C3%A7a_pintada_(felino)"; got != want {
		t.Errorf("PtURL\ngot  %s\nwant %s", got, want)
	}
}

// The escaper on its own, including the space SummaryURL never
// passes it (it turns spaces into "_" first).
func TestEscapePathSegment(t *testing.T) {
	tests := []struct{ in, want string }{
		{"", ""},
		{"Jaguar", "Jaguar"},
		{"a b", "a%20b"},
		{"a\x01b", "a%01b"},
		{"AC/DC", "AC%2FDC"},
		{"100%", "100%25"},
		{"Onça pintada", "On%C3%A7a%20pintada"},
		{"()!*'", "()!*'"},
		{"-._~", "-._~"},
		{"\"#<>?`{}\\", "%22%23%3C%3E%3F%60%7B%7D%5C"},
	}
	for _, tt := range tests {
		if got := escapePathSegment(tt.in); got != tt.want {
			t.Errorf("escapePathSegment(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}
