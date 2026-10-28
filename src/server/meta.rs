//! `GET /api/meta` (PLAN §5.1): the document the client loads first. Ingest
//! stored it as JSON text, so it is sent verbatim, never re-serialised.
//!
//! Concepts introduced here:
//! - the `State` extractor: shared data handed to every handler
//! - building a response from a tuple of (headers, body)

use axum::extract::State;
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::response::IntoResponse;

use super::AppState;

// LEARN: `State(state): State<AppState>` asks axum for the value given to
// `Router::with_state`. axum clones it for each request, which is why
// `AppState` holds `Arc`s: cloning those only copies a pointer.
// `impl IntoResponse` as the return type means "some type axum can turn into
// a response"; the compiler knows the exact type, we do not have to spell it.
pub async fn meta(State(state): State<AppState>) -> impl IntoResponse {
    // `no-cache` = the browser may keep it but must revalidate every time,
    // because a new ingest changes `dataVersion`.
    (
        [
            (CONTENT_TYPE, "application/json"),
            (CACHE_CONTROL, "no-cache"),
        ],
        state.meta.json.clone(),
    )
}
