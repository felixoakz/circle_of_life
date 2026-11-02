// Unit tests for the ingest report helpers (ingest.go). The end-to-end
// ingest tests are in ingest_test.go, in the external package ingest_test.
//
// Concepts introduced here:
// - (none beyond the package's)

package ingest

import "testing"

func TestThousandsSeparators(t *testing.T) {
	cases := []struct {
		n    int
		want string
	}{
		{0, "0"},
		{999, "999"},
		{1000, "1,000"},
		{2725682, "2,725,682"},
	}
	for _, c := range cases {
		if got := thousands(c.n); got != c.want {
			t.Errorf("thousands(%d) = %q, want %q", c.n, got, c.want)
		}
	}
}
