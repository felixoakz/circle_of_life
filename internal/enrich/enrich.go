// Package enrich fetches what Wikidata, Wikipedia, Wikimedia Commons, GBIF
// and iNaturalist know about a node when someone opens its panel, and
// assembles one attributed /about document (PLAN §6). The server caches the
// document in cache.db (internal/server); this package only fetches.
//
// The flow, per node:
//   - Stage A, in parallel: the Wikidata item (by OTT id, else by GBIF id),
//     GBIF species, GBIF occurrence counts and the GBIF map extent.
//   - Stage B, in parallel, using stage A: the Wikipedia summary, the
//     Commons image licence, an iNaturalist photo if Wikidata has no image,
//     and the IUCN status from GBIF if Wikidata has none.
//   - Fallbacks: with no Wikipedia article, the nearest genus, family or
//     order that has one (clearly labelled), plus a sentence generated from
//     the structured data, which is always present.
//
// A source that fails or times out leaves its part empty and is listed in
// Failed; the document is then incomplete and cached for a day only (ten
// minutes when a source was rate limited). Wikimedia requests pass a
// shared gate (gate.go): a token bucket, and a cooldown after a 429 or 503.
// Nothing here returns an error to the client.
//
// Concepts introduced here:
// - `context.Context` and `context.WithTimeout` per upstream request
// - buffered channels as semaphores (at most N requests per host)
// - `sync.WaitGroup.Go`: run several functions and wait for all
// - `sync.Mutex` guarding shared state
package enrich

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"species/internal/config"
	"species/internal/jsonfloat"
)

// Synth is the synthesis release, for Open Tree links.
const Synth = "opentree16.1"

// Timeout is how long each upstream request gets, start to finish (PLAN
// §6.1).
const Timeout = 4 * time.Second

// SlowTimeout is for GBIF's faceted occurrence search, which took 5 to 20 s
// on a query GBIF had not cached (October 2026).
const SlowTimeout = 10 * time.Second

// INatGap: iNaturalist asks for at most one request per second.
const INatGap = time.Second

// Source names, as shown to people in "Couldn't reach …".
const (
	SourceWikidata  = "Wikidata"
	SourceWikipedia = "Wikipedia"
	SourceCommons   = "Wikimedia Commons"
	SourceGBIF      = "GBIF"
	SourceINat      = "iNaturalist"
)

// WikipediaLicense is the text licence of every Wikipedia extract.
const WikipediaLicense = "CC BY-SA 4.0"

// Taxon is the node to enrich, from tree.db.
type Taxon struct {
	NodeID    string
	Ott       *uint32
	Name      string
	Rank      *string
	GBIF      *int64
	LeafCount uint32
	// Ancestors are the named ancestors, nearest first.
	Ancestors []Ancestor
}

// Ancestor is one named ancestor of a Taxon.
type Ancestor struct {
	NodeID string
	Ott    *uint32
	Name   string
	Rank   *string
	// CachedSummary is the ancestor's own Wikipedia summary, if cache.db
	// already has it.
	CachedSummary *Summary
}

// FallbackRanks are the ranks an article may be borrowed from (PLAN §6.1).
var FallbackRanks = [3]string{"genus", "family", "order"}

// FallbackTries is how many ancestors to try for an article.
const FallbackTries = 3

// Fallbacks are the ancestors worth trying for a borrowed article, nearest
// first: rank in FallbackRanks and an OTT id, at most FallbackTries.
func (t Taxon) Fallbacks() []Ancestor {
	var out []Ancestor
	for _, ancestor := range t.Ancestors {
		rank := ""
		if ancestor.Rank != nil {
			rank = *ancestor.Rank
		}
		if slices.Contains(FallbackRanks[:], rank) && ancestor.Ott != nil {
			out = append(out, ancestor)
		}
		if len(out) == FallbackTries {
			break
		}
	}
	return out
}

// Report collects which sources failed while one document is assembled.
// Safe for concurrent use.
type Report struct {
	mu     sync.Mutex
	failed []string
	// rateLimited: at least one failure was a "too many requests"
	// (ErrRateLimited).
	rateLimited bool
}

