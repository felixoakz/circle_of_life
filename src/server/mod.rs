//! The HTTP server behind `species serve`: opens `tree.db`, builds the axum
//! router, binds the port and runs until Ctrl+C or SIGTERM.
//!
//! Routes: `/healthz`; the read API under `/api` (one sibling module per
//! endpoint group: `meta`, `tiles`, `search`, `nodes`) with a JSON 404 for
//! unknown `/api/…` paths; hashed frontend assets under `/assets` (cached
//! forever); everything else is `web/dist` with an `index.html` fallback (never
//! cached) so deep links like `/?n=ott770315` load the app. Enrichment (P10)
//! is `/api/nodes/{ref}/about` (`about`), cached in `cache.db`.
//!
//! Concepts introduced here:
//! - `async fn` and `.await`
//! - the `?` operator for early return on error
//! - `Result<T, E>` and `anyhow::Context` for readable error messages
//! - building a value step by step with the builder pattern (`Router::new().route(…)`)
//! - `tokio::select!`: wait for whichever of several futures finishes first
//! - conditional compilation with `#[cfg(unix)]`
//! - axum extractors and destructuring a struct in a parameter
//! - `Arc`: shared ownership across threads
//! - `Mutex`: one user at a time for a value that is not thread-safe
//! - `spawn_blocking`: running blocking code outside the async workers
//! - a generic function with closure bounds (`FnOnce + Send + 'static`)
//! - axum middleware written as plain async functions
//! - `impl Trait` in a return type

mod about;
mod meta;
mod nodes;
mod search;
mod tiles;

use std::net::SocketAddr;
use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Instant;

use anyhow::Context;
use axum::Router;
use axum::extract::{OriginalUri, Request};
use axum::http::HeaderValue;
use axum::http::header::CACHE_CONTROL;
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::get;
use rusqlite::Connection;
use tower_http::compression::CompressionLayer;
use tower_http::compression::predicate::{DefaultPredicate, NotForContentType, Predicate};
use tower_http::services::{ServeDir, ServeFile};

use crate::config::ServeArgs;
use crate::db::{cache, queries};
use crate::enrich::{Enricher, Settings};
use crate::error::AppError;

/// The `/api/meta` document and the one field the server itself needs.
#[derive(Debug)]
pub struct Meta {
    /// The JSON text, sent verbatim.
    pub json: String,
    /// Tiles requested with any other version get a 404.
    pub data_version: String,
}

// LEARN: `Arc<T>` ("atomically reference counted") lets many owners share one
// value, even across threads: `clone()` copies a pointer and bumps a counter,
// and the value is freed when the last clone is dropped. axum clones the state
// for every request, so everything big or unique sits behind an `Arc`.
//
// LEARN: an SQLite `Connection` may be *moved* between threads but not *used*
// from two at once. `Mutex<T>` enforces that: `lock()` waits until no one
// else holds the lock, then hands out access; the lock is released when that
// guard is dropped. Together, `Arc<Mutex<Connection>>` is "one connection that
// any request may use, one at a time" (PLAN §5.3 says why that is enough).
/// Shared by every request.
#[derive(Clone)]
pub struct AppState {
    pub tree: Arc<Mutex<Connection>>,
    pub meta: Arc<Meta>,
    /// `cache.db`, the enrichment cache (read-write).
    pub cache: Arc<Mutex<Connection>>,
    /// The HTTP client and per-host limits for enrichment.
    pub enricher: Arc<Enricher>,
}

impl AppState {
    /// Opens `tree.db`; fails (naming the path) if it is missing or not a
    /// tree database.
    pub fn open(path: &Path) -> anyhow::Result<AppState> {
        let conn = queries::open(path)?;
        AppState::new(conn).with_context(|| format!("reading meta from {}", path.display()))
    }

    /// Wraps an already open connection (tests use an in-memory one). The
    /// enrichment cache starts as an empty in-memory database and the
    /// enricher talks to the real services; [`AppState::with_enrichment`]
    /// replaces both.
    pub fn new(conn: Connection) -> anyhow::Result<AppState> {
        let json = queries::meta_json(&conn)?;
        let value: serde_json::Value = serde_json::from_str(&json)?;
        let Some(data_version) = value["dataVersion"].as_str() else {
            anyhow::bail!("meta has no dataVersion");
        };
        let meta = Meta {
            data_version: data_version.to_string(),
            json,
        };
        let cache_conn = Connection::open_in_memory()?;
        cache::init(&cache_conn)?;
        let user_agent = crate::config::user_agent(None, None);
        let enricher = Enricher::new(Settings::live(user_agent))?;
        Ok(AppState {
            tree: Arc::new(Mutex::new(conn)),
            meta: Arc::new(meta),
            cache: Arc::new(Mutex::new(cache_conn)),
            enricher: Arc::new(enricher),
        })
    }

