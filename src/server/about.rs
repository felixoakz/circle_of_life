//! `GET /api/nodes/{ref}/about[?retry=1]` (PLAN §6): the enrichment
//! document for one node.
//!
//! - Unnamed (mrca) nodes get a minimal document at once: they are never
//!   enriched and never cached.
//! - A cached document is served as is. If it is past its time to live it
//!   is still served, and refreshed in the background (stale-while-
//!   revalidate), so nobody waits for a refresh.
//! - On a miss, the enricher fetches everything (a few seconds at most),
//!   and the document is stored before it is returned.
//! - `?retry=1` refetches a cached *partial* document (the panel's "Retry"
//!   after a source failed). A complete one is served from cache anyway, so
//!   the parameter cannot be used to hammer the upstream services.
//!
//! Concepts introduced here:
//! - `tokio::spawn`: start a task that outlives the request
//! - building a response from a tuple of headers and a body

use axum::Json;
use axum::extract::rejection::QueryRejection;
use axum::extract::{Path, Query, State};
use axum::http::header::CACHE_CONTROL;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

use super::{AppState, run_cache, run_query};
use crate::db::cache::{self, Cached, Freshness};
use crate::db::queries::{self, NodeDetail, NodeRef};
use crate::enrich::{self, About, Ancestor, FALLBACK_RANKS, Summary, Taxon};
use crate::error::AppError;

#[derive(Debug, Deserialize)]
pub struct AboutParams {
    /// `?retry=1`: refetch a cached partial document.
    retry: Option<u8>,
}

pub async fn about(
    State(state): State<AppState>,
    Path(reference): Path<String>,
    params: Result<Query<AboutParams>, QueryRejection>,
) -> Result<Response, AppError> {
    let Query(params) = params.map_err(|rejection| AppError::BadRequest(rejection.body_text()))?;
    let retry = params.retry.unwrap_or(0) != 0;
    let node_ref: NodeRef = reference.parse().map_err(AppError::BadRequest)?;
    let detail = run_query(&state, move |conn| queries::node_detail(conn, &node_ref)).await?;
    let Some(detail) = detail else {
        return Err(AppError::NotFound(format!("node {reference}")));
    };
    let now = cache::now();

    let Some(name) = detail.node.name.clone() else {
        let within = detail.named_ancestor.as_ref().and_then(|a| a.name.clone());
        let doc = enrich::minimal(
            &detail.node.node_id,
            within.as_deref(),
            detail.node.leaf_count,
            now,
        );
        return Ok(respond(&doc));
    };

    let node_id = detail.node.node_id.clone();
    let key = node_id.clone();
    let cached = run_cache(&state, move |conn| cache::get(conn, &key)).await?;
    if let Some(row) = cached {
        // A row that no longer parses (an older document shape) is a miss.
        if let Ok(doc) = serde_json::from_str::<About>(&row.body)
            && !(retry && !row.complete)
        {
            if row.freshness(now) == Freshness::Stale {
                refresh_in_background(&state, &detail, &name);
            }
            tracing::info!(node = %node_id, complete = row.complete, "about: from cache");
            return Ok(respond(&doc));
        }
    }

    let taxon = taxon_for(&state, &detail, &name).await?;
    let doc = fetch_and_store(&state, &taxon).await?;
    tracing::info!(node = %node_id, complete = doc.complete, failed = ?doc.failed, "about: fetched");
    Ok(respond(&doc))
}

/// The JSON response. A complete document may be cached by the browser for
/// a day; a partial one not at all, so "Retry" really asks again.
fn respond(doc: &About) -> Response {
    let cache_control = if doc.complete {
        "public, max-age=86400"
    } else {
        "no-store"
    };
    // LEARN: a tuple `(headers, body)` is itself a response: axum applies
    // each part in order. `[(name, value)]` is an array of header pairs.
    ([(CACHE_CONTROL, cache_control)], Json(doc)).into_response()
}