// Fail logs why and records source as failed (once).
func (r *Report) Fail(source, why string) {
	slog.Warn("enrichment source failed", "source", source, "why", why)
	// LEARN: a `sync.Mutex` lets one goroutine at a time past Lock; the
	// others wait until Unlock. Every read and write of r.failed happens
	// between the two, so goroutines of the same document never see it
	// half-updated. `defer r.mu.Unlock()` unlocks however the function
	// returns.
	r.mu.Lock()
	defer r.mu.Unlock()
	if !slices.Contains(r.failed, source) {
		r.failed = append(r.failed, source)
	}
}

// failRateLimited is Fail for a failure that wraps ErrRateLimited.
func (r *Report) failRateLimited(source, why string) {
	r.Fail(source, why)
	r.mu.Lock()
	defer r.mu.Unlock()
	r.rateLimited = true
}

// RateLimited reports whether any source failed because it was rate
// limited.
func (r *Report) RateLimited() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.rateLimited
}

// HasFailed reports whether source has failed.
func (r *Report) HasFailed(source string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Contains(r.failed, source)
}

// Failed is the failed sources in the order they failed; never nil.
func (r *Report) Failed() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	// A copy, never nil, so the document encodes [] rather than null.
	failed := make([]string, len(r.failed))
	copy(failed, r.failed)
	return failed
}

// Host is which per-host limit a request counts against (PLAN §6.2).
type Host uint8

const (
	// HostWikimedia is shared by Wikidata, Wikipedia and Commons: 4 at
	// once, and through the Wikimedia gate (gate.go).
	HostWikimedia Host = iota
	// HostGBIF allows 8 at once.
	HostGBIF
	// HostINat allows 1 at once, INatGap apart.
	HostINat
)

// Settings say how to build an Enricher.
type Settings struct {
	Endpoints config.Endpoints
	UserAgent string
	Timeout   time.Duration
	// SlowTimeout is for the few calls known to be slow.
	SlowTimeout time.Duration
	INatGap     time.Duration
	// WikimediaRate is the Wikimedia token bucket's rate per second, with
	// bursts of WikimediaBurst (gate.go); 0 turns the bucket off. The
	// cooldown after a 429 or 503 is always on.
	WikimediaRate  float64
	WikimediaBurst int
}

// LiveSettings are the real services with the standard limits.
func LiveSettings(userAgent string) Settings {
	return Settings{
		Endpoints:      config.LiveEndpoints(),
		UserAgent:      userAgent,
		Timeout:        Timeout,
		SlowTimeout:    SlowTimeout,
		INatGap:        INatGap,
		WikimediaRate:  WikimediaRate,
		WikimediaBurst: WikimediaBurst,
	}
}

// Enricher is shared by every request: one HTTP client and the per-host
// limits.
type Enricher struct {
	Endpoints config.Endpoints

	client      *http.Client
	userAgent   string
	timeout     time.Duration
	slowTimeout time.Duration

	// Semaphores: a send takes a slot, a receive gives it back.
	wikimedia chan struct{}
	gbif      chan struct{}
	inat      chan struct{}

	// inatMu is held across the sleep that keeps iNat requests inatGap apart.
	inatMu   sync.Mutex
	inatLast time.Time
	inatGap  time.Duration

	// wikimediaGate paces Wikimedia requests and shuts after a 429 or 503.
	wikimediaGate *gate
}

// New builds an Enricher.
func New(s Settings) *Enricher {
	return &Enricher{
		Endpoints: s.Endpoints,
		// One client for every request: its Transport keeps a pool of open
		// connections, so requests to the same host reuse them. No
		// client-wide Timeout: each request gets its own context deadline.
		client:      &http.Client{},
		userAgent:   s.UserAgent,
		timeout:     s.Timeout,
		slowTimeout: s.SlowTimeout,
		// LEARN: a buffered channel of capacity N works as a semaphore.
		// Sending takes a slot and blocks while all N are taken; receiving
		// gives one back. The values carry nothing, so the element type is
		// struct{}, which takes no memory.
		wikimedia:     make(chan struct{}, 4),
		gbif:          make(chan struct{}, 8),
		inat:          make(chan struct{}, 1),
		inatGap:       s.INatGap,
		wikimediaGate: newGate(s.WikimediaRate, s.WikimediaBurst),
	}
}

