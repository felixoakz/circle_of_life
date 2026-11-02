// Tests for the router without a real tree: /healthz, the JSON 404 under
// /api, static files with their Cache-Control and content types, and the
// gzip rules. The database holds only the schema and a minimal meta row.
//
// The tests are in package server_test, so they see only exported names
// and use the server exactly as cmd/species does.
//
// Concepts introduced here:
// - `net/http/httptest`: requests through a handler without a socket

package server_test

import (
	"bytes"
	"compress/gzip"
	"database/sql"
	"io"
	"mime"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"species/internal/db"
	"species/internal/server"
)

// immutableCC is the Cache-Control of hashed assets and tiles.
const immutableCC = "public, max-age=31536000, immutable"

// testStaticDir is a temporary static dir holding a tiny index.html and
// one hashed asset.
func testStaticDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	writeTestFile(t, filepath.Join(dir, "index.html"), "<!doctype html>app")
	if err := os.Mkdir(filepath.Join(dir, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, filepath.Join(dir, "assets", "index-abc123.js"), "console.log(1)")
	return dir
}

func writeTestFile(t *testing.T, path, text string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

// testState is a database with the real schema and a minimal meta row:
// enough for routes that do not query nodes. It is a temporary file, not
// ":memory:", because database/sql gives every pooled connection its own
// in-memory database.
func testState(t *testing.T) *server.State {
	t.Helper()
	path := filepath.Join(t.TempDir(), "tree.db")
	conn, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(db.Schema); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(`INSERT INTO meta (key, value) VALUES ('meta', '{"dataVersion":"test"}')`); err != nil {
		t.Fatal(err)
	}
	if err := conn.Close(); err != nil {
		t.Fatal(err)
	}

	tree, err := db.OpenTree(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { tree.Close() })
	state, err := server.NewState(tree)
	if err != nil {
		t.Fatal(err)
	}
	return state
}

// testRouter is the router on testState and dir.
func testRouter(t *testing.T, dir string) http.Handler {
	t.Helper()
	return server.Router(testState(t), dir)
}

// send GETs uri through h, accepting gzip if acceptGzip, and returns the
// response with its body read into memory.
func send(h http.Handler, uri string, acceptGzip bool) (*http.Response, []byte) {
	// LEARN: `httptest.NewRequest` builds a request as a server would
	// receive it, and `httptest.NewRecorder` is an http.ResponseWriter that
	// just remembers the status, headers and body. Calling ServeHTTP with
	// the two runs the whole router (middleware included) in this goroutine,
	// with no socket and no port; `Result()` gives the recorded response.
	req := httptest.NewRequest(http.MethodGet, uri, nil)
	if acceptGzip {
		req.Header.Set("Accept-Encoding", "gzip")
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	res := rec.Result()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		panic(err) // a recorder's body is in memory; this cannot fail
	}
	return res, body
}

// gunzipBytes unzips a gzip body.
func gunzipBytes(t *testing.T, gz []byte) []byte {
	t.Helper()
	r, err := gzip.NewReader(bytes.NewReader(gz))
	if err != nil {
		t.Fatalf("not gzip: %v", err)
	}
	raw, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("bad gzip: %v", err)
	}
	return raw
}

// mediaType is the Content-Type without parameters: Go's net/http adds
// "; charset=utf-8" to text types, and the tests care about the type only.
func mediaType(t *testing.T, res *http.Response) string {
	t.Helper()
	header := res.Header.Get("Content-Type")
	if header == "" {
		return ""
	}
	media, _, err := mime.ParseMediaType(header)
	if err != nil {
		t.Fatalf("Content-Type %q: %v", header, err)
	}
	return media
}

func TestHealthzIsOK(t *testing.T) {
	res, body := send(testRouter(t, testStaticDir(t)), "/healthz", false)
	if res.StatusCode != http.StatusOK {
		t.Errorf("status = %d, want 200", res.StatusCode)
	}
	if string(body) != "ok" {
		t.Errorf("body = %q, want ok", body)
	}
}

func TestUnknownPathsFallBackToIndexHTML(t *testing.T) {
	res, body := send(testRouter(t, testStaticDir(t)), "/some/deep/link", false)
	if res.StatusCode != http.StatusOK {
		t.Errorf("status = %d, want 200", res.StatusCode)
	}
	if !strings.Contains(string(body), "app") {
		t.Errorf("body = %q, want index.html", body)
	}
}

