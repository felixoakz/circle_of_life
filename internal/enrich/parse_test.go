// Parse tests on upstream responses captured once on 2026-10-28 into
// tests/fixtures/enrich/ (the Wikidata entity files are trimmed to the
// properties we read; their structure is unchanged).
//
// Concepts introduced here:
// - (none beyond the package's)

package enrich_test

import (
	"encoding/json"
	"os"
	"slices"
	"strings"
	"testing"

	"species/internal/enrich"
	"species/internal/testutil"
)

// fixture is the content of tests/fixtures/enrich/<name>.
func fixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(testutil.Fixture("enrich/" + name))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestWikidataSearchListsEveryHit(t *testing.T) {
	qids, err := enrich.ParseSearch(fixture(t, "wd_search_ott770315.json"))
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"Q15978631", "Q186266"}; !slices.Equal(qids, want) {
		t.Errorf("qids = %v, want %v", qids, want)
	}
	none, err := enrich.ParseSearch(fixture(t, "wd_search_none.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(none) != 0 {
		t.Errorf("no hits: got %v", none)
	}
}

func TestWikidataBusyIsAnErrorNotAnEmptyResult(t *testing.T) {
	// Wikidata answers HTTP 200 with {"error": {"code": "cirrussearch-too-busy-error"}}.
	_, err := enrich.ParseSearch(fixture(t, "wd_search_busy.json"))
	if err == nil {
		t.Fatal("want an error")
	}
	if !strings.Contains(err.Error(), "too-busy") {
		t.Errorf("error %q does not mention too-busy", err)
	}
}

func TestWikidataPicksTheItemWhoseTaxonNameMatches(t *testing.T) {
	body := fixture(t, "wd_entities_homo.json")
	// Search order puts Homo floresiensis first here; P225 must still win.
	qids := []string{"Q186266", "Q15978631"}
	item, err := enrich.ParseEntities(body, qids, "Homo sapiens")
	if err != nil {
		t.Fatal(err)
	}
	if item == nil {
		t.Fatal("no item")
	}
	if item.QID != "Q15978631" {
		t.Errorf("QID = %q", item.QID)
	}
	if item.Image == nil || *item.Image != "Human.svg" {
		t.Errorf("Image = %v", item.Image)
	}
	if item.GBIF == nil || *item.GBIF != 2436436 {
		t.Errorf("GBIF = %v", item.GBIF)
	}
	if item.Enwiki == nil || *item.Enwiki != "Homo sapiens" {
		t.Errorf("Enwiki = %v", item.Enwiki)
	}
	// Without a name match, the first item in search order.
	other, err := enrich.ParseEntities(body, qids, "Nobody")
	if err != nil {
		t.Fatal(err)
	}
	if other == nil || other.QID != "Q186266" {
		t.Errorf("fallback item = %+v, want Q186266", other)
	}
}

func TestWikidataStatementsOfTheJaguarAndTheCoelacanth(t *testing.T) {
	onca, err := enrich.ParseEntities(fixture(t, "wd_entities_onca.json"), []string{"Q35694"}, "Panthera onca")
	if err != nil {
		t.Fatal(err)
	}
	if onca == nil {
		t.Fatal("no jaguar")
	}
	if onca.IUCN == nil || *onca.IUCN != "NT" {
		t.Errorf("IUCN = %v", onca.IUCN)
	}
	if onca.IUCNID == nil || *onca.IUCNID != "15953" {
		t.Errorf("IUCNID = %v", onca.IUCNID)
	}
	if onca.Enwiki == nil || *onca.Enwiki != "Jaguar" {
		t.Errorf("Enwiki = %v", onca.Enwiki)
	}
	if onca.Ptwiki == nil || *onca.Ptwiki != "Panthera onca" {
		t.Errorf("Ptwiki = %v", onca.Ptwiki)
	}
	if onca.Image == nil || !strings.HasPrefix(*onca.Image, "Onça-pintada") {
		t.Errorf("Image = %v", onca.Image)
	}

	coelacanth, err := enrich.ParseEntities(fixture(t, "wd_entities_latimeria.json"), []string{"Q668921"}, "Latimeria chalumnae")
	if err != nil {
		t.Fatal(err)
	}
	if coelacanth == nil {
		t.Fatal("no coelacanth")
	}
	if coelacanth.IUCN == nil || *coelacanth.IUCN != "CR" {
		t.Errorf("IUCN = %v", coelacanth.IUCN)
	}
	if coelacanth.Ptwiki != nil {
		t.Errorf("Ptwiki = %q, want none", *coelacanth.Ptwiki)
	}
}

