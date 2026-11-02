// Package vernacular reads common names (P11) from GBIF's
// VernacularName.tsv and keeps the ones in the wanted languages (English
// and Portuguese by default) for the nodes of our tree.
//
// The file lives inside the 971 MB GBIF backbone.zip and is never unpacked
// to disk: for a .zip path ingest runs `unzip -p <zip> VernacularName.tsv`
// as a child process and reads its stdout as it streams. "-" reads the same
// text from stdin, and any other path is read as a plain .tsv file (the test
// fixtures). Columns are found by their header names; taxonID is a GBIF
// backbone key, joined to our nodes through OTT's sourceinfo.
//
// Concepts introduced here:
// - running a child process with `os/exec` and reading its stdout pipe
// - `defer` for clean-up
// - structs as map keys
package vernacular

import (
	"bufio"
	"cmp"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"species/internal/names"
)

// ZipMember is the file we want inside backbone.zip.
const ZipMember = "VernacularName.tsv"

// CommonName is one common name for one node of our tree.
type CommonName struct {
	// Node is the pre-order node id (nodes.id).
	Node uint32
	// Lang is the two-letter language code, "en" or "pt".
	Lang string
	// Name is trimmed, with runs of spaces collapsed: "Onça-pintada".
	Name string
	// Support is how many rows gave this name (ignoring case and accents).
	Support uint32
}

// Vernaculars are the names kept, plus counts for the ingest report.
type Vernaculars struct {
	// Names are sorted by node, then language, then best supported first
	// (a stable sort, so equal support keeps the file's order).
	Names []CommonName
	// RowsPerNode maps node id → rows for that node in any language: a
	// rough measure of how well known a taxon is.
	RowsPerNode map[uint32]uint32
	// RowsRead counts data rows (not the header).
	RowsRead int
	// RowsInLangs counts rows in a wanted language.
	RowsInLangs int
	// Unmatched counts rows in a wanted language whose taxonID is on none
	// of our nodes.
	Unmatched int
	// Duplicates counts rows dropped as repeats of a kept name (same
	// language, ignoring case, accents and punctuation) or of the node's
	// scientific name.
	Duplicates int
}

// Count is how many names were kept in lang.
func (v *Vernaculars) Count(lang string) int {
	n := 0
	for _, name := range v.Names {
		if name.Lang == lang {
			n++
		}
	}
	return n
}

// NodesCovered is how many distinct nodes have at least one name.
func (v *Vernaculars) NodesCovered() int {
	// Names is sorted by node, so a new node starts wherever the id differs
	// from the previous entry's.
	n := 0
	for i, name := range v.Names {
		if i == 0 || v.Names[i-1].Node != name.Node {
			n++
		}
	}
	return n
}

// BestNames maps each named node to its display name: its best supported
// English name, else its best Portuguese one.
func (v *Vernaculars) BestNames() map[uint32]string {
	best := make(map[uint32]string)
	for _, name := range v.Names {
		// Sorted by language ("en" < "pt") and support, so the first name
		// seen for a node is the one we want.
		if _, seen := best[name.Node]; !seen {
			best[name.Node] = name.Name
		}
	}
	return best
}

// nameKey identifies one kept name: the node, the language, and the name
// folded to lowercase without accents or punctuation, so "Jaguar",
// "jaguar" and "JAGUAR" are one name.
type nameKey struct {
	node   uint32
	lang   string
	folded string
}

// spellingKey is one exact spelling of the kept name at index in Names.
type spellingKey struct {
	index int
	name  string
}

