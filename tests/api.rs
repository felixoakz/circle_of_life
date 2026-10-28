//! The read API end to end (PLAN §9 P4): build the mini `tree.db` with the
//! real ingest, then send requests through the router with `oneshot` (no
//! socket) and check status codes, headers and JSON.

use std::io::Read;
use std::path::{Path, PathBuf};

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::header::{ACCEPT_ENCODING, CACHE_CONTROL, CONTENT_ENCODING, CONTENT_TYPE};
use axum::http::{HeaderMap, Request, StatusCode};
use flate2::read::GzDecoder;
use serde_json::Value;
use species::config::IngestArgs;
use species::server::{AppState, router};
use tower::ServiceExt;

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

/// Ingests the mini fixtures into a temp dir and builds the router on it.
/// The `TempDir` must outlive the router (dropping it deletes the files).
fn app() -> (tempfile::TempDir, Router) {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("mini.db");
    let args = IngestArgs {
        tree: fixture("mini.tre"),
        taxonomy: fixture("mini_taxonomy.tsv"),
        vernacular: Some(fixture("mini_vernacular.tsv")),
        langs: "en,pt".to_string(),
        out: out.clone(),
        dry_run: false,
    };
    species::ingest::run(&args).unwrap();
    std::fs::write(dir.path().join("index.html"), "<!doctype html>app").unwrap();
    let state = AppState::open(&out).unwrap();
    let app = router(state, dir.path());
    (dir, app)
}

struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    body: Vec<u8>,
}

impl Reply {
    /// The body as the browser sees it: unzipped if CompressionLayer zipped it.
    fn bytes(&self) -> Vec<u8> {
        if self.headers.get(CONTENT_ENCODING).is_some() {
            gunzip(&self.body)
        } else {
            self.body.clone()
        }
    }
    fn json(&self) -> Value {
        serde_json::from_slice(&self.bytes()).unwrap()
    }
    fn header(&self, name: impl axum::http::header::AsHeaderName) -> &str {
        self.headers.get(name).unwrap().to_str().unwrap()
    }
}

/// GETs `uri` the way a browser does (accepting gzip).
async fn get(app: &Router, uri: &str) -> Reply {
    let request = Request::get(uri)
        .header(ACCEPT_ENCODING, "gzip")
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let body = to_bytes(response.into_body(), 1 << 24).await.unwrap();
    Reply {
        status,
        headers,
        body: body.to_vec(),
    }
}

fn gunzip(gz: &[u8]) -> Vec<u8> {
    let mut raw = Vec::new();
    GzDecoder::new(gz).read_to_end(&mut raw).unwrap();
    raw
}

async fn data_version(app: &Router) -> String {
    let meta = get(app, "/api/meta").await.json();
    meta["dataVersion"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn meta() {
    let (_dir, app) = app();
    let reply = get(&app, "/api/meta").await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.header(CACHE_CONTROL), "no-cache");
    assert_eq!(reply.header(CONTENT_TYPE), "application/json");
    let meta = reply.json();
    assert!(
        meta["dataVersion"]
            .as_str()
            .unwrap()
            .starts_with("otl16.1-ott3.7.3-")
    );
    assert_eq!(meta["tipCount"], 30);
    assert_eq!(meta["home"]["nodeId"], "ott770315");
}

#[tokio::test]
async fn tile_has_headers_and_is_gzipped_once() {
    let (_dir, app) = app();
    let version = data_version(&app).await;
    let reply = get(&app, &format!("/api/v/{version}/tiles/0/0")).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.header(CONTENT_TYPE), "application/octet-stream");
    assert_eq!(reply.header(CONTENT_ENCODING), "gzip");
    assert_eq!(
        reply.header(CACHE_CONTROL),
        "public, max-age=31536000, immutable"
    );
    // One gunzip gives the raw tile: CompressionLayer did not zip it again.
    let raw = gunzip(&reply.body);
    assert_eq!(&raw[..4], b"SPT2");
    let tile = species::tiles::decode(&raw).unwrap();
    assert_eq!(tile.nodes.len(), 57);
}

#[tokio::test]
async fn absent_tile_is_204() {
    let (_dir, app) = app();
    let version = data_version(&app).await;
    let reply = get(&app, &format!("/api/v/{version}/tiles/9/17")).await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    assert!(reply.body.is_empty());
}