func TestIUCNMapMatchesTheLiveLabels(t *testing.T) {
	// wbgetentities labels for the eight P141 values, captured live.
	var body struct {
		Entities map[string]struct {
			Labels struct {
				En struct {
					Value string `json:"value"`
				} `json:"en"`
			} `json:"labels"`
		} `json:"entities"`
	}
	if err := json.Unmarshal(fixture(t, "wd_iucn_statuses.json"), &body); err != nil {
		t.Fatal(err)
	}
	expected := map[string]string{
		"least concern":         "LC",
		"near threatened":       "NT",
		"vulnerable":            "VU",
		"endangered species":    "EN",
		"critically endangered": "CR",
		"extinct in the wild":   "EW",
		"extinct":               "EX",
		"Data Deficient":        "DD",
	}
	if len(body.Entities) != len(expected) {
		t.Fatalf("%d entities, want %d", len(body.Entities), len(expected))
	}
	for qid, entity := range body.Entities {
		label := entity.Labels.En.Value
		want, known := expected[label]
		if !known {
			t.Errorf("%s: unexpected label %q", qid, label)
			continue
		}
		got, ok := enrich.IUCNCode(qid)
		if !ok || got != want {
			t.Errorf("IUCNCode(%s) = %q, %v; want %q (%s)", qid, got, ok, want, label)
		}
	}
}

func TestWikipediaSummary(t *testing.T) {
	summary, err := enrich.ParseSummary(fixture(t, "wp_summary_jaguar.json"))
	if err != nil {
		t.Fatal(err)
	}
	if summary == nil {
		t.Fatal("no summary")
	}
	if summary.Title != "Jaguar" {
		t.Errorf("Title = %q", summary.Title)
	}
	if summary.URL != "https://en.wikipedia.org/wiki/Jaguar" {
		t.Errorf("URL = %q", summary.URL)
	}
	if summary.Description == nil || *summary.Description != "Large cat native to the Americas" {
		t.Errorf("Description = %v", summary.Description)
	}
	if !strings.HasPrefix(summary.Text, "The jaguar is a large cat") {
		t.Errorf("Text = %q", summary.Text)
	}
	if summary.License != "CC BY-SA 4.0" {
		t.Errorf("License = %q", summary.License)
	}
	// The 404 body is not a summary.
	missing, err := enrich.ParseSummary(fixture(t, "wp_summary_missing.json"))
	if err != nil {
		t.Fatal(err)
	}
	if missing != nil {
		t.Errorf("missing article gave %+v", missing)
	}
}

func TestCommonsLicenceAndPlainTextArtist(t *testing.T) {
	image, err := enrich.ParseCommons(fixture(t, "commons_onca.json"))
	if err != nil {
		t.Fatal(err)
	}
	if image == nil {
		t.Fatal("no image")
	}
	if image.Credit == nil || *image.Credit != "Thiagomarcelcampi" {
		t.Errorf("Credit = %v", image.Credit)
	}
	if image.License != "CC BY-SA 4.0" {
		t.Errorf("License = %q", image.License)
	}
	if image.LicenseURL == nil || *image.LicenseURL != "https://creativecommons.org/licenses/by-sa/4.0" {
		t.Errorf("LicenseURL = %v", image.LicenseURL)
	}
	if image.Width == nil || *image.Width != 640 {
		t.Errorf("Width = %v", image.Width)
	}
	if strings.Contains(image.URL, "utm_source") {
		t.Errorf("URL keeps tracking: %s", image.URL)
	}
	if !strings.HasPrefix(image.PageURL, "https://commons.wikimedia.org/wiki/File:") {
		t.Errorf("PageURL = %q", image.PageURL)
	}

	flickr, err := enrich.ParseCommons(fixture(t, "commons_latimeria.json"))
	if err != nil {
		t.Fatal(err)
	}
	if flickr == nil || flickr.Credit == nil || *flickr.Credit != "sybarite48" {
		t.Errorf("flickr image = %+v", flickr)
	}
	publicDomain, err := enrich.ParseCommons(fixture(t, "commons_human_svg.json"))
	if err != nil {
		t.Fatal(err)
	}
	if publicDomain == nil {
		t.Fatal("no public-domain image")
	}
	if publicDomain.License != "Public domain" {
		t.Errorf("License = %q", publicDomain.License)
	}
	if publicDomain.LicenseURL != nil {
		t.Errorf("LicenseURL = %q, want none", *publicDomain.LicenseURL)
	}
	missing, err := enrich.ParseCommons(fixture(t, "commons_missing.json"))
	if err != nil {
		t.Fatal(err)
	}
	if missing != nil {
		t.Errorf("missing file gave %+v", missing)
	}
}

