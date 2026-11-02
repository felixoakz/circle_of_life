// Package testutil finds the shared test fixtures in tests/fixtures/ (read
// by the Go and Vitest tests alike).
//
// It imports nothing from this module, so any package's own tests can use
// it without an import cycle. Building the mini tree.db needs the ingest
// package, so that lives next door in testutil/minidb.
//
// Concepts introduced here:
// - `runtime.Caller`: where is this source file?
package testutil

import (
	"path/filepath"
	"runtime"
)

// Fixture is the path of tests/fixtures/<name> (name may contain slashes,
// e.g. "enrich/wd_search_none.json").
func Fixture(name string) string {
	return filepath.Join(repoRoot(), "tests", "fixtures", filepath.FromSlash(name))
}

// repoRoot is the repository root, found from this file's own location.
func repoRoot() string {
	// LEARN: `runtime.Caller(0)` reports the source file and line of the
	// code that calls it, as recorded at compile time. This file is
	// internal/testutil/fixtures.go, so the repository root is two
	// directories up, wherever `go test` runs from. (Each test runs with
	// its own package directory as the working directory, so a relative
	// path like "../../tests" would differ from package to package.)
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		panic("testutil: runtime.Caller failed")
	}
	return filepath.Join(filepath.Dir(file), "..", "..")
}
