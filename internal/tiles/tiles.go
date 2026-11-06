// Package tiles builds the binary blobs the browser draws from (ARCHITECTURE
// §3.6–3.7; docs/tile-format.md gives every byte offset).
//
// Every node lives in exactly one tile, keyed by (level, sector): its LOD
// level and the sector of that level containing its angle. Build buckets
// all nodes that way, Encodes each bucket in format v2 and gzips it; Decode
// reads a raw (ungzipped) tile back, for tests.
//
// The per-node values that tiles and tree.db share (flags, name, the home
// node) are defined here, so the two can never disagree.
//
// Concepts introduced here:
// - `encoding/binary`: little-endian numbers as bytes
// - `io.Writer`, and gzip as a writer that wraps another
// - a hand-written FNV-1a hash
package tiles

import (
	"bytes"
	"cmp"
	"compress/gzip"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"slices"
	"unicode/utf8"

	"species/internal/tree"
)

// Magic is the first four bytes of every tile.
const Magic = "SPT2"

// Version is the format version, byte 4.
const Version uint8 = 2

// HeaderLen is the number of bytes before the first array.
const HeaderLen = 24

// u32Columns is the number of 4-byte arrays (id … parentR) before the three
// u8 arrays.
const u32Columns = 9

// HomeOtt is Homo sapiens. Its node gets FlagHome; it is not a tip in the
// real tree (it has two subspecies), so the flag is on the species node.
const HomeOtt uint32 = 770315

// Flag bits (ARCHITECTURE §3.7). Bits 4–7 are reserved and always 0.
const (
	FlagTip     uint8 = 1 << 0
	FlagNamed   uint8 = 1 << 1
	FlagSpecies uint8 = 1 << 2
	FlagHome    uint8 = 1 << 3
)

// Node is one node as stored in a tile: one row across the tile's arrays.
type Node struct {
	ID        uint32
	Parent    uint32
	Angle     uint32
	ArcLo     uint32
	ArcHi     uint32
	LeafCount uint32
	// FirstTip is the rank of the clade's first tip; its tips are
	// FirstTip .. FirstTip+LeafCount-1.
	FirstTip   uint32
	R          float32
	ParentR    float32
	Group      uint8
	Flags      uint8
	ChildLevel uint8
	// Name is the scientific name; empty for mrca nodes.
	Name string
}

// Tile is a decoded tile: internal nodes first, then tips, each run sorted
// by angle (then id).
type Tile struct {
	Level         uint8
	Sector        uint32
	InternalCount uint32
	Nodes         []Node
}

// Encoded is a finished tile, ready for the tiles table.
type Encoded struct {
	Level  uint8
	Sector uint32
	// Count is the node count, for logs.
	Count uint32
	// RawLen is the ungzipped size, for logs.
	RawLen int
	// Gz is the gzipped blob stored in tree.db and sent as-is to the browser.
	Gz []byte
}

// Set is every tile, plus a hash of their raw bytes for dataVersion.
type Set struct {
	// Tiles are sorted by (level, sector).
	Tiles []Encoded
	// Hash is FNV-1a over every raw tile in order.
	Hash uint64
}

// NodeFlags are the flags of the node with final id (see the Flag
// constants).
func NodeFlags(t *tree.Tree, x *tree.Taxonomy, l *tree.Layout, id int) uint8 {
	node := int(l.Node[id])
	var flags uint8
	if l.IsTip(id) {
		flags |= FlagTip
	}
	if taxon, ok := x.Taxon(node); ok {
		flags |= FlagNamed
		if taxon.Rank == "species" {
			flags |= FlagSpecies
		}
	}
	if isHome(t.Label[node]) {
		flags |= FlagHome
	}
	return flags
}

// isHome reports whether label is Homo sapiens' "ott770315".
func isHome(label tree.Label) bool {
	return label.Kind == tree.LabelOtt && label.Ott == HomeOtt
}

// HomeID is the final id of the home node (Homo sapiens), and false if the
// tree lacks it.
func HomeID(t *tree.Tree, l *tree.Layout) (int, bool) {
	for id := 0; id < l.Len(); id++ {
		if isHome(t.Label[l.Node[id]]) {
			return id, true
		}
	}
	return 0, false
}

// Build buckets every node into its tile, then encodes and gzips each tile.
// Empty tiles are left out.
func Build(t *tree.Tree, x *tree.Taxonomy, l *tree.Layout) (*Set, error) {
	// buckets[level][sector] = final ids in that tile. Levels have 1, 2, 4, …
	// sectors; 16,383 buckets in all for MaxLevel = 13, most of them small.
	buckets := make([][][]uint32, int(l.MaxLevel)+1)
	for level := range buckets {
		buckets[level] = make([][]uint32, 1<<level)
	}
	for id := 0; id < l.Len(); id++ {
		level := l.Level[id]
		sector := tree.SectorOf(l.Angle[id], level)
		buckets[level][sector] = append(buckets[level][sector], uint32(id))
	}

	set := &Set{Hash: fnvOffset}
	for level, sectors := range buckets {
		for sector, ids := range sectors {
			if len(ids) == 0 {
				continue // an empty tile is simply absent
			}
			tile := makeTile(t, x, l, uint8(level), uint32(sector), ids)
			raw := Encode(tile)
			set.Hash = fnv1a(set.Hash, raw)
			gz, err := Gzip(raw)
			if err != nil {
				return nil, fmt.Errorf("gzip tile %d/%d: %w", level, sector, err)
			}
			set.Tiles = append(set.Tiles, Encoded{
				Level:  uint8(level),
				Sector: uint32(sector),
				Count:  uint32(len(ids)),
				RawLen: len(raw),
				Gz:     gz,
			})
		}
	}
	return set, nil
}

