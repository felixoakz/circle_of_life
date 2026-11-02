// Unit tests of the iNaturalist helpers.
//
// Concepts introduced here:
// - (none beyond the package's)

package enrich

import "testing"

func TestCreditNameFromAttribution(t *testing.T) {
	tests := []struct{ attribution, want string }{
		{"(c) Olli Pihlajamaa, some rights reserved (CC BY-NC), uploaded by Olli Pihlajamaa", "Olli Pihlajamaa"},
		{"Jane Doe", "Jane Doe"},
	}
	for _, tt := range tests {
		if got := CreditName(tt.attribution); got != tt.want {
			t.Errorf("CreditName(%q) = %q, want %q", tt.attribution, got, tt.want)
		}
	}
}
