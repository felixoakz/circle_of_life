// The read API end to end (PLAN §9 P4): build the mini tree.db with the
// real ingest, then send requests through the router with httptest (no
// socket) and check status codes, headers and JSON.
//
// Also byte snapshots of the JSON on mini.db and checks of how numbers in
// URLs are parsed.
//
// Concepts introduced here:
// - (none beyond the package's)

package server_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"

	"species/internal/server"
	"species/internal/testutil/minidb"
	"species/internal/tiles"
)

// apiApp ingests the mini fixtures into a temp dir and builds the router on
// it, with that dir (holding an index.html) as the static dir.
func apiApp(t *testing.T) http.Handler {
	t.Helper()
	out := minidb.Build(t)
	dir := filepath.Dir(out)
	writeTestFile(t, filepath.Join(dir, "index.html"), "<!doctype html>app")
	state, err := server.Open(out)
	if err != nil {
		t.Fatal(err)
	}
	return server.Router(state, dir)
}

// reply is one response, read into memory.
type reply struct {
	status int
	header http.Header
	body   []byte
}

// bytes is the body as the browser sees it: unzipped if it was zipped.
func (r reply) bytes(t *testing.T) []byte {
	t.Helper()
	if r.header.Get("Content-Encoding") != "" {
		return gunzipBytes(t, r.body)
	}
	return r.body
}

// json decodes the body: objects become map[string]any, arrays []any,
// numbers float64.
func (r reply) json(t *testing.T) any {
	t.Helper()
	var v any
	if err := json.Unmarshal(r.bytes(t), &v); err != nil {
		t.Fatalf("body is not JSON: %v\n%s", err, r.bytes(t))
	}
	return v
}

// apiGet GETs uri the way a browser does (accepting gzip).
func apiGet(app http.Handler, uri string) reply {
	res, body := send(app, uri, true)
	return reply{status: res.StatusCode, header: res.Header, body: body}
}

// getJSON is apiGet(...).json.
func getJSON(t *testing.T, app http.Handler, uri string) any {
	t.Helper()
	return apiGet(app, uri).json(t)
}

// at walks into decoded JSON: at(v, "children", "top", 0) is
// v["children"]["top"][0]; nil if any step is missing.
func at(v any, path ...any) any {
	for _, step := range path {
		switch key := step.(type) {
		case string:
			object, ok := v.(map[string]any)
			if !ok {
				return nil
			}
			v = object[key]
		case int:
			array, ok := v.([]any)
			if !ok || key >= len(array) {
				return nil
			}
			v = array[key]
		}
	}
	return v
}

// list is decoded JSON as an array (nil if it is not one).
func list(v any) []any {
	array, _ := v.([]any)
	return array
}

// isUint says a decoded JSON number is a whole number ≥ 0.
func isUint(v any) bool {
	n, ok := v.(float64)
	return ok && n >= 0 && n == float64(uint64(n))
}

func dataVersion(t *testing.T, app http.Handler) string {
	t.Helper()
	version, ok := at(getJSON(t, app, "/api/meta"), "dataVersion").(string)
	if !ok {
		t.Fatal("meta has no dataVersion")
	}
	return version
}

func TestMeta(t *testing.T) {
	app := apiApp(t)
	r := apiGet(app, "/api/meta")
	if r.status != http.StatusOK {
		t.Fatalf("status = %d, want 200", r.status)
	}
	if got := r.header.Get("Cache-Control"); got != "no-cache" {
		t.Errorf("Cache-Control = %q, want no-cache", got)
	}
	if got := r.header.Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", got)
	}
	meta := r.json(t)
	version, _ := at(meta, "dataVersion").(string)
	if !strings.HasPrefix(version, "otl16.1-ott3.7.3-") {
		t.Errorf("dataVersion = %q", version)
	}
	if got := at(meta, "tipCount"); got != 30.0 {
		t.Errorf("tipCount = %v, want 30", got)
	}
	if got := at(meta, "home", "nodeId"); got != "ott770315" {
		t.Errorf("home.nodeId = %v, want ott770315", got)
	}
}

