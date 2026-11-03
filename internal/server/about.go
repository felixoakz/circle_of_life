// GET /api/nodes/{ref}/about[?retry=1] (PLAN §6): the enrichment document
// for one node.
//
//   - Unnamed (mrca) nodes get a minimal document at once: never enriched,
//     never cached.
//   - A cached document is served as is. Past its time to live it is still
//     served, and refreshed in the background (stale-while-revalidate),
//     except while Wikimedia has asked us to wait.
//   - On a miss the enricher fetches everything (a few seconds at most), and
//     the document is stored before it is returned. One fetch per node runs
//     at a time, detached from the request (flight.go).
//   - ?retry=1 refetches a cached partial document; a complete one is served
//     from cache anyway, so the parameter cannot hammer the upstreams.
//
// Without a cache and enricher (a State from NewState alone) enrichment is
// off: named nodes get a 503, unnamed ones still their minimal document.
//
// Concepts introduced here:
// - (none beyond the package's; the detached fetch is in flight.go)

package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strings"

	"species/internal/db"
	"species/internal/enrich"
	"species/internal/names"
)

func (s *State) about(w http.ResponseWriter, r *http.Request) error {
	retry := false
	if query := r.URL.Query(); query.Has("retry") {
		text := query.Get("retry")
		n, err := parseUint(text, 8)
		if err != nil {
			return badRequest(fmt.Sprintf("retry %q is not a number from 0 to 255", text))
		}
		retry = n != 0
	}
	detail, err := s.nodeDetail(r)
	if err != nil {
		return err
	}
	now := db.Now()

	if detail.Name == nil {
		within := ""
		if a := detail.NamedAncestor; a != nil && a.Name != nil {
			within = *a.Name
		}
		return writeAbout(w, enrich.Minimal(detail.NodeID, within, detail.LeafCount, now))
	}
	name := *detail.Name
	if s.Cache == nil || s.Enricher == nil {
		return &httpError{status: http.StatusServiceUnavailable, msg: "enrichment is off"}
	}

	ctx := r.Context()
	row, found, err := db.GetCached(ctx, s.Cache, detail.NodeID)
	if err != nil {
		return err
	}
	if found && !(retry && !row.Complete) {
		var doc enrich.About
		// A row that no longer parses (an older document shape) is a miss.
		if json.Unmarshal([]byte(row.Body), &doc) == nil {
			// During a Wikimedia cooldown a refresh would only fail again.
			if row.Freshness(now, doc.RateLimited) == db.Stale && s.Enricher.WikimediaCooldown() == 0 {
				s.refreshInBackground(ctx, detail, name)
			}
			slog.Info("about: from cache", "node", detail.NodeID, "complete", row.Complete)
			return writeAbout(w, doc)
		}
	}

	taxon, err := s.taxonFor(ctx, detail, name)
	if err != nil {
		return err
	}
	doc, err := s.fetches.do(ctx, detail.NodeID, func(fetchCtx context.Context) (enrich.About, error) {
		return s.fetchAndStore(fetchCtx, taxon)
	})
	if err != nil {
		return err
	}
	slog.Info("about: fetched", "node", detail.NodeID, "complete", doc.Complete, "failed", doc.Failed)
	return writeAbout(w, doc)
}

// writeAbout sends doc. A complete document may be cached by the browser
// for a day; a partial one not at all, so "Retry" really asks again.
func writeAbout(w http.ResponseWriter, doc enrich.About) error {
	if doc.Complete {
		w.Header().Set("Cache-Control", "public, max-age=86400")
	} else {
		w.Header().Set("Cache-Control", "no-store")
	}
	return writeJSON(w, http.StatusOK, doc)
}