func TestGBIFSpeciesOccurrencesAndMapExtent(t *testing.T) {
	onca, err := enrich.ParseSpecies(fixture(t, "gbif_species_5219426.json"))
	if err != nil {
		t.Fatal(err)
	}
	if onca.Authorship == nil || *onca.Authorship != "(Linnaeus, 1758)" {
		t.Errorf("Authorship = %v", onca.Authorship)
	}
	if onca.Vernacular == nil || *onca.Vernacular != "jaguar" {
		t.Errorf("Vernacular = %v", onca.Vernacular)
	}
	coelacanth, err := enrich.ParseSpecies(fixture(t, "gbif_species_2441273.json"))
	if err != nil {
		t.Fatal(err)
	}
	// `publishedIn` arrives with <em> tags.
	wantPublished := "Smith, J. L. B. (1939). A living fish of Mesozoic type. Nature (London). v. 143 (no. 3620): 455-456."
	if coelacanth.PublishedIn == nil || *coelacanth.PublishedIn != wantPublished {
		t.Errorf("PublishedIn = %v", coelacanth.PublishedIn)
	}

	occ, err := enrich.ParseOccurrences(fixture(t, "gbif_occ_5219426.json"))
	if err != nil {
		t.Fatal(err)
	}
	if occ.Total != 146_418 {
		t.Errorf("Total = %d", occ.Total)
	}
	if occ.CountryTotal != 32 {
		t.Errorf("CountryTotal = %d", occ.CountryTotal)
	}
	if len(occ.Countries) == 0 {
		t.Fatal("no countries")
	}
	if want := (enrich.CountryCount{Code: "BR", Count: 97_224}); occ.Countries[0] != want {
		t.Errorf("Countries[0] = %v, want %v", occ.Countries[0], want)
	}
	// max(3, 0.1% of 146,418) = 147: every listed country clears it.
	for _, c := range occ.Countries {
		if c.Count < 147 {
			t.Errorf("%s has only %d records", c.Code, c.Count)
		}
	}
	if len(occ.Countries) >= occ.CountryTotal {
		t.Errorf("%d countries listed of %d: nothing filtered", len(occ.Countries), occ.CountryTotal)
	}

	extent, err := enrich.ParseCapabilities(fixture(t, "gbif_map_caps_5219426.json"))
	if err != nil {
		t.Fatal(err)
	}
	if want := [4]float64{-123.0, -53.0, 19.0, 51.0}; extent.Bbox == nil || *extent.Bbox != want {
		t.Errorf("Bbox = %v, want %v", extent.Bbox, want)
	}
}

func TestGBIFIUCNFallback(t *testing.T) {
	onca, ok, err := enrich.ParseMatchIUCN(fixture(t, "gbif_match_onca.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok || onca != "NT" {
		t.Errorf("onca = %q, %v; want NT", onca, ok)
	}
	homo, ok, err := enrich.ParseMatchIUCN(fixture(t, "gbif_match_homo.json"))
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Errorf("homo = %q, want none", homo)
	}
}

func TestINatLicenceFilterDropsAllRightsReserved(t *testing.T) {
	// The jaguar's default photo has license_code null ("all rights
	// reserved"); the CC BY-SA photo next to it is *Panthera atrox*, which
	// the exact name match must not take either.
	onca, err := enrich.ParseTaxa(fixture(t, "inat_taxa_panthera_onca.json"), "Panthera onca")
	if err != nil {
		t.Fatal(err)
	}
	if onca == nil {
		t.Fatal("no jaguar taxon")
	}
	if onca.Image != nil {
		t.Errorf("Image = %+v, want none", onca.Image)
	}

	beetle, err := enrich.ParseTaxa(fixture(t, "inat_taxa_pselaphus_heisei.json"), "Pselaphus heisei")
	if err != nil {
		t.Fatal(err)
	}
	if beetle == nil || beetle.Image == nil {
		t.Fatalf("beetle = %+v, want a taxon with an image", beetle)
	}
	image := beetle.Image
	if image.License != "CC BY-NC" {
		t.Errorf("License = %q", image.License)
	}
	if image.Credit == nil || *image.Credit != "Olli Pihlajamaa" {
		t.Errorf("Credit = %v", image.Credit)
	}
	if image.Source != "iNaturalist" {
		t.Errorf("Source = %q", image.Source)
	}
}
