// cache.db, the enrichment cache (ARCHITECTURE §4, §6.1): one JSON document per
// node, with when it was fetched and whether every source answered.
//
// Unlike tree.db this file is written while the server runs, so it uses
// SQLite's write-ahead log. The pool is limited to one connection; the
// DSN sets journal_mode(WAL), synchronous(NORMAL) and
// busy_timeout(2000) for it.
//
// Concepts introduced here:
// - unix time with `time.Now().Unix()`

package db

import (
	"context"
	"database/sql"
	_ "embed"
	"errors"
	"fmt"
	"time"
)

// CacheSchema is the cache.db schema (cache.sql).
//
//go:embed cache.sql
var CacheSchema string

// A complete document is fresh for 30 days (ARCHITECTURE §6.1); a partial one (some
// source failed) only for a day, so it is retried soon; one that is
// partial because a source rate limited us for ten minutes, by when the
// limit has most likely passed.
const (
	TTLComplete    int64 = 30 * 24 * 3600
	TTLPartial     int64 = 24 * 3600
	TTLRateLimited int64 = 10 * 60
)

// Cached is one row of the about table.
type Cached struct {
	Body      string
	Complete  bool
	FetchedAt int64 // unix seconds
}

// Freshness is how a cached row compares with its time to live.
type Freshness uint8

const (
	Fresh Freshness = iota
	// Stale is past its TTL: still served, and refreshed in the background.
	Stale
)

// Freshness classifies the row at time now (unix seconds). rateLimited is
// the document's own flag (it lives in the JSON body, not in a column).
func (c Cached) Freshness(now int64, rateLimited bool) Freshness {
	ttl := TTLPartial
	if c.Complete {
		ttl = TTLComplete
	} else if rateLimited {
		ttl = TTLRateLimited
	}
	if now-c.FetchedAt < ttl {
		return Fresh
	}
	return Stale
}

// Now is seconds since 1970-01-01 UTC.
func Now() int64 {
	return time.Now().Unix()
}

// OpenCache opens (creating if needed) cache.db with WAL and runs
// InitCache.
func OpenCache(path string) (*sql.DB, error) {
	// busy_timeout is applied first by the driver, before journal_mode.
	dsn := "file:" + uriPath(path) +
		"?_pragma=busy_timeout(2000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("opening %s: %w", path, err)
	}
	// One connection is plenty: the cache sees a
	// handful of writes a minute, and one writer never waits on another.
	db.SetMaxOpenConns(1)
	if err := InitCache(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("opening %s: %w", path, err)
	}
	return db, nil
}

// InitCache creates the schema if it is missing.
func InitCache(db *sql.DB) error {
	if _, err := db.Exec(CacheSchema); err != nil {
		return fmt.Errorf("creating the cache schema: %w", err)
	}
	return nil
}

// GetCached is the row for nodeID, and false if there is none.
func GetCached(ctx context.Context, db *sql.DB, nodeID string) (Cached, bool, error) {
	var c Cached
	row := db.QueryRowContext(ctx, "SELECT body, complete, fetched_at FROM about WHERE node_id = ?", nodeID)
	err := row.Scan(&c.Body, &c.Complete, &c.FetchedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Cached{}, false, nil
	}
	if err != nil {
		return Cached{}, false, err
	}
	return c, true, nil
}

// PutCached inserts or replaces the row for nodeID.
func PutCached(ctx context.Context, db *sql.DB, nodeID string, c Cached) error {
	_, err := db.ExecContext(ctx,
		"INSERT OR REPLACE INTO about (node_id, body, complete, fetched_at) VALUES (?, ?, ?, ?)",
		nodeID, c.Body, c.Complete, c.FetchedAt)
	return err
}