// fetchAndStore fetches the document and stores it in cache.db. ctx is a
// flight's detached context (flight.go), not a request's.
func (s *State) fetchAndStore(ctx context.Context, taxon enrich.Taxon) (enrich.About, error) {
	doc := s.Enricher.About(ctx, taxon, db.Now())
	// Past FetchTimeout every unfinished source "fails". That partial
	// document says nothing about the sources, so it is not stored.
	if err := ctx.Err(); err != nil {
		return enrich.About{}, err
	}
	body, err := encodeJSON(doc)
	if err != nil {
		// A failed store must not cost the reader their answer.
		slog.Error("about: not stored", "node", doc.NodeID, "error", err)
		return doc, nil
	}
	row := db.Cached{Body: string(body), Complete: doc.Complete, FetchedAt: doc.FetchedAt}
	if err := db.PutCached(ctx, s.Cache, doc.NodeID, row); err != nil {
		return enrich.About{}, err
	}
	return doc, nil
}

// refreshInBackground starts a refresh that outlives this request, unless
// a fetch already runs for this node (then that one is the refresh).
func (s *State) refreshInBackground(ctx context.Context, detail db.NodeDetail, name string) {
	nodeID := detail.NodeID
	// The request's context is cancelled as soon as its response is sent.
	// The flight's context keeps its values but not that cancellation
	// (context.WithoutCancel), so the refresh is not cut short when this
	// request finishes. Nothing waits for it: the request answers with the
	// stale document at once, and the log is the refresh's only trace.
	s.fetches.start(ctx, nodeID, func(bg context.Context) (enrich.About, error) {
		taxon, err := s.taxonFor(bg, detail, name)
		if err != nil {
			slog.Warn("about: background refresh failed", "node", nodeID, "error", err)
			return enrich.About{}, err
		}
		doc, err := s.fetchAndStore(bg, taxon)
		if err != nil {
			slog.Warn("about: background refresh failed", "node", nodeID, "error", err)
		}
		return doc, err
	})
}

// taxonFor is what the enricher needs about a named node: its ids, and its
// named ancestors nearest first, with any Wikipedia summary cache.db
// already holds for those an article may be borrowed from.
func (s *State) taxonFor(ctx context.Context, detail db.NodeDetail, name string) (enrich.Taxon, error) {
	var ancestors []enrich.Ancestor
	for i := len(detail.Lineage) - 1; i >= 0; i-- {
		entry := detail.Lineage[i]
		if entry.Name == nil || names.IsPlaceholder(*entry.Name) {
			continue
		}
		ancestor := enrich.Ancestor{
			NodeID: entry.NodeID,
			Ott:    ottOf(entry.NodeID),
			Name:   *entry.Name,
			Rank:   entry.Rank,
		}
		// Only the ranks Taxon.Fallbacks may use are worth a cache read.
		rank := ""
		if entry.Rank != nil {
			rank = *entry.Rank
		}
		if slices.Contains(enrich.FallbackRanks[:], rank) {
			row, found, err := db.GetCached(ctx, s.Cache, entry.NodeID)
			if err != nil {
				return enrich.Taxon{}, err
			}
			if found {
				ancestor.CachedSummary = ownSummary(row.Body)
			}
		}
		ancestors = append(ancestors, ancestor)
	}
	return enrich.Taxon{
		NodeID:    detail.NodeID,
		Ott:       detail.IDs.Ott,
		Name:      name,
		Rank:      detail.Rank,
		GBIF:      detail.GBIFID,
		LeafCount: detail.LeafCount,
		Ancestors: ancestors,
	}, nil
}

// ownSummary is a cached document's own article (not one it borrowed), or
// nil.
func ownSummary(body string) *enrich.Summary {
	var doc enrich.About
	if json.Unmarshal([]byte(body), &doc) != nil {
		return nil
	}
	if doc.Summary == nil || doc.Summary.About != nil {
		return nil
	}
	return doc.Summary
}

// ottOf is 770315 for "ott770315", nil for anything else.
func ottOf(nodeID string) *uint32 {
	digits, ok := strings.CutPrefix(nodeID, "ott")
	if !ok {
		return nil
	}
	n, err := parseUint(digits, 32)
	if err != nil {
		return nil
	}
	return new(uint32(n))
}
