// Level of detail: which zoom level a node first appears at, and which tile
// (sector) stores it (PLAN §3.6).
//
// At level L the circle is cut into 2^L equal sectors. A node is introduced
// at the smallest level where `leafCount · P · 2^L ≥ N`, with N the number
// of tips. Big clades come in early, single tips last, at MaxLevel.
//
// Concepts introduced here:
// - bit shifts as multiply/divide by powers of two
// - Go defines shifts by the full bit width or more (they give 0)

package tree

// P is the tile-size knob: roughly how many nodes one tile holds (stored in
// meta as tileP).
const P uint64 = 512

// NoChildLevel is the child level of a tip: it has no children to introduce.
const NoChildLevel uint8 = 255

// IntroLevel is the smallest L with leafCount · P · 2^L ≥ tipCount.
func IntroLevel(leafCount, tipCount uint32) uint8 {
	// uint64 so leafCount · P · 2^L cannot overflow: at most 2.4M · 512 · 2^13.
	lhs := uint64(leafCount) * P
	var level uint8
	// LEARN: `x << n` shifts the bits of x left by n places, multiplying by
	// 2^n (as long as nothing falls off the top); `x >> n` divides by 2^n.
	for lhs<<level < uint64(tipCount) {
		level++
	}
	return level
}

// MaxLevel is Lmax, the level of a single tip: 13 for the full tree.
func MaxLevel(tipCount uint32) uint8 {
	return IntroLevel(1, tipCount)
}

// SectorWidth is the width of one sector at level, in angle units
// (2^32 / 2^level).
func SectorWidth(level uint8) uint64 {
	return (uint64(1) << 32) >> level
}

// SectorOf is the sector at level containing angle: its top level bits.
func SectorOf(angle uint32, level uint8) uint32 {
	// LEARN: Go defines shifts by the full bit width or more: a uint32
	// shifted right by 32 is simply 0, never a panic (C leaves it
	// undefined). So `angle >> 32` would already give the right answer at
	// level 0; the branch stays to make level 0 obvious.
	if level == 0 {
		return 0
	}
	return angle >> (32 - uint32(level))
}