    /// The same state with this cache database and enricher.
    pub fn with_enrichment(self, cache: Connection, enricher: Enricher) -> AppState {
        // LEARN: struct update syntax: `..self` takes every field not named
        // here from `self`, so only the changed fields are spelled out.
        AppState {
            cache: Arc::new(Mutex::new(cache)),
            enricher: Arc::new(enricher),
            ..self
        }
    }
}

/// Runs a blocking database function on tokio's blocking thread pool and
/// waits for its result without holding up an async worker.
// LEARN: tokio runs thousands of async tasks on a handful of worker threads,
// switching between them at each `.await`. Code that blocks a thread (an
// SQLite query, a big file read, a mutex wait) never reaches an `.await`, so
// while it runs that worker cannot serve anyone else. `spawn_blocking` moves
// such code to a separate pool of threads made for blocking, and gives back a
// future we can `.await` like any other.
//
// LEARN: this function is *generic*: `F` is "any closure type" and `T` "any
// result type", fixed per call by the compiler. The `where` clause lists what
// they must allow: `FnOnce(&Connection) -> …` (called once with the
// connection), `Send` (may move to another thread) and `'static` (borrows
// nothing from the caller, which might be gone by the time it runs). That is
// why handlers pass `move |conn| …` closures that own their inputs.
pub async fn run_query<T, F>(state: &AppState, query: F) -> Result<T, AppError>
where
    F: FnOnce(&Connection) -> rusqlite::Result<T> + Send + 'static,
    T: Send + 'static,
{
    run_blocking(&state.tree, query).await
}

/// [`run_query`] for `cache.db`.
pub async fn run_cache<T, F>(state: &AppState, query: F) -> Result<T, AppError>
where
    F: FnOnce(&Connection) -> rusqlite::Result<T> + Send + 'static,
    T: Send + 'static,
{
    run_blocking(&state.cache, query).await
}

async fn run_blocking<T, F>(db: &Arc<Mutex<Connection>>, query: F) -> Result<T, AppError>
where
    F: FnOnce(&Connection) -> rusqlite::Result<T> + Send + 'static,
    T: Send + 'static,
{
    let db = Arc::clone(db);
    let result = tokio::task::spawn_blocking(move || {
        // If a query ever panicked while holding the lock, the mutex is
        // "poisoned". The connection itself is still fine (SQLite statements
        // are atomic), so we take it anyway instead of failing every later
        // request.
        let conn = db.lock().unwrap_or_else(PoisonError::into_inner);
        query(&conn)
    })
    .await?;
    Ok(result?)
}

/// Builds the full router. Kept separate from [`run`] so tests can call it
/// without opening a socket.
pub fn router(state: AppState, static_dir: &Path) -> Router {
    // `/api/...` must never fall back to index.html: a typo in an API path
    // should be a clear JSON 404, not an HTML page that fails to parse.
    let api = Router::new()
        .route("/meta", get(meta::meta))
        .route("/v/{ver}/tiles/{level}/{sector}", get(tiles::tile))
        .route("/search", get(search::search))
        .route("/nodes/{reference}", get(nodes::node))
        .route("/nodes/{reference}/about", get(about::about))
        .fallback(api_not_found)
        .with_state(state);

    // Vite puts a content hash in every file name under `assets/`, so a
    // given URL never changes content and may be cached forever.
    let assets = Router::new()
        .fallback_service(ServeDir::new(static_dir.join("assets")))
        .layer(middleware::map_response(cache_forever));

    // Unknown files fall back to index.html, because the frontend is a
    // single page app and every URL is really "the app plus a query string".
    // index.html names the current hashed assets, so it must be revalidated.
    let index = static_dir.join("index.html");
    let app_shell = Router::new()
        .fallback_service(ServeDir::new(static_dir).fallback(ServeFile::new(index)))
        .layer(middleware::map_response(no_cache));

    // LEARN: the builder pattern. Each method takes the router by value and
    // returns a new one with one more piece, so calls chain naturally.
    Router::new()
        .route("/healthz", get(healthz))
        .nest("/api", api)
        .nest_service("/assets", assets)
        .fallback_service(app_shell)
        .layer(compression())
        .layer(middleware::from_fn(log_request))
}

