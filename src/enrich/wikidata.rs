//! Wikidata (PLAN §6.1 stage A): find the item for a taxon and read the few
//! statements we use.
//!
//! Two Action API calls: a search for items carrying the OTT id (property
//! P9157), or failing that the GBIF id (P846), then `wbgetentities` for
//! their statements and Wikipedia titles. Several items can carry one OTT id
//! (ott770315 has two), so we take the one whose taxon name (P225) equals
//! ours, else the first.
//!
//! Concepts introduced here:
//! - `HashMap<String, T>` as a serde target for JSON objects with dynamic keys
//! - `serde_json::Value` for the parts whose shape varies
//! - `#[serde(default)]` on a field: absent in the JSON means empty

use std::collections::HashMap;

use anyhow::bail;
use serde::Deserialize;

use super::{Enricher, Host, Report, WIKIDATA};

/// What we keep from one Wikidata item.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Item {
    /// "Q35694"
    pub qid: String,
    /// P225 taxon name.
    pub taxon_name: Option<String>,
    /// P18 image, a Commons file name without the `File:` prefix.
    pub image: Option<String>,
    /// P141 IUCN conservation status, as a code (see [`iucn_code`]).
    pub iucn: Option<&'static str>,
    /// P627 IUCN taxon id.
    pub iucn_id: Option<String>,
    /// P846 GBIF taxon key.
    pub gbif: Option<i64>,
    /// P3151 iNaturalist taxon id.
    pub inat_id: Option<String>,
    pub enwiki: Option<String>,
    pub ptwiki: Option<String>,
}

/// P141 values (IUCN Red List categories as Wikidata items) to codes.
///
/// Each QID was checked against its Wikidata label on 2026-10-28 (fixture
/// `tests/fixtures/enrich/wd_iucn_statuses.json`): least concern, near
/// threatened, vulnerable, endangered species, critically endangered,
/// extinct in the wild, extinct, Data Deficient.
pub fn iucn_code(qid: &str) -> Option<&'static str> {
    match qid {
        "Q211005" => Some("LC"),
        "Q719675" => Some("NT"),
        "Q278113" => Some("VU"),
        "Q11394" => Some("EN"),
        "Q219127" => Some("CR"),
        "Q239509" => Some("EW"),
        "Q237350" => Some("EX"),
        "Q3245245" => Some("DD"),
        _ => None,
    }
}

// The Action API answers errors with HTTP 200 and an `error` object (for
// example "cirrussearch-too-busy-error"), so every response type has one.
#[derive(Debug, Deserialize)]
struct ApiError {
    code: String,
}

#[derive(Debug, Deserialize)]
struct SearchResponse {
    query: Option<SearchQuery>,
    error: Option<ApiError>,
}

#[derive(Debug, Deserialize)]
struct SearchQuery {
    search: Vec<SearchHit>,
}

#[derive(Debug, Deserialize)]
struct SearchHit {
    title: String,
}

/// The QIDs of a `list=search` response, best match first.
pub fn parse_search(body: &str) -> anyhow::Result<Vec<String>> {
    let response: SearchResponse = serde_json::from_str(body)?;
    if let Some(error) = response.error {
        bail!("Wikidata error {}", error.code);
    }
    let Some(query) = response.query else {
        bail!("Wikidata search response without results");
    };
    let mut qids = Vec::new();
    for hit in query.search {
        if hit.title.starts_with('Q') {
            qids.push(hit.title);
        }
    }
    Ok(qids)
}

#[derive(Debug, Deserialize)]
struct EntitiesResponse {
    // LEARN: a JSON object whose keys are data ("Q35694": {…}) rather than
    // fixed field names maps onto a `HashMap<String, T>`. `#[serde(default)]`
    // makes a missing key an empty map instead of an error.
    #[serde(default)]
    entities: HashMap<String, Entity>,
    error: Option<ApiError>,
}

#[derive(Debug, Deserialize)]
struct Entity {
    #[serde(default)]
    claims: HashMap<String, Vec<Claim>>,
    #[serde(default)]
    sitelinks: HashMap<String, Sitelink>,
}

#[derive(Debug, Deserialize)]
struct Claim {
    mainsnak: Snak,
    /// "preferred", "normal" or "deprecated".
    #[serde(default)]
    rank: String,
}

#[derive(Debug, Deserialize)]
struct Snak {
    /// Absent for "unknown value" and "no value" statements.
    datavalue: Option<DataValue>,
}

