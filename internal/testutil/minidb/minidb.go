// Package minidb builds the mini tree.db from the test fixtures with the
// real ingest, for tests that need a database (the API and /about tests,
// the golden tile).
//
// It is separate from testutil because it imports ingest (and so tree,
// tiles, db, …); a package's internal tests importing it would form an
// import cycle. Tests of those lower packages use testutil.Fixture; the
// ingest package's own tests use this from an external test package
// (package ingest_test).
//
// Concepts introduced here:
// - `testing.TB`: what *testing.T and *testing.B have in common
// - `t.Helper()`: failures are reported at the caller's line
package minidb

import (
	"io"
	"path/filepath"
	"testing"

	"species/internal/config"
	"species/internal/ingest"
	"species/internal/testutil"
)

// Build ingests mini.tre, mini_taxonomy.tsv and mini_vernacular.tsv into
// mini.db in a fresh temporary directory (deleted when the test ends) and
// returns the database path. Its directory is free for other files the
// test needs (an index.html, a cache.db).
func Build(t testing.TB) string {
	t.Helper()
	return build(t, testutil.Fixture("mini_vernacular.tsv"))
}

// BuildWithoutNames is Build without common names (no --vernacular), which
// is what the enrichment tests expect.
func BuildWithoutNames(t testing.TB) string {
	t.Helper()
	return build(t, "")
}

func build(t testing.TB, vernacularPath string) string {
	t.Helper()
	out := filepath.Join(t.TempDir(), "mini.db")
	args := config.Ingest{
		Tree:       testutil.Fixture("mini.tre"),
		Taxonomy:   testutil.Fixture("mini_taxonomy.tsv"),
		Vernacular: vernacularPath,
		Langs:      "en,pt",
		Out:        out,
	}
	// The ingest report is not interesting in tests.
	if err := ingest.Run(args, io.Discard); err != nil {
		t.Fatalf("ingesting the mini fixtures: %v", err)
	}
	return out
}