// getText GETs rawURL with query and returns the body. A 404 is a definite
// "nothing there" (false, no failure). Anything else that is not a
// success, including 429/503 and timeouts, is recorded in report under
// source and also gives false: fail fast, never sleep in the request path
// (beyond the Wikimedia gate's short wait for a token).
func (e *Enricher) getText(ctx context.Context, report *Report, host Host, source, rawURL string, query url.Values) ([]byte, bool) {
	body, found, err := e.tryGetText(ctx, host, rawURL, query, e.timeout)
	return record(report, source, rawURL, body, found, err)
}

// getTextSlow is getText with the slow timeout.
func (e *Enricher) getTextSlow(ctx context.Context, report *Report, host Host, source, rawURL string, query url.Values) ([]byte, bool) {
	body, found, err := e.tryGetText(ctx, host, rawURL, query, e.slowTimeout)
	return record(report, source, rawURL, body, found, err)
}

// record turns tryGetText's result into getText's: the body, or false with
// any failure recorded in report.
func record(report *Report, source, rawURL string, body []byte, found bool, err error) ([]byte, bool) {
	if err != nil {
		why := fmt.Sprintf("%s: %v", rawURL, err)
		if errors.Is(err, ErrRateLimited) {
			report.failRateLimited(source, why)
		} else {
			report.Fail(source, why)
		}
		return nil, false
	}
	return body, found
}

// limit is the semaphore of host.
func (e *Enricher) limit(host Host) chan struct{} {
	switch host {
	case HostGBIF:
		return e.gbif
	case HostINat:
		return e.inat
	default:
		return e.wikimedia
	}
}

// tryGetText does the request under host's limit; found is false for a 404.
func (e *Enricher) tryGetText(ctx context.Context, host Host, rawURL string, query url.Values, timeout time.Duration) (body []byte, found bool, err error) {
	// The gate first, so a request waiting for a token holds no slot.
	if host == HostWikimedia {
		if err := e.wikimediaGate.admit(ctx); err != nil {
			return nil, false, err
		}
	}

	// Take a slot, or give up if the caller does first. The slot is held
	// until this function returns, so it covers the whole request.
	sem := e.limit(host)
	select {
	case sem <- struct{}{}:
	case <-ctx.Done():
		return nil, false, ctx.Err()
	}
	defer func() { <-sem }()

	if host == HostINat {
		// Held across the sleep, so a second iNat request waits here until
		// a full gap has passed since the one before.
		e.inatMu.Lock()
		if !e.inatLast.IsZero() {
			wait := e.inatGap - time.Since(e.inatLast)
			if wait > 0 {
				time.Sleep(wait)
			}
		}
		e.inatLast = time.Now()
		e.inatMu.Unlock()
	}

	// LEARN: a `context.Context` carries a deadline and a cancel signal
	// through a chain of calls. `context.WithTimeout` derives a child that
	// is cancelled after timeout (or when its parent is); the HTTP client
	// watches it and aborts the request, body read included. The returned
	// cancel function frees the timer early and must always be called,
	// hence the defer.
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	target := rawURL
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("User-Agent", e.userAgent)
	resp, err := e.client.Do(req)
	if err != nil {
		return nil, false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, false, nil
	}
	if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == http.StatusServiceUnavailable {
		// Wikimedia's "slow down" applies to every Wikimedia request
		// from now on, not only this one.
		if host == HostWikimedia {
			e.wikimediaGate.block(Cooldown(resp.Header.Get("Retry-After"), time.Now()))
		}
		return nil, false, fmt.Errorf("HTTP %s: %w", resp.Status, ErrRateLimited)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, false, fmt.Errorf("HTTP %s", resp.Status)
	}
	body, err = io.ReadAll(resp.Body)
	if err != nil {
		return nil, false, err
	}
	return body, true, nil
}

