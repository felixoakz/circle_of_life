// Unit tests of the Wikimedia gate's parts: the token bucket at chosen
// instants, and reading Retry-After.
//
// Concepts introduced here:
// - (none beyond the package's)

package enrich

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestBucketAllowsABurstThenPacesRequests(t *testing.T) {
	b := bucket{rate: 4, burst: 2}
	start := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)

	// It starts full: the burst goes at once.
	for i := range 2 {
		if wait := b.reserve(start); wait != 0 {
			t.Fatalf("request %d of the burst waits %s", i, wait)
		}
	}
	// Then each request waits a quarter of a second more than the last.
	if wait := b.reserve(start); wait != 250*time.Millisecond {
		t.Errorf("third request waits %s, want 250ms", wait)
	}
	if wait := b.reserve(start); wait != 500*time.Millisecond {
		t.Errorf("fourth request waits %s, want 500ms", wait)
	}
	// A token given back shortens the queue again.
	b.unreserve()
	if wait := b.reserve(start); wait != 500*time.Millisecond {
		t.Errorf("after unreserve: waits %s, want 500ms", wait)
	}

	// After a quiet second it is full again, never fuller than burst.
	later := start.Add(10 * time.Second)
	for i := range 2 {
		if wait := b.reserve(later); wait != 0 {
			t.Errorf("after a pause: request %d waits %s", i, wait)
		}
	}
	if wait := b.reserve(later); wait == 0 {
		t.Error("the bucket held more than its burst")
	}
}

func TestBucketWithRateZeroIsOff(t *testing.T) {
	var b bucket
	now := time.Now()
	for range 100 {
		if wait := b.reserve(now); wait != 0 {
			t.Fatalf("an off bucket made a request wait %s", wait)
		}
	}
}

func TestCooldownReadsRetryAfter(t *testing.T) {
	now := time.Date(2026, 11, 3, 11, 0, 0, 0, time.UTC)
	cases := []struct {
		header string
		want   time.Duration
	}{
		{"120", 2 * time.Minute},
		{" 5 ", 5 * time.Second},
		{"Tue, 03 Nov 2026 11:01:30 GMT", 90 * time.Second},
		// Missing, unreadable, zero or past: the default.
		{"", DefaultCooldown},
		{"soon", DefaultCooldown},
		{"0", DefaultCooldown},
		{"-3", DefaultCooldown},
		{"Tue, 03 Nov 2026 10:00:00 GMT", DefaultCooldown},
		// Never longer than the cap.
		{"86400", MaxCooldown},
	}
	for _, c := range cases {
		if got := Cooldown(c.header, now); got != c.want {
			t.Errorf("Cooldown(%q) = %s, want %s", c.header, got, c.want)
		}
	}
}

func TestGateRefusesAWaitLongerThanMaxThrottleWait(t *testing.T) {
	g := newGate(1, 1)
	// Cancelled, so the requests that would wait return at once instead.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := g.admit(ctx); err != nil {
		t.Fatalf("first request: %v", err)
	}
	// Waits of 1, 2 and 3 s are allowed (and cut short by ctx here).
	for i := range 3 {
		if err := g.admit(ctx); !errors.Is(err, context.Canceled) {
			t.Fatalf("request %d: %v, want it to wait", i+2, err)
		}
	}
	// 4 s is too long: refused without a wait, as a rate limit.
	if err := g.admit(ctx); !errors.Is(err, ErrRateLimited) {
		t.Errorf("fifth request: %v, want ErrRateLimited", err)
	}
}

func TestShutGateFailsAtOnce(t *testing.T) {
	g := newGate(0, 0)
	g.block(time.Minute)
	// A shorter block never shortens a longer one.
	g.block(time.Second)
	if left := g.left(); left < 59*time.Second {
		t.Errorf("left = %s, want about a minute", left)
	}
	if err := g.admit(context.Background()); !errors.Is(err, ErrRateLimited) {
		t.Errorf("admit = %v, want ErrRateLimited", err)
	}
}
