// Package enrichtest is a mock of every upstream service enrichment talks
// to (Wikidata, Wikipedia, Commons, GBIF, iNaturalist), answering from the
// JSON fixtures in tests/fixtures/enrich/. Tests start it with Start.
//
// Point an Enricher at it with config.EndpointsUnder(base): every service
// then lives under one path prefix (/wikidata, /wikipedia, /commons,
// /gbif, /inat).
//
// Concepts introduced here:
// - `httptest.NewServer`: a real HTTP server on a free local port
// - implementing `http.Handler` with a ServeHTTP method
// - `sync/atomic` counters
package enrichtest

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"species/internal/testutil"
)

// Mock answers like the upstream services. The zero value is ready to use.
type Mock struct {
	// SlowPrefix: requests whose path starts with it answer only after
	// Delay ("" for none).
	SlowPrefix string
	Delay      time.Duration

	hits   atomic.Int64
	mu     sync.Mutex
	agents []string
}

// Hits is how many requests the mock has answered.
func (m *Mock) Hits() int {
	return int(m.hits.Load())
}

// Agents are the User-Agent headers of every request so far.
func (m *Mock) Agents() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	// A copy, so the caller can read it while requests keep arriving.
	agents := make([]string, len(m.agents))
	copy(agents, m.agents)
	return agents
}

// LEARN: `http.Handler` is an interface with one method,
// `ServeHTTP(http.ResponseWriter, *http.Request)`. Go interfaces are
// satisfied implicitly: *Mock has that method, so a *Mock can be passed
// anywhere an http.Handler is expected (httptest.NewServer, http.Server)
// without ever saying "implements".

// ServeHTTP counts the request, records its User-Agent, waits if the path
// starts with SlowPrefix, then answers from the fixtures.
func (m *Mock) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	m.hits.Add(1)
	if agents := r.Header.Values("User-Agent"); len(agents) > 0 {
		m.mu.Lock()
		m.agents = append(m.agents, agents[0])
		m.mu.Unlock()
	}

	// The path as sent, still percent-encoded, so tests see exactly what
	// the enricher put on the wire ("Homo_sapiens", "On%C3%A7a…").
	path := r.URL.EscapedPath()
	if m.SlowPrefix != "" && strings.HasPrefix(path, m.SlowPrefix) {
		// Give up early if the client already has (it timed out), so the
		// server can close without waiting out the whole delay.
		select {
		case <-time.After(m.Delay):
		case <-r.Context().Done():
			return
		}
	}

	status, fixture, body := answer(path, r.URL.Query())
	if fixture == "" {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(status)
		w.Write([]byte(body))
		return
	}
	data, err := os.ReadFile(testutil.Fixture("enrich/" + fixture))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	w.Write(data)
}

// Start serves m on a free local port until the test ends and returns its
// base URL ("http://127.0.0.1:PORT").
func Start(t testing.TB, m *Mock) string {
	t.Helper()
	srv := httptest.NewServer(m)
	t.Cleanup(srv.Close)
	return srv.URL
}

// answer picks the fixture an upstream would answer path?query with: the
// status code, and the fixture file name (or a literal body when fixture
// is "", e.g. `{"results":[]}` or a 404's "{}").
func answer(path string, query url.Values) (status int, fixture, body string) {
	ok := func(name string) (int, string, string) { return http.StatusOK, name, "" }
	notFound := func() (int, string, string) { return http.StatusNotFound, "", "{}" }

	if path == "/wikidata" {
		if query.Get("list") == "search" {
			switch query.Get("srsearch") {
			case "haswbstatement:P9157=770315":
				return ok("wd_search_ott770315.json")
			case "haswbstatement:P9157=42322":
				return ok("wd_search_ott42322.json")
			case "haswbstatement:P9157=3349025":
				return ok("wd_search_ott3349025.json")
			case "haswbstatement:P9157=3349021":
				return ok("wd_search_ott3349021.json")
			default:
				return ok("wd_search_none.json")
			}
		}
		switch query.Get("ids") {
		case "Q15978631|Q186266":
			return ok("wd_entities_homo.json")
		case "Q35694":
			return ok("wd_entities_onca.json")
		case "Q14896534":
			return ok("wd_entities_pselaphus_heisei.json")
		case "Q4047512":
			return ok("wd_entities_pselaphus.json")
		default:
			return notFound()
		}
	}
	if title, found := strings.CutPrefix(path, "/wikipedia/page/summary/"); found {
		switch title {
		case "Homo_sapiens":
			return ok("wp_summary_homo_sapiens.json")
		case "Jaguar":
			return ok("wp_summary_jaguar.json")
		case "Pselaphus":
			return ok("wp_summary_pselaphus.json")
		default:
			return notFound()
		}
	}
	if path == "/commons" {
		switch query.Get("titles") {
		case "File:Human.svg":
			return ok("commons_human_svg.json")
		case "File:Pselaphus heisei Jacobson.png":
			return ok("commons_pselaphus.json")
		case "File:Onça-pintada-PE Encontro das Águas-Thiagomarcelcampi(001).jpg":
			return ok("commons_onca.json")
		default:
			return ok("commons_missing.json")
		}
	}
	if key, found := strings.CutPrefix(path, "/gbif/v1/species/"); found {
		switch key {
		case "2436436", "5219426", "4440809":
			return ok("gbif_species_" + key + ".json")
		default:
			return notFound()
		}
	}
	if path == "/gbif/v1/occurrence/search" {
		switch key := query.Get("taxonKey"); key {
		case "2436436", "5219426", "4440809":
			return ok("gbif_occ_" + key + ".json")
		default:
			return notFound()
		}
	}
	if path == "/gbif/v2/map/occurrence/density/capabilities.json" {
		switch key := query.Get("taxonKey"); key {
		case "2436436", "5219426", "4440809":
			return ok("gbif_map_caps_" + key + ".json")
		default:
			return notFound()
		}
	}
	if path == "/gbif/v2/species/match" {
		switch query.Get("scientificName") {
		case "Homo sapiens":
			return ok("gbif_match_homo.json")
		case "Panthera onca":
			return ok("gbif_match_onca.json")
		default:
			return ok("gbif_match_pselaphus_heisei.json")
		}
	}
	if path == "/inat/taxa" {
		switch query.Get("q") {
		case "Panthera onca":
			return ok("inat_taxa_panthera_onca.json")
		case "Pselaphus heisei":
			return ok("inat_taxa_pselaphus_heisei.json")
		default:
			return http.StatusOK, "", `{"results":[]}`
		}
	}
	return notFound()
}
