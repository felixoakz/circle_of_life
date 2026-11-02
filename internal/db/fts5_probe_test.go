// A probe of the SQLite build inside modernc.org/sqlite: it
// must have FTS5 with the unicode61 tokenizer (remove_diacritics 2), prefix
// indexes, bm25() and the 'optimize' command, exactly as schema.sql and the
// search code use them. If this fails, search cannot work.
//
// Concepts introduced here:
// - `t.TempDir()`: a directory deleted when the test ends
// - `t.Logf`: output shown with `go test -v`

package db

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestFTS5Probe(t *testing.T) {
	// A file, never ":memory:": every pooled connection to ":memory:" would
	// be a separate, empty database.
	path := filepath.Join(t.TempDir(), "probe.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	var version string
	if err := db.QueryRow("SELECT sqlite_version()").Scan(&version); err != nil {
		t.Fatal(err)
	}
	t.Logf("sqlite_version() = %s", version)

	// The same options as names_fts in schema.sql.
	_, err = db.Exec(`CREATE VIRTUAL TABLE t USING fts5(
		name, node UNINDEXED,
		tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3')`)
	if err != nil {
		t.Fatalf("creating the fts5 table: %v", err)
	}
	rows := []struct {
		name string
		node int
	}{
		{"Homo sapiens", 1},
		{"Homo erectus", 2},
		{"Homo", 3},
		{"Onça-pintada", 4},
		{"Sapajus", 5},
	}
	for _, r := range rows {
		if _, err := db.Exec("INSERT INTO t (name, node) VALUES (?, ?)", r.name, r.node); err != nil {
			t.Fatal(err)
		}
	}

	// Prefix terms joined with AND, ranked by bm25 as search does.
	var node int
	var score float64
	err = db.QueryRow(`SELECT node, bm25(t) FROM t WHERE t MATCH '"homo"* AND "sap"*'
		ORDER BY rank`).Scan(&node, &score)
	if err != nil {
		t.Fatalf("prefix query: %v", err)
	}
	if node != 1 {
		t.Errorf(`"homo"* AND "sap"* matched node %d, want 1`, node)
	}
	t.Logf("bm25 of Homo sapiens = %g", score)

	// remove_diacritics 2: "onca" finds "Onça".
	err = db.QueryRow(`SELECT node FROM t WHERE t MATCH '"onca"'`).Scan(&node)
	if err != nil {
		t.Fatalf("diacritics query: %v", err)
	}
	if node != 4 {
		t.Errorf(`"onca" matched node %d, want 4`, node)
	}

	// Two-letter prefix (prefix='2 3' builds an index for it).
	var count int
	if err := db.QueryRow(`SELECT count(*) FROM t WHERE t MATCH '"ho"*'`).Scan(&count); err != nil {
		t.Fatalf("two-letter prefix: %v", err)
	}
	if count != 3 {
		t.Errorf(`"ho"* matched %d rows, want 3`, count)
	}

	// Merge the index segments, as ingest does after its commit.
	if _, err := db.Exec("INSERT INTO t(t) VALUES('optimize')"); err != nil {
		t.Fatalf("optimize: %v", err)
	}
	if err := db.QueryRow(`SELECT count(*) FROM t WHERE t MATCH '"homo"*'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 3 {
		t.Errorf(`after optimize "homo"* matched %d rows, want 3`, count)
	}
}
