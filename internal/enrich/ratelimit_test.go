// The Wikimedia gate against enrichtest's mock: a 429 or 503 shuts it for
// the Retry-After asked for, Wikimedia requests then fail without being
// sent, other hosts go on, and the document says it was rate limited.
//
// Concepts introduced here:
// - (none beyond the package's)

package enrich_test

import (
	"context"
	"net/http"
	"slices"
	"testing"
	"time"

	"species/internal/config"
	"species/internal/enrich"
	"species/internal/enrich/enrichtest"
)

// within reports whether got is at most a second short of want (the
// cooldown starts counting down as soon as it is set).
func within(got, want time.Duration) bool {
	return got <= want && got > want-time.Second
}

func TestA429ShutsTheWikimediaGateForItsRetryAfter(t *testing.T) {
	mock := &enrichtest.Mock{FailPrefix: "/wikidata", FailStatus: http.StatusTooManyRequests, RetryAfter: "120"}
	e := newEnricher(enrichtest.Start(t, mock), 4*time.Second)

	if left := e.WikimediaCooldown(); left != 0 {
		t.Fatalf("cooldown before any request: %s", left)
	}
	doc := e.About(context.Background(), jaguar(), 0)
	if !within(e.WikimediaCooldown(), 120*time.Second) {
		t.Errorf("cooldown = %s, want about 120s", e.WikimediaCooldown())
	}
	if !doc.RateLimited || doc.Complete {
		t.Errorf("rateLimited = %v, complete = %v; want true, false", doc.RateLimited, doc.Complete)
	}
	if !slices.Contains(doc.Failed, enrich.SourceWikidata) {
		t.Errorf("failed = %v, want Wikidata in it", doc.Failed)
	}
	// One search, then the gate shut: nothing else went to Wikidata.
	if n := mock.HitsUnder("/wikidata"); n != 1 {
		t.Errorf("%d Wikidata requests, want 1", n)
	}
	// GBIF has its own limits and still answered.
	if doc.Distribution == nil {
		t.Error("no distribution: GBIF was cut off too")
	}
}

func TestA503WithoutRetryAfterShutsTheGateForTheDefault(t *testing.T) {
	mock := &enrichtest.Mock{FailPrefix: "/wikidata", FailStatus: http.StatusServiceUnavailable}
	e := newEnricher(enrichtest.Start(t, mock), 4*time.Second)

	e.About(context.Background(), jaguar(), 0)
	if !within(e.WikimediaCooldown(), enrich.DefaultCooldown) {
		t.Errorf("cooldown = %s, want about %s", e.WikimediaCooldown(), enrich.DefaultCooldown)
	}
}

func TestDuringTheCooldownWikimediaRequestsAreNotSent(t *testing.T) {
	mock := &enrichtest.Mock{FailPrefix: "/wikidata", FailStatus: http.StatusTooManyRequests}
	e := newEnricher(enrichtest.Start(t, mock), 4*time.Second)
	e.About(context.Background(), jaguar(), 0)

	wikimedia := mock.HitsUnder("/wikidata") + mock.HitsUnder("/wikipedia") + mock.HitsUnder("/commons")
	gbif := mock.HitsUnder("/gbif")
	doc := e.About(context.Background(), beetle(), 0)
	after := mock.HitsUnder("/wikidata") + mock.HitsUnder("/wikipedia") + mock.HitsUnder("/commons")
	if after != wikimedia {
		t.Errorf("%d Wikimedia requests went out during the cooldown", after-wikimedia)
	}
	if mock.HitsUnder("/gbif") == gbif {
		t.Error("no GBIF requests: the cooldown must only stop Wikimedia")
	}
	if !doc.RateLimited || !slices.Contains(doc.Failed, enrich.SourceWikidata) {
		t.Errorf("rateLimited = %v, failed = %v", doc.RateLimited, doc.Failed)
	}
}

func TestOtherFailuresAreNotRateLimits(t *testing.T) {
	mock := &enrichtest.Mock{FailPrefix: "/wikidata", FailStatus: http.StatusInternalServerError}
	e := newEnricher(enrichtest.Start(t, mock), 4*time.Second)
	doc := e.About(context.Background(), jaguar(), 0)
	if doc.RateLimited {
		t.Error("a 500 marked the document rate limited")
	}
	if left := e.WikimediaCooldown(); left != 0 {
		t.Errorf("a 500 shut the gate for %s", left)
	}
}

func TestTheTokenBucketPacesWikimediaRequests(t *testing.T) {
	mock := &enrichtest.Mock{}
	base := enrichtest.Start(t, mock)
	// Two at once, then 20 a second: the n Wikimedia requests of the
	// jaguar's document (search, entities, summary, image) take at least
	// (n-2)/20 s.
	e := enrich.New(enrich.Settings{
		Endpoints:      config.EndpointsUnder(base),
		UserAgent:      "test",
		Timeout:        4 * time.Second,
		SlowTimeout:    4 * time.Second,
		INatGap:        time.Millisecond,
		WikimediaRate:  20,
		WikimediaBurst: 2,
	})
	start := time.Now()
	doc := e.About(context.Background(), jaguar(), 0)
	took := time.Since(start)
	if !doc.Complete {
		t.Fatalf("failed = %v", doc.Failed)
	}
	n := mock.HitsUnder("/wikidata") + mock.HitsUnder("/wikipedia") + mock.HitsUnder("/commons")
	if n <= 2 {
		t.Fatalf("only %d Wikimedia requests: the test needs more than the burst", n)
	}
	if least := time.Duration(n-2) * time.Second / 20; took < least {
		t.Errorf("%d Wikimedia requests took %s, want at least %s", n, took, least)
	}
}
