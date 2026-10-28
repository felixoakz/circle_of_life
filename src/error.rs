//! The one error type of the HTTP server, `AppError`, and how it becomes an
//! HTTP response: a JSON body `{"error": "…"}` with the right status code
//! (PLAN §5).
//!
//! The CLI and ingest use `anyhow` instead, because there the only thing we do
//! with an error is print it. In the server we need to *decide* things from the
//! error (which status code?), so a concrete enum is the better fit.
//!
//! Concepts introduced here:
//! - enums whose variants carry data
//! - `thiserror`: deriving the standard `Error` trait
//! - `#[from]`: automatic conversion from a library's error, so `?` works
//! - implementing a library trait (`IntoResponse`) for our own type
//! - `match` on an enum

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

// LEARN: an `enum` is a type that is exactly one of several variants, and a
// variant can carry data (`NotFound(String)` holds a message). `thiserror`'s
// `#[error("…")]` writes the `Display` impl, so `err.to_string()` gives
// "not found: /api/x".
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("not found: {0}")]
    NotFound(String),

    #[error("bad request: {0}")]
    BadRequest(String),

    // LEARN: `#[from]` makes thiserror write `impl From<rusqlite::Error> for
    // AppError`. The `?` operator calls `From::from` on the error it returns
    // early with, so inside a function returning `Result<_, AppError>`, a
    // `rusqlite::Error` turns into `AppError::Database` without any code.
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),

    /// A blocking task panicked or was cancelled (see `server::run_query`).
    #[error("background task failed: {0}")]
    Task(#[from] tokio::task::JoinError),
}

// LEARN: a trait is a set of methods a type promises to have, like an
// interface. axum calls `into_response` on whatever a handler returns, so by
// implementing `IntoResponse` for `AppError`, a handler can simply return
// `Err(AppError::…)` and axum turns it into an HTTP response.
impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        // LEARN: `match` must cover every variant; adding a variant later
        // makes this a compile error until we choose its status code.
        let (status, message) = match &self {
            AppError::NotFound(_) => (StatusCode::NOT_FOUND, self.to_string()),
            AppError::BadRequest(_) => (StatusCode::BAD_REQUEST, self.to_string()),
            // Server faults: the details go to the log, not to the client.
            AppError::Database(_) | AppError::Task(_) => {
                tracing::error!(error = %self, "request failed");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal error".to_string(),
                )
            }
        };
        let body = Json(json!({ "error": message }));
        // A tuple of (status, body) already implements IntoResponse.
        (status, body).into_response()
    }
}
