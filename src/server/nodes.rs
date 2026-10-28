//! `GET /api/nodes/{ref}` (PLAN §5.1): one node with its lineage and largest
//! children. `ref` is a pre-order id, `ott…` or `mrcaott…` (`NodeRef`).

use axum::Json;
use axum::extract::{Path, State};

use super::{AppState, run_query};
use crate::db::queries::{self, NodeDetail, NodeRef};
use crate::error::AppError;

pub async fn node(
    State(state): State<AppState>,
    Path(reference): Path<String>,
) -> Result<Json<NodeDetail>, AppError> {
    // `parse` works because `NodeRef` implements `FromStr`. A malformed ref
    // is the client's mistake (400); a well-formed one that matches nothing
    // is a 404.
    let node_ref: NodeRef = reference.parse().map_err(AppError::BadRequest)?;
    let detail = run_query(&state, move |conn| queries::node_detail(conn, &node_ref)).await?;
    match detail {
        Some(detail) => Ok(Json(detail)),
        None => Err(AppError::NotFound(format!("node {reference}"))),
    }
}
