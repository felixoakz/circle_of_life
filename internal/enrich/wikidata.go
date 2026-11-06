// Wikidata (ARCHITECTURE §6.1 stage A): find the item for a taxon and read the few
// statements we use.
//
// Two Action API calls: a search for items carrying the OTT id (property
// P9157), or failing that the GBIF id (P846), then wbgetentities for their
// statements and Wikipedia titles. Several items can carry one OTT id
// (ott770315 has two), so we take the one whose taxon name (P225) equals
// ours, else the first in search order.
//
// Concepts introduced here:
// - decoding JSON objects with dynamic keys into a map
// - `any` for values whose shape varies, read back with type assertions

package enrich

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

// Item is what we keep from one Wikidata item.
type Item struct {
	// QID is e.g. "Q35694".
	QID string
	// TaxonName is P225.
	TaxonName *string
	// Image is P18, a Commons file name without the "File:" prefix.
	Image *string
	// IUCN is P141 as a code (see IUCNCode).
	IUCN *string
	// IUCNID is P627, the IUCN taxon id.
	IUCNID *string
	// GBIF is P846, the GBIF taxon key.
	GBIF *int64
	// INatID is P3151, the iNaturalist taxon id.
	INatID *string
	Enwiki *string
	Ptwiki *string
}

// IUCNCode maps a P141 value (an IUCN Red List category as a Wikidata item)
// to its code; false for anything else. Each QID was checked against its
// Wikidata label on 2026-10-28 (tests/fixtures/enrich/wd_iucn_statuses.json).
func IUCNCode(qid string) (string, bool) {
	switch qid {
	case "Q211005":
		return "LC", true // least concern
	case "Q719675":
		return "NT", true // near threatened
	case "Q278113":
		return "VU", true // vulnerable
	case "Q11394":
		return "EN", true // endangered species
	case "Q219127":
		return "CR", true // critically endangered
	case "Q239509":
		return "EW", true // extinct in the wild
	case "Q237350":
		return "EX", true // extinct
	case "Q3245245":
		return "DD", true // Data Deficient
	}
	return "", false
}

// The Action API answers errors with HTTP 200 and an "error" object (for
// example "cirrussearch-too-busy-error"), so every response type has one.
type apiError struct {
	Code string `json:"code"`
}

type searchResponse struct {
	Query *struct {
		Search []struct {
			Title string `json:"title"`
		} `json:"search"`
	} `json:"query"`
	Error *apiError `json:"error"`
}

// ParseSearch gives the QIDs of a list=search response, best match first.
// The Action API answers errors with HTTP 200 and an "error" object, which
// is an error here.
func ParseSearch(body []byte) ([]string, error) {
	var response searchResponse
	if err := json.Unmarshal(body, &response); err != nil {
		return nil, err
	}
	if response.Error != nil {
		return nil, fmt.Errorf("Wikidata error %s", response.Error.Code)
	}
	if response.Query == nil {
		return nil, errors.New("Wikidata search response without results")
	}
	qids := []string{}
	for _, hit := range response.Query.Search {
		if strings.HasPrefix(hit.Title, "Q") {
			qids = append(qids, hit.Title)
		}
	}
	return qids, nil
}

// LEARN: a JSON object whose keys are data ("Q35694": {…}) rather than
// fixed field names decodes into a `map[string]T`. A key missing from the
// JSON leaves the map nil, and reading a nil map is fine: it is empty.
type entitiesResponse struct {
	Entities map[string]entity `json:"entities"`
	Error    *apiError         `json:"error"`
}

type entity struct {
	Claims    map[string][]claim  `json:"claims"`
	Sitelinks map[string]sitelink `json:"sitelinks"`
}

type claim struct {
	Mainsnak struct {
		// Absent for "unknown value" and "no value" statements.
		Datavalue *struct {
			// A statement's value is a string for some properties and an
			// object ({"id": "Q…"}) for others, so it stays untyped.
			Value any `json:"value"`
		} `json:"datavalue"`
	} `json:"mainsnak"`
	// Rank is "preferred", "normal" or "deprecated".
	Rank string `json:"rank"`
}

type sitelink struct {
	Title string `json:"title"`
}

// bestValue is the best statement of property: a preferred one if any,
// else the first normal one. Deprecated statements are never used.
func bestValue(claims map[string][]claim, property string) (any, bool) {
	var normal any
	found := false
	for _, c := range claims[property] {
		if c.Mainsnak.Datavalue == nil {
			continue
		}
		if c.Rank == "preferred" {
			return c.Mainsnak.Datavalue.Value, true
		}
		if c.Rank != "deprecated" && !found {
			normal = c.Mainsnak.Datavalue.Value
			found = true
		}
	}
	return normal, found
}

