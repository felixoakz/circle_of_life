// Tests for parsing node refs and building FTS5 queries. (fold and the
// placeholder-name check live in internal/names and are tested there.)
//
// Numbers in a node ref accept one leading '+'.
//
// Concepts introduced here:
// - (none beyond the package's)

package db

import "testing"

func TestParsesNodeRefs(t *testing.T) {
	good := []struct {
		text string
		want NodeRef
	}{
		{"1134830", NodeRef{Kind: RefID, Num: 1134830}},
		{"ott770315", NodeRef{Kind: RefOtt, Num: 770315}},
		{"mrcaott786ott3428", NodeRef{Kind: RefMrca, Mrca: "mrcaott786ott3428"}},
	}
	for _, c := range good {
		got, err := ParseNodeRef(c.text)
		if err != nil {
			t.Errorf("ParseNodeRef(%q): %v", c.text, err)
			continue
		}
		if got != c.want {
			t.Errorf("ParseNodeRef(%q) = %+v, want %+v", c.text, got, c.want)
		}
	}
	for _, bad := range []string{"ott", "ottx1", "felis", "-1"} {
		if got, err := ParseNodeRef(bad); err == nil {
			t.Errorf("ParseNodeRef(%q) = %+v, want an error", bad, got)
		}
	}
}

// The API accepts /api/nodes/+5 and /api/nodes/ott+5. Go's
// strconv.ParseUint rejects '+', so parseU32 strips one first.
func TestNodeRefsAcceptALeadingPlus(t *testing.T) {
	good := []struct {
		text string
		want NodeRef
	}{
		{"+5", NodeRef{Kind: RefID, Num: 5}},
		{"ott+5", NodeRef{Kind: RefOtt, Num: 5}},
		{"4294967295", NodeRef{Kind: RefID, Num: 4294967295}},
	}
	for _, c := range good {
		got, err := ParseNodeRef(c.text)
		if err != nil {
			t.Errorf("ParseNodeRef(%q): %v", c.text, err)
			continue
		}
		if got != c.want {
			t.Errorf("ParseNodeRef(%q) = %+v, want %+v", c.text, got, c.want)
		}
	}
	// Still rejected: a lone sign, a minus, two signs, spaces and
	// numbers past uint32.
	for _, bad := range []string{"", "+", "ott+", "ott-1", "++5", " 5", "5 ", "4294967296"} {
		if got, err := ParseNodeRef(bad); err == nil {
			t.Errorf("ParseNodeRef(%q) = %+v, want an error", bad, got)
		}
	}
}

func TestBuildsFTSQueries(t *testing.T) {
	cases := []struct {
		query  string
		prefix bool
		want   string
		ok     bool
	}{
		{"homo  sap", true, `"homo"* AND "sap"*`, true},
		{`a"b`, true, `"ab"*`, true},
		{"ox", false, `"ox"`, true},
		{`" "`, true, "", false},
	}
	for _, c := range cases {
		got, ok := FTSQuery(c.query, c.prefix)
		if got != c.want || ok != c.ok {
			t.Errorf("FTSQuery(%q, %v) = %q, %v; want %q, %v",
				c.query, c.prefix, got, ok, c.want, c.ok)
		}
	}
}