// makeTile gathers the nodes ids into a Tile in the order the format wants:
// internal nodes first, each run by angle, the id breaking ties.
func makeTile(t *tree.Tree, x *tree.Taxonomy, l *tree.Layout, level uint8, sector uint32, ids []uint32) Tile {
	ids = slices.Clone(ids)
	// The id breaks ties (a monotypic chain shares one angle), so the order
	// is total and the output deterministic.
	slices.SortFunc(ids, func(a, b uint32) int {
		aTip, bTip := l.IsTip(int(a)), l.IsTip(int(b))
		if aTip != bTip {
			if aTip {
				return 1 // tips after internal nodes
			}
			return -1
		}
		if c := cmp.Compare(l.Angle[a], l.Angle[b]); c != 0 {
			return c
		}
		return cmp.Compare(a, b)
	})

	nodes := make([]Node, 0, len(ids))
	var internalCount uint32
	for _, id := range ids {
		i := int(id)
		parent := l.Parent[i]
		// The root has no parent; its parentR is its own r, so its radial
		// segment has zero length.
		parentR := l.R[i]
		if parent != tree.NoParent {
			parentR = l.R[parent]
		}
		if !l.IsTip(i) {
			internalCount++
		}
		name, _ := x.Name(int(l.Node[i])) // "" when there is no taxon
		nodes = append(nodes, Node{
			ID:         id,
			Parent:     parent,
			Angle:      l.Angle[i],
			ArcLo:      l.ArcLo[i],
			ArcHi:      l.ArcHi[i],
			LeafCount:  l.LeafCount[i],
			FirstTip:   l.FirstTip[i],
			R:          l.R[i],
			ParentR:    parentR,
			Group:      l.Group[i],
			Flags:      NodeFlags(t, x, l, i),
			ChildLevel: l.ChildLevel[i],
			Name:       name,
		})
	}
	return Tile{
		Level:         level,
		Sector:        sector,
		InternalCount: internalCount,
		Nodes:         nodes,
	}
}

// Encode writes tile in binary format v2 (raw, not gzipped).
func Encode(tile Tile) []byte {
	n := len(tile.Nodes)
	namesLen := 0
	for _, node := range tile.Nodes {
		namesLen += len(node.Name)
	}
	out := make([]byte, 0, HeaderLen+n*44+4+namesLen)

	out = append(out, Magic...)
	out = append(out, Version, tile.Level)
	// LEARN: `encoding/binary` turns numbers into bytes in a fixed order.
	// `binary.LittleEndian.AppendUint32(out, v)` appends v's four bytes,
	// least significant first, and returns the grown slice (like `append`).
	// Fixing the byte order in the format means the browser's DataView and
	// typed arrays read the same values whatever CPU wrote them.
	out = binary.LittleEndian.AppendUint16(out, 0) // reserved
	out = binary.LittleEndian.AppendUint32(out, tile.Sector)
	out = binary.LittleEndian.AppendUint32(out, uint32(n))
	out = binary.LittleEndian.AppendUint32(out, tile.InternalCount)
	out = binary.LittleEndian.AppendUint32(out, uint32(namesLen))

	// Column after column ("struct of arrays"), so the client can point a
	// vertex attribute straight at each array.
	for _, node := range tile.Nodes {
		out = binary.LittleEndian.AppendUint32(out, node.ID)
	}
	for _, node := range tile.Nodes {
		out = binary.LittleEndian.AppendUint32(out, node.Parent)
	}
	for _, node := range tile.Nodes {
		out = binary.LittleEndian.AppendUint32(out, node.Angle)
	}
	for _, node := range tile.Nodes {
		out = binary.LittleEndian.AppendUint32(out, node.ArcLo)
	}
	for _, node := range tile.Nodes {
		out = binary.LittleEndian.AppendUint32(out, node.ArcHi)
	}
	for _, node := range tile.Nodes {
		out = binary.LittleEndian.AppendUint32(out, node.LeafCount)
	}
	for _, node := range tile.Nodes {
		out = binary.LittleEndian.AppendUint32(out, node.FirstTip)
	}
	// Floats go out as their IEEE 754 bit pattern, little-endian, which is
	// what a Float32Array in the browser reads.
	for _, node := range tile.Nodes {
		out = binary.LittleEndian.AppendUint32(out, math.Float32bits(node.R))
	}
	for _, node := range tile.Nodes {
		out = binary.LittleEndian.AppendUint32(out, math.Float32bits(node.ParentR))
	}
	for _, node := range tile.Nodes {
		out = append(out, node.Group)
	}
	for _, node := range tile.Nodes {
		out = append(out, node.Flags)
	}
	for _, node := range tile.Nodes {
		out = append(out, node.ChildLevel)
	}
	// The u8 arrays may leave us off a multiple of 4; the offsets array that
	// follows must start 4-byte aligned for a Uint32Array view.
	for len(out)%4 != 0 {
		out = append(out, 0)
	}

	var offset uint32
	out = binary.LittleEndian.AppendUint32(out, offset)
	for _, node := range tile.Nodes {
		offset += uint32(len(node.Name))
		out = binary.LittleEndian.AppendUint32(out, offset)
	}
	for _, node := range tile.Nodes {
		out = append(out, node.Name...)
	}
	return out
}