// stringValue is a string-valued statement (P225, P18, P846, …).
func stringValue(claims map[string][]claim, property string) *string {
	value, found := bestValue(claims, property)
	if !found {
		return nil
	}
	// LEARN: `v.(string)` is a type assertion: it asks whether the `any`
	// value v holds a string. The two-result form never panics; ok is false
	// when v holds something else (an object, a number, nil).
	text, ok := value.(string)
	if !ok {
		return nil
	}
	return &text
}

// itemValue is an item-valued statement's QID (P141).
func itemValue(claims map[string][]claim, property string) *string {
	value, found := bestValue(claims, property)
	if !found {
		return nil
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	id, ok := object["id"].(string)
	if !ok {
		return nil
	}
	return &id
}

func itemFrom(qid string, e entity) *Item {
	item := &Item{
		QID:       qid,
		TaxonName: stringValue(e.Claims, "P225"),
		Image:     stringValue(e.Claims, "P18"),
		IUCNID:    stringValue(e.Claims, "P627"),
		INatID:    stringValue(e.Claims, "P3151"),
	}
	if iucnQID := itemValue(e.Claims, "P141"); iucnQID != nil {
		if code, ok := IUCNCode(*iucnQID); ok {
			item.IUCN = &code
		}
	}
	if key := stringValue(e.Claims, "P846"); key != nil {
		if gbif, err := strconv.ParseInt(*key, 10, 64); err == nil {
			item.GBIF = &gbif
		}
	}
	if link, ok := e.Sitelinks["enwiki"]; ok {
		item.Enwiki = new(link.Title)
	}
	if link, ok := e.Sitelinks["ptwiki"]; ok {
		item.Ptwiki = new(link.Title)
	}
	return item
}

// ParseEntities picks, among qids, the item whose P225 is name, else the
// first one present; nil if none is.
func ParseEntities(body []byte, qids []string, name string) (*Item, error) {
	var response entitiesResponse
	if err := json.Unmarshal(body, &response); err != nil {
		return nil, err
	}
	if response.Error != nil {
		return nil, fmt.Errorf("Wikidata error %s", response.Error.Code)
	}
	// A map has no order, so walk qids (the search order) instead.
	var first *Item
	for _, qid := range qids {
		e, ok := response.Entities[qid]
		if !ok {
			continue
		}
		item := itemFrom(qid, e)
		if item.TaxonName != nil && *item.TaxonName == name {
			return item, nil
		}
		if first == nil {
			first = item
		}
	}
	return first, nil
}

// wikidataSearch gives the QIDs of the items with statement
// ("haswbstatement:P9157=42322"); false if the search failed (recorded in
// report).
func (e *Enricher) wikidataSearch(ctx context.Context, report *Report, statement string) ([]string, bool) {
	query := url.Values{}
	query.Set("action", "query")
	query.Set("list", "search")
	query.Set("srsearch", statement)
	query.Set("srlimit", "5")
	query.Set("format", "json")
	body, ok := e.getText(ctx, report, HostWikimedia, SourceWikidata, e.Endpoints.Wikidata, query)
	if !ok {
		return nil, false
	}
	qids, err := ParseSearch(body)
	if err != nil {
		report.Fail(SourceWikidata, fmt.Sprintf("search %s: %v", statement, err))
		return nil, false
	}
	return qids, true
}

// wikidataLookup is the Wikidata item for a taxon: by OTT id, else by GBIF
// key. nil when there is none or Wikidata failed (then report says so).
func (e *Enricher) wikidataLookup(ctx context.Context, report *Report, ott *uint32, name string, gbif *int64) *Item {
	var qids []string
	if ott != nil {
		found, ok := e.wikidataSearch(ctx, report, fmt.Sprintf("haswbstatement:P9157=%d", *ott))
		if !ok {
			return nil
		}
		qids = found
	}
	if len(qids) == 0 && gbif != nil {
		found, ok := e.wikidataSearch(ctx, report, fmt.Sprintf("haswbstatement:P846=%d", *gbif))
		if !ok {
			return nil
		}
		qids = found
	}
	if len(qids) == 0 {
		return nil
	}

	ids := strings.Join(qids, "|")
	query := url.Values{}
	query.Set("action", "wbgetentities")
	query.Set("ids", ids)
	query.Set("props", "claims|sitelinks")
	query.Set("sitefilter", "enwiki|ptwiki")
	query.Set("format", "json")
	body, ok := e.getText(ctx, report, HostWikimedia, SourceWikidata, e.Endpoints.Wikidata, query)
	if !ok {
		return nil
	}
	item, err := ParseEntities(body, qids, name)
	if err != nil {
		report.Fail(SourceWikidata, fmt.Sprintf("entities %s: %v", ids, err))
		return nil
	}
	return item
}
