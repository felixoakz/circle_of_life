// GBIF (PLAN §6.1): the species record (authorship, where it was published,
// a common name), occurrence counts per country, the extent of the density
// map, and, when Wikidata has no conservation status, the IUCN category
// from GBIF's name matcher. All GBIF data is CC BY 4.0.
//
// Concepts introduced here:
// - `math.Ceil` and converting between integers and floats

package enrich

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"slices"
	"strconv"
	"strings"
)

// SpeciesInfo is what the species record gives us.
type SpeciesInfo struct {
	Authorship  *string
	PublishedIn *string
	Vernacular  *string
	// Rank is lowercase, as OTT writes ranks: "species".
	Rank *string
	// Family is the family in GBIF's classification, for the generated
	// sentence.
	Family *string
}

type speciesResponse struct {
	Authorship     *string `json:"authorship"`
	PublishedIn    *string `json:"publishedIn"`
	VernacularName *string `json:"vernacularName"`
	Rank           *string `json:"rank"`
	Family         *string `json:"family"`
}

// nonEmpty is text as plain text, or nil if there is none.
func nonEmpty(text *string) *string {
	if text == nil {
		return nil
	}
	plain := StripHTML(*text)
	if plain == "" {
		return nil
	}
	return &plain
}

// ParseSpecies reads GET /v1/species/{key}.
func ParseSpecies(body []byte) (SpeciesInfo, error) {
	var response speciesResponse
	if err := json.Unmarshal(body, &response); err != nil {
		return SpeciesInfo{}, err
	}
	info := SpeciesInfo{
		Authorship:  nonEmpty(response.Authorship),
		PublishedIn: nonEmpty(response.PublishedIn),
		Vernacular:  nonEmpty(response.VernacularName),
		Rank:        nonEmpty(response.Rank),
		Family:      nonEmpty(response.Family),
	}
	if info.Rank != nil {
		info.Rank = new(strings.ToLower(*info.Rank))
	}
	return info, nil
}

// Occurrences are occurrence records and where they are.
type Occurrences struct {
	Total uint64
	// Countries are ISO 3166 alpha-2 codes and counts above the noise
	// threshold, most first (a stable sort).
	Countries []CountryCount
	// CountryTotal counts countries with any record at all.
	CountryTotal int
}

type occurrenceResponse struct {
	// A pointer, to tell a missing count (an error) from 0.
	Count  *uint64 `json:"count"`
	Facets []struct {
		Counts []struct {
			Name  string `json:"name"`
			Count uint64 `json:"count"`
		} `json:"counts"`
	} `json:"facets"`
}

// CountryThreshold is the fewest records for a country to be listed:
// max(3, ceil(0.1% of all records)). A handful of museum specimens should
// not put a jaguar in Germany.
func CountryThreshold(total uint64) uint64 {
	// LEARN: Go never converts between number types implicitly; `float64(x)`
	// and `uint64(f)` say so. uint64 → float64 may round above 2^53, which
	// occurrence counts never reach; math.Ceil rounds up, and float64 →
	// uint64 drops the (zero) fraction.
	perMille := uint64(math.Ceil(float64(total) * 0.001))
	return max(perMille, 3)
}

// ParseOccurrences reads GET /v1/occurrence/search with a country facet.
func ParseOccurrences(body []byte) (Occurrences, error) {
	var response occurrenceResponse
	if err := json.Unmarshal(body, &response); err != nil {
		return Occurrences{}, err
	}
	if response.Count == nil {
		return Occurrences{}, errors.New("occurrence search response without count")
	}
	total := *response.Count
	threshold := CountryThreshold(total)
	countries := []CountryCount{}
	countryTotal := 0
	if len(response.Facets) > 0 {
		for _, entry := range response.Facets[0].Counts {
			if entry.Count == 0 {
				continue
			}
			countryTotal++
			if entry.Count >= threshold {
				countries = append(countries, CountryCount{Code: entry.Name, Count: entry.Count})
			}
		}
	}
	// GBIF already sorts by count; sorting again makes that a guarantee.
	slices.SortStableFunc(countries, func(a, b CountryCount) int {
		return cmp.Compare(b.Count, a.Count)
	})
	return Occurrences{Total: total, Countries: countries, CountryTotal: countryTotal}, nil
}

// Extent is where the density map has data.
type Extent struct {
	Total uint64
	// Bbox is [minLng, minLat, maxLng, maxLat]; nil when there is no data.
	Bbox *[4]float64
}

type capabilities struct {
	MinLat *float64 `json:"minLat"`
	MaxLat *float64 `json:"maxLat"`
	MinLng *float64 `json:"minLng"`
	MaxLng *float64 `json:"maxLng"`
	Total  uint64   `json:"total"`
}

