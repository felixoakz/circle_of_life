// Tests for the tree.db writer's helpers and schema.
//
// Concepts introduced here:
// - (none beyond the package's)

package db

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestTmpPathAppendsSuffix(t *testing.T) {
	if got := tmpPath("data/tree.db"); got != "data/tree.db.tmp" {
		t.Errorf(`tmpPath("data/tree.db") = %q, want "data/tree.db.tmp"`, got)
	}
}

func TestDataVersionFormat(t *testing.T) {
	cases := []struct {
		hash uint64
		want string
	}{
		{0x7f3a_9c00_0000_0001, "otl16.1-ott3.7.3-7f3a9c"},
		{1, "otl16.1-ott3.7.3-000000"},
	}
	for _, c := range cases {
		if got := DataVersion(c.hash); got != c.want {
			t.Errorf("DataVersion(%#x) = %q, want %q", c.hash, got, c.want)
		}
	}
}

// A temporary file, not ":memory:": every pooled connection to
// ":memory:" is a separate database.
func TestSchemaCreatesEveryTable(t *testing.T) {
	conn, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "schema.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Exec(Schema); err != nil {
		t.Fatalf("running schema.sql: %v", err)
	}
	for _, table := range []string{"meta", "nodes", "names_fts", "tiles"} {
		var count int
		err := conn.QueryRow("SELECT count(*) FROM sqlite_master WHERE name = ?", table).Scan(&count)
		if err != nil {
			t.Fatal(err)
		}
		if count != 1 {
			t.Errorf("table %s: found %d times, want 1", table, count)
		}
	}
}