// About fetches everything about taxon and assembles the document. now is
// unix seconds, stored as FetchedAt.
func (e *Enricher) About(ctx context.Context, taxon Taxon, now int64) About {
	report := &Report{}
	name := taxon.Name

	// Stage A. Everything starts at once; the slowest source sets the time,
	// not the sum of all of them. Each goroutine writes only its own
	// variable, and wg.Wait() makes those writes visible here.
	var item *Item
	var species *SpeciesInfo
	var occurrences *Occurrences
	var extent *Extent
	// LEARN: `wg.Go(f)` runs f in a new goroutine and counts it in the
	// WaitGroup; `wg.Wait()` blocks until every one has returned. (Before
	// Go 1.25 this took wg.Add(1), `go func() { defer wg.Done(); … }()`.)
	var stageA sync.WaitGroup
	stageA.Go(func() { item = e.wikidataLookup(ctx, report, taxon.Ott, name, taxon.GBIF) })
	stageA.Go(func() { species = e.gbifSpecies(ctx, report, taxon.GBIF) })
	stageA.Go(func() { occurrences = e.gbifOccurrences(ctx, report, taxon.GBIF) })
	stageA.Go(func() { extent = e.gbifExtent(ctx, report, taxon.GBIF) })
	stageA.Wait()
	wikidataFailed := report.HasFailed(SourceWikidata)

	// A GBIF key known only from Wikidata (P846) is fetched in stage B.
	var lateGBIF *int64
	if taxon.GBIF == nil && item != nil {
		lateGBIF = item.GBIF
	}
	enwiki := ""
	p18 := ""
	hasStatus := false
	if item != nil {
		if item.Enwiki != nil {
			enwiki = *item.Enwiki
		}
		if item.Image != nil {
			p18 = *item.Image
		}
		hasStatus = item.IUCN != nil
	}
	// iNat only when Wikidata answered and has no image of its own, or
	// could not answer at all.
	inatName := ""
	if item == nil || item.Image == nil {
		inatName = name
	}
	iucnName := ""
	if !hasStatus && taxon.Rank != nil && *taxon.Rank == "species" {
		iucnName = name
	}

	// Stage B.
	var summary *Summary
	var image *Image
	var inatTaxon *INatTaxon
	var gbifStatus string
	var hasGBIFStatus bool
	var lateSpecies *SpeciesInfo
	var lateOcc *Occurrences
	var lateExtent *Extent
	var stageB sync.WaitGroup
	stageB.Go(func() { summary = e.wikipediaSummary(ctx, report, enwiki) })
	stageB.Go(func() { image = e.commonsImage(ctx, report, p18) })
	stageB.Go(func() { inatTaxon = e.inatLookup(ctx, report, inatName) })
	stageB.Go(func() { gbifStatus, hasGBIFStatus = e.gbifIUCNStatus(ctx, report, iucnName) })
	stageB.Go(func() { lateSpecies = e.gbifSpecies(ctx, report, lateGBIF) })
	stageB.Go(func() { lateOcc = e.gbifOccurrences(ctx, report, lateGBIF) })
	stageB.Go(func() { lateExtent = e.gbifExtent(ctx, report, lateGBIF) })
	stageB.Wait()
	if species == nil {
		species = lateSpecies
	}
	if occurrences == nil {
		occurrences = lateOcc
	}
	if extent == nil {
		extent = lateExtent
	}
	gbifKey := taxon.GBIF
	if gbifKey == nil {
		gbifKey = lateGBIF
	}

	// No article of its own: borrow the nearest ancestor's, but only when
	// we know for sure there is none (Wikidata and Wikipedia answered).
	wikipediaFailed := report.HasFailed(SourceWikipedia)
	if summary == nil && !wikidataFailed && !wikipediaFailed {
		summary = e.ancestorSummary(ctx, report, taxon)
	}

	if image == nil && inatTaxon != nil {
		image = inatTaxon.Image
	}

	var status *Status
	if item != nil && item.IUCN != nil {
		status = &Status{Code: *item.IUCN, Source: SourceWikidata}
	} else if hasGBIFStatus {
		status = &Status{Code: gbifStatus, Source: SourceGBIF}
	}

	var taxonomy *Taxonomy
	if species != nil {
		taxonomy = &Taxonomy{
			Authorship:  species.Authorship,
			PublishedIn: species.PublishedIn,
			Source:      SourceGBIF,
		}
	}

	var distribution *Distribution
	if gbifKey != nil && occurrences != nil {
		countries := occurrences.Countries
		if countries == nil {
			countries = []CountryCount{}
		}
		distribution = &Distribution{
			Occurrences:  occurrences.Total,
			Countries:    countries,
			CountryTotal: occurrences.CountryTotal,
			GBIFKey:      *gbifKey,
		}
		if extent != nil && extent.Bbox != nil {
			b := extent.Bbox
			distribution.Bbox = &[4]jsonfloat.F64{
				jsonfloat.F64(b[0]), jsonfloat.F64(b[1]), jsonfloat.F64(b[2]), jsonfloat.F64(b[3]),
			}
		}
	}

	// The summary is the node's own only when it is not borrowed.
	ownSummary := summary != nil && summary.About == nil

	commonNames := []string{}
	if species != nil && species.Vernacular != nil {
		commonNames = pushName(commonNames, *species.Vernacular, name)
	}
	if ownSummary {
		commonNames = pushName(commonNames, summary.Title, name)
	}

	links := Links{Opentree: opentreeURL(taxon.NodeID)}
	if gbifKey != nil {
		links.GBIF = new(fmt.Sprintf("https://www.gbif.org/species/%d", *gbifKey))
	}
	if ownSummary {
		links.Wikipedia = new(summary.URL)
	}
	if item != nil {
		links.Wikidata = new("https://www.wikidata.org/wiki/" + item.QID)
		if item.Ptwiki != nil {
			links.WikipediaPt = new(PtURL(*item.Ptwiki))
		}
		if item.INatID != nil {
			links.INat = new("https://www.inaturalist.org/taxa/" + *item.INatID)
		}
		if item.IUCNID != nil {
			links.IUCN = new("https://www.iucnredlist.org/details/" + *item.IUCNID + "/0")
		}
	}
	if links.INat == nil && inatTaxon != nil {
		links.INat = new(fmt.Sprintf("https://www.inaturalist.org/taxa/%d", inatTaxon.ID))
	}

	generated := GeneratedSentence(taxon, species, occurrences)
	failed := report.Failed()
	return About{
		NodeID:       taxon.NodeID,
		Taxonomy:     taxonomy,
		CommonNames:  commonNames,
		Summary:      summary,
		Image:        image,
		Status:       status,
		Distribution: distribution,
		Generated:    generated,
		Links:        links,
		Failed:       failed,
		Complete:     len(failed) == 0,
		FetchedAt:    now,
		RateLimited:  report.RateLimited(),
	}
}