func TestUnknownAPIPathIsJSON404(t *testing.T) {
	res, body := send(testRouter(t, testStaticDir(t)), "/api/nope", false)
	if res.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d, want 404", res.StatusCode)
	}
	if want := `{"error":"not found: /api/nope"}`; string(body) != want {
		t.Errorf("body = %s, want %s", body, want)
	}
}

// "/api" without the slash is the same JSON 404 as any unknown API path,
// not ServeMux's redirect to "/api/".
func TestBareAPIPathIsJSON404(t *testing.T) {
	res, body := send(testRouter(t, testStaticDir(t)), "/api", false)
	if res.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d, want 404", res.StatusCode)
	}
	if want := `{"error":"not found: /api"}`; string(body) != want {
		t.Errorf("body = %s, want %s", body, want)
	}
}

func TestStaticCacheHeaders(t *testing.T) {
	app := testRouter(t, testStaticDir(t))
	cases := []struct {
		uri    string
		status int
		cc     string // "" = no Cache-Control header
	}{
		{"/assets/index-abc123.js", http.StatusOK, immutableCC},
		// A 404 must not be cached forever.
		{"/assets/gone-123.js", http.StatusNotFound, ""},
		{"/", http.StatusOK, "no-cache"},
		{"/?n=ott770315", http.StatusOK, "no-cache"},
	}
	for _, c := range cases {
		res, _ := send(app, c.uri, false)
		if res.StatusCode != c.status {
			t.Errorf("%s: status = %d, want %d", c.uri, res.StatusCode, c.status)
		}
		if got := res.Header.Get("Cache-Control"); got != c.cc {
			t.Errorf("%s: Cache-Control = %q, want %q", c.uri, got, c.cc)
		}
	}
}

func TestGzipSkipsFontsAndImages(t *testing.T) {
	dir := testStaticDir(t)
	text := strings.Repeat("body { color: black; } ", 50)
	writeTestFile(t, filepath.Join(dir, "assets", "index-abc123.css"), text)
	writeTestFile(t, filepath.Join(dir, "assets", "font-abc123.woff2"), text)
	writeTestFile(t, filepath.Join(dir, "fallback.webp"), text)
	app := testRouter(t, dir)

	cases := []struct {
		uri      string
		encoding string
	}{
		{"/assets/index-abc123.css", "gzip"},
		{"/assets/font-abc123.woff2", ""},
		{"/fallback.webp", ""},
	}
	for _, c := range cases {
		res, _ := send(app, c.uri, true)
		if got := res.Header.Get("Content-Encoding"); got != c.encoding {
			t.Errorf("%s: Content-Encoding = %q, want %q", c.uri, got, c.encoding)
		}
	}
}

func TestMissingTreeDBNamesThePath(t *testing.T) {
	_, err := server.Open("no/such/tree.db")
	if err == nil {
		t.Fatal("opening a missing tree.db succeeded")
	}
	if !strings.Contains(err.Error(), "no/such/tree.db") {
		t.Errorf("error %q does not name the path", err)
	}
}

// Content types of static files, compared without parameters. Go's mime
// table differs between systems for
// some of these (e.g. .woff), hence explicit types in static.go.
func TestStaticContentTypes(t *testing.T) {
	dir := testStaticDir(t)
	files := map[string]string{
		"assets/index-abc123.css":  "a{}",
		"assets/font-abc123.woff":  "font",
		"assets/font-abc123.woff2": "font",
		"fallback.webp":            "webp",
		"icon.svg":                 "<svg/>",
		"data.json":                "{}",
	}
	for name, text := range files {
		writeTestFile(t, filepath.Join(dir, filepath.FromSlash(name)), text)
	}
	app := testRouter(t, dir)

	cases := []struct{ uri, want string }{
		{"/", "text/html"},
		{"/some/deep/link", "text/html"},
		{"/assets/index-abc123.js", "text/javascript"},
		{"/assets/index-abc123.css", "text/css"},
		// application/font-woff, not font/woff, so the gzip rules zip it
		// (see TestGzipRules).
		{"/assets/font-abc123.woff", "application/font-woff"},
		{"/assets/font-abc123.woff2", "font/woff2"},
		{"/fallback.webp", "image/webp"},
		{"/icon.svg", "image/svg+xml"},
		{"/data.json", "application/json"},
		{"/healthz", "text/plain"},
		{"/api/nope", "application/json"},
	}
	for _, c := range cases {
		res, _ := send(app, c.uri, false)
		if res.StatusCode != http.StatusOK && c.uri != "/api/nope" {
			t.Errorf("%s: status = %d, want 200", c.uri, res.StatusCode)
		}
		if got := mediaType(t, res); got != c.want {
			t.Errorf("%s: content type = %q, want %q", c.uri, got, c.want)
		}
	}
}

