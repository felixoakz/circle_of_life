//! GBIF (PLAN §6.1): the species record (authorship, where it was published,
//! a common name), occurrence counts per country, the extent of the density
//! map, and, when Wikidata has no conservation status, the IUCN category
//! from GBIF's name matcher. All GBIF data is CC BY 4.0.
//!
//! Concepts introduced here:
//! - `#[serde(rename_all = "camelCase")]` on the *input* side
//! - `f64::ceil` and converting between integers and floats with `as`

use serde::Deserialize;

use super::{Enricher, GBIF, Host, Report, known_iucn_code, strip_html};

/// What the species record gives us.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SpeciesInfo {
    pub authorship: Option<String>,
    pub published_in: Option<String>,
    pub vernacular: Option<String>,
    /// Lowercase, as OTT writes ranks: "species".
    pub rank: Option<String>,
    /// The family in GBIF's classification, for the generated sentence.
    pub family: Option<String>,
}

// LEARN: `rename_all = "camelCase"` works for reading too: the Rust field
// `published_in` reads the JSON key `publishedIn`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpeciesResponse {
    authorship: Option<String>,
    published_in: Option<String>,
    vernacular_name: Option<String>,
    rank: Option<String>,
    family: Option<String>,
}

fn non_empty(text: Option<String>) -> Option<String> {
    let text = text?;
    let text = strip_html(&text);
    if text.is_empty() { None } else { Some(text) }
}

pub fn parse_species(body: &str) -> anyhow::Result<SpeciesInfo> {
    let response: SpeciesResponse = serde_json::from_str(body)?;
    Ok(SpeciesInfo {
        authorship: non_empty(response.authorship),
        published_in: non_empty(response.published_in),
        vernacular: non_empty(response.vernacular_name),
        rank: non_empty(response.rank).map(|r| r.to_lowercase()),
        family: non_empty(response.family),
    })
}

/// Occurrence records and where they are.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Occurrences {
    pub total: u64,
    /// ISO 3166 alpha-2 code and count, above the noise threshold, most first.
    pub countries: Vec<(String, u64)>,
    /// Countries with any record at all.
    pub country_total: usize,
}

#[derive(Debug, Deserialize)]
struct OccurrenceResponse {
    count: u64,
    #[serde(default)]
    facets: Vec<Facet>,
}

#[derive(Debug, Deserialize)]
struct Facet {
    counts: Vec<FacetCount>,
}

#[derive(Debug, Deserialize)]
struct FacetCount {
    name: String,
    count: u64,
}

/// A country is listed only with at least `max(3, 0.1% of all records)`
/// records: a handful of museum specimens or mislabelled points should not
/// put a jaguar in Germany (PLAN §6.1).
pub fn country_threshold(total: u64) -> u64 {
    // LEARN: `as` converts between number types. u64 → f64 may round for
    // values above 2^53, which occurrence counts never reach; `ceil()` then
    // rounds up, and f64 → u64 drops the (zero) fraction.
    let per_mille = (total as f64 * 0.001).ceil() as u64;
    per_mille.max(3)
}

pub fn parse_occurrences(body: &str) -> anyhow::Result<Occurrences> {
    let response: OccurrenceResponse = serde_json::from_str(body)?;
    let threshold = country_threshold(response.count);
    let mut countries = Vec::new();
    let mut country_total = 0;
    if let Some(facet) = response.facets.into_iter().next() {
        for entry in facet.counts {
            if entry.count == 0 {
                continue;
            }
            country_total += 1;
            if entry.count >= threshold {
                countries.push((entry.name, entry.count));
            }
        }
    }
    // GBIF already sorts by count; sorting again makes that a guarantee.
    countries.sort_by_key(|entry| std::cmp::Reverse(entry.1));
    Ok(Occurrences {
        total: response.count,
        countries,
        country_total,
    })
}

/// Where the density map has data.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Extent {
    pub total: u64,
    /// `[minLng, minLat, maxLng, maxLat]`, `None` when there is no data.
    pub bbox: Option<[f64; 4]>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Capabilities {
    min_lat: Option<f64>,
    max_lat: Option<f64>,
    min_lng: Option<f64>,
    max_lng: Option<f64>,
    #[serde(default)]
    total: u64,
}

