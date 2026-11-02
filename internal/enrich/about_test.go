// Whole /about documents assembled against enrichtest's mock of every
// upstream service: the enricher's Endpoints point at it, and it counts
// every request and records the User-Agent.
//
// Concepts introduced here:
// - (none beyond the package's)

package enrich_test

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"species/internal/config"
	"species/internal/enrich"
	"species/internal/enrich/enrichtest"
	"species/internal/jsonfloat"
)

func newEnricher(base string, timeout time.Duration) *enrich.Enricher {
	return enrich.New(enrich.Settings{
		Endpoints:   config.EndpointsUnder(base),
		UserAgent:   config.UserAgent("https://circle.example", "test-contact"),
		Timeout:     timeout,
		SlowTimeout: timeout,
		INatGap:     10 * time.Millisecond,
	})
}

func ancestor(name, rank string, ott uint32) enrich.Ancestor {
	return enrich.Ancestor{
		NodeID: fmt.Sprintf("ott%d", ott),
		Ott:    new(ott),
		Name:   name,
		Rank:   new(rank),
	}
}

func beetle() enrich.Taxon {
	return enrich.Taxon{
		NodeID:    "ott3349025",
		Ott:       new(uint32(3349025)),
		Name:      "Pselaphus heisei",
		Rank:      new("species"),
		GBIF:      new(int64(4440809)),
		LeafCount: 1,
		Ancestors: []enrich.Ancestor{
			ancestor("Pselaphus", "genus", 3349021),
			ancestor("Staphylinidae", "family", 1),
		},
	}
}

func jaguar() enrich.Taxon {
	return enrich.Taxon{
		NodeID:    "ott42322",
		Ott:       new(uint32(42322)),
		Name:      "Panthera onca",
		Rank:      new("species"),
		GBIF:      new(int64(5219426)),
		LeafCount: 1,
		Ancestors: []enrich.Ancestor{
			ancestor("Panthera", "genus", 563154),
			ancestor("Felidae", "family", 563159),
		},
	}
}

// is reports whether p points at want.
func is(p *string, want string) bool {
	return p != nil && *p == want
}

