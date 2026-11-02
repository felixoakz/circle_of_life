// Tests for the level of detail (lod.go).
//
// Concepts introduced here:
// - (none beyond the package's)

package tree

import (
	"math"
	"testing"
)

func TestLevelsOnTheFullTreeSize(t *testing.T) {
	const n = 2_385_875
	if got := MaxLevel(n); got != 13 {
		t.Errorf("MaxLevel(%d) = %d, want 13", n, got)
	}
	cases := []struct {
		name      string
		leafCount uint32
		want      uint8
	}{
		{"the root", n, 0},
		// 512 · 2^12 = 2,097,152 < N, so a single tip needs level 13.
		{"a single tip", 1, 13},
		// A clade of 4,660 tips: 4660 · 512 = 2,385,920 ≥ N.
		{"4660 tips", 4660, 0},
		{"4659 tips", 4659, 1},
	}
	for _, c := range cases {
		if got := IntroLevel(c.leafCount, n); got != c.want {
			t.Errorf("%s: IntroLevel(%d, %d) = %d, want %d", c.name, c.leafCount, n, got, c.want)
		}
	}
}

func TestSectors(t *testing.T) {
	cases := []struct {
		angle uint32
		level uint8
		want  uint32
	}{
		{math.MaxUint32, 0, 0},
		{math.MaxUint32, 1, 1},
		{1 << 31, 1, 1},
		{1<<31 - 1, 1, 0},
		{math.MaxUint32, 13, 1<<13 - 1},
	}
	for _, c := range cases {
		if got := SectorOf(c.angle, c.level); got != c.want {
			t.Errorf("SectorOf(%d, %d) = %d, want %d", c.angle, c.level, got, c.want)
		}
	}
	if got := SectorWidth(0); got != 1<<32 {
		t.Errorf("SectorWidth(0) = %d, want 2^32", got)
	}
	if got := SectorWidth(13); got != 1<<19 {
		t.Errorf("SectorWidth(13) = %d, want 2^19", got)
	}
}
