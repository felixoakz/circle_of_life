//! `GET /api/search?q=homo%20sap&limit=8` (PLAN §5.2). The ranking itself is
//! in `db::queries::search`.
//!
//! Concepts introduced here:
//! - the `Query` extractor and `#[derive(Deserialize)]`
//! - `Json(…)` as a response
//! - `#[serde(default)]` for an optional query parameter
//! - `Result<Extractor, Rejection>`: handling an extractor's failure yourself

use axum::Json;
use axum::extract::rejection::QueryRejection;
use axum::extract::{Query, State};
use serde::Deserialize;

use super::{AppState, run_query};
use crate::db::queries::{self, SearchHit};
use crate::error::AppError;

const DEFAULT_LIMIT: usize = 8;
const MAX_LIMIT: usize = 50;

// LEARN: `Deserialize` is the reverse of `Serialize`: serde writes code that
// builds this struct from the query string `?q=…&limit=…`. `#[serde(default)]`
// uses `String::default()` (empty) when `q` is missing; an `Option` field is
// simply `None` when absent. A malformed value (`limit=abc`) makes the
// extractor fail; see the handler for how that failure becomes our JSON.
#[derive(Debug, Deserialize)]
pub struct SearchParams {
    #[serde(default)]
    q: String,
    limit: Option<usize>,
}

// LEARN: `Json(value)` is a response that serialises `value` with serde and
// sets `Content-Type: application/json`.
pub async fn search(
    State(state): State<AppState>,
    params: Result<Query<SearchParams>, QueryRejection>,
) -> Result<Json<Vec<SearchHit>>, AppError> {
    // LEARN: an extractor that fails normally answers the request itself
    // (here with axum's plain-text 400) and the handler never runs. Asking
    // for `Result<Query<…>, QueryRejection>` instead hands us the failure as
    // a value, so we can turn it into the same `{"error": …}` JSON as every
    // other error. `body_text()` is axum's human-readable reason.
    let Query(params) = params.map_err(|rejection| AppError::BadRequest(rejection.body_text()))?;
    let limit = params.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let hits = run_query(&state, move |conn| queries::search(conn, &params.q, limit)).await?;
    Ok(Json(hits))
}