#[tokio::test]
async fn wrong_version_is_404_and_bad_numbers_are_400() {
    let (_dir, app) = app();
    let reply = get(&app, "/api/v/otl0-old/tiles/0/0").await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    assert!(reply.json()["error"].as_str().unwrap().contains("otl0-old"));

    let version = data_version(&app).await;
    let reply = get(&app, &format!("/api/v/{version}/tiles/x/0")).await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert!(reply.json()["error"].is_string());
}

#[tokio::test]
async fn search_ranks_and_shapes_results() {
    let (_dir, app) = app();
    let reply = get(&app, "/api/search?q=homo%20sap").await;
    assert_eq!(reply.status, StatusCode::OK);
    let hits = reply.json();
    let first = &hits[0];
    assert_eq!(first["nodeId"], "ott770315");
    assert_eq!(first["name"], "Homo sapiens");
    assert_eq!(first["matched"], "Homo sapiens");
    assert_eq!(first["matchedKind"], "scientific");
    assert_eq!(first["rank"], "species");
    // The 3 nearest named ancestors above genus, broadest first: the genus
    // Homo is skipped, "no rank" Primates counts.
    assert_eq!(
        first["lineage"],
        serde_json::json!(["Mammalia", "Primates", "Homininae"])
    );
    assert!(first["angle"].is_u64());
    assert_eq!(first["r"], 1.0);

    // An exact name beats longer names that start with it.
    let hits = get(&app, "/api/search?q=PAN").await.json();
    assert_eq!(hits[0]["name"], "Pan");
    assert!(hits.as_array().unwrap().len() >= 3);

    let hits = get(&app, "/api/search?q=urapteritra&limit=3").await.json();
    assert_eq!(hits.as_array().unwrap().len(), 3);
    assert_eq!(hits[0]["name"], "Urapteritra");

    // Two letters match whole words only: "pan" is a word, "pa" is not.
    let hits = get(&app, "/api/search?q=pa").await.json();
    assert_eq!(hits, serde_json::json!([]));

    // Too short, only quotes, or missing: empty, not an error.
    for uri in ["/api/search?q=h", "/api/search?q=%22%22", "/api/search"] {
        let reply = get(&app, uri).await;
        assert_eq!(reply.status, StatusCode::OK, "{uri}");
        assert_eq!(reply.json(), serde_json::json!([]), "{uri}");
    }
}

#[tokio::test]
async fn common_names_are_found_in_english_and_portuguese() {
    let (_dir, app) = app();

    // "human" is a common name of Homo sapiens and of the genus Homo; the
    // species, with more names in GBIF, comes first.
    let hits = get(&app, "/api/search?q=Human").await.json();
    let first = &hits[0];
    assert_eq!(first["nodeId"], "ott770315");
    assert_eq!(first["name"], "Homo sapiens");
    assert_eq!(first["matched"], "Human");
    assert_eq!(first["matchedKind"], "vernacular");
    assert_eq!(first["matchedLang"], "en");
    assert_eq!(first["commonName"], "Human");
    assert_eq!(hits[1]["name"], "Homo");

    // Portuguese, with and without the accent, and a hyphenated name typed
    // with a space.
    for q in ["pardal", "pardal-dom", "pardal%20dom", "carvalho"] {
        let hits = get(&app, &format!("/api/search?q={q}")).await.json();
        assert_eq!(hits[0]["matchedLang"], "pt", "{q}");
    }
    let hits = get(&app, "/api/search?q=pardal").await.json();
    assert_eq!(hits[0]["name"], "Passer domesticus");
    assert_eq!(hits[0]["matched"], "pardal");
    for q in ["chimpanz%C3%A9", "chimpanze"] {
        let hits = get(&app, &format!("/api/search?q={q}")).await.json();
        assert_eq!(hits[0]["name"], "Pan troglodytes", "{q}");
    }

    // A node found by several names is listed once, with its best match.
    let hits = get(&app, "/api/search?q=chimpanzee").await.json();
    let mut pan = 0;
    for hit in hits.as_array().unwrap() {
        if hit["name"] == "Pan troglodytes" {
            pan += 1;
        }
    }
    assert_eq!(pan, 1);
    assert_eq!(hits[0]["matched"], "Chimpanzee");

    // A scientific match still says it is one, and has no language.
    let hits = get(&app, "/api/search?q=passer").await.json();
    assert_eq!(hits[0]["matchedKind"], "scientific");
    assert_eq!(hits[0]["matchedLang"], serde_json::Value::Null);
    assert_eq!(hits[0]["commonName"], "House sparrow");
}