// The mock itself answers from the fixtures, counts and records.
func TestMockAnswersFromFixtures(t *testing.T) {
	mock := &enrichtest.Mock{}
	base := enrichtest.Start(t, mock)

	get := func(path string) (int, string, string) {
		t.Helper()
		req, err := http.NewRequest("GET", base+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("User-Agent", "probe/1")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		return resp.StatusCode, resp.Header.Get("Content-Type"), string(body)
	}

	status, contentType, body := get("/wikidata?action=query&list=search&srsearch=haswbstatement%3AP9157%3D770315")
	if status != 200 || contentType != "application/json" {
		t.Errorf("search: %d %q", status, contentType)
	}
	if want := string(fixture(t, "wd_search_ott770315.json")); body != want {
		t.Errorf("search body is not wd_search_ott770315.json: %.80q", body)
	}
	status, _, body = get("/wikipedia/page/summary/Jaguar")
	if want := string(fixture(t, "wp_summary_jaguar.json")); status != 200 || body != want {
		t.Errorf("summary: %d %.80q", status, body)
	}
	status, _, body = get("/commons?titles=File%3AOn%C3%A7a-pintada-PE+Encontro+das+%C3%81guas-Thiagomarcelcampi%28001%29.jpg")
	if want := string(fixture(t, "commons_onca.json")); status != 200 || body != want {
		t.Errorf("commons: %d %.80q", status, body)
	}
	status, _, body = get("/wikipedia/page/summary/Nothing_here")
	if status != 404 || body != "{}" {
		t.Errorf("missing summary: %d %q", status, body)
	}
	status, _, body = get("/inat/taxa?q=Nobody")
	if status != 200 || body != `{"results":[]}` {
		t.Errorf("unknown iNat name: %d %q", status, body)
	}
	status, _, _ = get("/nowhere")
	if status != 404 {
		t.Errorf("unknown path: %d", status)
	}

	if mock.Hits() != 6 {
		t.Errorf("Hits = %d, want 6", mock.Hits())
	}
	agents := mock.Agents()
	if len(agents) != 6 || agents[0] != "probe/1" {
		t.Errorf("Agents = %v", agents)
	}
}

// SlowPrefix delays only the matching paths.
func TestMockSlowPrefix(t *testing.T) {
	mock := &enrichtest.Mock{SlowPrefix: "/gbif", Delay: 300 * time.Millisecond}
	base := enrichtest.Start(t, mock)
	client := &http.Client{Timeout: 100 * time.Millisecond}

	resp, err := client.Get(base + "/inat/taxa?q=Panthera+onca")
	if err != nil {
		t.Fatalf("a fast path timed out: %v", err)
	}
	resp.Body.Close()
	if _, err := client.Get(base + "/gbif/v1/species/5219426"); err == nil {
		t.Error("a slow path answered within 100 ms")
	}
}

func TestJaguarDocumentFromEverySource(t *testing.T) {
	mock := &enrichtest.Mock{}
	base := enrichtest.Start(t, mock)
	doc := newEnricher(base, 4*time.Second).About(context.Background(), jaguar(), 1)

	if !doc.Complete {
		t.Fatalf("incomplete: failed %v", doc.Failed)
	}
	if doc.Summary == nil {
		t.Fatal("no summary")
	}
	if doc.Summary.Title != "Jaguar" {
		t.Errorf("summary title = %q", doc.Summary.Title)
	}
	if doc.Summary.About != nil {
		t.Errorf("summary borrowed from %+v", doc.Summary.About)
	}
	if want := []string{"jaguar"}; !slices.Equal(doc.CommonNames, want) {
		t.Errorf("CommonNames = %v, want %v", doc.CommonNames, want)
	}
	if doc.Image == nil {
		t.Fatal("no image")
	}
	if doc.Image.Source != "Wikimedia Commons" || doc.Image.License != "CC BY-SA 4.0" {
		t.Errorf("image source %q, license %q", doc.Image.Source, doc.Image.License)
	}
	if doc.Status == nil || doc.Status.Code != "NT" || doc.Status.Source != "Wikidata" {
		t.Errorf("Status = %+v, want NT from Wikidata", doc.Status)
	}
	if doc.Distribution == nil {
		t.Fatal("no distribution")
	}
	if doc.Distribution.Occurrences != 146_418 {
		t.Errorf("Occurrences = %d", doc.Distribution.Occurrences)
	}
	if want := [4]jsonfloat.F64{-123.0, -53.0, 19.0, 51.0}; doc.Distribution.Bbox == nil || *doc.Distribution.Bbox != want {
		t.Errorf("Bbox = %v, want %v", doc.Distribution.Bbox, want)
	}
	if !is(doc.Links.Wikidata, "https://www.wikidata.org/wiki/Q35694") {
		t.Errorf("Links.Wikidata = %v", doc.Links.Wikidata)
	}
	if !is(doc.Links.Wikipedia, "https://en.wikipedia.org/wiki/Jaguar") {
		t.Errorf("Links.Wikipedia = %v", doc.Links.Wikipedia)
	}
	if !is(doc.Links.IUCN, "https://www.iucnredlist.org/details/15953/0") {
		t.Errorf("Links.IUCN = %v", doc.Links.IUCN)
	}
	if doc.Taxonomy == nil || !is(doc.Taxonomy.Authorship, "(Linnaeus, 1758)") {
		t.Errorf("Taxonomy = %+v", doc.Taxonomy)
	}
}

func TestObscureBeetleGetsGeneratedSentenceAndLabelledAncestorArticle(t *testing.T) {
	mock := &enrichtest.Mock{}
	base := enrichtest.Start(t, mock)
	doc := newEnricher(base, 4*time.Second).About(context.Background(), beetle(), 1)

	if !doc.Complete {
		t.Fatalf("incomplete: failed %v", doc.Failed)
	}
	want := "Pselaphus heisei Herbst, 1791 is a species in the family Staphylinidae. " +
		"GBIF has 1,881 occurrence records of it from 24 countries."
	if doc.Generated != want {
		t.Errorf("Generated = %q\nwant        %q", doc.Generated, want)
	}
	if doc.Summary == nil || doc.Summary.About == nil {
		t.Fatalf("Summary = %+v, want one borrowed from the genus", doc.Summary)
	}
	about := doc.Summary.About
	if about.Name != "Pselaphus" || !is(about.Rank, "genus") {
		t.Errorf("borrowed from %q (rank %v), want Pselaphus (genus)", about.Name, about.Rank)
	}
	if !strings.HasPrefix(doc.Summary.Text, "Pselaphus is a genus of ant-loving beetles") {
		t.Errorf("Text = %q", doc.Summary.Text)
	}
	// The borrowed article is not the beetle's own Wikipedia link.
	if doc.Links.Wikipedia != nil {
		t.Errorf("Links.Wikipedia = %q, want none", *doc.Links.Wikipedia)
	}
	// Wikidata has a public-domain plate of the beetle itself.
	if doc.Image == nil || doc.Image.License != "Public domain" {
		t.Errorf("Image = %+v, want the public-domain plate", doc.Image)
	}
}

func TestAncestorArticleFromCacheCostsNoLookup(t *testing.T) {
	mock := &enrichtest.Mock{}
	base := enrichtest.Start(t, mock)
	e := newEnricher(base, 4*time.Second)

	taxon := beetle()
	genus, err := enrich.ParseSummary(fixture(t, "wp_summary_pselaphus.json"))
	if err != nil {
		t.Fatal(err)
	}
	if genus == nil {
		t.Fatal("no genus summary")
	}
	taxon.Ancestors[0].CachedSummary = genus
	withCache := e.About(context.Background(), taxon, 1)
	hitsCached := mock.Hits()
	if withCache.Summary == nil || withCache.Summary.About == nil || withCache.Summary.About.Name != "Pselaphus" {
		t.Errorf("Summary = %+v, want the cached genus article", withCache.Summary)
	}

	without := e.About(context.Background(), beetle(), 1)
	if without.Summary == nil {
		t.Error("no summary without the cache")
	}
	// The uncached run needs the genus' Wikidata search, entities and summary.
	if got, want := mock.Hits()-hitsCached, hitsCached+3; got != want {
		t.Errorf("uncached run made %d requests, want %d (cached run made %d)", got, want, hitsCached)
	}
}

func TestTimeoutGivesAPartialDocument(t *testing.T) {
	mock := &enrichtest.Mock{SlowPrefix: "/gbif", Delay: 1500 * time.Millisecond}
	base := enrichtest.Start(t, mock)
	doc := newEnricher(base, 300*time.Millisecond).About(context.Background(), jaguar(), 1)

	if doc.Complete {
		t.Error("complete despite a timeout")
	}
	if want := []string{"GBIF"}; !slices.Equal(doc.Failed, want) {
		t.Errorf("Failed = %v, want %v", doc.Failed, want)
	}
	// Everything else still arrived.
	if doc.Summary == nil || doc.Summary.Title != "Jaguar" {
		t.Errorf("Summary = %+v", doc.Summary)
	}
	if doc.Image == nil {
		t.Error("no image")
	}
	if doc.Status == nil || doc.Status.Code != "NT" {
		t.Errorf("Status = %+v", doc.Status)
	}
	if doc.Distribution != nil {
		t.Errorf("Distribution = %+v, want none", doc.Distribution)
	}
	if doc.Taxonomy != nil {
		t.Errorf("Taxonomy = %+v, want none", doc.Taxonomy)
	}
	if !strings.HasPrefix(doc.Generated, "Panthera onca is a species in the family Felidae.") {
		t.Errorf("Generated = %q", doc.Generated)
	}
}

func TestUserAgentCarriesTheContact(t *testing.T) {
	mock := &enrichtest.Mock{}
	base := enrichtest.Start(t, mock)
	newEnricher(base, 4*time.Second).About(context.Background(), jaguar(), 1)

	agents := mock.Agents()
	if len(agents) == 0 {
		t.Fatal("no requests recorded")
	}
	for _, agent := range agents {
		if !strings.HasPrefix(agent, "species-circle/") ||
			!strings.Contains(agent, "test-contact") ||
			!strings.Contains(agent, "+https://circle.example") {
			t.Errorf("User-Agent %q", agent)
		}
	}
}