/// gzip for JSON and static text. It skips responses that already have a
/// Content-Encoding (the tiles), so nothing is zipped twice, and formats
/// that are compressed already: images (the default rule; SVG excepted)
/// and fonts (woff2 is Brotli inside), where gzip costs CPU and saves
/// nothing.
// LEARN: `impl Predicate` in a return type means "some type that implements
// `Predicate`; the compiler knows which, callers need not". The real type is
// a long nested `And<…>` that nobody wants to spell out.
fn compression() -> CompressionLayer<impl Predicate> {
    let predicate = DefaultPredicate::new().and(NotForContentType::const_new("font/"));
    CompressionLayer::new().compress_when(predicate)
}

// LEARN: an `async fn` returns a *future*: a value describing work that has
// not happened yet. Nothing runs until something `.await`s it (here: axum,
// for each request). A `&'static str` is a string baked into the binary, and
// axum knows how to turn it into a `200 text/plain` response.
async fn healthz() -> &'static str {
    "ok"
}

// Inside a nested router the request URI has the `/api` prefix stripped;
// `OriginalUri` is the path as the client sent it, which is what the error
// message should show.
// LEARN: axum *extractors*: a handler declares what it needs as parameters
// and axum fills them from the request. `OriginalUri(uri)` is a pattern that
// unpacks the one-field wrapper struct right in the parameter list.
async fn api_not_found(OriginalUri(uri): OriginalUri) -> AppError {
    AppError::NotFound(uri.path().to_string())
}

// LEARN: axum middleware can be a plain async function. `from_fn` gives it
// the request and `next`, the rest of the app; whatever it does before
// `next.run(…)` happens on the way in, whatever after, on the way out.
/// One log line per request: `GET /api/meta 200 312.4µs`.
async fn log_request(request: Request, next: Next) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_string();
    let start = Instant::now();
    let response = next.run(request).await;
    // `{:.1?}` prints a Duration in its natural unit with one decimal.
    tracing::info!(
        "{method} {path} {} {:.1?}",
        response.status().as_u16(),
        start.elapsed()
    );
    response
}

/// `map_response` middleware for hashed assets. Only successful responses:
/// a 404 must not be cached forever.
async fn cache_forever(mut response: Response) -> Response {
    if response.status().is_success() {
        response
            .headers_mut()
            .insert(CACHE_CONTROL, HeaderValue::from_static(tiles::IMMUTABLE));
    }
    response
}

/// `map_response` middleware for index.html and other unhashed files.
async fn no_cache(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}

/// Runs the server until it receives Ctrl+C or SIGTERM.
pub async fn run(args: ServeArgs) -> anyhow::Result<()> {
    // A missing or broken tree.db stops the server right here, with the
    // path in the message (PLAN §11).
    let db_path = args.tree_db_path();
    let state = AppState::open(&db_path)?;
    tracing::info!(path = %db_path.display(), data_version = %state.meta.data_version, "opened tree database");

    let cache_path = args.cache_db_path();
    let cache_conn = cache::open(&cache_path)?;
    let user_agent = args.user_agent();
    if args.contact.as_deref().is_none_or(|c| c.trim().is_empty()) {
        // Logged once, at start. Fine for local development; a public
        // deployment must set it (Wikimedia asks for a way to reach us).
        tracing::warn!("SPECIES_CONTACT is not set; upstream requests carry no contact");
    }
    tracing::info!(path = %cache_path.display(), %user_agent, "enrichment cache ready");
    let enricher = Enricher::new(Settings::live(user_agent))?;
    let state = state.with_enrichment(cache_conn, enricher);
    if !args.static_dir.join("index.html").exists() {
        tracing::warn!(dir = %args.static_dir.display(), "no index.html in the static dir; run `pnpm -C web build`");
    }

    let app = router(state, &args.static_dir);
    let addr = SocketAddr::from(([0, 0, 0, 0], args.port));

    // LEARN: `?` after an expression that returns `Result` means "if this is
    // an `Err`, return it from the current function right now; otherwise give
    // me the `Ok` value". `.with_context(…)` (from anyhow) wraps the error
    // with a human sentence first, so the user sees *what* failed, not just
    // "Address already in use".
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("could not listen on {addr}"))?;
    tracing::info!(%addr, static_dir = %args.static_dir.display(), "listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("server error")?;

    tracing::info!("shut down cleanly");
    Ok(())
}