#[derive(Debug, Deserialize)]
struct DataValue {
    // LEARN: `serde_json::Value` is "any JSON". A statement's value is a
    // string for some properties and an object (`{"id": "Q…"}`) for others,
    // so we keep it untyped and look inside where we know what to expect.
    value: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct Sitelink {
    title: String,
}

/// The best statement of `property`: a preferred one if any, else the first
/// normal one. Deprecated statements are never used.
fn best_value(claims: &HashMap<String, Vec<Claim>>, property: &str) -> Option<serde_json::Value> {
    let list = claims.get(property)?;
    let mut normal = None;
    for claim in list {
        let Some(data) = &claim.mainsnak.datavalue else {
            continue;
        };
        if claim.rank == "preferred" {
            return Some(data.value.clone());
        }
        if claim.rank != "deprecated" && normal.is_none() {
            normal = Some(data.value.clone());
        }
    }
    normal
}

/// A string-valued statement (P225, P18, P846, …).
fn string_value(claims: &HashMap<String, Vec<Claim>>, property: &str) -> Option<String> {
    let value = best_value(claims, property)?;
    value.as_str().map(|s| s.to_string())
}

/// An item-valued statement's QID (P141).
fn item_value(claims: &HashMap<String, Vec<Claim>>, property: &str) -> Option<String> {
    let value = best_value(claims, property)?;
    value["id"].as_str().map(|s| s.to_string())
}

fn item_from(qid: &str, entity: &Entity) -> Item {
    let claims = &entity.claims;
    let iucn_qid = item_value(claims, "P141");
    Item {
        qid: qid.to_string(),
        taxon_name: string_value(claims, "P225"),
        image: string_value(claims, "P18"),
        iucn: iucn_qid.as_deref().and_then(iucn_code),
        iucn_id: string_value(claims, "P627"),
        gbif: string_value(claims, "P846").and_then(|key| key.parse().ok()),
        inat_id: string_value(claims, "P3151"),
        enwiki: entity.sitelinks.get("enwiki").map(|s| s.title.clone()),
        ptwiki: entity.sitelinks.get("ptwiki").map(|s| s.title.clone()),
    }
}

/// The item among `qids` whose P225 is `name`, else the first one present.
pub fn parse_entities(body: &str, qids: &[String], name: &str) -> anyhow::Result<Option<Item>> {
    let response: EntitiesResponse = serde_json::from_str(body)?;
    if let Some(error) = response.error {
        bail!("Wikidata error {}", error.code);
    }
    // A HashMap has no order, so walk `qids` (the search order) instead.
    let mut first = None;
    for qid in qids {
        let Some(entity) = response.entities.get(qid) else {
            continue;
        };
        let item = item_from(qid, entity);
        if item.taxon_name.as_deref() == Some(name) {
            return Ok(Some(item));
        }
        if first.is_none() {
            first = Some(item);
        }
    }
    Ok(first)
}

/// QIDs of the items with `statement` ("haswbstatement:P9157=42322"), or
/// `None` if the search failed (recorded in `report`).
async fn search(e: &Enricher, report: &Report, statement: &str) -> Option<Vec<String>> {
    let query = [
        ("action", "query"),
        ("list", "search"),
        ("srsearch", statement),
        ("srlimit", "5"),
        ("format", "json"),
    ];
    let url = &e.endpoints.wikidata;
    let body = e
        .get_text(report, Host::Wikimedia, WIKIDATA, url, &query)
        .await?;
    match parse_search(&body) {
        Ok(qids) => Some(qids),
        Err(err) => {
            report.fail(WIKIDATA, format!("search {statement}: {err:#}"));
            None
        }
    }
}

/// The Wikidata item for a taxon: by OTT id, else by GBIF key. `None` when
/// there is none or Wikidata failed (then `report` says so).
pub async fn lookup(
    e: &Enricher,
    report: &Report,
    ott: Option<u32>,
    name: &str,
    gbif: Option<i64>,
) -> Option<Item> {
    let mut qids = Vec::new();
    if let Some(ott) = ott {
        qids = search(e, report, &format!("haswbstatement:P9157={ott}")).await?;
    }
    if qids.is_empty()
        && let Some(gbif) = gbif
    {
        qids = search(e, report, &format!("haswbstatement:P846={gbif}")).await?;
    }
    if qids.is_empty() {
        return None;
    }

    let ids = qids.join("|");
    let query = [
        ("action", "wbgetentities"),
        ("ids", ids.as_str()),
        ("props", "claims|sitelinks"),
        ("sitefilter", "enwiki|ptwiki"),
        ("format", "json"),
    ];
    let url = &e.endpoints.wikidata;
    let body = e
        .get_text(report, Host::Wikimedia, WIKIDATA, url, &query)
        .await?;
    match parse_entities(&body, &qids, name) {
        Ok(item) => item,
        Err(err) => {
            report.fail(WIKIDATA, format!("entities {ids}: {err:#}"));
            None
        }
    }
}
