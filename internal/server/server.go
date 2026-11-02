// Package server is the HTTP server behind `species serve`: it opens
// tree.db, builds the routes, listens on the port and runs until Ctrl+C or
// SIGTERM.
//
// Routes: /healthz; the read API under /api (meta.go, tiles.go, search.go,
// nodes.go, about.go) with a JSON 404 for unknown /api/… paths; hashed
// frontend assets under /assets (cached forever); everything else is
// web/dist with an index.html fallback (never cached), so deep links like
// /?n=ott770315 load the app (static.go). Every response passes through
// gzip (gzip.go) and the request log (logging.go).
//
// Concepts introduced here:
// - `http.ServeMux` patterns with methods and wildcards ("GET /api/nodes/{ref}")
// - `r.PathValue`
// - middleware as `func(http.Handler) http.Handler`
// - graceful shutdown with `signal.NotifyContext` and `srv.Shutdown`
package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"species/internal/config"
	"species/internal/db"
	"species/internal/enrich"
)

// Meta is the /api/meta document and the one field the server needs.
type Meta struct {
	// JSON is the document, sent verbatim.
	JSON []byte
	// DataVersion: tiles requested with any other version get a 404.
	DataVersion string
}

// State is shared by every request. Everything in it is safe for
// concurrent use.
type State struct {
	// Tree is the read-only tree.db pool.
	Tree *sql.DB
	Meta Meta
	// Cache is cache.db, the enrichment cache (one connection). nil means
	// enrichment is off (see NewState).
	Cache *sql.DB
	// Enricher holds the HTTP client and per-host limits for enrichment;
	// nil when enrichment is off.
	Enricher *enrich.Enricher
}

// Open opens tree.db and reads its meta; it fails, naming the path, if the
// file is missing or not a tree database.
func Open(path string) (*State, error) {
	tree, err := db.OpenTree(path)
	if err != nil {
		return nil, err
	}
	state, err := NewState(tree)
	if err != nil {
		tree.Close()
		return nil, fmt.Errorf("reading meta from %s: %w", path, err)
	}
	return state, nil
}

// NewState wraps an open tree.db pool and reads its meta. Enrichment starts
// off (nil Cache and Enricher: /about answers named nodes with a 503);
// WithEnrichment turns it on.
//
// There is no default cache: with database/sql, ":memory:" gives every
// pooled connection its own empty database, and a temporary file would
// have no owner to delete it. A State that only reads the tree should not
// reach the internet either.
func NewState(tree *sql.DB) (*State, error) {
	text, err := db.ReadMeta(context.Background(), tree)
	if err != nil {
		return nil, err
	}
	var fields struct {
		DataVersion *string `json:"dataVersion"`
	}
	if err := json.Unmarshal(text, &fields); err != nil {
		return nil, fmt.Errorf("meta is not JSON: %w", err)
	}
	if fields.DataVersion == nil {
		return nil, errors.New("meta has no dataVersion")
	}
	return &State{
		Tree: tree,
		Meta: Meta{JSON: text, DataVersion: *fields.DataVersion},
	}, nil
}

// WithEnrichment is a copy of s with this cache database and enricher.
func (s *State) WithEnrichment(cache *sql.DB, e *enrich.Enricher) *State {
	copied := *s
	copied.Cache = cache
	copied.Enricher = e
	return &copied
}