/// Fetches the document and stores it in cache.db.
async fn fetch_and_store(state: &AppState, taxon: &Taxon) -> Result<About, AppError> {
    let doc = state.enricher.about(taxon, cache::now()).await;
    match serde_json::to_string(&doc) {
        Ok(body) => {
            let row = Cached {
                body,
                complete: doc.complete,
                fetched_at: doc.fetched_at,
            };
            let node_id = doc.node_id.clone();
            run_cache(state, move |conn| cache::put(conn, &node_id, &row)).await?;
        }
        // Cannot happen for these plain types, but a failed store must not
        // cost the reader their answer.
        Err(err) => tracing::error!(node = %doc.node_id, "about: not stored: {err}"),
    }
    Ok(doc)
}

/// Starts a refresh that outlives this request, unless one already runs.
fn refresh_in_background(state: &AppState, detail: &NodeDetail, name: &str) {
    let node_id = detail.node.node_id.clone();
    if !state.enricher.begin_refresh(&node_id) {
        return;
    }
    let state = state.clone();
    let detail = detail.clone();
    let name = name.to_string();
    // LEARN: `tokio::spawn` runs a future as its own task, independent of
    // the caller: this request returns the stale document right away while
    // the refresh goes on. The future must own everything it uses
    // (`async move` plus the clones above), because the request that
    // started it is long gone when it finishes.
    tokio::spawn(async move {
        match taxon_for(&state, &detail, &name).await {
            Ok(taxon) => {
                if let Err(err) = fetch_and_store(&state, &taxon).await {
                    tracing::warn!(node = %node_id, "about: background refresh failed: {err}");
                }
            }
            Err(err) => tracing::warn!(node = %node_id, "about: background refresh failed: {err}"),
        }
        state.enricher.end_refresh(&node_id);
    });
}

/// What the enricher needs about a named node: its ids, and its named
/// ancestors nearest first, with any Wikipedia summary cache.db already
/// holds for the ones an article may be borrowed from.
async fn taxon_for(state: &AppState, detail: &NodeDetail, name: &str) -> Result<Taxon, AppError> {
    let mut ancestors = Vec::new();
    for entry in detail.lineage.iter().rev() {
        let Some(ancestor_name) = &entry.name else {
            continue;
        };
        if queries::is_placeholder_name(ancestor_name) {
            continue;
        }
        ancestors.push(Ancestor {
            node_id: entry.node_id.clone(),
            ott: ott_of(&entry.node_id),
            name: ancestor_name.clone(),
            rank: entry.rank.clone(),
            cached_summary: None,
        });
    }

    // Only the nodes `Taxon::fallbacks` may use are worth a cache read.
    let mut wanted = Vec::new();
    for ancestor in &ancestors {
        if FALLBACK_RANKS.contains(&ancestor.rank.as_deref().unwrap_or("")) {
            wanted.push(ancestor.node_id.clone());
        }
    }
    let summaries = run_cache(state, move |conn| {
        let mut found = Vec::new();
        for node_id in wanted {
            if let Some(row) = cache::get(conn, &node_id)? {
                found.push((node_id, own_summary(&row.body)));
            }
        }
        Ok(found)
    })
    .await?;
    for (node_id, summary) in summaries {
        for ancestor in ancestors.iter_mut() {
            if ancestor.node_id == node_id {
                ancestor.cached_summary = summary.clone();
            }
        }
    }

    Ok(Taxon {
        node_id: detail.node.node_id.clone(),
        ott: detail.ids.ott,
        name: name.to_string(),
        rank: detail.node.rank.clone(),
        gbif: detail.node.gbif_id,
        leaf_count: detail.node.leaf_count,
        ancestors,
    })
}

/// A cached document's own article (not one it borrowed).
fn own_summary(body: &str) -> Option<Summary> {
    let doc: About = serde_json::from_str(body).ok()?;
    doc.summary.filter(|s| s.about.is_none())
}

/// 770315 from "ott770315".
fn ott_of(node_id: &str) -> Option<u32> {
    node_id.strip_prefix("ott")?.parse().ok()
}
