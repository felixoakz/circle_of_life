// The Wikimedia gate (ARCHITECTURE §6.2): every Wikidata, Wikipedia and Commons
// request passes it first. Two rules, both shared by the whole server:
//
//   - A token bucket keeps us at WikimediaRate requests a second on
//     average, with bursts of up to WikimediaBurst. A request that would
//     wait longer than MaxThrottleWait for its token is not sent at all.
//   - After a 429 or 503 the gate shuts for the Retry-After the answer
//     asked for (DefaultCooldown if none, at most MaxCooldown). Until then
//     every Wikimedia request fails at once, without being sent: one
//     "slow down" stops the whole server, not just the request that got it.
//
// Both failures wrap ErrRateLimited, so the document can say it was rate
// limited and be cached for a short time only.
//
// Concepts introduced here:
// - a token bucket computed from timestamps (no ticker goroutine)
// - `time.NewTimer` with `select` for a wait that a context can cut short
// - parsing an HTTP header that is either a number or a date

package enrich

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// WikimediaRate is the long-run limit on Wikimedia requests, per second,
// for the whole server.
const WikimediaRate = 4

// WikimediaBurst is how many Wikimedia requests may go at once after a
// quiet spell (one /about makes about 3 to 16).
const WikimediaBurst = 8

// MaxThrottleWait is the longest a request waits for a token; past it the
// request fails as rate limited instead.
const MaxThrottleWait = 3 * time.Second

// DefaultCooldown is how long the gate stays shut after a 429 or 503
// without a usable Retry-After.
const DefaultCooldown = 60 * time.Second

// MaxCooldown caps a Retry-After.
const MaxCooldown = 10 * time.Minute

// ErrRateLimited is wrapped by every failure that means "too many
// requests": a 429 or 503, the gate shut after one, or our own throttle.
var ErrRateLimited = errors.New("rate limited")

// bucket is a token bucket. Tokens refill continuously at rate a second up
// to burst; each request takes one. Tokens may go below zero: that is a
// queue of requests that have been promised a later slot.
type bucket struct {
	// rate is tokens per second; 0 turns the bucket off.
	rate   float64
	burst  float64
	tokens float64
	// last is when tokens was last brought up to date (zero: never, so the
	// bucket starts full).
	last time.Time
}

// reserve takes a token at now and says how long to wait before using it
// (0: at once).
func (b *bucket) reserve(now time.Time) time.Duration {
	if b.rate <= 0 {
		return 0
	}
	if b.last.IsZero() {
		b.tokens = b.burst
	} else if elapsed := now.Sub(b.last); elapsed > 0 {
		b.tokens = min(b.burst, b.tokens+elapsed.Seconds()*b.rate)
	}
	b.last = now
	b.tokens--
	if b.tokens >= 0 {
		return 0
	}
	return time.Duration(-b.tokens / b.rate * float64(time.Second))
}

// unreserve gives back a token reserve took but that was not used.
func (b *bucket) unreserve() {
	if b.rate > 0 {
		b.tokens++
	}
}

// gate is the Wikimedia gate: the bucket and the cooldown, under one
// mutex because every request reads and writes both.
type gate struct {
	mu           sync.Mutex
	bucket       bucket
	blockedUntil time.Time
}

func newGate(rate float64, burst int) *gate {
	return &gate{bucket: bucket{rate: rate, burst: float64(burst)}}
}

// admit lets a request through: at once, after a short wait for a token,
// or not at all (an error wrapping ErrRateLimited, or ctx's error).
func (g *gate) admit(ctx context.Context) error {
	g.mu.Lock()
	now := time.Now()
	if left := g.blockedUntil.Sub(now); left > 0 {
		g.mu.Unlock()
		return fmt.Errorf("Wikimedia asked us to wait, %s left: %w", left.Round(time.Second), ErrRateLimited)
	}
	wait := g.bucket.reserve(now)
	if wait > MaxThrottleWait {
		g.bucket.unreserve()
		g.mu.Unlock()
		return fmt.Errorf("over %d requests a second to Wikimedia: %w", int(g.bucket.rate), ErrRateLimited)
	}
	g.mu.Unlock()
	if wait <= 0 {
		return nil
	}
	// The mutex is not held while waiting: other requests take their own
	// later tokens meanwhile.
	// LEARN: time.NewTimer delivers one value on timer.C after the
	// duration. Unlike time.Sleep it can be raced against other channels
	// in a `select`, so a cancelled context ends the wait early; Stop
	// releases the timer when the context wins.
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// block shuts the gate for d from now, unless it is already shut for
// longer.
func (g *gate) block(d time.Duration) {
	g.mu.Lock()
	defer g.mu.Unlock()
	until := time.Now().Add(d)
	if until.After(g.blockedUntil) {
		g.blockedUntil = until
	}
}

// left is how long the gate stays shut (0: open).
func (g *gate) left() time.Duration {
	g.mu.Lock()
	defer g.mu.Unlock()
	return max(0, time.Until(g.blockedUntil))
}

// Cooldown is how long to stay away after an answer with this
// Retry-After header value at now: its delay in seconds or its date,
// DefaultCooldown when it is missing, unreadable or not in the future,
// and never more than MaxCooldown.
func Cooldown(retryAfter string, now time.Time) time.Duration {
	retryAfter = strings.TrimSpace(retryAfter)
	d := DefaultCooldown
	// LEARN: Retry-After is either a number of seconds ("120") or an HTTP
	// date ("Tue, 03 Nov 2026 11:00:00 GMT"). Try the number first;
	// http.ParseTime reads the three date formats HTTP allows.
	if seconds, err := strconv.Atoi(retryAfter); err == nil {
		if seconds > 0 {
			d = time.Duration(seconds) * time.Second
		}
	} else if date, err := http.ParseTime(retryAfter); err == nil {
		if until := date.Sub(now); until > 0 {
			d = until
		}
	}
	return min(d, MaxCooldown)
}

// WikimediaCooldown is how long Wikimedia requests keep failing at once
// after a 429 or 503 (0: they go out as usual).
func (e *Enricher) WikimediaCooldown() time.Duration {
	return e.wikimediaGate.left()
}