// Router builds every route. Kept apart from Run so tests can send
// requests with httptest without opening a socket.
func Router(s *State, staticDir string) http.Handler {
	mux := http.NewServeMux()
	// LEARN: since Go 1.22 a ServeMux pattern may start with a method and
	// contain wildcards: "GET /api/nodes/{ref}" matches GET (and HEAD)
	// requests for /api/nodes/ followed by exactly one path segment, which
	// the handler reads with r.PathValue("ref"). A pattern ending in "/"
	// matches everything below it. When several patterns match, the most
	// specific wins, so "GET /api/" catches only what the API routes do
	// not, and "GET /" only what nothing else does.
	mux.HandleFunc("GET /healthz", healthz)
	mux.HandleFunc("GET /api/meta", s.meta)
	mux.Handle("GET /api/v/{ver}/tiles/{level}/{sector}", handle(s.tile))
	mux.Handle("GET /api/search", handle(s.search))
	mux.Handle("GET /api/nodes/{ref}", handle(s.node))
	mux.Handle("GET /api/nodes/{ref}/about", handle(s.about))
	// A typo in an API path must be a clear JSON 404, never index.html.
	// "/api" itself needs its own pattern: with only "/api/", ServeMux
	// would answer it with a redirect to "/api/".
	mux.Handle("GET /api", handle(apiNotFound))
	mux.Handle("GET /api/", handle(apiNotFound))
	mux.Handle("GET /assets/", assets(staticDir))
	mux.Handle("GET /", appShell(staticDir))

	// LEARN: middleware is a function from handler to handler,
	// `func(http.Handler) http.Handler`: it gets the rest of the app and
	// returns a handler that does something before and/or after calling
	// it. Middlewares nest like function calls; the outermost runs first.
	// Here every response is zipped (compress), and the log sees the final
	// status (logRequests).
	return logRequests(compress(mux))
}

func healthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain")
	w.Write([]byte("ok"))
}

// apiNotFound names the path as the client sent it (still escaped).
func apiNotFound(w http.ResponseWriter, r *http.Request) error {
	return notFound(r.URL.EscapedPath())
}

// Run serves cfg until ctx is cancelled or the process gets Ctrl+C or
// SIGTERM; in-flight requests then finish before it returns.
func Run(ctx context.Context, cfg config.Serve) error {
	// A missing or broken tree.db stops the server right here, with the
	// path in the message (PLAN §11).
	treePath := cfg.TreeDBPath()
	state, err := Open(treePath)
	if err != nil {
		return err
	}
	defer state.Tree.Close()
	slog.Info("opened tree database", "path", treePath, "dataVersion", state.Meta.DataVersion)

	cachePath := cfg.CacheDBPath()
	cache, err := db.OpenCache(cachePath)
	if err != nil {
		return err
	}
	defer cache.Close()
	userAgent := cfg.UserAgent()
	if strings.TrimSpace(cfg.Contact) == "" {
		// Fine for local development; a public deployment must set it
		// (Wikimedia asks for a way to reach us).
		slog.Warn("SPECIES_CONTACT is not set; upstream requests carry no contact")
	}
	settings := enrich.LiveSettings(userAgent)
	slog.Info("enrichment cache ready", "path", cachePath, "userAgent", userAgent)
	state = state.WithEnrichment(cache, enrich.New(settings))
	if _, err := os.Stat(filepath.Join(cfg.StaticDir, "index.html")); err != nil {
		slog.Warn("no index.html in the static dir; run `pnpm -C web build`", "dir", cfg.StaticDir)
	}

	addr := fmt.Sprintf("0.0.0.0:%d", cfg.Port)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("could not listen on %s: %w", addr, err)
	}
	slog.Info("listening", "addr", addr, "staticDir", cfg.StaticDir)

	// stop is the context's own cancel: it also stops listening for the
	// signals, so a second Ctrl+C kills the process the usual way.
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	srv := &http.Server{Handler: Router(state, cfg.StaticDir)}
	served := make(chan error, 1)
	go func() {
		served <- srv.Serve(listener)
	}()

	select {
	case err := <-served:
		return fmt.Errorf("server error: %w", err)
	case <-ctx.Done():
	}
	slog.Info("shutdown signal received")
	// Shutdown stops accepting connections and waits for in-flight
	// requests to finish.
	if err := srv.Shutdown(context.Background()); err != nil {
		return fmt.Errorf("shutting down: %w", err)
	}
	if err := <-served; !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("server error: %w", err)
	}
	slog.Info("shut down cleanly")
	return nil
}