#[tokio::test]
async fn malformed_search_limit_is_a_json_400() {
    let (_dir, app) = app();
    for uri in [
        "/api/search?q=homo&limit=abc",
        "/api/search?q=homo&limit=-1",
    ] {
        let reply = get(&app, uri).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{uri}");
        assert_eq!(reply.header("content-type"), "application/json", "{uri}");
        assert!(
            reply.json()["error"].as_str().unwrap().contains("limit"),
            "{uri}"
        );
    }
}

#[tokio::test]
async fn node_by_id_ott_and_mrca() {
    let (_dir, app) = app();
    let by_ott = get(&app, "/api/nodes/ott770315").await.json();
    assert_eq!(by_ott["name"], "Homo sapiens");
    assert_eq!(by_ott["ids"]["ott"], 770315);
    assert_eq!(by_ott["flags"].as_u64().unwrap() & 0x08, 0x08, "home flag");
    assert_eq!(by_ott["namedAncestor"], Value::Null);

    let id = by_ott["id"].as_u64().unwrap();
    let by_id = get(&app, &format!("/api/nodes/{id}")).await.json();
    assert_eq!(by_id, by_ott);

    let reply = get(&app, "/api/nodes/mrcaott786ott3428").await;
    assert_eq!(reply.status, StatusCode::OK);
    let mrca = reply.json();
    assert_eq!(mrca["name"], Value::Null);
    assert_eq!(mrca["ids"]["ott"], Value::Null);
    assert_eq!(mrca["namedAncestor"]["name"], "Primates");
    // r is sent as the f32 the tiles hold, so it prints short.
    let text = String::from_utf8(reply.bytes()).unwrap();
    assert!(text.contains("\"r\":0.724,"), "{text}");
}

#[tokio::test]
async fn lineage_runs_root_to_parent() {
    let (_dir, app) = app();
    let node = get(&app, "/api/nodes/ott770315").await.json();
    let lineage = node["lineage"].as_array().unwrap();
    let names: Vec<&str> = lineage
        .iter()
        .map(|entry| entry["name"].as_str().unwrap_or("-"))
        .collect();
    assert_eq!(
        names,
        [
            "cellular organisms",
            "Eukaryota",
            "Opisthokonta",
            "Metazoa",
            "Chordata",
            "Mammalia",
            "Primates",
            "-",
            "Homininae",
            "Homo",
        ]
    );
    // Radii grow from the root (r0) outwards, and every entry has geometry.
    let mut last_r = 0.0;
    for entry in lineage {
        let r = entry["r"].as_f64().unwrap();
        assert!(r > last_r);
        last_r = r;
        assert!(entry["angle"].is_u64());
    }
    assert_eq!(lineage[0]["r"], 0.08);

    // The root has no lineage.
    let root = get(&app, "/api/nodes/0").await.json();
    assert_eq!(root["lineage"], serde_json::json!([]));
}

#[tokio::test]
async fn children_are_largest_first_with_total() {
    let (_dir, app) = app();
    let root = get(&app, "/api/nodes/0").await.json();
    assert_eq!(root["children"]["total"], 3);
    let leaf_counts: Vec<u64> = root["children"]["top"]
        .as_array()
        .unwrap()
        .iter()
        .map(|child| child["leafCount"].as_u64().unwrap())
        .collect();
    assert_eq!(leaf_counts, [25, 3, 2]);

    let genus = get(&app, "/api/nodes/ott530093").await.json();
    assert_eq!(genus["children"]["total"], 8);
    assert_eq!(genus["children"]["top"].as_array().unwrap().len(), 8);
}

#[tokio::test]
async fn unknown_or_malformed_node() {
    let (_dir, app) = app();
    for uri in [
        "/api/nodes/ott999999",
        "/api/nodes/mrcaott1ott2",
        "/api/nodes/4000000",
    ] {
        let reply = get(&app, uri).await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND, "{uri}");
        let error = reply.json()["error"].as_str().unwrap().to_string();
        assert!(error.starts_with("not found: node "), "{error}");
    }
    let reply = get(&app, "/api/nodes/felis").await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert!(reply.json()["error"].is_string());
}