/// The density map's `capabilities.json`.
pub fn parse_capabilities(body: &str) -> anyhow::Result<Extent> {
    let caps: Capabilities = serde_json::from_str(body)?;
    let mut bbox = None;
    if caps.total > 0
        && let (Some(min_lng), Some(min_lat), Some(max_lng), Some(max_lat)) =
            (caps.min_lng, caps.min_lat, caps.max_lng, caps.max_lat)
    {
        bbox = Some([min_lng, min_lat, max_lng, max_lat]);
    }
    Ok(Extent {
        total: caps.total,
        bbox,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MatchResponse {
    #[serde(default)]
    additional_status: Vec<AdditionalStatus>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdditionalStatus {
    dataset_alias: Option<String>,
    status_code: Option<String>,
}

/// The IUCN category from GBIF's v2 name match, if it has one we show.
pub fn parse_match_iucn(body: &str) -> anyhow::Result<Option<&'static str>> {
    let response: MatchResponse = serde_json::from_str(body)?;
    for status in response.additional_status {
        if status.dataset_alias.as_deref() == Some("IUCN")
            && let Some(code) = status.status_code.as_deref()
        {
            return Ok(known_iucn_code(code));
        }
    }
    Ok(None)
}

/// `GET /v1/species/{key}`.
pub async fn species(e: &Enricher, report: &Report, key: Option<i64>) -> Option<SpeciesInfo> {
    let key = key?;
    let url = format!("{}/v1/species/{key}", e.endpoints.gbif);
    let body = e.get_text(report, Host::Gbif, GBIF, &url, &[]).await?;
    match parse_species(&body) {
        Ok(info) => Some(info),
        Err(err) => {
            report.fail(GBIF, format!("species {key}: {err:#}"));
            None
        }
    }
}

/// `GET /v1/occurrence/search`, counts only (`limit=0`) with a country facet.
pub async fn occurrences(e: &Enricher, report: &Report, key: Option<i64>) -> Option<Occurrences> {
    let key = key?.to_string();
    let url = format!("{}/v1/occurrence/search", e.endpoints.gbif);
    let query = [
        ("taxonKey", key.as_str()),
        ("limit", "0"),
        ("facet", "country"),
        ("facetLimit", "300"),
        ("hasGeospatialIssue", "false"),
        ("occurrenceStatus", "PRESENT"),
    ];
    let body = e
        .get_text_slow(report, Host::Gbif, GBIF, &url, &query)
        .await?;
    match parse_occurrences(&body) {
        Ok(occ) => Some(occ),
        Err(err) => {
            report.fail(GBIF, format!("occurrences {key}: {err:#}"));
            None
        }
    }
}

/// The density map's extent (`/v2/map/occurrence/density/capabilities.json`).
/// The browser loads the map tiles itself, straight from GBIF.
pub async fn extent(e: &Enricher, report: &Report, key: Option<i64>) -> Option<Extent> {
    let key = key?.to_string();
    let url = format!(
        "{}/v2/map/occurrence/density/capabilities.json",
        e.endpoints.gbif
    );
    let query = [("taxonKey", key.as_str())];
    let body = e.get_text(report, Host::Gbif, GBIF, &url, &query).await?;
    match parse_capabilities(&body) {
        Ok(extent) => Some(extent),
        Err(err) => {
            report.fail(GBIF, format!("map extent {key}: {err:#}"));
            None
        }
    }
}

/// The IUCN category via `GET /v2/species/match?scientificName=…`.
pub async fn iucn_status(
    e: &Enricher,
    report: &Report,
    name: Option<&str>,
) -> Option<&'static str> {
    let name = name?;
    let url = format!("{}/v2/species/match", e.endpoints.gbif);
    let query = [("scientificName", name)];
    let body = e.get_text(report, Host::Gbif, GBIF, &url, &query).await?;
    match parse_match_iucn(&body) {
        Ok(code) => code,
        Err(err) => {
            report.fail(GBIF, format!("match {name}: {err:#}"));
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn threshold_is_three_or_one_per_mille() {
        assert_eq!(country_threshold(0), 3);
        assert_eq!(country_threshold(2_000), 3);
        assert_eq!(country_threshold(146_418), 147);
    }
}