// Read reads the names from source (a .zip, "-" for stdin, or a .tsv).
// langs is the --langs list ("en,pt"); nodeOfGBIF maps a GBIF key to our
// node id; scientific[node] is a node's scientific name ("" for none), so
// names that only repeat it are skipped.
func Read(source, langs string, nodeOfGBIF map[uint32]uint32, scientific []string) (*Vernaculars, error) {
	wanted, err := ParseLangs(langs)
	if err != nil {
		return nil, err
	}
	in, err := openInput(source)
	if err != nil {
		return nil, err
	}
	// LEARN: `defer` schedules a call to run when the surrounding function
	// returns, by any path: the normal end or any early `return` on an
	// error. Here it closes the file or stops unzip however Read ends;
	// the success path below also calls close itself, to check unzip's
	// exit status, and a second close does nothing.
	defer in.close()

	out := &Vernaculars{RowsPerNode: make(map[uint32]uint32)}
	// LEARN: a struct whose fields are all comparable (numbers, strings,
	// other such structs) can be a map key: two keys are equal when every
	// field is, so a struct does the job of a tuple key.
	//
	// The value is where that name sits in out.Names.
	indexOf := make(map[nameKey]int)
	// Rows per exact spelling of each kept name ("Jaguar" 5, "jaguar" 3),
	// so the most common spelling is the one shown.
	spellingRows := make(map[spellingKey]uint32)

	var cols columns
	haveHeader := false
	for {
		line, readErr := in.reader.ReadString('\n')
		if readErr != nil && readErr != io.EOF {
			return nil, fmt.Errorf("reading the vernacular names: %w", readErr)
		}
		if line == "" && readErr == io.EOF {
			break
		}
		// Text that is not UTF-8 is an error, not a row: a broken file
		// should stop the ingest rather than put mojibake in the index.
		if !utf8.ValidString(line) {
			return nil, errors.New("reading the vernacular names: stream did not contain valid UTF-8")
		}
		row := strings.TrimRight(line, "\n\r")
		if !haveHeader {
			cols, err = columnsFromHeader(row)
			if err != nil {
				return nil, err
			}
			haveHeader = true
		} else {
			out.addRow(row, cols, wanted, nodeOfGBIF, scientific, indexOf, spellingRows)
		}
		if readErr == io.EOF {
			break
		}
	}
	if err := in.close(); err != nil {
		return nil, err
	}

	// Best supported first within a node and language. The sort is stable,
	// so equal support keeps the file's order.
	slices.SortStableFunc(out.Names, func(a, b CommonName) int {
		if c := cmp.Compare(a.Node, b.Node); c != 0 {
			return c
		}
		if c := strings.Compare(a.Lang, b.Lang); c != 0 {
			return c
		}
		return cmp.Compare(b.Support, a.Support)
	})
	return out, nil
}

// addRow counts one data row and keeps its name, or merges it into a kept
// one.
func (v *Vernaculars) addRow(row string, cols columns, wanted []string, nodeOfGBIF map[uint32]uint32,
	scientific []string, indexOf map[nameKey]int, spellingRows map[spellingKey]uint32) {
	v.RowsRead++

	fields := strings.Split(row, "\t")
	node, known := uint32(0), false
	if gbif, ok := cols.gbif(fields); ok {
		node, known = nodeOfGBIF[gbif]
	}
	if known {
		v.RowsPerNode[node]++
	}
	lang, name, ok := cols.nameIn(fields, wanted)
	if !ok {
		return
	}
	v.RowsInLangs++
	if !known {
		v.Unmatched++
		return
	}

	key := nameKey{node, lang, names.Fold(name)}
	if i, seen := indexOf[key]; seen {
		v.Duplicates++
		spellingRows[spellingKey{i, name}]++
		rows := spellingRows[spellingKey{i, name}]
		kept := &v.Names[i]
		kept.Support++
		keptRows := spellingRows[spellingKey{i, kept.Name}]
		// The spelling with accents wins ("Onça" over "Onca"), then the
		// more common one.
		accents, keptAccents := nonASCII(name), nonASCII(kept.Name)
		if accents > keptAccents || (accents == keptAccents && rows > keptRows) {
			kept.Name = name
		}
		return
	}
	if int(node) < len(scientific) && scientific[node] != "" && names.Fold(scientific[node]) == key.folded {
		v.Duplicates++
		return
	}
	indexOf[key] = len(v.Names)
	spellingRows[spellingKey{len(v.Names), name}] = 1
	v.Names = append(v.Names, CommonName{Node: node, Lang: lang, Name: name, Support: 1})
}

// ParseLangs turns "en,pt" into ["en", "pt"], each checked with LangCode.
// An unknown or empty list is an error.
func ParseLangs(langs string) ([]string, error) {
	var wanted []string
	for _, part := range strings.Split(langs, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		code, ok := LangCode(part)
		if !ok {
			return nil, fmt.Errorf("unknown language %q in --langs (known: en, pt, es, fr, de, …)", part)
		}
		wanted = append(wanted, code)
	}
	if len(wanted) == 0 {
		return nil, errors.New("--langs is empty")
	}
	return wanted, nil
}

// language is a two-letter code and the three-letter codes that mean the
// same language (ISO 639-1 and 639-2, bibliographic and terminology forms).
type language struct {
	two, three, other string
}

var languages = [8]language{
	{"en", "eng", "eng"},
	{"pt", "por", "por"},
	{"es", "spa", "spa"},
	{"fr", "fra", "fre"},
	{"de", "deu", "ger"},
	{"it", "ita", "ita"},
	{"nl", "nld", "dut"},
	{"la", "lat", "lat"},
}

// LangCode turns "eng", "EN" or "pt-BR" into "en" / "pt"; false for an
// unknown code.
func LangCode(code string) (string, bool) {
	// A region suffix (pt-BR, en_GB) does not change the language.
	base := code
	if i := strings.IndexAny(code, "-_"); i >= 0 {
		base = code[:i]
	}
	base = asciiLower(strings.TrimSpace(base))
	for _, l := range languages {
		if base == l.two || base == l.three || base == l.other {
			return l.two, true
		}
	}
	return "", false
}

