// The /about document (ARCHITECTURE §6.3): the JSON body of
// GET /api/nodes/{ref}/about. It is written to the client and read back
// from cache.db, so the same types serve both directions.
//
// Field order is JSON key order, so it is part of the API. Absent values
// are pointers that encode as null (no omitempty: the client reads one
// shape with every key present). Slices must never be nil, or they would
// encode as null instead of [].
//
// Concepts introduced here:
// - pointers as "maybe absent" values that encode to JSON null
// - custom JSON for a pair (`[["BR", 120], …]`)

package enrich

import (
	"bytes"
	"encoding/json"
	"errors"

	"species/internal/jsonfloat"
)

// About is the body of GET /api/nodes/{ref}/about.
type About struct {
	NodeID   string    `json:"nodeId"`
	Taxonomy *Taxonomy `json:"taxonomy"`
	// CommonNames are English common names, best first (GBIF, then the
	// Wikipedia title). Never nil.
	CommonNames  []string      `json:"commonNames"`
	Summary      *Summary      `json:"summary"`
	Image        *Image        `json:"image"`
	Status       *Status       `json:"status"`
	Distribution *Distribution `json:"distribution"`
	// Generated is always present; the panel shows it when there is no
	// summary.
	Generated string `json:"generated"`
	Links     Links  `json:"links"`
	// Failed lists sources that failed or timed out (empty when Complete).
	// Never nil.
	Failed    []string `json:"failed"`
	Complete  bool     `json:"complete"`
	FetchedAt int64    `json:"fetchedAt"`
	// RateLimited: a source failed because it was rate limited (HTTP 429
	// or 503, or the Wikimedia gate), so the cache keeps this document for
	// minutes rather than a day.
	RateLimited bool `json:"rateLimited"`
}

// Taxonomy is the authorship and publication of the name, from GBIF.
type Taxonomy struct {
	// Authorship is e.g. "Linnaeus, 1758".
	Authorship  *string `json:"authorship"`
	PublishedIn *string `json:"publishedIn"`
	Source      string  `json:"source"`
}

// AboutRef says which node a borrowed text or image is really about.
type AboutRef struct {
	NodeID string  `json:"nodeId"`
	Name   string  `json:"name"`
	Rank   *string `json:"rank"`
}

// Summary is a Wikipedia article summary.
type Summary struct {
	Text string `json:"text"`
	// Description is Wikipedia's short description, "Large cat native to
	// the Americas".
	Description *string `json:"description"`
	// Title is the article title, "Jaguar".
	Title   string `json:"title"`
	URL     string `json:"url"`
	License string `json:"license"`
	// About is set when the article is an ancestor's (the node has none).
	About *AboutRef `json:"about"`
}

// Image is a photo or drawing with its attribution.
type Image struct {
	URL    string  `json:"url"`
	Width  *uint32 `json:"width"`
	Height *uint32 `json:"height"`
	// Credit is the author as plain text; nil if the source names nobody.
	Credit *string `json:"credit"`
	// License is never empty: an image without a known licence is not used.
	License    string  `json:"license"`
	LicenseURL *string `json:"licenseUrl"`
	// Source is "Wikimedia Commons" or "iNaturalist".
	Source string `json:"source"`
	// PageURL is the file or photo page, where the full attribution lives.
	PageURL string    `json:"pageUrl"`
	About   *AboutRef `json:"about"`
}

// Status is a conservation status.
type Status struct {
	// Code is the IUCN Red List category: LC, NT, VU, EN, CR, EW, EX or DD.
	Code string `json:"code"`
	// Source is "Wikidata" or "GBIF".
	Source string `json:"source"`
}

// Distribution is where GBIF has occurrence records.
type Distribution struct {
	// Occurrences counts records (present, without geospatial issues).
	Occurrences uint64 `json:"occurrences"`
	// Countries above the noise threshold, most records first. Never nil.
	Countries []CountryCount `json:"countries"`
	// CountryTotal counts every country with at least one record.
	CountryTotal int   `json:"countryTotal"`
	GBIFKey      int64 `json:"gbifKey"`
	// Bbox is where the density map has data, [minLng, minLat, maxLng,
	// maxLat]; nil when there is none.
	Bbox *[4]jsonfloat.F64 `json:"bbox"`
}

// CountryCount is one country and its record count. In JSON it is a
// two-element array, ["BR", 120], the shape the frontend reads.
type CountryCount struct {
	Code  string
	Count uint64
}

// MarshalJSON writes ["BR",120].
func (c CountryCount) MarshalJSON() ([]byte, error) {
	// An encoder with SetEscapeHTML(false), like everywhere we write JSON:
	// json.Marshal would turn <, > and & into \u003c… and the outer encoder
	// copies our bytes as they are.
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	pair := []any{c.Code, c.Count}
	if err := enc.Encode(pair); err != nil {
		return nil, err
	}
	// Encode ends with a newline; the pair is part of a larger document.
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

// UnmarshalJSON reads ["BR",120] (a cached document).
func (c *CountryCount) UnmarshalJSON(data []byte) error {
	// Read the array first, then each element with its own type, so that
	// ["BR"], [120,"BR"] and ["BR",-1] are errors.
	var pair []json.RawMessage
	if err := json.Unmarshal(data, &pair); err != nil {
		return err
	}
	if len(pair) != 2 {
		return errors.New("a country count must be a [code, count] pair")
	}
	var code string
	if err := json.Unmarshal(pair[0], &code); err != nil {
		return err
	}
	// Unmarshalling null into a string leaves it unchanged without an
	// error; a null here means a broken document, so refuse it.
	if bytes.Equal(bytes.TrimSpace(pair[0]), []byte("null")) || bytes.Equal(bytes.TrimSpace(pair[1]), []byte("null")) {
		return errors.New("a country count cannot hold null")
	}
	var count uint64
	if err := json.Unmarshal(pair[1], &count); err != nil {
		return err
	}
	c.Code = code
	c.Count = count
	return nil
}

// Links are the outbound links in the panel.
type Links struct {
	Opentree  string  `json:"opentree"`
	Wikipedia *string `json:"wikipedia"`
	// WikipediaPt is the Portuguese article, for a later pt-BR UI.
	WikipediaPt *string `json:"wikipediaPt"`
	Wikidata    *string `json:"wikidata"`
	GBIF        *string `json:"gbif"`
	INat        *string `json:"inat"`
	IUCN        *string `json:"iucn"`
}