// opentreeURL is the node's page in the Open Tree browser.
func opentreeURL(nodeID string) string {
	return "https://tree.opentreeoflife.org/opentree/argus/" + Synth + "@" + nodeID
}

// ancestorSummary is the first genus, family or order above taxon with an
// article, labelled with whose it is; nil if none (or a source failed).
func (e *Enricher) ancestorSummary(ctx context.Context, report *Report, taxon Taxon) *Summary {
	for _, ancestor := range taxon.Fallbacks() {
		about := &AboutRef{NodeID: ancestor.NodeID, Name: ancestor.Name, Rank: ancestor.Rank}
		if ancestor.CachedSummary != nil {
			// A copy, so the cached summary itself is not relabelled.
			borrowed := *ancestor.CachedSummary
			borrowed.About = about
			return &borrowed
		}
		item := e.wikidataLookup(ctx, report, ancestor.Ott, ancestor.Name, nil)
		if report.HasFailed(SourceWikidata) {
			return nil
		}
		title := ""
		if item != nil && item.Enwiki != nil {
			title = *item.Enwiki
		}
		if found := e.wikipediaSummary(ctx, report, title); found != nil {
			found.About = about
			return found
		}
		if report.HasFailed(SourceWikipedia) {
			return nil
		}
	}
	return nil
}

// Minimal is the document for an unnamed (mrca) node: never enriched (PLAN
// §6.1), so it costs no upstream request and is not cached. within is the
// nearest named ancestor's name, "" for none.
func Minimal(nodeID, within string, leafCount uint32, now int64) About {
	generated := "An unnamed clade"
	if within != "" {
		generated += " within " + within
	}
	generated += fmt.Sprintf(", with %s species in the Open Tree synthesis.", Thousands(uint64(leafCount)))
	return About{
		NodeID:      nodeID,
		CommonNames: []string{},
		Generated:   generated,
		Links:       Links{Opentree: opentreeURL(nodeID)},
		Failed:      []string{},
		Complete:    true,
		FetchedAt:   now,
	}
}

// pushName appends candidate (trimmed) unless it is empty, the scientific
// name (ignoring ASCII case) or already listed (ignoring case).
func pushName(names []string, candidate, scientific string) []string {
	candidate = strings.TrimSpace(candidate)
	if candidate == "" || equalIgnoreASCIICase(candidate, scientific) {
		return names
	}
	for _, name := range names {
		if strings.ToLower(name) == strings.ToLower(candidate) {
			return names
		}
	}
	return append(names, candidate)
}

