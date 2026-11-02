// Unit tests of the GBIF helpers.
//
// Concepts introduced here:
// - (none beyond the package's)

package enrich

import "testing"

func TestThresholdIsThreeOrOnePerMille(t *testing.T) {
	tests := []struct{ total, want uint64 }{
		{0, 3},
		{2_000, 3},
		{146_418, 147},
	}
	for _, tt := range tests {
		if got := CountryThreshold(tt.total); got != tt.want {
			t.Errorf("CountryThreshold(%d) = %d, want %d", tt.total, got, tt.want)
		}
	}
}