// Decode reads a raw (ungzipped) v2 tile, checking the magic, version and
// lengths.
func Decode(raw []byte) (Tile, error) {
	if len(raw) < HeaderLen {
		return Tile{}, errors.New("tile shorter than its header")
	}
	if string(raw[0:4]) != Magic {
		return Tile{}, fmt.Errorf("bad tile magic %q", raw[0:4])
	}
	if raw[4] != Version {
		return Tile{}, fmt.Errorf("unsupported tile version %d", raw[4])
	}
	level := raw[5]
	sector := readU32(raw, 8)
	n := int(readU32(raw, 12))
	internalCount := readU32(raw, 16)
	namesLen := int(readU32(raw, 20))

	u8Start := HeaderLen + u32Columns*4*n
	offsetsStart := (u8Start + 3*n + 3) / 4 * 4 // round up to a multiple of 4
	namesStart := offsetsStart + 4*(n+1)
	if len(raw) != namesStart+namesLen {
		return Tile{}, fmt.Errorf("tile is %d bytes, header says %d", len(raw), namesStart+namesLen)
	}
	names := raw[namesStart:]

	// column is the offset of row i in 4-byte array k.
	column := func(k, i int) int { return HeaderLen + k*4*n + 4*i }
	nodes := make([]Node, 0, n)
	for i := 0; i < n; i++ {
		nameLo := int(readU32(raw, offsetsStart+4*i))
		nameHi := int(readU32(raw, offsetsStart+4*(i+1)))
		if nameLo > nameHi || nameHi > namesLen {
			return Tile{}, errors.New("bad name offsets")
		}
		name := names[nameLo:nameHi]
		if !utf8.Valid(name) {
			return Tile{}, errors.New("name is not UTF-8")
		}
		nodes = append(nodes, Node{
			ID:         readU32(raw, column(0, i)),
			Parent:     readU32(raw, column(1, i)),
			Angle:      readU32(raw, column(2, i)),
			ArcLo:      readU32(raw, column(3, i)),
			ArcHi:      readU32(raw, column(4, i)),
			LeafCount:  readU32(raw, column(5, i)),
			FirstTip:   readU32(raw, column(6, i)),
			R:          math.Float32frombits(readU32(raw, column(7, i))),
			ParentR:    math.Float32frombits(readU32(raw, column(8, i))),
			Group:      raw[u8Start+i],
			Flags:      raw[u8Start+n+i],
			ChildLevel: raw[u8Start+2*n+i],
			Name:       string(name),
		})
	}
	return Tile{
		Level:         level,
		Sector:        sector,
		InternalCount: internalCount,
		Nodes:         nodes,
	}, nil
}

// readU32 is the little-endian uint32 at offset; the caller checked the
// length.
func readU32(b []byte, offset int) uint32 {
	return binary.LittleEndian.Uint32(b[offset : offset+4])
}

// Gzip compresses raw at the best level. Go's deflate only matches runs of
// 4+ bytes (zlib also takes 3), so on these float-heavy tiles it ends up
// ~20% larger than zlib's at any level; the best level wins back 2% for
// about 2 s more ingest. dataVersion hashes the raw tiles, so the
// compressor never changes it.
func Gzip(raw []byte) ([]byte, error) {
	// LEARN: `io.Writer` is the interface of anything you can write bytes
	// to: one method, `Write([]byte) (int, error)`. A `bytes.Buffer` is one
	// (it collects the bytes in memory), and so is `gzip.Writer`, which
	// wraps another writer: bytes written into it come out compressed into
	// the inner one. `Close` flushes the last block and the gzip trailer, so
	// the output is incomplete until it returns.
	var buf bytes.Buffer
	zw, err := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	if err != nil {
		return nil, err
	}
	if _, err := zw.Write(raw); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

const (
	fnvOffset uint64 = 0xcbf29ce484222325
	fnvPrime  uint64 = 0x100000001b3
)

// fnv1a continues the FNV-1a hash hash over b (start with fnvOffset).
func fnv1a(hash uint64, b []byte) uint64 {
	for _, c := range b {
		hash ^= uint64(c)
		// Unsigned overflow in Go wraps modulo 2^64, which is what the hash
		// wants.
		hash *= fnvPrime
	}
	return hash
}