// equalIgnoreASCIICase reports whether a and b are equal when only A-Z
// and a-z compare equal across case (strings.EqualFold also folds non-ASCII).
func equalIgnoreASCIICase(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		if asciiLower(a[i]) != asciiLower(b[i]) {
			return false
		}
	}
	return true
}

func asciiLower(c byte) byte {
	if c >= 'A' && c <= 'Z' {
		return c + ('a' - 'A')
	}
	return c
}

// contextRanks are named in the generated sentence's "in the family X",
// narrowest first.
var contextRanks = [5]string{"family", "order", "class", "phylum", "kingdom"}

// speciesAndBelow are ranks where "with N species in the Open Tree
// synthesis" would be odd.
var speciesAndBelow = [5]string{"species", "subspecies", "variety", "form", "forma"}

// GeneratedSentence builds "Pselaphus heisei Herbst, 1791 is a species in
// the family Staphylinidae. GBIF has 1,881 occurrence records of it from 24
// countries." from structured data only, so every taxon has one (PLAN
// §6.3). species and occ may be nil.
func GeneratedSentence(taxon Taxon, species *SpeciesInfo, occ *Occurrences) string {
	text := taxon.Name
	if species != nil && species.Authorship != nil {
		text += " " + *species.Authorship
	}

	// The synth tree often lacks the rank or the family (Hominidae and
	// Staphylinidae are "broken" there), so GBIF's own fill those gaps.
	rank := "taxon"
	if taxon.Rank != nil && *taxon.Rank != "" && !strings.HasPrefix(*taxon.Rank, "no rank") {
		rank = *taxon.Rank
	} else if species != nil && species.Rank != nil && *species.Rank != "unranked" {
		rank = *species.Rank
	}
	text += " is " + article(rank) + " " + rank

	// The nearest ancestor of a broader major rank than the node's own;
	// own is -1 when the node's rank is none of contextRanks.
	own := slices.Index(contextRanks[:], rank)
	within := ""
	// GBIF's family, when the node sits below family level.
	if species != nil && species.Family != nil && own == -1 && *species.Family != taxon.Name {
		within = " in the family " + *species.Family
	}
	if within == "" {
		for _, ancestor := range taxon.Ancestors {
			ancestorRank := ""
			if ancestor.Rank != nil {
				ancestorRank = *ancestor.Rank
			}
			index := slices.Index(contextRanks[:], ancestorRank)
			if index != -1 && (own == -1 || index > own) {
				within = " in the " + ancestorRank + " " + ancestor.Name
				break
			}
		}
	}
	if within == "" && len(taxon.Ancestors) > 0 {
		within = " in " + taxon.Ancestors[0].Name
	}
	text += within
	if taxon.LeafCount > 1 && !slices.Contains(speciesAndBelow[:], rank) {
		text += fmt.Sprintf(", with %s species in the Open Tree synthesis", Thousands(uint64(taxon.LeafCount)))
	}
	text += "."

	if occ != nil {
		if occ.Total == 0 {
			text += " GBIF has no occurrence records of it."
		} else {
			records := "records"
			if occ.Total == 1 {
				records = "record"
			}
			text += fmt.Sprintf(" GBIF has %s occurrence %s of it", Thousands(occ.Total), records)
			switch occ.CountryTotal {
			case 0:
			case 1:
				text += " from 1 country"
			default:
				text += fmt.Sprintf(" from %d countries", occ.CountryTotal)
			}
			text += "."
		}
	}
	return text
}

// article is "a" or "an" for word.
func article(word string) string {
	if word == "" {
		return "a"
	}
	switch word[0] {
	case 'a', 'e', 'i', 'o', 'u':
		return "an"
	}
	return "a"
}

// Thousands formats 1234567 as "1,234,567".
func Thousands(n uint64) string {
	digits := fmt.Sprint(n)
	var out strings.Builder
	for i := 0; i < len(digits); i++ {
		if i > 0 && (len(digits)-i)%3 == 0 {
			out.WriteByte(',')
		}
		out.WriteByte(digits[i])
	}
	return out.String()
}

// KnownIUCNCode returns code if it is one we show (LC, NT, VU, EN, CR, EW,
// EX, DD); false for anything else (NE, LR/cd, …).
func KnownIUCNCode(code string) (string, bool) {
	switch code {
	case "LC", "NT", "VU", "EN", "CR", "EW", "EX", "DD":
		return code, true
	}
	return "", false
}
