// The OTT taxonomy (taxonomy.tsv): name, rank and source ids for the nodes
// of our tree (ARCHITECTURE §2.2, §3.1). Only rows whose uid is in the tree are
// kept; the ~2M others are skipped without allocating.
//
// Memory layout: every kept name is appended
// to one big string, and each node stores where its name starts and ends;
// ranks are interned (a small index per node into a short list of rank
// strings); GBIF and NCBI ids are plain uint32 slices with NoID for none.
// So the taxonomy holds a handful of large slices and no per-node pointers.
//
// OTT's `flags` column is not kept: nothing uses it.
//
// Concepts introduced here:
// - `bufio.Scanner` for reading a file line by line
// - `bytes.Cut` for splitting without allocating
// - substrings share the memory of the string they come from

package tree

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"strings"
	"unicode/utf8"
)

// Taxon is what the taxonomy knows about one node.
type Taxon struct {
	Name string
	Rank string
	GBIF uint32 // NoID if none
	NCBI uint32 // NoID if none
}

// Taxonomy is the OTT data for the nodes of one tree, by node index.
type Taxonomy struct {
	// RowsRead counts data rows in the file (not the header).
	RowsRead int
	// Missing counts tree nodes with an OTT label but no taxonomy row.
	Missing int

	// names holds every kept name back to back; node i's name is
	// names[nameStart[i]:nameEnd[i]].
	names     string
	nameStart []uint32
	nameEnd   []uint32
	// rank[i] indexes ranks; 0 means node i has no taxon at all.
	rank  []uint8
	ranks []string
	gbif  []uint32
	ncbi  []uint32
}

// NewTaxonomy is a taxonomy for n nodes, none of which has a taxon.
func NewTaxonomy(n int) *Taxonomy {
	x := &Taxonomy{
		nameStart: make([]uint32, n),
		nameEnd:   make([]uint32, n),
		rank:      make([]uint8, n),
		// Index 0 is "no taxon", so a real (even empty) rank never gets it.
		ranks: []string{""},
		gbif:  make([]uint32, n),
		ncbi:  make([]uint32, n),
	}
	for i := range n {
		x.gbif[i] = NoID
		x.ncbi[i] = NoID
	}
	return x
}

// ReadTaxonomy reads taxonomy.tsv and keeps the rows for the nodes of t.
// A short row or a bad uid is an error naming the path and line.
//
// The file is 417 MB with about 4.5M rows, so it is streamed line by line.
// Its rows look like
//
//	770315\t|\t770309\t|\tHomo sapiens\t|\tspecies\t|\tncbi:9606,…\t|\t\t|\textinct\t|\t
//
// after a header row: the separator is "\t|\t", and every line also ends
// with one.
func ReadTaxonomy(path string, t *Tree) (*Taxonomy, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	nodeOfOtt := t.OttIndex()
	x := NewTaxonomy(t.Len())
	var names strings.Builder
	rankIndex := make(map[string]uint8)

	// LEARN: a `bufio.Scanner` reads a file in large chunks and hands it
	// out one line at a time: `Scan()` advances (false at the end or on an
	// error, which `Err()` then reports) and `Bytes()` is the current line
	// without its "\n". The slice points into the scanner's own buffer and
	// is overwritten by the next Scan, so anything kept must be copied. The
	// default line limit is 64 KiB; Buffer raises it, to be safe.
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 1<<20), 64<<20)

	var fields [][]byte // reused for every line
	lineNumber := 0
	for scanner.Scan() {
		line := scanner.Bytes()
		lineNumber++
		// Names end up in JSON and the FTS index, so they must be UTF-8.
		if !utf8.Valid(line) {
			return nil, fmt.Errorf("%s line %d: not valid UTF-8", path, lineNumber)
		}

		fields = splitRow(fields, line)
		if lineNumber == 1 && string(fields[0]) == "uid" {
			continue // the header
		}
		x.RowsRead++
		if len(fields) < 7 {
			return nil, fmt.Errorf("%s line %d: expected 7 fields, found %d", path, lineNumber, len(fields))
		}

		// Most rows are not in the tree. Check the uid before copying
		// anything, so skipped rows cost almost nothing.
		uid, ok := parseUint32(fields[0])
		if !ok {
			return nil, fmt.Errorf("%s line %d: bad uid %q", path, lineNumber, fields[0])
		}
		node, ok := nodeOfOtt[uid]
		if !ok {
			continue
		}

		// The name is copied onto the end of one big string, and the node
		// remembers where it starts and ends.
		x.nameStart[node] = uint32(names.Len())
		names.Write(fields[2])
		x.nameEnd[node] = uint32(names.Len())

		// The compiler turns m[string(b)] into a lookup that does not
		// allocate; only a rank not seen before is copied.
		rank, ok := rankIndex[string(fields[3])]
		if !ok {
			if len(x.ranks) > 255 {
				return nil, fmt.Errorf("%s line %d: more than 255 distinct ranks", path, lineNumber)
			}
			rank = uint8(len(x.ranks))
			x.ranks = append(x.ranks, string(fields[3]))
			rankIndex[string(fields[3])] = rank
		}
		x.rank[node] = rank
		x.gbif[node], x.ncbi[node] = ParseSourceinfo(fields[4])
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}
	x.names = names.String()

	for node, label := range t.Label {
		if label.Kind == LabelOtt && x.rank[node] == 0 {
			x.Missing++
		}
	}
	return x, nil
}