// asciiLower lowercases A-Z only
// (strings.ToLower would also turn "İ" into "i").
func asciiLower(text string) string {
	b := []byte(text)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + ('a' - 'A')
		}
	}
	return string(b)
}

// Clean trims a name and collapses inner runs of whitespace to one space.
func Clean(raw string) string {
	return strings.Join(strings.Fields(raw), " ")
}

// nonASCII counts the characters outside ASCII (accented letters, mostly).
func nonASCII(text string) int {
	n := 0
	for _, r := range text {
		if r >= utf8.RuneSelf {
			n++
		}
	}
	return n
}

// columns are the positions of the three columns we use.
type columns struct {
	taxon, name, lang int
}

// columnsFromHeader finds the columns by name in the header row.
func columnsFromHeader(header string) (columns, error) {
	taxon, name, lang := -1, -1, -1
	for i, column := range strings.Split(header, "\t") {
		switch strings.TrimSpace(column) {
		case "taxonID", "id", "coreid":
			taxon = i
		case "vernacularName":
			name = i
		case "language":
			lang = i
		}
	}
	if taxon < 0 || name < 0 || lang < 0 {
		return columns{}, fmt.Errorf("%s: header %q lacks taxonID, vernacularName or language", ZipMember, header)
	}
	return columns{taxon: taxon, name: name, lang: lang}, nil
}

// gbif is the row's GBIF key, if it has a usable one.
func (c columns) gbif(fields []string) (uint32, bool) {
	if c.taxon >= len(fields) {
		return 0, false
	}
	text := strings.TrimSpace(fields[c.taxon])
	// Accept one leading '+', as node refs do; ParseUint does not.
	text = strings.TrimPrefix(text, "+")
	key, err := strconv.ParseUint(text, 10, 32)
	if err != nil {
		return 0, false
	}
	return uint32(key), true
}

// nameIn gives the language and cleaned name of a row in a wanted language
// with a non-empty name; ok is false otherwise.
func (c columns) nameIn(fields []string, wanted []string) (lang, name string, ok bool) {
	if c.lang >= len(fields) {
		return "", "", false
	}
	lang, ok = LangCode(fields[c.lang])
	if !ok || !slices.Contains(wanted, lang) {
		return "", "", false
	}
	if c.name >= len(fields) {
		return "", "", false
	}
	name = Clean(fields[c.name])
	if name == "" {
		return "", "", false
	}
	return lang, name, true
}

// input is where the text comes from: unzip's stdout, our stdin, or a file.
type input struct {
	reader *bufio.Reader
	// closer is the file or pipe to close when done; nil for stdin.
	closer io.Closer
	// cmd is the running unzip, nil for the other sources.
	cmd    *exec.Cmd
	source string
}

func openInput(source string) (*input, error) {
	if source == "-" {
		return &input{reader: bufio.NewReader(os.Stdin), source: source}, nil
	}
	// A bare ".zip" file name is a hidden file with no extension, not a zip.
	ext := filepath.Ext(source)
	isZip := strings.EqualFold(ext, ".zip") && len(filepath.Base(source)) > len(ext)
	if !isZip {
		file, err := os.Open(source)
		if err != nil {
			return nil, fmt.Errorf("opening %s: %w", source, err)
		}
		return &input{reader: bufio.NewReader(file), closer: file, source: source}, nil
	}
	if _, err := os.Stat(source); err != nil {
		return nil, fmt.Errorf("%s not found; download it with `make fetch-gbif`", source)
	}
	// LEARN: `os/exec` runs another program. exec.Command builds the
	// command line one argument at a time (no shell, so no quoting
	// problems). StdoutPipe connects the child's stdout to a pipe we read,
	// and Start launches it and returns at once, so unzip inflates the
	// next chunk while we parse the previous one. Wait, later, reaps the
	// process and reports its exit status.
	cmd := exec.Command("unzip", "-p", source, ZipMember)
	cmd.Stderr = os.Stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("starting `unzip`: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("starting `unzip` (is it installed?): %w", err)
	}
	// A bigger buffer than the default 4 KB: fewer reads from the pipe.
	reader := bufio.NewReaderSize(stdout, 1<<20)
	return &input{reader: reader, closer: stdout, cmd: cmd, source: source}, nil
}

// close closes the file or pipe and, for unzip, waits for it to exit and
// fails if it did not succeed (a truncated download, or no
// VernacularName.tsv in the archive). Calling it again does nothing.
func (in *input) close() error {
	if in.closer != nil {
		// Close our end of the pipe first, so an unzip that still has
		// output left (we stopped early on an error) cannot block forever
		// writing to it.
		in.closer.Close()
		in.closer = nil
	}
	if in.cmd != nil {
		cmd := in.cmd
		in.cmd = nil
		if err := cmd.Wait(); err != nil {
			return fmt.Errorf("`unzip -p %s %s` failed: %w", in.source, ZipMember, err)
		}
	}
	return nil
}
