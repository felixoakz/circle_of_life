// Tests for the tile format (tiles.go): round trip, byte layout, bad input
// and the FNV-1a hash.
//
// Concepts introduced here:
// - (none beyond the package's)

package tiles

import (
	"reflect"
	"testing"

	"species/internal/tree"
)

// sampleNode is one node of sampleTile.
func sampleNode(id, angle uint32, tip bool, name string) Node {
	n := Node{
		ID:         id,
		Parent:     0,
		Angle:      angle,
		ArcLo:      angle,
		ArcHi:      angle,
		LeafCount:  1,
		FirstTip:   id,
		R:          float32(0.5) + float32(id)/10.0,
		ParentR:    0.08,
		Group:      3,
		Flags:      0,
		ChildLevel: 4,
		Name:       name,
	}
	if id == 0 {
		n.Parent = tree.NoParent
		n.Group = 255
	}
	if tip {
		n.Flags = FlagTip | FlagNamed
		n.ChildLevel = 255
	}
	return n
}

// sampleTile is one internal node and two named tips.
func sampleTile() Tile {
	return Tile{
		Level:         4,
		Sector:        9,
		InternalCount: 1,
		Nodes: []Node{
			sampleNode(0, 100, false, ""),
			sampleNode(1, 50, true, "Homo sapiens"),
			sampleNode(2, 150, true, "Onça ü"), // non-ASCII survives
		},
	}
}

func TestEncodeDecodeRoundTrip(t *testing.T) {
	tile := sampleTile()
	got, err := Decode(Encode(tile))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, tile) {
		t.Errorf("Decode(Encode(tile)) = %+v, want %+v", got, tile)
	}
}

func TestHeaderAndAlignment(t *testing.T) {
	raw := Encode(sampleTile())
	if len(raw) < 152 {
		t.Fatalf("tile is only %d bytes", len(raw))
	}
	if string(raw[0:4]) != "SPT2" {
		t.Errorf("magic = %q, want SPT2", raw[0:4])
	}
	if raw[4] != 2 {
		t.Errorf("version = %d, want 2", raw[4])
	}
	if raw[5] != 4 {
		t.Errorf("level = %d, want 4", raw[5])
	}
	if got := readU32(raw, 8); got != 9 {
		t.Errorf("sector = %d, want 9", got)
	}
	if got := readU32(raw, 12); got != 3 {
		t.Errorf("node count = %d, want 3", got)
	}
	// n = 3: 24 + 9·12 = 132, u8 arrays end at 141, offsets start at 144.
	namesLen := len("Homo sapiens") + len("Onça ü")
	if got := readU32(raw, 20); int(got) != namesLen {
		t.Errorf("names length = %d, want %d", got, namesLen)
	}
	if got := readU32(raw, 144); got != 0 {
		t.Errorf("offset[0] = %d, want 0", got)
	}
	if got := readU32(raw, 148); got != 0 {
		t.Errorf("offset[1] = %d, want 0 (the internal node has no name)", got)
	}
	if want := 144 + 4*4 + namesLen; len(raw) != want {
		t.Errorf("len = %d, want %d", len(raw), want)
	}
}

func TestDecodeRejectsGarbage(t *testing.T) {
	badMagic := Encode(sampleTile())
	badMagic[0] = 'X'
	good := Encode(sampleTile())
	truncated := good[:len(good)-1]

	cases := []struct {
		name string
		raw  []byte
	}{
		{"too short", []byte("nope")},
		{"bad magic", badMagic},
		{"one byte short", truncated},
	}
	for _, c := range cases {
		if _, err := Decode(c.raw); err == nil {
			t.Errorf("%s: Decode succeeded, want an error", c.name)
		}
	}
}

func TestFNV1aKnownValue(t *testing.T) {
	// Published FNV-1a 64 test vector for "a".
	if got := fnv1a(fnvOffset, []byte("a")); got != 0xaf63dc4c8601ec8c {
		t.Errorf("fnv1a(\"a\") = %#x, want 0xaf63dc4c8601ec8c", got)
	}
}