// Taxon is node's taxon, and false if it has none.
func (x *Taxonomy) Taxon(node int) (Taxon, bool) {
	name, ok := x.Name(node)
	if !ok {
		return Taxon{}, false
	}
	return Taxon{
		Name: name,
		Rank: x.ranks[x.rank[node]],
		GBIF: x.gbif[node],
		NCBI: x.ncbi[node],
	}, true
}

// Name is node's scientific name without allocating, and false if it has
// no taxon.
func (x *Taxonomy) Name(node int) (string, bool) {
	if x.rank[node] == 0 {
		return "", false
	}
	// LEARN: slicing a string, s[i:j], makes a new string header pointing
	// into the same bytes: no copy, no allocation. Go strings are
	// immutable, so sharing is safe. (The flip side: one small substring
	// keeps the whole big string alive, which is fine here, as the names
	// live as long as the taxonomy.)
	return x.names[x.nameStart[node]:x.nameEnd[node]], true
}

// splitRow splits one taxonomy.tsv line on "\t|\t", after removing the line
// ending and the trailing "\t|\t". It appends the fields to fields[:0] and
// returns that, so one buffer serves every line.
func splitRow(fields [][]byte, line []byte) [][]byte {
	line = bytes.TrimRight(line, "\r\n")
	// Lenient about a missing trailing separator.
	line, _ = bytes.CutSuffix(line, []byte("\t|\t"))
	fields = fields[:0]
	rest := line
	for {
		// LEARN: `bytes.Cut(s, sep)` splits s around the first sep and
		// returns (before, after, found). Both halves are sub-slices of s,
		// so splitting a line this way allocates nothing.
		field, after, found := bytes.Cut(rest, []byte("\t|\t"))
		fields = append(fields, field)
		if !found {
			return fields
		}
		rest = after
	}
}

// ParseSourceinfo finds the first gbif and the first ncbi id in a
// sourceinfo field ("ncbi:9606,gbif:2436436,irmng:…"); NoID when absent.
// Some taxa list a source twice ("gbif:106,gbif:8029077"); the first one is
// OTT's primary. An id that does not parse is skipped, so a later entry of
// the same source can still win.
func ParseSourceinfo(sourceinfo []byte) (gbif, ncbi uint32) {
	gbif, ncbi = NoID, NoID
	rest := sourceinfo
	for {
		entry, after, more := bytes.Cut(rest, []byte(","))
		source, id, ok := bytes.Cut(entry, []byte(":"))
		if ok {
			if string(source) == "gbif" && gbif == NoID {
				gbif = parseOrNoID(id)
			} else if string(source) == "ncbi" && ncbi == NoID {
				ncbi = parseOrNoID(id)
			}
		}
		if !more {
			return gbif, ncbi
		}
		rest = after
	}
}

// parseOrNoID parses an id, NoID if it is not a number.
func parseOrNoID(digits []byte) uint32 {
	n, ok := parseUint32(digits)
	if !ok {
		return NoID
	}
	return n
}
