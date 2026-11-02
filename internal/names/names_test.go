// Tests for name folding and placeholder names (names.go).
//
// Concepts introduced here:
// - (none beyond the package's)

package names

import "testing"

func TestFoldsLikeTheFTSTokenizer(t *testing.T) {
	cases := []struct{ in, want string }{
		{"Onça-pintada ", "onca pintada"},
		{"  onca   PINTADA", "onca pintada"},
		{"Leão", "leao"},
		{"Lion's mane", "lion s mane"},
		{"Homo sapiens", "homo sapiens"},
		{"--", ""},
	}
	for _, c := range cases {
		if got := Fold(c.in); got != c.want {
			t.Errorf("Fold(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestSpotsPlaceholderNames(t *testing.T) {
	cases := []struct {
		name string
		want bool
	}{
		{"h2007-1", true},
		{"Fungi incertae sedis", true},
		{"unclassified Bacteria", true},
		{"environmental samples", true},
		{"Homininae", false},
		{"h2007", false},
		{"hominoid-1", false},
		{"BD1-5", false},
	}
	for _, c := range cases {
		if got := IsPlaceholder(c.name); got != c.want {
			t.Errorf("IsPlaceholder(%q) = %v, want %v", c.name, got, c.want)
		}
	}
}
