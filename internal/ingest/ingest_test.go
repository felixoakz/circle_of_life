// End-to-end checks of `species ingest` (ARCHITECTURE §9.3): build tree.db
// from the mini fixtures, then read it back with plain SQL and the tile
// decoder.
// Also writes/checks the golden tile used by the TypeScript decoder tests,
// and that ingesting twice gives the same database.
//
// These tests live in package ingest_test, outside package ingest, because
// minidb imports ingest: an internal test importing it would be an import
// cycle.
//
// Concepts introduced here:
// - an external test package (`package ingest_test`) that sees only the
//   exported API, like any other user of the package

package ingest_test

import (
	"bytes"
	"compress/gzip"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	// Registers the "sqlite" driver with database/sql.
	_ "modernc.org/sqlite"

	"species/internal/db"
	"species/internal/testutil"
	"species/internal/testutil/minidb"
	"species/internal/tiles"
	"species/internal/tree"
)

// openDB opens a database file with plain database/sql, closed when the
// test ends.
func openDB(t *testing.T, path string) *sql.DB {
	t.Helper()
	conn, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

// queryRow runs a query returning one row and scans it into dest, failing
// the test on any error.
func queryRow(t *testing.T, conn *sql.DB, query string, args []any, dest ...any) {
	t.Helper()
	if err := conn.QueryRow(query, args...).Scan(dest...); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
}

func gunzip(t *testing.T, gz []byte) []byte {
	t.Helper()
	r, err := gzip.NewReader(bytes.NewReader(gz))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// rawTile is one row of the tiles table, ungzipped.
type rawTile struct {
	level  uint8
	sector uint32
	raw    []byte
}

// allTiles is every tile in the database, ungzipped, by (level, sector).
func allTiles(t *testing.T, conn *sql.DB) []rawTile {
	t.Helper()
	rows, err := conn.Query("SELECT level, sector, data FROM tiles ORDER BY level, sector")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var result []rawTile
	for rows.Next() {
		var tile rawTile
		var gz []byte
		if err := rows.Scan(&tile.level, &tile.sector, &gz); err != nil {
			t.Fatal(err)
		}
		tile.raw = gunzip(t, gz)
		result = append(result, tile)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return result
}

// nodeRow is what checkTilesAgainstNodes needs from the nodes table.
type nodeRow struct {
	level  uint8
	angle  uint32
	parent *uint32 // nil for the root
	flags  uint8
	name   *string // nil for mrca nodes
}

// checkTilesAgainstNodes checks that every node appears in exactly one
// tile, the one at (level, SectorOf(angle, level)), with the same values as
// in nodes; that records are internal-first and angle-sorted; and that
// decode → encode is lossless.
func checkTilesAgainstNodes(t *testing.T, conn *sql.DB) {
	t.Helper()
	rows, err := conn.Query("SELECT id, level, angle, parent, flags, name FROM nodes")
	if err != nil {
		t.Fatal(err)
	}
	nodes := map[uint32]nodeRow{}
	for rows.Next() {
		var id uint32
		var n nodeRow
		if err := rows.Scan(&id, &n.level, &n.angle, &n.parent, &n.flags, &n.name); err != nil {
			t.Fatal(err)
		}
		nodes[id] = n
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	rows.Close()

	var tipCount uint32
	for _, n := range nodes {
		if n.flags&tiles.FlagTip != 0 {
			tipCount++
		}
	}

	type place struct {
		level  uint8
		sector uint32
	}
	seen := map[uint32]place{}
	for _, rt := range allTiles(t, conn) {
		tile, err := tiles.Decode(rt.raw)
		if err != nil {
			t.Fatalf("tile (%d, %d): %v", rt.level, rt.sector, err)
		}
		if !bytes.Equal(tiles.Encode(tile), rt.raw) {
			t.Errorf("tile (%d, %d): re-encoding is not byte-identical", rt.level, rt.sector)
		}
		if tile.Level != rt.level || tile.Sector != rt.sector {
			t.Errorf("tile (%d, %d) says it is (%d, %d)", rt.level, rt.sector, tile.Level, tile.Sector)
		}
		if len(tile.Nodes) == 0 {
			t.Errorf("tile (%d, %d) is empty; empty tiles are not stored", rt.level, rt.sector)
		}

		internal := int(tile.InternalCount)
		for i, node := range tile.Nodes {
			if isInternal := node.Flags&tiles.FlagTip == 0; isInternal != (i < internal) {
				t.Errorf("node %d: internal = %v at position %d of %d internal", node.ID, isInternal, i, internal)
			}
			if i > 0 && i != internal && tile.Nodes[i-1].Angle > node.Angle {
				t.Errorf("node %d: not sorted by angle", node.ID)
			}
			n, ok := nodes[node.ID]
			if !ok {
				t.Fatalf("tile node %d is not in nodes", node.ID)
			}
			if n.level != rt.level {
				t.Errorf("node %d: level %d in nodes, tile level %d", node.ID, n.level, rt.level)
			}
			if got := tree.SectorOf(n.angle, rt.level); got != rt.sector {
				t.Errorf("node %d: sector %d, tile sector %d", node.ID, got, rt.sector)
			}
			if node.Angle != n.angle {
				t.Errorf("node %d: angle %d in tile, %d in nodes", node.ID, node.Angle, n.angle)
			}
			// A clade's tips are ranks FirstTip .. FirstTip+LeafCount-1.
			last := node.FirstTip + node.LeafCount - 1
			if tree.TipAngle(node.FirstTip, tipCount) > node.ArcLo {
				t.Errorf("node %d: first tip after arc start", node.ID)
			}
			if node.ArcHi > tree.TipAngle(last, tipCount) {
				t.Errorf("node %d: arc end after last tip", node.ID)
			}
			wantParent := tree.NoParent
			if n.parent != nil {
				wantParent = *n.parent
			}
			if node.Parent != wantParent {
				t.Errorf("node %d: parent %d in tile, %d in nodes", node.ID, node.Parent, wantParent)
			}
			if node.Flags != n.flags {
				t.Errorf("node %d: flags %d in tile, %d in nodes", node.ID, node.Flags, n.flags)
			}
			wantName := ""
			if n.name != nil {
				wantName = *n.name
			}
			if node.Name != wantName {
				t.Errorf("node %d: name %q in tile, %q in nodes", node.ID, node.Name, wantName)
			}
			if _, twice := seen[node.ID]; twice {
				t.Errorf("node %d is in two tiles", node.ID)
			}
			seen[node.ID] = place{rt.level, rt.sector}
		}
	}
	if len(seen) != len(nodes) {
		t.Errorf("%d nodes in tiles, %d in nodes: every node must be in some tile", len(seen), len(nodes))
	}
}

// metaDoc is the part of the /api/meta document the test checks.
type metaDoc struct {
	NodeCount   int    `json:"nodeCount"`
	TileP       int    `json:"tileP"`
	TipCount    uint64 `json:"tipCount"`
	DataVersion string `json:"dataVersion"`
	Home        *struct {
		NodeID string `json:"nodeId"`
		ID     uint32 `json:"id"`
	} `json:"home"`
	Groups []struct {
		RootIDs  []string `json:"rootIds"`
		TipCount uint64   `json:"tipCount"`
	} `json:"groups"`
}

func TestMiniDatabase(t *testing.T) {
	path := minidb.Build(t)
	if _, err := os.Stat(filepath.Join(filepath.Dir(path), "mini.db.tmp")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("mini.db.tmp still exists (or stat failed: %v); it should be renamed", err)
	}
	conn := openDB(t, path)

	// Node count: everything in mini.tre.
	tr, err := tree.ParseNewickFile(testutil.Fixture("mini.tre"))
	if err != nil {
		t.Fatal(err)
	}
	var count int
	queryRow(t, conn, "SELECT count(*) FROM nodes", nil, &count)
	if count != tr.Len() || count != 57 {
		t.Errorf("node count = %d, want %d and 57", count, tr.Len())
	}

	// Lookup by OpenTree node id; Homo sapiens is the home node. (It is a
	// tip in the mini tree; in the real synth tree it has two subspecies,
	// and the flag still sits on the species node itself.)
	var (
		id        uint32
		name      string
		rank      string
		flags     uint8
		leafCount uint32
		gbif      *uint32
	)
	queryRow(t, conn,
		"SELECT id, name, rank, flags, leaf_count, gbif_id FROM nodes WHERE node_id = ?1",
		[]any{"ott770315"}, &id, &name, &rank, &flags, &leafCount, &gbif)
	if name != "Homo sapiens" || rank != "species" {
		t.Errorf("ott770315 = %q, %q; want Homo sapiens, species", name, rank)
	}
	if want := tiles.FlagTip | tiles.FlagHome | tiles.FlagNamed | tiles.FlagSpecies; flags != want {
		t.Errorf("Homo sapiens flags = %#b, want %#b", flags, want)
	}
	if leafCount != 1 {
		t.Errorf("Homo sapiens leaf_count = %d, want 1", leafCount)
	}
	if gbif == nil || *gbif != 2436436 {
		t.Errorf("Homo sapiens gbif_id = %v, want 2436436", gbif)
	}
	var homes int
	queryRow(t, conn, "SELECT count(*) FROM nodes WHERE flags & ?1", []any{int64(tiles.FlagHome)}, &homes)
	if homes != 1 {
		t.Errorf("%d home nodes, want 1", homes)
	}

	// An mrca node: no name, no rank, not "named".
	var mrcaName, mrcaRank *string
	var mrcaFlags uint8
	queryRow(t, conn, "SELECT name, rank, flags FROM nodes WHERE node_id = 'mrcaott786ott3428'",
		nil, &mrcaName, &mrcaRank, &mrcaFlags)
	if mrcaName != nil || mrcaRank != nil || mrcaFlags&tiles.FlagNamed != 0 {
		t.Errorf("mrca node: name %v, rank %v, flags %#b; want NULL, NULL, not named", mrcaName, mrcaRank, mrcaFlags)
	}

	// The root has a NULL parent and id 0.
	var rootID uint32
	var rootParent *uint32
	queryRow(t, conn, "SELECT id, parent FROM nodes WHERE node_id = 'ott93302'", nil, &rootID, &rootParent)
	if rootID != 0 || rootParent != nil {
		t.Errorf("root: id %d, parent %v; want 0, NULL", rootID, rootParent)
	}

	// Search: one scientific-name row per named node, prefix queries work.
	var found uint32
	queryRow(t, conn,
		`SELECT node FROM names_fts WHERE names_fts MATCH '"homo"* AND "sap"*' AND kind = 0`,
		nil, &found)
	if found != id {
		t.Errorf("search for homo sap found %d, want %d", found, id)
	}
	var ftsRows, named int
	queryRow(t, conn,
		`SELECT (SELECT count(*) FROM names_fts WHERE kind = 0),
		        (SELECT count(*) FROM nodes WHERE name IS NOT NULL)`,
		nil, &ftsRows, &named)
	if ftsRows != named {
		t.Errorf("%d scientific names in names_fts, %d named nodes", ftsRows, named)
	}

	// Common names (P11, mini_vernacular.tsv): kind 1 with a language,
	// repeats and the "Fungi" that only repeats the scientific name
	// dropped, the German and Swedish rows and the unknown key skipped.
	for _, c := range []struct {
		lang string
		want int
	}{{"en", 17}, {"pt", 10}} {
		var n int
		queryRow(t, conn, "SELECT count(*) FROM names_fts WHERE kind = 1 AND lang = ?1", []any{c.lang}, &n)
		if n != c.want {
			t.Errorf("%d common names in %s, want %d", n, c.lang, c.want)
		}
	}
	var other int
	queryRow(t, conn, "SELECT count(*) FROM names_fts WHERE kind = 1 AND lang NOT IN ('en', 'pt')", nil, &other)
	if other != 0 {
		t.Errorf("%d common names in other languages, want 0", other)
	}
	// Accents fold away in the index: "chimpanze" finds "Chimpanzé".
	var chimpNode uint32
	var chimpName, chimpLang string
	queryRow(t, conn,
		`SELECT node, name, lang FROM names_fts WHERE names_fts MATCH '"chimpanze"' AND kind = 1`,
		nil, &chimpNode, &chimpName, &chimpLang)
	var pan uint32
	queryRow(t, conn, "SELECT id FROM nodes WHERE node_id = 'ott417950'", nil, &pan)
	if chimpNode != pan || chimpName != "Chimpanzé" || chimpLang != "pt" {
		t.Errorf("chimpanze found %d, %q, %q; want %d, Chimpanzé, pt", chimpNode, chimpName, chimpLang, pan)
	}
	// Each node keeps its best English name and how many GBIF rows it has.
	var common *string
	var vernacularRows int
	queryRow(t, conn, "SELECT common_name, vernacular_rows FROM nodes WHERE id = ?1", []any{id}, &common, &vernacularRows)
	if common == nil || *common != "Human" {
		t.Errorf("Homo sapiens common_name = %v, want Human", common)
	}
	if vernacularRows != 7 {
		t.Errorf("Homo sapiens vernacular_rows = %d, want 7", vernacularRows)
	}

	// Meta: the /api/meta document.
	var metaText string
	queryRow(t, conn, "SELECT value FROM meta WHERE key = 'meta'", nil, &metaText)
	var meta metaDoc
	if err := json.Unmarshal([]byte(metaText), &meta); err != nil {
		t.Fatalf("meta is not JSON: %v", err)
	}
	if meta.NodeCount != 57 {
		t.Errorf("meta nodeCount = %d, want 57", meta.NodeCount)
	}
	if meta.TileP != 512 {
		t.Errorf("meta tileP = %d, want 512", meta.TileP)
	}
	if meta.Home == nil {
		t.Error("meta home is null")
	} else if meta.Home.NodeID != "ott770315" || meta.Home.ID != id {
		t.Errorf("meta home = %+v, want ott770315 with id %d", *meta.Home, id)
	}
	if !strings.HasPrefix(meta.DataVersion, "otl16.1-ott3.7.3-") {
		t.Errorf("meta dataVersion = %q", meta.DataVersion)
	}
	if len(meta.Groups) != 6 {
		t.Fatalf("meta has %d groups, want 6", len(meta.Groups))
	}
	if n := len(meta.Groups[2].RootIDs); n != 3 {
		t.Errorf("Plants has %d root ids, want 3", n)
	}
	var groupTips uint64
	for _, g := range meta.Groups {
		groupTips += g.TipCount
	}
	if meta.TipCount != groupTips {
		t.Errorf("meta tipCount = %d, groups add up to %d", meta.TipCount, groupTips)
	}

	checkTilesAgainstNodes(t, conn)
}

// A generated tree with ~5,000 tips (all group roots present, so the layout
// accepts it) has several LOD levels and many tiles, unlike the one-tile
// mini tree.
func TestGeneratedTreeSpreadsOverLevels(t *testing.T) {
	rng := uint64(12345)
	nextOtt := uint32(10_000_000)
	clade := func(tips int, ott uint32) string {
		var text strings.Builder
		randomClade(&text, tips, &rng, &nextOtt)
		return fmt.Sprintf("(%s)ott%d", text.String(), ott)
	}
	eukaryota := fmt.Sprintf("(%s,%s,%s,%s,%s,%s)ott304358",
		clade(3000, 691846),
		clade(400, 352914),
		clade(600, 361838),
		clade(100, 878953),
		clade(20, 664970),
		clade(300, 5246039),
	)
	newick := fmt.Sprintf("(%s,%s,%s)ott93302;", eukaryota, clade(500, 844192), clade(50, 996421))

	tr, err := tree.ParseNewick([]byte(newick))
	if err != nil {
		t.Fatal(err)
	}
	x := tree.NewTaxonomy(tr.Len())
	l, err := tree.ComputeLayout(tr)
	if err != nil {
		t.Fatal(err)
	}
	if l.MaxLevel < 3 {
		t.Errorf("MaxLevel = %d, want ≥ 3", l.MaxLevel)
	}
	set, err := tiles.Build(tr, x, l)
	if err != nil {
		t.Fatal(err)
	}
	if len(set.Tiles) <= 10 {
		t.Errorf("%d tiles, want more than 10", len(set.Tiles))
	}

	out := filepath.Join(t.TempDir(), "gen.db")
	if _, err := db.Write(out, tr, x, l, set, nil); err != nil {
		t.Fatal(err)
	}
	checkTilesAgainstNodes(t, openDB(t, out))
}

// randomClade appends a random clade with tips tips (without its own
// label) to out: a mix of binary splits and polytomies, like the real tree.
func randomClade(out *strings.Builder, tips int, rng *uint64, nextOtt *uint32) {
	parts := tips
	if tips > 8 {
		parts = 2 + below(rng, 4)
	}
	left := tips
	for part := 0; part < parts; part++ {
		size := left
		if part+1 != parts {
			size = 1 + below(rng, left-(parts-part-1))
		}
		left -= size
		if part > 0 {
			out.WriteByte(',')
		}
		*nextOtt++
		if size == 1 {
			fmt.Fprintf(out, "ott%d", *nextOtt)
		} else {
			ott := *nextOtt
			out.WriteByte('(')
			randomClade(out, size, rng, nextOtt)
			fmt.Fprintf(out, ")ott%d", ott)
		}
	}
}

// below is a "random" number in 0..bound-1 from a tiny linear congruential
// generator (unsigned arithmetic wraps modulo 2^64).
func below(rng *uint64, bound int) int {
	*rng = *rng*6364136223846793005 + 1442695040888963407
	return int((*rng >> 33) % uint64(bound))
}

// The mini tree fits in one tile, (0, 0). Its raw bytes are the golden
// fixture the TypeScript decoder is tested against. UPDATE_GOLDEN=1
// rewrites the file; otherwise the test fails when the encoder's output
// drifts from it.
func TestGoldenTile(t *testing.T) {
	all := allTiles(t, openDB(t, minidb.Build(t)))
	if len(all) != 1 {
		t.Fatalf("%d tiles; the mini tree is a single tile", len(all))
	}
	if all[0].level != 0 || all[0].sector != 0 {
		t.Fatalf("the tile is (%d, %d), want (0, 0)", all[0].level, all[0].sector)
	}

	path := testutil.Fixture("golden_tile.bin")
	if _, ok := os.LookupEnv("UPDATE_GOLDEN"); ok {
		if err := os.WriteFile(path, all[0].raw, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	golden, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("missing golden_tile.bin (rerun with UPDATE_GOLDEN=1): %v", err)
	}
	if !bytes.Equal(golden, all[0].raw) {
		t.Error("tile bytes changed; if deliberate, rerun with UPDATE_GOLDEN=1")
	}
}

// dumpTable reads every row of query as text, one line per row, so two
// databases can be compared. Values print with %#v: exact for floats
// (shortest round-trip form), byte for byte for blobs, and NULL as <nil>.
func dumpTable(t *testing.T, conn *sql.DB, query string) []string {
	t.Helper()
	rows, err := conn.Query(query)
	if err != nil {
		t.Fatalf("%s: %v", query, err)
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		t.Fatal(err)
	}
	var lines []string
	for rows.Next() {
		values := make([]any, len(columns))
		pointers := make([]any, len(columns))
		for i := range values {
			pointers[i] = &values[i]
		}
		if err := rows.Scan(pointers...); err != nil {
			t.Fatal(err)
		}
		lines = append(lines, fmt.Sprintf("%#v", values))
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return lines
}

// Ingest is deterministic. Two ingests of the
// mini fixtures give the same rows in every table, in the same order
// (names_fts by rowid, so insert order counts), and the same gzipped tile
// bytes.
func TestIngestTwiceIsIdentical(t *testing.T) {
	first := openDB(t, minidb.Build(t))
	second := openDB(t, minidb.Build(t))
	queries := []string{
		"SELECT key, value FROM meta ORDER BY key",
		"SELECT * FROM nodes ORDER BY id",
		"SELECT rowid, name, node, kind, lang FROM names_fts ORDER BY rowid",
		"SELECT level, sector, data FROM tiles ORDER BY level, sector",
	}
	for _, query := range queries {
		a := dumpTable(t, first, query)
		b := dumpTable(t, second, query)
		if len(a) == 0 {
			t.Errorf("%s: no rows", query)
		}
		if !slices.Equal(a, b) {
			t.Errorf("%s: the two ingests differ (%d vs %d rows)", query, len(a), len(b))
		}
	}
}
