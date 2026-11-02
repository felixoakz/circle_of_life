// Opening tree.db for the server: a read-only connection pool.
//
// database/sql is already a pool safe for concurrent use, so handlers
// share one *sql.DB and need no lock. The pragmas go in the DSN, so every
// connection the pool opens gets them: mode=ro, query_only(1), mmap_size
// (1 GiB).
//
// Concepts introduced here:
// - a blank import (`_ "modernc.org/sqlite"`) to register a driver

package db

import (
	"database/sql"
	"fmt"
	"os"
	"strings"

	// Registers the "sqlite" driver with database/sql.
	_ "modernc.org/sqlite"
)

// OpenTree opens tree.db read-only. A missing file is an error naming the
// path and how to build it (`make ingest`, or `make ingest-mini` and serve
// with `--db mini.db`).
func OpenTree(path string) (*sql.DB, error) {
	// Checked first: SQLite would report only "unable to open database".
	if _, err := os.Stat(path); err != nil {
		return nil, fmt.Errorf("tree database not found at %s; build it with `make ingest` (or `make ingest-mini` and serve with `--db mini.db`)", path)
	}
	// A "file:" URI lets SQLite read mode=ro itself (the same as opening
	// with SQLITE_OPEN_READONLY). Each _pragma runs on every new connection:
	// query_only refuses writes even through a bug; mmap lets SQLite read
	// pages straight from the OS page cache instead of copying them.
	dsn := "file:" + uriPath(path) + "?mode=ro&_pragma=query_only(1)&_pragma=mmap_size(1073741824)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("opening %s: %w", path, err)
	}
	// sql.Open connects lazily; Ping opens the first connection now, so a
	// file that is not a database fails at startup, not on the first request.
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("opening %s: %w", path, err)
	}
	return db, nil
}

// uriPath escapes the characters that would end or garble the path part of
// a "file:" URI. SQLite decodes %XX escapes in it.
func uriPath(path string) string {
	escaper := strings.NewReplacer("%", "%25", "?", "%3f", "#", "%23")
	return escaper.Replace(path)
}
