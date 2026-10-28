//! Enrichment without the network (PLAN §9 P10, §10.3).
//!
//! - **Parse tests** read real upstream responses captured once on
//!   2026-10-28 into `tests/fixtures/enrich/` (the Wikidata entity files are
//!   trimmed to the properties we read; their structure is unchanged).
//! - **Mock-server tests** start a tiny axum server on a free local port
//!   that answers like Wikidata, Wikipedia, Commons, GBIF and iNaturalist
//!   from those fixtures, counts every request and records the User-Agent.
//!   The enricher's `Endpoints` point at it.

use std::net::SocketAddr;
use std::path::{Path as FsPath, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::{Request, State};
use axum::http::{StatusCode, header::USER_AGENT};
use axum::response::{IntoResponse, Response};
use reqwest::Url;
use serde_json::Value;
use species::config::{Endpoints, IngestArgs, user_agent};
use species::db::cache;
use species::enrich::{self, Ancestor, Enricher, Settings, Taxon, gbif, inat, wikidata, wikipedia};
use species::server::{AppState, router};
use tower::ServiceExt;

fn fixture_dir() -> PathBuf {
    FsPath::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn fixture(name: &str) -> String {
    let path = fixture_dir().join("enrich").join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

// ---- Parse tests on captured responses ----

#[test]
fn wikidata_search_lists_every_hit() {
    let qids = wikidata::parse_search(&fixture("wd_search_ott770315.json")).unwrap();
    assert_eq!(qids, ["Q15978631", "Q186266"]);
    assert!(
        wikidata::parse_search(&fixture("wd_search_none.json"))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn wikidata_busy_is_an_error_not_an_empty_result() {
    // Wikidata answers HTTP 200 with {"error": {"code": "cirrussearch-too-busy-error"}}.
    let err = wikidata::parse_search(&fixture("wd_search_busy.json")).unwrap_err();
    assert!(err.to_string().contains("too-busy"), "{err}");
}

#[test]
fn wikidata_picks_the_item_whose_taxon_name_matches() {
    let body = fixture("wd_entities_homo.json");
    // Search order puts Homo floresiensis first here; P225 must still win.
    let qids = ["Q186266".to_string(), "Q15978631".to_string()];
    let item = wikidata::parse_entities(&body, &qids, "Homo sapiens")
        .unwrap()
        .unwrap();
    assert_eq!(item.qid, "Q15978631");
    assert_eq!(item.image.as_deref(), Some("Human.svg"));
    assert_eq!(item.gbif, Some(2436436));
    assert_eq!(item.enwiki.as_deref(), Some("Homo sapiens"));
    // Without a name match, the first item in search order.
    let other = wikidata::parse_entities(&body, &qids, "Nobody")
        .unwrap()
        .unwrap();
    assert_eq!(other.qid, "Q186266");
}

#[test]
fn wikidata_statements_of_the_jaguar_and_the_coelacanth() {
    let onca = wikidata::parse_entities(
        &fixture("wd_entities_onca.json"),
        &["Q35694".to_string()],
        "Panthera onca",
    )
    .unwrap()
    .unwrap();
    assert_eq!(onca.iucn, Some("NT"));
    assert_eq!(onca.iucn_id.as_deref(), Some("15953"));
    assert_eq!(onca.enwiki.as_deref(), Some("Jaguar"));
    assert_eq!(onca.ptwiki.as_deref(), Some("Panthera onca"));
    assert!(onca.image.unwrap().starts_with("Onça-pintada"));

    let coelacanth = wikidata::parse_entities(
        &fixture("wd_entities_latimeria.json"),
        &["Q668921".to_string()],
        "Latimeria chalumnae",
    )
    .unwrap()
    .unwrap();
    assert_eq!(coelacanth.iucn, Some("CR"));
    assert_eq!(coelacanth.ptwiki, None);
}

#[test]
fn iucn_map_matches_the_live_labels() {
    // wbgetentities labels for the eight P141 values, captured live.
    let body: Value = serde_json::from_str(&fixture("wd_iucn_statuses.json")).unwrap();
    let expected = [
        ("least concern", "LC"),
        ("near threatened", "NT"),
        ("vulnerable", "VU"),
        ("endangered species", "EN"),
        ("critically endangered", "CR"),
        ("extinct in the wild", "EW"),
        ("extinct", "EX"),
        ("Data Deficient", "DD"),
    ];
    let entities = body["entities"].as_object().unwrap();
    assert_eq!(entities.len(), expected.len());
    for (qid, entity) in entities {
        let label = entity["labels"]["en"]["value"].as_str().unwrap();
        let code = expected.iter().find(|(l, _)| *l == label).unwrap().1;
        assert_eq!(wikidata::iucn_code(qid), Some(code), "{qid} {label}");
    }
}

#[test]
fn wikipedia_summary() {
    let summary = wikipedia::parse_summary(&fixture("wp_summary_jaguar.json"))
        .unwrap()
        .unwrap();
    assert_eq!(summary.title, "Jaguar");
    assert_eq!(summary.url, "https://en.wikipedia.org/wiki/Jaguar");
    assert_eq!(
        summary.description.as_deref(),
        Some("Large cat native to the Americas")
    );
    assert!(summary.text.starts_with("The jaguar is a large cat"));
    assert_eq!(summary.license, "CC BY-SA 4.0");
    // The 404 body is not a summary.
    assert!(
        wikipedia::parse_summary(&fixture("wp_summary_missing.json"))
            .unwrap()
            .is_none()
    );
}

#[test]
fn commons_licence_and_plain_text_artist() {
    let image = wikipedia::parse_commons(&fixture("commons_onca.json"))
        .unwrap()
        .unwrap();
    assert_eq!(image.credit.as_deref(), Some("Thiagomarcelcampi"));
    assert_eq!(image.license, "CC BY-SA 4.0");
    assert_eq!(
        image.license_url.as_deref(),
        Some("https://creativecommons.org/licenses/by-sa/4.0")
    );
    assert_eq!(image.width, Some(640));
    assert!(!image.url.contains("utm_source"), "{}", image.url);
    assert!(
        image
            .page_url
            .starts_with("https://commons.wikimedia.org/wiki/File:")
    );

    let flickr = wikipedia::parse_commons(&fixture("commons_latimeria.json"))
        .unwrap()
        .unwrap();
    assert_eq!(flickr.credit.as_deref(), Some("sybarite48"));
    let public_domain = wikipedia::parse_commons(&fixture("commons_human_svg.json"))
        .unwrap()
        .unwrap();
    assert_eq!(public_domain.license, "Public domain");
    assert_eq!(public_domain.license_url, None);
    assert!(
        wikipedia::parse_commons(&fixture("commons_missing.json"))
            .unwrap()
            .is_none()
    );
}

#[test]
fn gbif_species_occurrences_and_map_extent() {
    let onca = gbif::parse_species(&fixture("gbif_species_5219426.json")).unwrap();
    assert_eq!(onca.authorship.as_deref(), Some("(Linnaeus, 1758)"));
    assert_eq!(onca.vernacular.as_deref(), Some("jaguar"));
    let coelacanth = gbif::parse_species(&fixture("gbif_species_2441273.json")).unwrap();
    // `publishedIn` arrives with <em> tags.
    assert_eq!(
        coelacanth.published_in.as_deref(),
        Some(
            "Smith, J. L. B. (1939). A living fish of Mesozoic type. Nature (London). v. 143 (no. 3620): 455-456."
        )
    );

    let occ = gbif::parse_occurrences(&fixture("gbif_occ_5219426.json")).unwrap();
    assert_eq!(occ.total, 146_418);
    assert_eq!(occ.country_total, 32);
    assert_eq!(occ.countries[0], ("BR".to_string(), 97_224));
    // max(3, 0.1% of 146,418) = 147: every listed country clears it.
    assert!(occ.countries.iter().all(|(_, n)| *n >= 147));
    assert!(occ.countries.len() < occ.country_total);

    let extent = gbif::parse_capabilities(&fixture("gbif_map_caps_5219426.json")).unwrap();
    assert_eq!(extent.bbox, Some([-123.0, -53.0, 19.0, 51.0]));
}

#[test]
fn gbif_iucn_fallback() {
    let onca = gbif::parse_match_iucn(&fixture("gbif_match_onca.json")).unwrap();
    assert_eq!(onca, Some("NT"));
    let homo = gbif::parse_match_iucn(&fixture("gbif_match_homo.json")).unwrap();
    assert_eq!(homo, None);
}

#[test]
fn inat_licence_filter_drops_all_rights_reserved() {
    // The jaguar's default photo has license_code null ("all rights
    // reserved"); the CC BY-SA photo next to it is *Panthera atrox*, which
    // the exact name match must not take either.
    let onca = inat::parse_taxa(&fixture("inat_taxa_panthera_onca.json"), "Panthera onca")
        .unwrap()
        .unwrap();
    assert_eq!(onca.image, None);

    let beetle = inat::parse_taxa(
        &fixture("inat_taxa_pselaphus_heisei.json"),
        "Pselaphus heisei",
    )
    .unwrap()
    .unwrap();
    let image = beetle.image.unwrap();
    assert_eq!(image.license, "CC BY-NC");
    assert_eq!(image.credit.as_deref(), Some("Olli Pihlajamaa"));
    assert_eq!(image.source, "iNaturalist");
}

// ---- A mock of every upstream service ----

#[derive(Default)]
struct Mock {
    hits: AtomicUsize,
    agents: Mutex<Vec<String>>,
    /// Requests whose path starts with this prefix answer only after `delay`.
    slow_prefix: Option<&'static str>,
    delay: Duration,
}

impl Mock {
    fn hits(&self) -> usize {
        self.hits.load(Ordering::SeqCst)
    }
}

fn json(name: &str) -> Response {
    (
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        fixture(name),
    )
        .into_response()
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "{}").into_response()
}

/// Picks the fixture an upstream would answer `path?query` with.
fn answer(path: &str, params: &[(String, String)]) -> Response {
    let param = |key: &str| -> String {
        for (k, v) in params {
            if k == key {
                return v.clone();
            }
        }
        String::new()
    };
    if path == "/wikidata" {
        if param("list") == "search" {
            return match param("srsearch").as_str() {
                "haswbstatement:P9157=770315" => json("wd_search_ott770315.json"),
                "haswbstatement:P9157=42322" => json("wd_search_ott42322.json"),
                "haswbstatement:P9157=3349025" => json("wd_search_ott3349025.json"),
                "haswbstatement:P9157=3349021" => json("wd_search_ott3349021.json"),
                _ => json("wd_search_none.json"),
            };
        }
        return match param("ids").as_str() {
            "Q15978631|Q186266" => json("wd_entities_homo.json"),
            "Q35694" => json("wd_entities_onca.json"),
            "Q14896534" => json("wd_entities_pselaphus_heisei.json"),
            "Q4047512" => json("wd_entities_pselaphus.json"),
            _ => not_found(),
        };
    }
    if let Some(title) = path.strip_prefix("/wikipedia/page/summary/") {
        return match title {
            "Homo_sapiens" => json("wp_summary_homo_sapiens.json"),
            "Jaguar" => json("wp_summary_jaguar.json"),
            "Pselaphus" => json("wp_summary_pselaphus.json"),
            _ => not_found(),
        };
    }
    if path == "/commons" {
        return match param("titles").as_str() {
            "File:Human.svg" => json("commons_human_svg.json"),
            "File:Pselaphus heisei Jacobson.png" => json("commons_pselaphus.json"),
            "File:Onça-pintada-PE Encontro das Águas-Thiagomarcelcampi(001).jpg" => {
                json("commons_onca.json")
            }
            _ => json("commons_missing.json"),
        };
    }
    if let Some(key) = path.strip_prefix("/gbif/v1/species/") {
        return match key {
            "2436436" | "5219426" | "4440809" => json(&format!("gbif_species_{key}.json")),
            _ => not_found(),
        };
    }
    if path == "/gbif/v1/occurrence/search" {
        return match param("taxonKey").as_str() {
            "2436436" => json("gbif_occ_2436436.json"),
            "5219426" => json("gbif_occ_5219426.json"),
            "4440809" => json("gbif_occ_4440809.json"),
            _ => not_found(),
        };
    }
    if path == "/gbif/v2/map/occurrence/density/capabilities.json" {
        return match param("taxonKey").as_str() {
            "2436436" => json("gbif_map_caps_2436436.json"),
            "5219426" => json("gbif_map_caps_5219426.json"),
            "4440809" => json("gbif_map_caps_4440809.json"),
            _ => not_found(),
        };
    }
    if path == "/gbif/v2/species/match" {
        return match param("scientificName").as_str() {
            "Homo sapiens" => json("gbif_match_homo.json"),
            "Panthera onca" => json("gbif_match_onca.json"),
            _ => json("gbif_match_pselaphus_heisei.json"),
        };
    }
    if path == "/inat/taxa" {
        return match param("q").as_str() {
            "Panthera onca" => json("inat_taxa_panthera_onca.json"),
            "Pselaphus heisei" => json("inat_taxa_pselaphus_heisei.json"),
            _ => (StatusCode::OK, r#"{"results":[]}"#).into_response(),
        };
    }
    not_found()
}

async fn mock_handler(State(mock): State<Arc<Mock>>, request: Request) -> Response {
    mock.hits.fetch_add(1, Ordering::SeqCst);
    if let Some(agent) = request.headers().get(USER_AGENT) {
        let agent = agent.to_str().unwrap_or("").to_string();
        mock.agents.lock().unwrap().push(agent);
    }
    let uri = request.uri().to_string();
    let url = Url::parse(&format!("http://mock{uri}")).unwrap();
    let path = url.path().to_string();
    let mut params = Vec::new();
    for (k, v) in url.query_pairs() {
        params.push((k.into_owned(), v.into_owned()));
    }
    if let Some(prefix) = mock.slow_prefix
        && path.starts_with(prefix)
    {
        tokio::time::sleep(mock.delay).await;
    }
    answer(&path, &params)
}

/// Starts the mock on a free port; returns its base URL.
async fn start_mock(mock: Arc<Mock>) -> String {
    let app = Router::new().fallback(mock_handler).with_state(mock);
    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{addr}")
}

fn enricher(base: &str, timeout: Duration) -> Enricher {
    Enricher::new(Settings {
        endpoints: Endpoints::under(base),
        user_agent: user_agent(Some("https://circle.example"), Some("test-contact")),
        timeout,
        slow_timeout: timeout,
        inat_gap: Duration::from_millis(10),
    })
    .unwrap()
}

fn ancestor(name: &str, rank: &str, ott: u32) -> Ancestor {
    Ancestor {
        node_id: format!("ott{ott}"),
        ott: Some(ott),
        name: name.to_string(),
        rank: Some(rank.to_string()),
        cached_summary: None,
    }
}

fn beetle() -> Taxon {
    Taxon {
        node_id: "ott3349025".to_string(),
        ott: Some(3349025),
        name: "Pselaphus heisei".to_string(),
        rank: Some("species".to_string()),
        gbif: Some(4440809),
        leaf_count: 1,
        ancestors: vec![
            ancestor("Pselaphus", "genus", 3349021),
            ancestor("Staphylinidae", "family", 1),
        ],
    }
}

fn jaguar() -> Taxon {
    Taxon {
        node_id: "ott42322".to_string(),
        ott: Some(42322),
        name: "Panthera onca".to_string(),
        rank: Some("species".to_string()),
        gbif: Some(5219426),
        leaf_count: 1,
        ancestors: vec![
            ancestor("Panthera", "genus", 563154),
            ancestor("Felidae", "family", 563159),
        ],
    }
}

#[tokio::test]
async fn jaguar_document_from_every_source() {
    let mock = Arc::new(Mock::default());
    let base = start_mock(Arc::clone(&mock)).await;
    let doc = enricher(&base, Duration::from_secs(4))
        .about(&jaguar(), 1)
        .await;
    assert!(doc.complete, "{:?}", doc.failed);
    assert_eq!(doc.summary.as_ref().unwrap().title, "Jaguar");
    assert_eq!(doc.summary.as_ref().unwrap().about, None);
    assert_eq!(doc.common_names, ["jaguar"]);
    let image = doc.image.unwrap();
    assert_eq!(image.source, "Wikimedia Commons");
    assert_eq!(image.license, "CC BY-SA 4.0");
    let status = doc.status.unwrap();
    assert_eq!(
        (status.code.as_str(), status.source.as_str()),
        ("NT", "Wikidata")
    );
    let dist = doc.distribution.unwrap();
    assert_eq!(dist.occurrences, 146_418);
    assert_eq!(dist.bbox, Some([-123.0, -53.0, 19.0, 51.0]));
    assert_eq!(
        doc.links.wikidata.as_deref(),
        Some("https://www.wikidata.org/wiki/Q35694")
    );
    assert_eq!(
        doc.links.wikipedia.as_deref(),
        Some("https://en.wikipedia.org/wiki/Jaguar")
    );
    assert_eq!(
        doc.links.iucn.as_deref(),
        Some("https://www.iucnredlist.org/details/15953/0")
    );
    assert_eq!(
        doc.taxonomy.unwrap().authorship.as_deref(),
        Some("(Linnaeus, 1758)")
    );
}

#[tokio::test]
async fn obscure_beetle_gets_generated_sentence_and_labelled_ancestor_article() {
    let mock = Arc::new(Mock::default());
    let base = start_mock(Arc::clone(&mock)).await;
    let doc = enricher(&base, Duration::from_secs(4))
        .about(&beetle(), 1)
        .await;
    assert!(doc.complete, "{:?}", doc.failed);
    assert_eq!(
        doc.generated,
        "Pselaphus heisei Herbst, 1791 is a species in the family Staphylinidae. \
         GBIF has 1,881 occurrence records of it from 24 countries."
    );
    let summary = doc.summary.unwrap();
    let about = summary.about.unwrap();
    assert_eq!(
        (about.name.as_str(), about.rank.as_deref()),
        ("Pselaphus", Some("genus"))
    );
    assert!(
        summary
            .text
            .starts_with("Pselaphus is a genus of ant-loving beetles")
    );
    // The borrowed article is not the beetle's own Wikipedia link.
    assert_eq!(doc.links.wikipedia, None);
    // Wikidata has a public-domain plate of the beetle itself.
    assert_eq!(doc.image.unwrap().license, "Public domain");
}

#[tokio::test]
async fn ancestor_article_from_cache_costs_no_lookup() {
    let mock = Arc::new(Mock::default());
    let base = start_mock(Arc::clone(&mock)).await;
    let e = enricher(&base, Duration::from_secs(4));
    let mut taxon = beetle();
    let genus = wikipedia::parse_summary(&fixture("wp_summary_pselaphus.json"))
        .unwrap()
        .unwrap();
    taxon.ancestors[0].cached_summary = Some(genus);
    let with_cache = e.about(&taxon, 1).await;
    let hits_cached = mock.hits();
    assert_eq!(with_cache.summary.unwrap().about.unwrap().name, "Pselaphus");
    let without = e.about(&beetle(), 1).await;
    assert!(without.summary.is_some());
    // The uncached run needs the genus' Wikidata search, entities and summary.
    assert_eq!(mock.hits() - hits_cached, hits_cached + 3);
}

#[tokio::test]
async fn timeout_gives_a_partial_document() {
    let mock = Arc::new(Mock {
        slow_prefix: Some("/gbif"),
        delay: Duration::from_millis(1500),
        ..Mock::default()
    });
    let base = start_mock(Arc::clone(&mock)).await;
    let doc = enricher(&base, Duration::from_millis(300))
        .about(&jaguar(), 1)
        .await;
    assert!(!doc.complete);
    assert_eq!(doc.failed, ["GBIF"]);
    // Everything else still arrived.
    assert_eq!(doc.summary.unwrap().title, "Jaguar");
    assert!(doc.image.is_some());
    assert_eq!(doc.status.unwrap().code, "NT");
    assert_eq!(doc.distribution, None);
    assert_eq!(doc.taxonomy, None);
    assert!(
        doc.generated
            .starts_with("Panthera onca is a species in the family Felidae.")
    );
}

#[tokio::test]
async fn user_agent_carries_the_contact() {
    let mock = Arc::new(Mock::default());
    let base = start_mock(Arc::clone(&mock)).await;
    enricher(&base, Duration::from_secs(4))
        .about(&jaguar(), 1)
        .await;
    let agents = mock.agents.lock().unwrap().clone();
    assert!(!agents.is_empty());
    for agent in agents {
        assert!(agent.starts_with("species-circle/"), "{agent}");
        assert!(agent.contains("test-contact"), "{agent}");
        assert!(agent.contains("+https://circle.example"), "{agent}");
    }
}

// ---- Through the router, with cache.db ----

/// The mini tree (it has Homo sapiens, ott770315), a cache.db file and an
/// enricher pointed at `base`.
fn app(base: &str, timeout: Duration) -> (tempfile::TempDir, Router) {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("mini.db");
    let args = IngestArgs {
        tree: fixture_dir().join("mini.tre"),
        taxonomy: fixture_dir().join("mini_taxonomy.tsv"),
        vernacular: None,
        langs: "en,pt".to_string(),
        out: out.clone(),
        dry_run: false,
    };
    species::ingest::run(&args).unwrap();
    let cache_conn = cache::open(&dir.path().join("cache.db")).unwrap();
    let state = AppState::open(&out)
        .unwrap()
        .with_enrichment(cache_conn, enricher(base, timeout));
    let app = router(state, dir.path());
    (dir, app)
}

async fn get_json(app: &Router, uri: &str) -> (StatusCode, String, Value) {
    let request = axum::http::Request::get(uri).body(Body::empty()).unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let cache_control = response
        .headers()
        .get(axum::http::header::CACHE_CONTROL)
        .map(|v| v.to_str().unwrap().to_string())
        .unwrap_or_default();
    let body = to_bytes(response.into_body(), 1 << 22).await.unwrap();
    (
        status,
        cache_control,
        serde_json::from_slice(&body).unwrap(),
    )
}

#[tokio::test]
async fn cache_hit_makes_zero_upstream_calls() {
    let mock = Arc::new(Mock::default());
    let base = start_mock(Arc::clone(&mock)).await;
    let (_dir, app) = app(&base, Duration::from_secs(4));

    let (status, cache_control, first) = get_json(&app, "/api/nodes/ott770315/about").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cache_control, "public, max-age=86400");
    assert_eq!(first["complete"], true);
    assert_eq!(first["summary"]["title"], "Human");
    assert_eq!(first["image"]["license"], "Public domain");
    let after_miss = mock.hits();
    assert!(after_miss > 0);

    assert_eq!(first["nodeId"], "ott770315");
    let (_, _, second) = get_json(&app, "/api/nodes/ott770315/about").await;
    assert_eq!(
        mock.hits(),
        after_miss,
        "a cache hit must not call upstream"
    );
    assert_eq!(second, first);
    // `retry` only refetches partial documents.
    get_json(&app, "/api/nodes/ott770315/about?retry=1").await;
    assert_eq!(mock.hits(), after_miss);
}

#[tokio::test]
async fn timeout_is_stored_as_partial_and_retry_refetches() {
    let mock = Arc::new(Mock {
        slow_prefix: Some("/wikipedia"),
        delay: Duration::from_millis(1500),
        ..Mock::default()
    });
    let base = start_mock(Arc::clone(&mock)).await;
    let (dir, app) = app(&base, Duration::from_millis(300));

    let (_, cache_control, doc) = get_json(&app, "/api/nodes/ott770315/about").await;
    assert_eq!(doc["complete"], false);
    assert_eq!(doc["failed"], serde_json::json!(["Wikipedia"]));
    assert_eq!(doc["summary"], Value::Null);
    assert_eq!(doc["image"]["license"], "Public domain");
    assert_eq!(cache_control, "no-store");

    // The row in cache.db says complete = 0.
    let conn = cache::open(&dir.path().join("cache.db")).unwrap();
    let row = cache::get(&conn, "ott770315").unwrap().unwrap();
    assert!(!row.complete);

    // A plain request is served from cache; `retry=1` asks upstream again.
    let hits = mock.hits();
    get_json(&app, "/api/nodes/ott770315/about").await;
    assert_eq!(mock.hits(), hits);
    get_json(&app, "/api/nodes/ott770315/about?retry=1").await;
    assert!(mock.hits() > hits);
}

#[tokio::test]
async fn unnamed_clades_are_never_enriched() {
    let mock = Arc::new(Mock::default());
    let base = start_mock(Arc::clone(&mock)).await;
    let (_dir, app) = app(&base, Duration::from_secs(4));
    let (status, _, doc) = get_json(&app, "/api/nodes/mrcaott786ott3428/about").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(mock.hits(), 0);
    assert_eq!(doc["complete"], true);
    let generated = doc["generated"].as_str().unwrap();
    assert!(
        generated.starts_with("An unnamed clade within "),
        "{generated}"
    );
    let (status, _, _) = get_json(&app, "/api/nodes/ott999999999/about").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[test]
fn minimal_document_shape_matches_the_full_one() {
    // The client reads both with one type: same keys either way.
    let minimal = serde_json::to_value(enrich::minimal("mrcaott1ott2", None, 3, 0)).unwrap();
    let full = serde_json::to_value(enrich::About::default()).unwrap();
    let keys = |v: &Value| -> Vec<String> { v.as_object().unwrap().keys().cloned().collect() };
    assert_eq!(keys(&minimal), keys(&full));
}