func TestTileHasHeadersAndIsGzippedOnce(t *testing.T) {
	app := apiApp(t)
	version := dataVersion(t, app)
	r := apiGet(app, "/api/v/"+version+"/tiles/0/0")
	if r.status != http.StatusOK {
		t.Fatalf("status = %d, want 200", r.status)
	}
	headers := map[string]string{
		"Content-Type":     "application/octet-stream",
		"Content-Encoding": "gzip",
		"Cache-Control":    immutableCC,
	}
	for name, want := range headers {
		if got := r.header.Get(name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
	// One gunzip gives the raw tile: the gzip middleware did not zip it
	// again.
	raw := gunzipBytes(t, r.body)
	if !bytes.HasPrefix(raw, []byte("SPT2")) {
		t.Fatalf("tile starts with %q, want SPT2", raw[:min(4, len(raw))])
	}
	tile, err := tiles.Decode(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(tile.Nodes) != 57 {
		t.Errorf("tile has %d nodes, want 57", len(tile.Nodes))
	}
}

func TestAbsentTileIs204(t *testing.T) {
	app := apiApp(t)
	version := dataVersion(t, app)
	r := apiGet(app, "/api/v/"+version+"/tiles/9/17")
	if r.status != http.StatusNoContent {
		t.Errorf("status = %d, want 204", r.status)
	}
	if len(r.body) != 0 {
		t.Errorf("body = %q, want empty", r.body)
	}
	if got := r.header.Get("Cache-Control"); got != immutableCC {
		t.Errorf("Cache-Control = %q, want %q", got, immutableCC)
	}
}

func TestWrongVersionIs404AndBadNumbersAre400(t *testing.T) {
	app := apiApp(t)
	r := apiGet(app, "/api/v/otl0-old/tiles/0/0")
	if r.status != http.StatusNotFound {
		t.Errorf("status = %d, want 404", r.status)
	}
	if msg, _ := at(r.json(t), "error").(string); !strings.Contains(msg, "otl0-old") {
		t.Errorf("error = %q, want it to name otl0-old", msg)
	}

	version := dataVersion(t, app)
	r = apiGet(app, "/api/v/"+version+"/tiles/x/0")
	if r.status != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", r.status)
	}
	if _, ok := at(r.json(t), "error").(string); !ok {
		t.Error("400 without an error string")
	}
}

// Tile numbers accept a leading '+'; a level past 255 (uint8) is a 400.
func TestTileNumberParsing(t *testing.T) {
	app := apiApp(t)
	version := dataVersion(t, app)
	cases := []struct {
		path   string
		status int
	}{
		{"/+0/+0", http.StatusOK},
		{"/256/0", http.StatusBadRequest},
		{"/0/-1", http.StatusBadRequest},
		{"/0/4294967296", http.StatusBadRequest},
	}
	for _, c := range cases {
		r := apiGet(app, "/api/v/"+version+"/tiles"+c.path)
		if r.status != c.status {
			t.Errorf("tiles%s: status = %d, want %d", c.path, r.status, c.status)
		}
	}
}

func TestSearchRanksAndShapesResults(t *testing.T) {
	app := apiApp(t)
	r := apiGet(app, "/api/search?q=homo%20sap")
	if r.status != http.StatusOK {
		t.Fatalf("status = %d, want 200", r.status)
	}
	first := at(r.json(t), 0)
	fields := map[string]any{
		"nodeId":      "ott770315",
		"name":        "Homo sapiens",
		"matched":     "Homo sapiens",
		"matchedKind": "scientific",
		"rank":        "species",
		"r":           1.0,
	}
	for key, want := range fields {
		if got := at(first, key); got != want {
			t.Errorf("first hit %s = %v, want %v", key, got, want)
		}
	}
	// The 3 nearest named ancestors above genus, broadest first: the genus
	// Homo is skipped, "no rank" Primates counts.
	wantLineage := []any{"Mammalia", "Primates", "Homininae"}
	if got := at(first, "lineage"); !reflect.DeepEqual(got, wantLineage) {
		t.Errorf("first hit lineage = %v, want %v", got, wantLineage)
	}
	if !isUint(at(first, "angle")) {
		t.Errorf("first hit angle = %v, want an unsigned integer", at(first, "angle"))
	}

	// An exact name beats longer names that start with it.
	hits := getJSON(t, app, "/api/search?q=PAN")
	if got := at(hits, 0, "name"); got != "Pan" {
		t.Errorf("PAN: first hit = %v, want Pan", got)
	}
	if n := len(list(hits)); n < 3 {
		t.Errorf("PAN: %d hits, want at least 3", n)
	}

	hits = getJSON(t, app, "/api/search?q=urapteritra&limit=3")
	if n := len(list(hits)); n != 3 {
		t.Errorf("urapteritra&limit=3: %d hits, want 3", n)
	}
	if got := at(hits, 0, "name"); got != "Urapteritra" {
		t.Errorf("urapteritra: first hit = %v, want Urapteritra", got)
	}

	// Two letters match whole words only: "pan" is a word, "pa" is not.
	if hits := getJSON(t, app, "/api/search?q=pa"); !reflect.DeepEqual(hits, []any{}) {
		t.Errorf("pa: hits = %v, want []", hits)
	}

	// Too short, only quotes, or missing: empty, not an error.
	for _, uri := range []string{"/api/search?q=h", "/api/search?q=%22%22", "/api/search"} {
		r := apiGet(app, uri)
		if r.status != http.StatusOK {
			t.Errorf("%s: status = %d, want 200", uri, r.status)
		}
		if got := r.json(t); !reflect.DeepEqual(got, []any{}) {
			t.Errorf("%s: hits = %v, want []", uri, got)
		}
	}
}

func TestCommonNamesAreFoundInEnglishAndPortuguese(t *testing.T) {
	app := apiApp(t)

	// "human" is a common name of Homo sapiens and of the genus Homo; the
	// species, with more names in GBIF, comes first.
	hits := getJSON(t, app, "/api/search?q=Human")
	fields := map[string]any{
		"nodeId":      "ott770315",
		"name":        "Homo sapiens",
		"matched":     "Human",
		"matchedKind": "vernacular",
		"matchedLang": "en",
		"commonName":  "Human",
	}
	for key, want := range fields {
		if got := at(hits, 0, key); got != want {
			t.Errorf("Human: first hit %s = %v, want %v", key, got, want)
		}
	}
	if got := at(hits, 1, "name"); got != "Homo" {
		t.Errorf("Human: second hit = %v, want Homo", got)
	}

	// Portuguese, with and without the accent, and a hyphenated name typed
	// with a space.
	for _, q := range []string{"pardal", "pardal-dom", "pardal%20dom", "carvalho"} {
		if got := at(getJSON(t, app, "/api/search?q="+q), 0, "matchedLang"); got != "pt" {
			t.Errorf("%s: matchedLang = %v, want pt", q, got)
		}
	}
	hits = getJSON(t, app, "/api/search?q=pardal")
	if got := at(hits, 0, "name"); got != "Passer domesticus" {
		t.Errorf("pardal: first hit = %v, want Passer domesticus", got)
	}
	if got := at(hits, 0, "matched"); got != "pardal" {
		t.Errorf("pardal: matched = %v, want pardal", got)
	}
	for _, q := range []string{"chimpanz%C3%A9", "chimpanze"} {
		if got := at(getJSON(t, app, "/api/search?q="+q), 0, "name"); got != "Pan troglodytes" {
			t.Errorf("%s: first hit = %v, want Pan troglodytes", q, got)
		}
	}

	// A node found by several names is listed once, with its best match.
	hits = getJSON(t, app, "/api/search?q=chimpanzee")
	pan := 0
	for _, hit := range list(hits) {
		if at(hit, "name") == "Pan troglodytes" {
			pan++
		}
	}
	if pan != 1 {
		t.Errorf("chimpanzee: Pan troglodytes listed %d times, want 1", pan)
	}
	if got := at(hits, 0, "matched"); got != "Chimpanzee" {
		t.Errorf("chimpanzee: matched = %v, want Chimpanzee", got)
	}

	// A scientific match still says it is one, and has no language.
	hits = getJSON(t, app, "/api/search?q=passer")
	if got := at(hits, 0, "matchedKind"); got != "scientific" {
		t.Errorf("passer: matchedKind = %v, want scientific", got)
	}
	first, _ := at(hits, 0).(map[string]any)
	if lang, present := first["matchedLang"]; !present || lang != nil {
		t.Errorf("passer: matchedLang = %v (present %v), want null", lang, present)
	}
	if got := at(hits, 0, "commonName"); got != "House sparrow" {
		t.Errorf("passer: commonName = %v, want House sparrow", got)
	}
}

func TestMalformedSearchLimitIsAJSON400(t *testing.T) {
	app := apiApp(t)
	// limit=+3: in a query string '+' means a space, so this is " 3",
	// which is rejected too.
	for _, uri := range []string{
		"/api/search?q=homo&limit=abc",
		"/api/search?q=homo&limit=-1",
		"/api/search?q=homo&limit=+3",
	} {
		r := apiGet(app, uri)
		if r.status != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400", uri, r.status)
		}
		if got := r.header.Get("Content-Type"); got != "application/json" {
			t.Errorf("%s: Content-Type = %q, want application/json", uri, got)
		}
		if msg, _ := at(r.json(t), "error").(string); !strings.Contains(msg, "limit") {
			t.Errorf("%s: error = %q, want it to mention limit", uri, msg)
		}
	}
}

// Limit accepts an encoded '+' and is clamped to 1..50.
func TestSearchLimitParsing(t *testing.T) {
	app := apiApp(t)
	cases := []struct {
		uri  string
		hits int
	}{
		{"/api/search?q=homo&limit=%2B3", 3},
		{"/api/search?q=homo&limit=0", 1},
		{"/api/search?q=homo&limit=1", 1},
	}
	for _, c := range cases {
		r := apiGet(app, c.uri)
		if r.status != http.StatusOK {
			t.Errorf("%s: status = %d, want 200", c.uri, r.status)
			continue
		}
		if n := len(list(r.json(t))); n != c.hits {
			t.Errorf("%s: %d hits, want %d", c.uri, n, c.hits)
		}
	}
}

func TestNodeByIDOttAndMrca(t *testing.T) {
	app := apiApp(t)
	byOtt := getJSON(t, app, "/api/nodes/ott770315")
	if got := at(byOtt, "name"); got != "Homo sapiens" {
		t.Errorf("name = %v, want Homo sapiens", got)
	}
	if got := at(byOtt, "ids", "ott"); got != 770315.0 {
		t.Errorf("ids.ott = %v, want 770315", got)
	}
	flags, _ := at(byOtt, "flags").(float64)
	if uint8(flags)&tiles.FlagHome == 0 {
		t.Errorf("flags = %v, want the home flag", flags)
	}
	if got := at(byOtt, "namedAncestor"); got != nil {
		t.Errorf("namedAncestor = %v, want null", got)
	}

	id, _ := at(byOtt, "id").(float64)
	byID := getJSON(t, app, "/api/nodes/"+formatUint(id))
	if !reflect.DeepEqual(byID, byOtt) {
		t.Errorf("by id differs from by ott:\n%v\n%v", byID, byOtt)
	}

	r := apiGet(app, "/api/nodes/mrcaott786ott3428")
	if r.status != http.StatusOK {
		t.Fatalf("mrca: status = %d, want 200", r.status)
	}
	mrca := r.json(t)
	if got := at(mrca, "name"); got != nil {
		t.Errorf("mrca name = %v, want null", got)
	}
	if got := at(mrca, "ids", "ott"); got != nil {
		t.Errorf("mrca ids.ott = %v, want null", got)
	}
	if got := at(mrca, "namedAncestor", "name"); got != "Primates" {
		t.Errorf("mrca namedAncestor.name = %v, want Primates", got)
	}
	// r is sent as the float32 the tiles hold, so it prints short.
	if text := string(r.bytes(t)); !strings.Contains(text, `"r":0.724,`) {
		t.Errorf(`body lacks "r":0.724,: %s`, text)
	}
}

// formatUint prints a decoded JSON number as an integer.
func formatUint(n float64) string {
	return strconv.FormatUint(uint64(n), 10)
}

func TestLineageRunsRootToParent(t *testing.T) {
	app := apiApp(t)
	lineage := list(at(getJSON(t, app, "/api/nodes/ott770315"), "lineage"))
	var names []string
	for _, entry := range lineage {
		name, ok := at(entry, "name").(string)
		if !ok {
			name = "-"
		}
		names = append(names, name)
	}
	want := []string{
		"cellular organisms", "Eukaryota", "Opisthokonta", "Metazoa", "Chordata",
		"Mammalia", "Primates", "-", "Homininae", "Homo",
	}
	if !slices.Equal(names, want) {
		t.Errorf("lineage = %q, want %q", names, want)
	}

	// Radii grow from the root (r0) outwards, and every entry has geometry.
	lastR := 0.0
	for i, entry := range lineage {
		r, _ := at(entry, "r").(float64)
		if r <= lastR {
			t.Errorf("lineage[%d].r = %v, not above %v", i, r, lastR)
		}
		lastR = r
		if !isUint(at(entry, "angle")) {
			t.Errorf("lineage[%d].angle = %v, want an unsigned integer", i, at(entry, "angle"))
		}
	}
	if got := at(lineage, 0, "r"); got != 0.08 {
		t.Errorf("lineage[0].r = %v, want 0.08", got)
	}

	// The root has no lineage.
	if got := at(getJSON(t, app, "/api/nodes/0"), "lineage"); !reflect.DeepEqual(got, []any{}) {
		t.Errorf("root lineage = %v, want []", got)
	}
}

func TestChildrenAreLargestFirstWithTotal(t *testing.T) {
	app := apiApp(t)
	root := getJSON(t, app, "/api/nodes/0")
	if got := at(root, "children", "total"); got != 3.0 {
		t.Errorf("root children.total = %v, want 3", got)
	}
	var leafCounts []float64
	for _, child := range list(at(root, "children", "top")) {
		n, _ := at(child, "leafCount").(float64)
		leafCounts = append(leafCounts, n)
	}
	if want := []float64{25, 3, 2}; !slices.Equal(leafCounts, want) {
		t.Errorf("root children leaf counts = %v, want %v", leafCounts, want)
	}

	genus := getJSON(t, app, "/api/nodes/ott530093")
	if got := at(genus, "children", "total"); got != 8.0 {
		t.Errorf("genus children.total = %v, want 8", got)
	}
	if n := len(list(at(genus, "children", "top"))); n != 8 {
		t.Errorf("genus children.top has %d entries, want 8", n)
	}
}

func TestUnknownOrMalformedNode(t *testing.T) {
	app := apiApp(t)
	for _, uri := range []string{
		"/api/nodes/ott999999",
		"/api/nodes/mrcaott1ott2",
		"/api/nodes/4000000",
	} {
		r := apiGet(app, uri)
		if r.status != http.StatusNotFound {
			t.Errorf("%s: status = %d, want 404", uri, r.status)
		}
		if msg, _ := at(r.json(t), "error").(string); !strings.HasPrefix(msg, "not found: node ") {
			t.Errorf("%s: error = %q", uri, msg)
		}
	}
	r := apiGet(app, "/api/nodes/felis")
	if r.status != http.StatusBadRequest {
		t.Errorf("felis: status = %d, want 400", r.status)
	}
	if _, ok := at(r.json(t), "error").(string); !ok {
		t.Error("felis: 400 without an error string")
	}
}

// Node refs accept a leading '+'.
func TestNodeRefsWithAPlusSign(t *testing.T) {
	app := apiApp(t)
	if got := at(getJSON(t, app, "/api/nodes/+5"), "nodeId"); got != "ott44033" {
		t.Errorf("/api/nodes/+5: nodeId = %v, want ott44033", got)
	}
	// Parsed as ott 5, which is not in the mini tree.
	r := apiGet(app, "/api/nodes/ott+5")
	if r.status != http.StatusNotFound {
		t.Errorf("ott+5: status = %d, want 404", r.status)
	}
	if msg, _ := at(r.json(t), "error").(string); msg != "not found: node ott+5" {
		t.Errorf("ott+5: error = %q", msg)
	}
}

// The server's bodies on mini.db, byte for byte. They pin
// float formatting ("r":1.0, "r":0.724), key order, null for absent
// values and [] (not null) for empty arrays.
const (
	snapshotSearchHit = `[{"id":44,"nodeId":"ott770315","name":"Homo sapiens","rank":"species","group":0,"flags":15,"leafCount":1,"childCount":0,"level":0,"angle":2934894318,"arcLo":2934894318,"arcHi":2934894318,"r":1.0,"commonName":"Human","matched":"Homo sapiens","matchedKind":"scientific","matchedLang":null,"lineage":["Mammalia","Primates","Homininae"]}]`

	snapshotHomoSapiens = `{"id":44,"nodeId":"ott770315","name":"Homo sapiens","rank":"species","group":0,"flags":15,"leafCount":1,"childCount":0,"level":0,"angle":2934894318,"arcLo":2934894318,"arcHi":2934894318,"r":1.0,"commonName":"Human","ids":{"ott":770315,"gbif":2436436,"ncbi":9606},"lineage":[{"id":0,"nodeId":"ott93302","name":"cellular organisms","rank":"no rank","group":255,"angle":952945867,"r":0.08},{"id":8,"nodeId":"ott304358","name":"Eukaryota","rank":"domain","group":255,"angle":1762726159,"r":0.172},{"id":27,"nodeId":"ott332573","name":"Opisthokonta","rank":"no rank","group":255,"angle":2666458861,"r":0.264},{"id":31,"nodeId":"ott691846","name":"Metazoa","rank":"kingdom","group":0,"angle":3185434076,"r":0.356},{"id":32,"nodeId":"ott125642","name":"Chordata","rank":"phylum","group":0,"angle":2648563164,"r":0.448},{"id":36,"nodeId":"ott244265","name":"Mammalia","rank":"class","group":0,"angle":2863311529,"r":0.54},{"id":37,"nodeId":"ott913935","name":"Primates","rank":"no rank","group":0,"angle":2863311529,"r":0.632},{"id":38,"nodeId":"mrcaott786ott3428","name":null,"rank":null,"group":0,"angle":2863311529,"r":0.724},{"id":39,"nodeId":"ott312031","name":"Homininae","rank":"subfamily","group":0,"angle":2863311529,"r":0.816},{"id":43,"nodeId":"ott770309","name":"Homo","rank":"genus","group":0,"angle":3006477106,"r":0.908}],"children":{"total":0,"top":[]},"namedAncestor":null}`

	snapshotMrca = `{"id":38,"nodeId":"mrcaott786ott3428","name":null,"rank":null,"group":0,"flags":0,"leafCount":4,"childCount":1,"level":0,"angle":2863311529,"arcLo":2863311529,"arcHi":2863311529,"r":0.724,"commonName":null,"ids":{"ott":null,"gbif":null,"ncbi":null},"lineage":[{"id":0,"nodeId":"ott93302","name":"cellular organisms","rank":"no rank","group":255,"angle":952945867,"r":0.08},{"id":8,"nodeId":"ott304358","name":"Eukaryota","rank":"domain","group":255,"angle":1762726159,"r":0.172},{"id":27,"nodeId":"ott332573","name":"Opisthokonta","rank":"no rank","group":255,"angle":2666458861,"r":0.264},{"id":31,"nodeId":"ott691846","name":"Metazoa","rank":"kingdom","group":0,"angle":3185434076,"r":0.356},{"id":32,"nodeId":"ott125642","name":"Chordata","rank":"phylum","group":0,"angle":2648563164,"r":0.448},{"id":36,"nodeId":"ott244265","name":"Mammalia","rank":"class","group":0,"angle":2863311529,"r":0.54},{"id":37,"nodeId":"ott913935","name":"Primates","rank":"no rank","group":0,"angle":2863311529,"r":0.632}],"children":{"total":1,"top":[{"id":39,"nodeId":"ott312031","name":"Homininae","rank":"subfamily","group":0,"leafCount":4}]},"namedAncestor":{"id":37,"nodeId":"ott913935","name":"Primates","rank":"no rank","group":0,"angle":2863311529,"r":0.632}}`
)

// Exact JSON bytes of a search hit and of two nodes.
func TestJSONSnapshots(t *testing.T) {
	app := apiApp(t)
	cases := []struct{ uri, want string }{
		{"/api/search?q=homo%20sap&limit=1", snapshotSearchHit},
		{"/api/nodes/ott770315", snapshotHomoSapiens},
		{"/api/nodes/mrcaott786ott3428", snapshotMrca},
		// An empty search is [], never null, and no trailing newline.
		{"/api/search?q=pa", `[]`},
	}
	for _, c := range cases {
		r := apiGet(app, c.uri)
		if r.status != http.StatusOK {
			t.Errorf("%s: status = %d, want 200", c.uri, r.status)
			continue
		}
		if got := string(r.bytes(t)); got != c.want {
			t.Errorf("%s:\n got %s\nwant %s", c.uri, got, c.want)
		}
	}
}

// /api/meta's keys are alphabetical at every level (tree.db stores the
// meta JSON that way; the server sends it as it is).
func TestMetaKeyOrder(t *testing.T) {
	app := apiApp(t)
	body := apiGet(app, "/api/meta").bytes(t)

	var meta struct {
		Groups []json.RawMessage `json:"groups"`
		Home   json.RawMessage   `json:"home"`
		Runs   []json.RawMessage `json:"runs"`
	}
	if err := json.Unmarshal(body, &meta); err != nil {
		t.Fatal(err)
	}
	if len(meta.Groups) == 0 || len(meta.Runs) == 0 {
		t.Fatalf("meta has no groups or runs: %s", body)
	}
	cases := []struct {
		what string
		raw  []byte
		want []string
	}{
		{"meta", body, []string{"dataVersion", "groups", "home", "maxLevel", "nodeCount",
			"r0", "runs", "speciesCount", "tileP", "tipCount"}},
		{"groups[0]", meta.Groups[0], []string{"id", "name", "rootIds", "tipCount"}},
		{"home", meta.Home, []string{"angle", "id", "nodeId"}},
		{"runs[0]", meta.Runs[0], []string{"angleHi", "angleLo", "group"}},
	}
	for _, c := range cases {
		if got := objectKeys(t, c.raw); !slices.Equal(got, c.want) {
			t.Errorf("%s keys = %q, want %q", c.what, got, c.want)
		}
	}
	// r0 is a float and keeps its short form.
	if !bytes.Contains(body, []byte(`"r0":0.08,`)) {
		t.Errorf(`meta lacks "r0":0.08,: %s`, body)
	}
}

// objectKeys lists the keys of a JSON object in the order they appear.
func objectKeys(t *testing.T, raw []byte) []string {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader(raw))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		t.Fatalf("not a JSON object: %s", raw)
	}
	var keys []string
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			t.Fatal(err)
		}
		keys = append(keys, tok.(string))
		// Skip the value, whatever its shape.
		var skip json.RawMessage
		if err := dec.Decode(&skip); err != nil {
			t.Fatal(err)
		}
	}
	return keys
}