// ParseCapabilities reads the density map's capabilities.json.
func ParseCapabilities(body []byte) (Extent, error) {
	var caps capabilities
	if err := json.Unmarshal(body, &caps); err != nil {
		return Extent{}, err
	}
	extent := Extent{Total: caps.Total}
	if caps.Total > 0 && caps.MinLng != nil && caps.MinLat != nil && caps.MaxLng != nil && caps.MaxLat != nil {
		extent.Bbox = &[4]float64{*caps.MinLng, *caps.MinLat, *caps.MaxLng, *caps.MaxLat}
	}
	return extent, nil
}

type matchResponse struct {
	AdditionalStatus []struct {
		DatasetAlias *string `json:"datasetAlias"`
		StatusCode   *string `json:"statusCode"`
	} `json:"additionalStatus"`
}

// ParseMatchIUCN is the IUCN category from GBIF's v2 name match, if it has
// one we show; false otherwise.
func ParseMatchIUCN(body []byte) (string, bool, error) {
	var response matchResponse
	if err := json.Unmarshal(body, &response); err != nil {
		return "", false, err
	}
	for _, status := range response.AdditionalStatus {
		if status.DatasetAlias != nil && *status.DatasetAlias == "IUCN" && status.StatusCode != nil {
			code, ok := KnownIUCNCode(*status.StatusCode)
			return code, ok, nil
		}
	}
	return "", false, nil
}

// gbifSpecies is GET /v1/species/{key}; nil for key nil or on failure.
func (e *Enricher) gbifSpecies(ctx context.Context, report *Report, key *int64) *SpeciesInfo {
	if key == nil {
		return nil
	}
	rawURL := fmt.Sprintf("%s/v1/species/%d", e.Endpoints.GBIF, *key)
	body, ok := e.getText(ctx, report, HostGBIF, SourceGBIF, rawURL, nil)
	if !ok {
		return nil
	}
	info, err := ParseSpecies(body)
	if err != nil {
		report.Fail(SourceGBIF, fmt.Sprintf("species %d: %v", *key, err))
		return nil
	}
	return &info
}

// gbifOccurrences is GET /v1/occurrence/search, counts only (limit=0) with
// a country facet, under the slow timeout.
func (e *Enricher) gbifOccurrences(ctx context.Context, report *Report, key *int64) *Occurrences {
	if key == nil {
		return nil
	}
	taxonKey := strconv.FormatInt(*key, 10)
	rawURL := e.Endpoints.GBIF + "/v1/occurrence/search"
	query := url.Values{}
	query.Set("taxonKey", taxonKey)
	query.Set("limit", "0")
	query.Set("facet", "country")
	query.Set("facetLimit", "300")
	query.Set("hasGeospatialIssue", "false")
	query.Set("occurrenceStatus", "PRESENT")
	body, ok := e.getTextSlow(ctx, report, HostGBIF, SourceGBIF, rawURL, query)
	if !ok {
		return nil
	}
	occ, err := ParseOccurrences(body)
	if err != nil {
		report.Fail(SourceGBIF, fmt.Sprintf("occurrences %s: %v", taxonKey, err))
		return nil
	}
	return &occ
}

// gbifExtent is the density map's extent
// (/v2/map/occurrence/density/capabilities.json). The browser loads the
// map tiles itself, straight from GBIF.
func (e *Enricher) gbifExtent(ctx context.Context, report *Report, key *int64) *Extent {
	if key == nil {
		return nil
	}
	taxonKey := strconv.FormatInt(*key, 10)
	rawURL := e.Endpoints.GBIF + "/v2/map/occurrence/density/capabilities.json"
	query := url.Values{}
	query.Set("taxonKey", taxonKey)
	body, ok := e.getText(ctx, report, HostGBIF, SourceGBIF, rawURL, query)
	if !ok {
		return nil
	}
	extent, err := ParseCapabilities(body)
	if err != nil {
		report.Fail(SourceGBIF, fmt.Sprintf("map extent %s: %v", taxonKey, err))
		return nil
	}
	return &extent
}

// gbifIUCNStatus is the IUCN category via GET
// /v2/species/match?scientificName=…; name "" means "do not ask".
func (e *Enricher) gbifIUCNStatus(ctx context.Context, report *Report, name string) (string, bool) {
	if name == "" {
		return "", false
	}
	rawURL := e.Endpoints.GBIF + "/v2/species/match"
	query := url.Values{}
	query.Set("scientificName", name)
	body, ok := e.getText(ctx, report, HostGBIF, SourceGBIF, rawURL, query)
	if !ok {
		return "", false
	}
	code, found, err := ParseMatchIUCN(body)
	if err != nil {
		report.Fail(SourceGBIF, fmt.Sprintf("match %s: %v", name, err))
		return "", false
	}
	return code, found
}
