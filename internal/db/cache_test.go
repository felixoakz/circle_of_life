// Tests for cache.db, the enrichment cache.
//
// Concepts introduced here:
// - (none beyond the package's)

package db

import (
	"context"
	"path/filepath"
	"testing"
)

// A temporary file, not ":memory:", opened with OpenCache as the server
// does.
func TestPutGetRoundTrip(t *testing.T) {
	ctx := context.Background()
	conn, err := OpenCache(filepath.Join(t.TempDir(), "cache.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	// OpenCache already ran it; a second run must be harmless.
	if err := InitCache(conn); err != nil {
		t.Fatalf("InitCache on an initialised cache: %v", err)
	}

	if _, found, err := GetCached(ctx, conn, "ott1"); err != nil || found {
		t.Fatalf("GetCached on an empty cache = found %v, err %v; want nothing", found, err)
	}
	row := Cached{Body: "{}", Complete: true, FetchedAt: 100}
	if err := PutCached(ctx, conn, "ott1", row); err != nil {
		t.Fatal(err)
	}
	back, found, err := GetCached(ctx, conn, "ott1")
	if err != nil || !found {
		t.Fatalf("GetCached after PutCached = found %v, err %v", found, err)
	}
	if back != row {
		t.Errorf("GetCached = %+v, want %+v", back, row)
	}
}

func TestPartialDocumentsGoStaleSooner(t *testing.T) {
	complete := Cached{Body: "", Complete: true, FetchedAt: 0}
	partial := complete
	partial.Complete = false
	twoDays := int64(2 * 24 * 3600)

	cases := []struct {
		name string
		row  Cached
		now  int64
		want Freshness
	}{
		{"complete after two days", complete, twoDays, Fresh},
		{"partial after two days", partial, twoDays, Stale},
		{"complete at its TTL", complete, TTLComplete, Stale},
	}
	for _, c := range cases {
		if got := c.row.Freshness(c.now); got != c.want {
			t.Errorf("%s: Freshness = %d, want %d", c.name, got, c.want)
		}
	}
}
