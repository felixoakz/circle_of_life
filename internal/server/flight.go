// One upstream fetch per node at a time (ARCHITECTURE §6.1). Two people opening
// the same uncached species, a background refresh and a click, or a click
// and its own retry all share one fetch: the first starts it, the rest
// wait for its document.
//
// The fetch runs in its own goroutine, detached from the request that
// started it (context.WithoutCancel plus FetchTimeout), so a reader who
// clicks on before it ends does not throw away the requests already made:
// the document is still stored, and the next visit is a cache hit.
//
// Concepts introduced here:
// - a detached goroutine that outlives the request
// - `context.WithoutCancel` for that goroutine's work
// - closing a channel to wake every goroutine waiting on it
// - a map of in-flight work keyed by id, guarded by a mutex

package server

import (
	"context"
	"sync"
	"time"

	"species/internal/enrich"
)

// FetchTimeout bounds one whole fetch: both stages, the ancestor fallback
// and any wait at the Wikimedia gate.
const FetchTimeout = 30 * time.Second

// flights holds the fetches running now, by node id.
type flights struct {
	mu      sync.Mutex
	running map[string]*flight
	timeout time.Duration
}

// flight is one running fetch. doc and err are written once, before done
// is closed, and only read after.
type flight struct {
	done chan struct{}
	doc  enrich.About
	err  error
}

func newFlights(timeout time.Duration) *flights {
	return &flights{running: make(map[string]*flight), timeout: timeout}
}

// start runs fetch for key in a new goroutine, unless one already runs
// for key; either way it returns that running flight. fetch gets a context
// that keeps ctx's values but not its cancellation, with f.timeout.
func (f *flights) start(ctx context.Context, key string, fetch func(context.Context) (enrich.About, error)) *flight {
	f.mu.Lock()
	defer f.mu.Unlock()
	if running, ok := f.running[key]; ok {
		return running
	}
	fl := &flight{done: make(chan struct{})}
	f.running[key] = fl
	// The request's context is cancelled as soon as its response is sent
	// or its reader goes away. WithoutCancel keeps its values but never
	// ends; the timeout puts the end back, on our terms.
	detached, cancel := context.WithTimeout(context.WithoutCancel(ctx), f.timeout)
	// LEARN: `go f()` runs f in a new goroutine and returns at once, so the
	// caller can answer (or wait on done) while the fetch goes on. The
	// closure captures f, fl, key, fetch, detached and cancel, which stay
	// alive as long as the goroutine needs them.
	go func() {
		defer cancel()
		fl.doc, fl.err = fetch(detached)
		// Out of the map before done closes: a request arriving after
		// this point starts afresh (and will usually find the cache).
		f.mu.Lock()
		delete(f.running, key)
		f.mu.Unlock()
		// LEARN: closing a channel wakes every goroutine receiving from
		// it, now and later: a receive from a closed channel returns at
		// once. That makes close a broadcast, where a send would wake
		// only one waiter. Close it exactly once, by its owner.
		close(fl.done)
	}()
	return fl
}

// do is start, then a wait for the flight's document; a ctx that ends
// first gives ctx's error, and the flight goes on without this caller.
func (f *flights) do(ctx context.Context, key string, fetch func(context.Context) (enrich.About, error)) (enrich.About, error) {
	fl := f.start(ctx, key, fetch)
	select {
	case <-fl.done:
		return fl.doc, fl.err
	case <-ctx.Done():
		return enrich.About{}, ctx.Err()
	}
}
