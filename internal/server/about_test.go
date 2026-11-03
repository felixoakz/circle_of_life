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
	"sync"
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

// cachedRow is the cache.db row for nodeID in dir, and whether there is one.
func cachedRow(t *testing.T, dir, nodeID string) (db.Cached, bool) {
	t.Helper()
	cache, err := db.OpenCache(filepath.Join(dir, "cache.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Close()
	row, found, err := db.GetCached(context.Background(), cache, nodeID)
	if err != nil {
		t.Fatal(err)
	}
	return row, found
}

// ageRow moves the row's fetched_at back by age, so it reads as stale.
func ageRow(t *testing.T, dir, nodeID string, age time.Duration) {
	t.Helper()
	cache, err := db.OpenCache(filepath.Join(dir, "cache.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Close()
	row, found, err := db.GetCached(context.Background(), cache, nodeID)
	if err != nil || !found {
		t.Fatalf("no row for %s: %v", nodeID, err)
	}
	row.FetchedAt -= int64(age / time.Second)
	if err := db.PutCached(context.Background(), cache, nodeID, row); err != nil {
		t.Fatal(err)
	}
}

// eventually polls ok every 10 ms for up to 3 s.
func eventually(ok func() bool) bool {
	for range 300 {
		if ok() {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return ok()
}

func TestConcurrentRequestsShareOneFetch(t *testing.T) {
	// One request alone, for the number of upstream calls a fetch makes.
	alone := &enrichtest.Mock{}
	app, _ := aboutApp(t, enrichtest.Start(t, alone), 4*time.Second)
	aboutGet(t, app, "/api/nodes/ott770315/about")
	want := alone.Hits()

	// Eight at once against a slow upstream, so they overlap.
	mock := &enrichtest.Mock{SlowPrefix: "/wikipedia", Delay: 300 * time.Millisecond}
	app, _ = aboutApp(t, enrichtest.Start(t, mock), 4*time.Second)
	var wg sync.WaitGroup
	docs := make([]map[string]any, 8)
	for i := range docs {
		wg.Go(func() { _, _, docs[i] = aboutGet(t, app, "/api/nodes/ott770315/about") })
	}
	wg.Wait()
	if mock.Hits() != want {
		t.Errorf("8 concurrent requests made %d upstream calls, want %d (one fetch)", mock.Hits(), want)
	}
	for i, doc := range docs {
		if doc["complete"] != true || field(doc, "summary", "title") != "Human" {
			t.Errorf("request %d got complete = %v, summary %v", i, doc["complete"], doc["summary"])
		}
	}
}

func TestAFetchOutlivesTheRequestThatStartedIt(t *testing.T) {
	mock := &enrichtest.Mock{SlowPrefix: "/wikipedia", Delay: 300 * time.Millisecond}
	app, dir := aboutApp(t, enrichtest.Start(t, mock), 4*time.Second)

	// The reader clicks on after 50 ms: the request's context ends.
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	req := httptest.NewRequest("GET", "/api/nodes/ott770315/about", nil).WithContext(ctx)
	app.ServeHTTP(httptest.NewRecorder(), req)

	// The fetch goes on and stores a complete document.
	stored := eventually(func() bool {
		row, found := cachedRow(t, dir, "ott770315")
		return found && row.Complete
	})
	if !stored {
		t.Fatal("the abandoned fetch stored no complete document")
	}
	hits := mock.Hits()
	_, _, doc := aboutGet(t, app, "/api/nodes/ott770315/about")
	if mock.Hits() != hits {
		t.Errorf("the next visit called upstream %d times, want a cache hit", mock.Hits()-hits)
	}
	if doc["complete"] != true {
		t.Errorf("complete = %v", doc["complete"])
	}
}

func TestARateLimitedDocumentIsKeptMinutesAndNotRefreshedDuringTheCooldown(t *testing.T) {
	mock := &enrichtest.Mock{FailPrefix: "/wikidata", FailStatus: http.StatusTooManyRequests, RetryAfter: "1"}
	app, dir := aboutApp(t, enrichtest.Start(t, mock), 4*time.Second)

	_, cacheControl, doc := aboutGet(t, app, "/api/nodes/ott770315/about")
	if doc["rateLimited"] != true || doc["complete"] != false {
		t.Fatalf("rateLimited = %v, complete = %v", doc["rateLimited"], doc["complete"])
	}
	if cacheControl != "no-store" {
		t.Errorf("Cache-Control %q", cacheControl)
	}
	row, found := cachedRow(t, dir, "ott770315")
	if !found {
		t.Fatal("the rate-limited document was not stored")
	}
	// Stale after ten minutes, not a day.
	if row.Freshness(row.FetchedAt+int64(db.TTLRateLimited), true) != db.Stale {
		t.Error("a rate-limited row is still fresh after TTLRateLimited")
	}

	// Stale, but the gate is shut (Retry-After: 1): served, not refreshed.
	ageRow(t, dir, "ott770315", 11*time.Minute)
	hits := mock.Hits()
	aboutGet(t, app, "/api/nodes/ott770315/about")
	time.Sleep(100 * time.Millisecond)
	if mock.Hits() != hits {
		t.Errorf("a refresh during the cooldown made %d upstream calls", mock.Hits()-hits)
	}

	// Once the cooldown is over, a stale row is refreshed in the background
	// (and stored, which also lets the test end with nothing running).
	time.Sleep(1100 * time.Millisecond)
	aged, _ := cachedRow(t, dir, "ott770315")
	aboutGet(t, app, "/api/nodes/ott770315/about")
	refreshed := eventually(func() bool {
		row, _ := cachedRow(t, dir, "ott770315")
		return row.FetchedAt > aged.FetchedAt
	})
	if !refreshed || mock.Hits() == hits {
		t.Error("no background refresh after the cooldown")
	}
}
