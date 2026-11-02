// GET /api/nodes/{ref}/about through the router, with the mini tree.db, a
// cache.db file and an enricher pointed at enrichtest's mock upstream.
//
// Concepts introduced here:
// - (none beyond the package's)

package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"species/internal/config"
	"species/internal/db"
	"species/internal/enrich"
	"species/internal/enrich/enrichtest"
	"species/internal/server"
	"species/internal/testutil/minidb"
)

// aboutApp is the router over the mini tree (it has Homo sapiens,
// ott770315) with a cache.db next to it and an enricher pointed at base.
// It also returns the directory holding both databases.
func aboutApp(t *testing.T, base string, timeout time.Duration) (http.Handler, string) {
	t.Helper()
	treePath := minidb.BuildWithoutNames(t)
	dir := filepath.Dir(treePath)
	cache, err := db.OpenCache(filepath.Join(dir, "cache.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cache.Close() })
	state, err := server.Open(treePath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { state.Tree.Close() })
	e := enrich.New(enrich.Settings{
		Endpoints:   config.EndpointsUnder(base),
		UserAgent:   config.UserAgent("https://circle.example", "test-contact"),
		Timeout:     timeout,
		SlowTimeout: timeout,
		INatGap:     10 * time.Millisecond,
	})
	return server.Router(state.WithEnrichment(cache, e), dir), dir
}

// aboutGet sends GET uri and returns the status, Cache-Control and the
// decoded JSON body.
func aboutGet(t *testing.T, app http.Handler, uri string) (int, string, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	app.ServeHTTP(rec, httptest.NewRequest("GET", uri, nil))
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("GET %s: %v in %q", uri, err, rec.Body.String())
	}
	return rec.Code, rec.Header().Get("Cache-Control"), body
}

// field walks nested JSON objects: field(doc, "summary", "title").
func field(doc map[string]any, keys ...string) any {
	var v any = doc
	for _, key := range keys {
		object, ok := v.(map[string]any)
		if !ok {
			return nil
		}
		v = object[key]
	}
	return v
}

func TestCacheHitMakesZeroUpstreamCalls(t *testing.T) {
	mock := &enrichtest.Mock{}
	base := enrichtest.Start(t, mock)
	app, _ := aboutApp(t, base, 4*time.Second)

	status, cacheControl, first := aboutGet(t, app, "/api/nodes/ott770315/about")
	if status != http.StatusOK {
		t.Errorf("status %d", status)
	}
	if cacheControl != "public, max-age=86400" {
		t.Errorf("Cache-Control %q", cacheControl)
	}
	if first["complete"] != true {
		t.Errorf("complete = %v, failed %v", first["complete"], first["failed"])
	}
	if got := field(first, "summary", "title"); got != "Human" {
		t.Errorf("summary.title = %v", got)
	}
	if got := field(first, "image", "license"); got != "Public domain" {
		t.Errorf("image.license = %v", got)
	}
	afterMiss := mock.Hits()
	if afterMiss == 0 {
		t.Error("a miss made no upstream calls")
	}
	if first["nodeId"] != "ott770315" {
		t.Errorf("nodeId = %v", first["nodeId"])
	}

	_, _, second := aboutGet(t, app, "/api/nodes/ott770315/about")
	if mock.Hits() != afterMiss {
		t.Errorf("a cache hit must not call upstream: %d calls", mock.Hits()-afterMiss)
	}
	if !reflect.DeepEqual(second, first) {
		t.Errorf("cached document differs:\n%v\n%v", second, first)
	}
	// `retry` only refetches partial documents.
	aboutGet(t, app, "/api/nodes/ott770315/about?retry=1")
	if mock.Hits() != afterMiss {
		t.Errorf("retry of a complete document called upstream %d times", mock.Hits()-afterMiss)
	}
}

func TestTimeoutIsStoredAsPartialAndRetryRefetches(t *testing.T) {
	mock := &enrichtest.Mock{SlowPrefix: "/wikipedia", Delay: 1500 * time.Millisecond}
	base := enrichtest.Start(t, mock)
	app, dir := aboutApp(t, base, 300*time.Millisecond)

	_, cacheControl, doc := aboutGet(t, app, "/api/nodes/ott770315/about")
	if doc["complete"] != false {
		t.Errorf("complete = %v", doc["complete"])
	}
	if want := []any{"Wikipedia"}; !reflect.DeepEqual(doc["failed"], want) {
		t.Errorf("failed = %v, want %v", doc["failed"], want)
	}
	if doc["summary"] != nil {
		t.Errorf("summary = %v, want null", doc["summary"])
	}
	if got := field(doc, "image", "license"); got != "Public domain" {
		t.Errorf("image.license = %v", got)
	}
	if cacheControl != "no-store" {
		t.Errorf("Cache-Control %q", cacheControl)
	}

	// The row in cache.db says complete = 0.
	cache, err := db.OpenCache(filepath.Join(dir, "cache.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Close()
	row, found, err := db.GetCached(context.Background(), cache, "ott770315")
	if err != nil {
		t.Fatal(err)
	}
	if !found {
		t.Fatal("no row in cache.db")
	}
	if row.Complete {
		t.Error("cache.db row is complete")
	}

	// A plain request is served from cache; `retry=1` asks upstream again.
	hits := mock.Hits()
	aboutGet(t, app, "/api/nodes/ott770315/about")
	if mock.Hits() != hits {
		t.Errorf("a plain request called upstream %d times", mock.Hits()-hits)
	}
	aboutGet(t, app, "/api/nodes/ott770315/about?retry=1")
	if mock.Hits() <= hits {
		t.Error("retry=1 did not call upstream")
	}
}

func TestUnnamedCladesAreNeverEnriched(t *testing.T) {
	mock := &enrichtest.Mock{}
	base := enrichtest.Start(t, mock)
	app, _ := aboutApp(t, base, 4*time.Second)

	status, _, doc := aboutGet(t, app, "/api/nodes/mrcaott786ott3428/about")
	if status != http.StatusOK {
		t.Errorf("status %d", status)
	}
	if mock.Hits() != 0 {
		t.Errorf("an unnamed clade made %d upstream calls", mock.Hits())
	}
	if doc["complete"] != true {
		t.Errorf("complete = %v", doc["complete"])
	}
	generated, _ := doc["generated"].(string)
	if !strings.HasPrefix(generated, "An unnamed clade within ") {
		t.Errorf("generated = %q", generated)
	}

	status, _, _ = aboutGet(t, app, "/api/nodes/ott999999999/about")
	if status != http.StatusNotFound {
		t.Errorf("unknown node: status %d, want 404", status)
	}
}