// The gzip middleware's rules (gzip.go): which responses are zipped, and
// which get "Vary: accept-encoding".
func TestGzipRules(t *testing.T) {
	dir := testStaticDir(t)
	text := strings.Repeat("body { color: black; } ", 50)
	files := []string{
		"assets/big-abc123.css", "assets/big-abc123.woff", "assets/big-abc123.woff2",
		"big.png", "big.webp", "big.svg", "big.txt",
	}
	for _, name := range files {
		writeTestFile(t, filepath.Join(dir, filepath.FromSlash(name)), text)
	}
	// 4 bytes: under the 32-byte minimum.
	writeTestFile(t, filepath.Join(dir, "small.css"), "a{}\n")
	app := testRouter(t, dir)

	cases := []struct {
		uri      string
		encoding string // with Accept-Encoding: gzip
		vary     string // Vary, whether or not the client accepts gzip
	}{
		{"/assets/big-abc123.css", "gzip", "accept-encoding"},
		{"/big.txt", "gzip", "accept-encoding"},
		// application/font-woff is not font/*, so it is zipped.
		{"/assets/big-abc123.woff", "gzip", "accept-encoding"},
		// font/* and image/* are skipped, without a Vary...
		{"/assets/big-abc123.woff2", "", ""},
		{"/big.png", "", ""},
		{"/big.webp", "", ""},
		// ...except image/svg+xml, which is text.
		{"/big.svg", "gzip", "accept-encoding"},
		// Bodies under 32 bytes are skipped, without a Vary.
		{"/small.css", "", ""},
		{"/healthz", "", ""},
		// {"error":"not found: /api/nope"} is exactly 32 bytes: zipped.
		{"/api/nope", "gzip", "accept-encoding"},
	}
	for _, c := range cases {
		res, body := send(app, c.uri, true)
		if got := res.Header.Get("Content-Encoding"); got != c.encoding {
			t.Errorf("%s: Content-Encoding = %q, want %q", c.uri, got, c.encoding)
		}
		if got := strings.ToLower(res.Header.Get("Vary")); got != c.vary {
			t.Errorf("%s: Vary = %q, want %q", c.uri, got, c.vary)
		}
		if c.encoding == "gzip" {
			if raw := gunzipBytes(t, body); len(raw) == 0 {
				t.Errorf("%s: empty body after gunzip", c.uri)
			}
		}

		// Without Accept-Encoding: never zipped, but the Vary is the same,
		// so a shared cache keeps the two variants apart.
		res, _ = send(app, c.uri, false)
		if got := res.Header.Get("Content-Encoding"); got != "" {
			t.Errorf("%s without gzip: Content-Encoding = %q, want none", c.uri, got)
		}
		if got := strings.ToLower(res.Header.Get("Vary")); got != c.vary {
			t.Errorf("%s without gzip: Vary = %q, want %q", c.uri, got, c.vary)
		}
	}
}

// A gzipped body unzips to exactly the file, and a Content-Length,
// if any, is that of the compressed body.
func TestGzipBodyRoundTrips(t *testing.T) {
	dir := testStaticDir(t)
	text := strings.Repeat("body { color: black; } ", 50)
	writeTestFile(t, filepath.Join(dir, "assets", "big-abc123.css"), text)
	res, body := send(testRouter(t, dir), "/assets/big-abc123.css", true)
	if got := res.Header.Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	if got := string(gunzipBytes(t, body)); got != text {
		t.Errorf("gunzipped body differs from the file (%d bytes, want %d)", len(got), len(text))
	}
	if cl := res.Header.Get("Content-Length"); cl != "" && cl != strconv.Itoa(len(body)) {
		t.Errorf("Content-Length = %s, but the body has %d bytes", cl, len(body))
	}
}
