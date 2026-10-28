//! `GET /api/v/{ver}/tiles/{level}/{sector}` (PLAN §5.1, docs/tile-format.md):
//! the gzipped tile blob exactly as ingest stored it.
//!
//! Concepts introduced here:
//! - the `Path` extractor with several segments as a tuple
//! - returning different response shapes from one handler via `Response`

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::http::header::{CACHE_CONTROL, CONTENT_ENCODING, CONTENT_TYPE};
use axum::response::{IntoResponse, Response};

use super::{AppState, run_query};
use crate::db::queries;
use crate::error::AppError;

/// A tile URL carries the data version, so its content never changes.
pub const IMMUTABLE: &str = "public, max-age=31536000, immutable";

// LEARN: `Path((ver, level, sector))` fills a tuple from the three `{…}`
// segments of the route, in order. They are taken as `String`s and parsed
// below, so a bad number gets our JSON error instead of axum's plain text.
pub async fn tile(
    State(state): State<AppState>,
    Path((ver, level, sector)): Path<(String, String, String)>,
) -> Result<Response, AppError> {
    // The client sees 404, reloads meta and asks again with the new version.
    if ver != state.meta.data_version {
        return Err(AppError::NotFound(format!(
            "data version {ver} (current: {})",
            state.meta.data_version
        )));
    }
    let Ok(level) = level.parse::<u8>() else {
        return Err(AppError::BadRequest(format!("level {level:?}")));
    };
    let Ok(sector) = sector.parse::<u32>() else {
        return Err(AppError::BadRequest(format!("sector {sector:?}")));
    };

    let blob = run_query(&state, move |conn| queries::tile(conn, level, sector)).await?;
    // LEARN: the two branches build different types (one has a body, one
    // does not), so each calls `.into_response()` to become the common
    // `Response` type the function promises.
    let response = match blob {
        // Already gzip: `Content-Encoding` tells the browser to unzip it and
        // tells CompressionLayer to leave it alone (no double gzip).
        Some(gz) => (
            [
                (CONTENT_TYPE, "application/octet-stream"),
                (CONTENT_ENCODING, "gzip"),
                (CACHE_CONTROL, IMMUTABLE),
            ],
            gz,
        )
            .into_response(),
        // Empty tiles are not stored. That is as permanent as the version.
        None => (StatusCode::NO_CONTENT, [(CACHE_CONTROL, IMMUTABLE)]).into_response(),
    };
    Ok(response)
}