/// Completes when the process is asked to stop. axum then stops accepting
/// connections and lets in-flight requests finish.
async fn shutdown_signal() {
    let ctrl_c = async {
        // If installing the handler fails we cannot shut down gracefully at
        // all, so crashing loudly at startup is the right call.
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    // LEARN: `#[cfg(unix)]` compiles the next item only on Unix-like systems.
    // Docker and Coolify stop containers with SIGTERM, which only exists there.
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    // LEARN: `tokio::select!` waits on several futures at once and runs the
    // branch of whichever finishes first; the others are dropped (cancelled).
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received");
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{Body, to_bytes};
    use axum::http::{Request, StatusCode};
    // `oneshot` sends a single request through the router, no socket needed.
    use tower::ServiceExt;

    /// Sends a GET and returns (status, body as text).
    async fn get_text(app: Router, uri: &str) -> (StatusCode, String) {
        let request = Request::get(uri).body(Body::empty()).unwrap();
        let response = app.oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    /// A temporary static dir holding a tiny index.html. The `TempDir` is
    /// returned so it lives (and the files exist) for the whole test.
    fn static_dir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("index.html"), "<!doctype html>app").unwrap();
        std::fs::create_dir(dir.path().join("assets")).unwrap();
        std::fs::write(dir.path().join("assets/index-abc123.js"), "console.log(1)").unwrap();
        dir
    }

    /// An in-memory database with the real schema and a minimal meta row:
    /// enough for routes that do not query nodes.
    fn test_state() -> AppState {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::SCHEMA).unwrap();
        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('meta', '{\"dataVersion\":\"test\"}')",
            [],
        )
        .unwrap();
        AppState::new(conn).unwrap()
    }

    /// The Cache-Control header of a GET, if any.
    async fn cache_control(app: Router, uri: &str) -> (StatusCode, Option<String>) {
        let request = Request::get(uri).body(Body::empty()).unwrap();
        let response = app.oneshot(request).await.unwrap();
        let header = response.headers().get(CACHE_CONTROL);
        let value = header.map(|v| v.to_str().unwrap().to_string());
        (response.status(), value)
    }

    // LEARN: `#[tokio::test]` is `#[test]` for async functions: it starts a
    // small tokio runtime so the test body can `.await`.
    #[tokio::test]
    async fn healthz_is_ok() {
        let dir = static_dir();
        let (status, body) = get_text(router(test_state(), dir.path()), "/healthz").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, "ok");
    }

    #[tokio::test]
    async fn unknown_paths_fall_back_to_index_html() {
        let dir = static_dir();
        let (status, body) = get_text(router(test_state(), dir.path()), "/some/deep/link").await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("app"));
    }

    #[tokio::test]
    async fn unknown_api_path_is_json_404() {
        let dir = static_dir();
        let (status, body) = get_text(router(test_state(), dir.path()), "/api/nope").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body, r#"{"error":"not found: /api/nope"}"#);
    }

    #[tokio::test]
    async fn static_cache_headers() {
        let dir = static_dir();
        let app = router(test_state(), dir.path());
        let immutable = Some(tiles::IMMUTABLE.to_string());
        let no_cache = Some("no-cache".to_string());
        let hashed = cache_control(app.clone(), "/assets/index-abc123.js").await;
        assert_eq!(hashed, (StatusCode::OK, immutable));
        let missing = cache_control(app.clone(), "/assets/gone-123.js").await;
        assert_eq!(missing, (StatusCode::NOT_FOUND, None));
        let root = cache_control(app.clone(), "/").await;
        assert_eq!(root, (StatusCode::OK, no_cache.clone()));
        let deep = cache_control(app, "/?n=ott770315").await;
        assert_eq!(deep, (StatusCode::OK, no_cache));
    }

    /// The Content-Encoding of a GET that accepts gzip, if any.
    async fn encoding(app: Router, uri: &str) -> Option<String> {
        let request = Request::get(uri)
            .header("accept-encoding", "gzip")
            .body(Body::empty())
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        let header = response.headers().get("content-encoding");
        header.map(|v| v.to_str().unwrap().to_string())
    }

    #[tokio::test]
    async fn gzip_skips_fonts_and_images() {
        let dir = static_dir();
        let text = "body { color: black; } ".repeat(50);
        std::fs::write(dir.path().join("assets/index-abc123.css"), &text).unwrap();
        std::fs::write(dir.path().join("assets/font-abc123.woff2"), &text).unwrap();
        std::fs::write(dir.path().join("fallback.webp"), &text).unwrap();
        let app = router(test_state(), dir.path());
        let css = encoding(app.clone(), "/assets/index-abc123.css").await;
        assert_eq!(css.as_deref(), Some("gzip"));
        assert_eq!(
            encoding(app.clone(), "/assets/font-abc123.woff2").await,
            None
        );
        assert_eq!(encoding(app, "/fallback.webp").await, None);
    }

    #[test]
    fn missing_tree_db_names_the_path() {
        let error = AppState::open(Path::new("no/such/tree.db")).err().unwrap();
        assert!(error.to_string().contains("no/such/tree.db"), "{error}");
    }
}
