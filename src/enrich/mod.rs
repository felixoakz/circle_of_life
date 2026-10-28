//! Lazy enrichment (PLAN §6): when someone opens a node's panel, fetch what
//! Wikidata, Wikipedia, Wikimedia Commons, GBIF and iNaturalist know about
//! it, and assemble one attributed `/about` document. The server caches the
//! document in `cache.db` (`server::about`); this module only fetches.
//!
//! The flow, per node:
//! - **Stage A**, in parallel: the Wikidata item (by OTT id, else by GBIF
//!   id), GBIF species, GBIF occurrence counts and the GBIF map extent.
//! - **Stage B**, in parallel, using stage A: the Wikipedia summary, the
//!   Commons image licence, an iNaturalist photo if Wikidata has no image,
//!   and the IUCN status from GBIF if Wikidata has none.
//! - **Fallbacks:** with no Wikipedia article, the nearest genus, family or
//!   order that has one (clearly labelled), plus a sentence generated from
//!   the structured data, which is always present.
//!
//! A source that fails or times out leaves its part empty and is listed in
//! `failed`; the document is then `complete: false` and cached for a day
//! only. Nothing here returns an error to the client.
//!
//! Concepts introduced here:
//! - `reqwest`: one shared HTTP `Client` with timeouts and a User-Agent
//! - `tokio::join!`: run several futures at once and wait for all of them
//! - `tokio::sync::Semaphore`: at most N at a time
//! - `tokio::sync::Mutex` vs `std::sync::Mutex`: which one may be held
//!   across an `.await`
//! - `#[derive(Deserialize)]` for reading upstream JSON, and `Serialize`
//!   for writing ours
//! - `char` iteration and a tiny state machine (`strip_html`)

pub mod gbif;
pub mod inat;
pub mod wikidata;
pub mod wikipedia;

use std::collections::HashSet;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;

use crate::config::Endpoints;

/// The synthesis release, for Open Tree links.
pub const SYNTH: &str = "opentree16.1";

/// Each upstream request gets this long, start to finish (PLAN §6.1).
pub const TIMEOUT: Duration = Duration::from_secs(4);

/// Except GBIF's faceted occurrence search: on a query GBIF has not cached
/// it took 5 to 20 s in October 2026 (then under a second once cached), so
/// a 4 s limit failed nearly every first lookup. It runs in parallel with
/// everything else, so this only lengthens a cold miss.
pub const SLOW_TIMEOUT: Duration = Duration::from_secs(10);

/// iNaturalist asks for at most one request per second.
pub const INAT_GAP: Duration = Duration::from_secs(1);

/// Source names, as shown to people in "Couldn't reach …".
pub const WIKIDATA: &str = "Wikidata";
pub const WIKIPEDIA: &str = "Wikipedia";
pub const COMMONS: &str = "Wikimedia Commons";
pub const GBIF: &str = "GBIF";
pub const INAT: &str = "iNaturalist";

/// The text licence of every Wikipedia extract.
pub const WIKIPEDIA_LICENSE: &str = "CC BY-SA 4.0";

// ---- The `/about` document (PLAN §6.3) ----

// The document is written to the client *and* read back from cache.db, so
// every type derives both `Serialize` and `Deserialize`.
/// The body of `GET /api/nodes/{ref}/about`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct About {
    pub node_id: String,
    pub taxonomy: Option<Taxonomy>,
    /// English common names, best first (GBIF, then the Wikipedia title).
    pub common_names: Vec<String>,
    pub summary: Option<Summary>,
    pub image: Option<Image>,
    pub status: Option<Status>,
    pub distribution: Option<Distribution>,
    /// Always present; the panel shows it when there is no summary.
    pub generated: String,
    pub links: Links,
    /// Sources that failed or timed out (empty when `complete`).
    pub failed: Vec<String>,
    pub complete: bool,
    pub fetched_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Taxonomy {
    /// "Linnaeus, 1758"
    pub authorship: Option<String>,
    pub published_in: Option<String>,
    pub source: String,
}

/// Which node a borrowed text or image is really about.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AboutRef {
    pub node_id: String,
    pub name: String,
    pub rank: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub text: String,
    /// Wikipedia's short description, "Large cat native to the Americas".
    pub description: Option<String>,
    /// The article title, "Jaguar".
    pub title: String,
    pub url: String,
    pub license: String,
    /// Set when the article is an ancestor's (the node has none).
    pub about: Option<AboutRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Image {
    pub url: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// The author as plain text; `None` if the source names nobody.
    pub credit: Option<String>,
    /// Never empty: an image without a known licence is not used at all.
    pub license: String,
    pub license_url: Option<String>,
    /// "Wikimedia Commons" or "iNaturalist".
    pub source: String,
    /// The file or photo page, where the full attribution lives.
    pub page_url: String,
    pub about: Option<AboutRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// IUCN Red List category code: LC, NT, VU, EN, CR, EW, EX or DD.
    pub code: String,
    /// "Wikidata" or "GBIF".
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Distribution {
    /// Occurrence records (present, without geospatial issues).
    pub occurrences: u64,
    /// Countries above the noise threshold, most records first: `[["BR", 120], …]`.
    pub countries: Vec<(String, u64)>,
    /// Every country with at least one record, before the threshold.
    pub country_total: usize,
    pub gbif_key: i64,
    /// Where the density map has data, `[minLng, minLat, maxLng, maxLat]`.
    pub bbox: Option<[f64; 4]>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Links {
    pub opentree: String,
    pub wikipedia: Option<String>,
    /// The Portuguese article, for a later pt-BR UI.
    pub wikipedia_pt: Option<String>,
    pub wikidata: Option<String>,
    pub gbif: Option<String>,
    pub inat: Option<String>,
    pub iucn: Option<String>,
}

// ---- What the server tells us about the node ----

/// The node to enrich, from `tree.db`.
#[derive(Debug, Clone)]
pub struct Taxon {
    pub node_id: String,
    pub ott: Option<u32>,
    pub name: String,
    pub rank: Option<String>,
    pub gbif: Option<i64>,
    pub leaf_count: u32,
    /// Named ancestors, nearest first.
    pub ancestors: Vec<Ancestor>,
}

#[derive(Debug, Clone)]
pub struct Ancestor {
    pub node_id: String,
    pub ott: Option<u32>,
    pub name: String,
    pub rank: Option<String>,
    /// The ancestor's own Wikipedia summary, if cache.db already has it.
    pub cached_summary: Option<Summary>,
}

/// Ranks an article may be borrowed from (PLAN §6.1 "ancestor fallback").
pub const FALLBACK_RANKS: [&str; 3] = ["genus", "family", "order"];
/// How many ancestors to try for an article.
pub const FALLBACK_TRIES: usize = 3;

impl Taxon {
    /// The ancestors worth trying for a borrowed article, nearest first.
    pub fn fallbacks(&self) -> Vec<&Ancestor> {
        let mut out = Vec::new();
        for ancestor in &self.ancestors {
            let rank = ancestor.rank.as_deref().unwrap_or("");
            if FALLBACK_RANKS.contains(&rank) && ancestor.ott.is_some() {
                out.push(ancestor);
            }
            if out.len() == FALLBACK_TRIES {
                break;
            }
        }
        out
    }
}

// ---- Failure bookkeeping ----

/// Collects which sources failed while one document is assembled. Each
/// fetch function records its own failure here and returns `None`, so the
/// assembly code only sees "got it" or "didn't".
#[derive(Debug, Default)]
pub struct Report {
    // LEARN: this is `std::sync::Mutex`, not tokio's. It is locked only for
    // a quick push and never held across an `.await`, and for that the
    // standard one is the right (and cheaper) choice. tokio's `Mutex` exists
    // for locks that *must* stay held while awaiting (see `Enricher::inat_last`).
    failed: std::sync::Mutex<Vec<String>>,
}

impl Report {
    pub fn fail(&self, source: &str, why: String) {
        tracing::warn!(source, "enrichment source failed: {why}");
        let mut failed = self
            .failed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !failed.iter().any(|s| s == source) {
            failed.push(source.to_string());
        }
    }

    pub fn has_failed(&self, source: &str) -> bool {
        let failed = self
            .failed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        failed.iter().any(|s| s == source)
    }

    pub fn into_failed(self) -> Vec<String> {
        self.failed
            .into_inner()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

// ---- The HTTP side ----

/// Which per-host limit a request counts against (PLAN §6.2).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Host {
    /// Wikidata, Wikipedia and Commons share one budget.
    Wikimedia,
    Gbif,
    Inat,
}

/// How to build an [`Enricher`].
#[derive(Debug, Clone)]
pub struct Settings {
    pub endpoints: Endpoints,
    pub user_agent: String,
    pub timeout: Duration,
    /// For the few calls known to be slow ([`SLOW_TIMEOUT`]).
    pub slow_timeout: Duration,
    pub inat_gap: Duration,
}

impl Settings {
    /// The real services with the standard limits.
    pub fn live(user_agent: String) -> Settings {
        Settings {
            endpoints: Endpoints::live(),
            user_agent,
            timeout: TIMEOUT,
            slow_timeout: SLOW_TIMEOUT,
            inat_gap: INAT_GAP,
        }
    }
}

/// Shared by every request: one HTTP client and the per-host limits.
pub struct Enricher {
    // LEARN: a `reqwest::Client` holds a connection pool, so one client is
    // built at startup and shared: requests to the same host then reuse open
    // TLS connections instead of shaking hands every time. Cloning a Client
    // is cheap (it is an `Arc` inside), but we never need to.
    client: reqwest::Client,
    pub endpoints: Endpoints,
    // LEARN: a `Semaphore` holds N permits. `acquire().await` takes one,
    // waiting if none are left; dropping the permit gives it back. That caps
    // how many requests are in flight to one host at a time, however many
    // panels are opening at once.
    wikimedia: Semaphore,
    gbif: Semaphore,
    inat: Semaphore,
    // LEARN: tokio's `Mutex` can be held across an `.await` (here: while
    // sleeping until a second has passed since the last iNat request).
    // Holding a `std::sync::Mutex` guard across an `.await` would block the
    // worker thread, and the compiler refuses it in a spawned task anyway.
    inat_last: tokio::sync::Mutex<Option<Instant>>,
    inat_gap: Duration,
    timeout: Duration,
    slow_timeout: Duration,
    /// Node ids being refreshed in the background (stale-while-revalidate),
    /// so one stale document triggers one refresh, not one per request.
    refreshing: std::sync::Mutex<HashSet<String>>,
}

impl Enricher {
    pub fn new(settings: Settings) -> anyhow::Result<Enricher> {
        let client = reqwest::Client::builder()
            .user_agent(settings.user_agent)
            .connect_timeout(settings.timeout)
            .build()?;
        Ok(Enricher {
            client,
            endpoints: settings.endpoints,
            wikimedia: Semaphore::new(4),
            gbif: Semaphore::new(8),
            inat: Semaphore::new(1),
            inat_last: tokio::sync::Mutex::new(None),
            inat_gap: settings.inat_gap,
            timeout: settings.timeout,
            slow_timeout: settings.slow_timeout,
            refreshing: std::sync::Mutex::new(HashSet::new()),
        })
    }

    /// GETs `url` with `query` and returns the body text. A 404 is a definite
    /// "nothing there" (`None`, not a failure). Anything else that is not a
    /// success, including 429/503 and timeouts, is recorded in `report` under
    /// `source` and also gives `None`: we fail fast rather than sleep in the
    /// request path (PLAN §6.2).
    pub async fn get_text(
        &self,
        report: &Report,
        host: Host,
        source: &str,
        url: &str,
        query: &[(&str, &str)],
    ) -> Option<String> {
        let result = self.try_get_text(host, url, query, self.timeout).await;
        record(report, source, url, result)
    }

    /// [`Enricher::get_text`] with the longer [`SLOW_TIMEOUT`].
    pub async fn get_text_slow(
        &self,
        report: &Report,
        host: Host,
        source: &str,
        url: &str,
        query: &[(&str, &str)],
    ) -> Option<String> {
        let result = self.try_get_text(host, url, query, self.slow_timeout).await;
        record(report, source, url, result)
    }

    async fn try_get_text(
        &self,
        host: Host,
        url: &str,
        query: &[(&str, &str)],
        timeout: Duration,
    ) -> anyhow::Result<Option<String>> {
        let semaphore = match host {
            Host::Wikimedia => &self.wikimedia,
            Host::Gbif => &self.gbif,
            Host::Inat => &self.inat,
        };
        // Held until the end of this function, so it covers the whole request.
        let _permit = semaphore.acquire().await?;
        if host == Host::Inat {
            let mut last = self.inat_last.lock().await;
            if let Some(at) = *last {
                let wait = self.inat_gap.saturating_sub(at.elapsed());
                if !wait.is_zero() {
                    tokio::time::sleep(wait).await;
                }
            }
            *last = Some(Instant::now());
        }

        // LEARN: reqwest builds a request step by step and `send()` returns a
        // future of the response. `.query(…)` appends `?key=value&…`, encoding
        // each value (in reqwest 0.13 it needs the `query` feature).
        let request = self.client.get(url).query(query).timeout(timeout);
        let response = request.send().await?;
        let status = response.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !status.is_success() {
            anyhow::bail!("HTTP {status}");
        }
        Ok(Some(response.text().await?))
    }

    /// Marks `node_id` as being refreshed; false if a refresh already runs.
    pub fn begin_refresh(&self, node_id: &str) -> bool {
        let mut set = self
            .refreshing
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        set.insert(node_id.to_string())
    }

    pub fn end_refresh(&self, node_id: &str) {
        let mut set = self
            .refreshing
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        set.remove(node_id);
    }

    /// Fetches everything about `taxon` and assembles the document.
    pub async fn about(&self, taxon: &Taxon, now: i64) -> About {
        let report = Report::default();
        let name = taxon.name.as_str();

        // Stage A. Everything in one `join!` starts at once; the slowest
        // source sets the time, not the sum of all of them.
        // LEARN: `tokio::join!` polls all its futures concurrently on the
        // current task and returns a tuple of their results when every one
        // has finished. (`select!` would stop at the first.)
        let (item, species, occurrences, extent) = tokio::join!(
            wikidata::lookup(self, &report, taxon.ott, name, taxon.gbif),
            gbif::species(self, &report, taxon.gbif),
            gbif::occurrences(self, &report, taxon.gbif),
            gbif::extent(self, &report, taxon.gbif),
        );
        let wikidata_failed = report.has_failed(WIKIDATA);

        // A GBIF key known only from Wikidata (P846) is fetched in stage B.
        let mut late_gbif = None;
        if taxon.gbif.is_none() {
            late_gbif = item.as_ref().and_then(|i| i.gbif);
        }
        let enwiki = item.as_ref().and_then(|i| i.enwiki.clone());
        let p18 = item.as_ref().and_then(|i| i.image.clone());
        let has_status = item.as_ref().is_some_and(|i| i.iucn.is_some());
        // iNat only when Wikidata answered and has no image of its own, or
        // could not answer at all.
        let inat_name = if p18.is_none() { Some(name) } else { None };
        let is_species = taxon.rank.as_deref() == Some("species");
        let iucn_name = if !has_status && is_species {
            Some(name)
        } else {
            None
        };

        // Stage B.
        let (summary, image, inat_taxon, gbif_status, late_species, late_occ, late_extent) = tokio::join!(
            wikipedia::summary(self, &report, enwiki.as_deref()),
            wikipedia::commons_image(self, &report, p18.as_deref()),
            inat::taxon(self, &report, inat_name),
            gbif::iucn_status(self, &report, iucn_name),
            gbif::species(self, &report, late_gbif),
            gbif::occurrences(self, &report, late_gbif),
            gbif::extent(self, &report, late_gbif),
        );
        let species = species.or(late_species);
        let occurrences = occurrences.or(late_occ);
        let extent = extent.or(late_extent);
        let gbif_key = taxon.gbif.or(late_gbif);

        // No article of its own: borrow the nearest ancestor's, but only when
        // we know for sure there is none (Wikidata and Wikipedia answered).
        let mut summary = summary;
        let wikipedia_failed = report.has_failed(WIKIPEDIA);
        if summary.is_none() && !wikidata_failed && !wikipedia_failed {
            summary = self.ancestor_summary(&report, taxon).await;
        }

        let mut image = image;
        if image.is_none() {
            image = inat_taxon.as_ref().and_then(|t| t.image.clone());
        }

        let status = match item.as_ref().and_then(|i| i.iucn) {
            Some(code) => Some(Status {
                code: code.to_string(),
                source: WIKIDATA.to_string(),
            }),
            None => gbif_status.map(|code| Status {
                code: code.to_string(),
                source: GBIF.to_string(),
            }),
        };

        let taxonomy = species.as_ref().map(|s| Taxonomy {
            authorship: s.authorship.clone(),
            published_in: s.published_in.clone(),
            source: GBIF.to_string(),
        });

        let mut distribution = None;
        if let (Some(key), Some(occ)) = (gbif_key, occurrences.as_ref()) {
            distribution = Some(Distribution {
                occurrences: occ.total,
                countries: occ.countries.clone(),
                country_total: occ.country_total,
                gbif_key: key,
                bbox: extent.and_then(|e| e.bbox),
            });
        }

        let mut common_names = Vec::new();
        if let Some(vernacular) = species.as_ref().and_then(|s| s.vernacular.clone()) {
            push_name(&mut common_names, vernacular, name);
        }
        if let Some(own) = summary.as_ref().filter(|s| s.about.is_none()) {
            push_name(&mut common_names, own.title.clone(), name);
        }

        let mut links = Links {
            opentree: format!(
                "https://tree.opentreeoflife.org/opentree/argus/{SYNTH}@{}",
                taxon.node_id
            ),
            gbif: gbif_key.map(|k| format!("https://www.gbif.org/species/{k}")),
            ..Links::default()
        };
        if let Some(own) = summary.as_ref().filter(|s| s.about.is_none()) {
            links.wikipedia = Some(own.url.clone());
        }
        if let Some(item) = &item {
            links.wikidata = Some(format!("https://www.wikidata.org/wiki/{}", item.qid));
            links.wikipedia_pt = item.ptwiki.as_deref().map(wikipedia::pt_url);
            links.inat = item
                .inat_id
                .as_ref()
                .map(|id| format!("https://www.inaturalist.org/taxa/{id}"));
            links.iucn = item
                .iucn_id
                .as_ref()
                .map(|id| format!("https://www.iucnredlist.org/details/{id}/0"));
        }
        if links.inat.is_none() {
            links.inat = inat_taxon.map(|t| format!("https://www.inaturalist.org/taxa/{}", t.id));
        }

        let generated = generated_sentence(taxon, species.as_ref(), occurrences.as_ref());
        let failed = report.into_failed();
        About {
            node_id: taxon.node_id.clone(),
            taxonomy,
            common_names,
            summary,
            image,
            status,
            distribution,
            generated,
            links,
            complete: failed.is_empty(),
            failed,
            fetched_at: now,
        }
    }

    /// The first genus, family or order above `taxon` with an article,
    /// labelled with whose it is.
    async fn ancestor_summary(&self, report: &Report, taxon: &Taxon) -> Option<Summary> {
        for ancestor in taxon.fallbacks() {
            let about = Some(AboutRef {
                node_id: ancestor.node_id.clone(),
                name: ancestor.name.clone(),
                rank: ancestor.rank.clone(),
            });
            if let Some(cached) = &ancestor.cached_summary {
                return Some(Summary {
                    about,
                    ..cached.clone()
                });
            }
            let item = wikidata::lookup(self, report, ancestor.ott, &ancestor.name, None).await;
            if report.has_failed(WIKIDATA) {
                return None;
            }
            let title = item.and_then(|i| i.enwiki);
            if let Some(found) = wikipedia::summary(self, report, title.as_deref()).await {
                return Some(Summary { about, ..found });
            }
            if report.has_failed(WIKIPEDIA) {
                return None;
            }
        }
        None
    }
}

/// The body, or `None` with the failure recorded.
fn record(
    report: &Report,
    source: &str,
    url: &str,
    result: anyhow::Result<Option<String>>,
) -> Option<String> {
    match result {
        Ok(body) => body,
        Err(err) => {
            report.fail(source, format!("{url}: {err:#}"));
            None
        }
    }
}

/// The document for an unnamed (mrca) node: never enriched (PLAN §6.1),
/// so it costs no upstream request and is not cached.
pub fn minimal(node_id: &str, within: Option<&str>, leaf_count: u32, now: i64) -> About {
    let mut generated = String::from("An unnamed clade");
    if let Some(name) = within {
        generated.push_str(&format!(" within {name}"));
    }
    generated.push_str(&format!(
        ", with {} species in the Open Tree synthesis.",
        thousands(u64::from(leaf_count))
    ));
    About {
        node_id: node_id.to_string(),
        generated,
        links: Links {
            opentree: format!("https://tree.opentreeoflife.org/opentree/argus/{SYNTH}@{node_id}"),
            ..Links::default()
        },
        complete: true,
        fetched_at: now,
        ..About::default()
    }
}

/// Adds a common name unless it is the scientific name or already listed
/// (ignoring case: GBIF says "jaguar", Wikipedia "Jaguar").
fn push_name(names: &mut Vec<String>, candidate: String, scientific: &str) {
    let candidate = candidate.trim().to_string();
    if candidate.is_empty() || candidate.eq_ignore_ascii_case(scientific) {
        return;
    }
    for name in names.iter() {
        if name.to_lowercase() == candidate.to_lowercase() {
            return;
        }
    }
    names.push(candidate);
}

/// Ranks named in the generated sentence's "in the family X", narrowest first.
const CONTEXT_RANKS: [&str; 5] = ["family", "order", "class", "phylum", "kingdom"];

/// Ranks at which "with N species in the Open Tree synthesis" would be
/// odd: their extra tips are subspecies and varieties.
const SPECIES_AND_BELOW: [&str; 5] = ["species", "subspecies", "variety", "form", "forma"];

/// "Pselaphus heisei Herbst, 1791 is a species in the family Staphylinidae.
/// GBIF has 1,881 occurrence records of it from 24 countries."
///
/// Built only from structured data, so every taxon has one (PLAN §6.3).
/// The synth tree often lacks the family (Hominidae and Staphylinidae are
/// "broken" there), so GBIF's own classification and rank fill those gaps.
pub fn generated_sentence(
    taxon: &Taxon,
    species: Option<&gbif::SpeciesInfo>,
    occurrences: Option<&gbif::Occurrences>,
) -> String {
    let mut text = taxon.name.clone();
    if let Some(author) = species.and_then(|s| s.authorship.as_deref()) {
        text.push(' ');
        text.push_str(author);
    }

    let tree_rank = taxon
        .rank
        .as_deref()
        .filter(|r| !r.is_empty() && !r.starts_with("no rank"));
    let gbif_rank = species
        .and_then(|s| s.rank.as_deref())
        .filter(|r| *r != "unranked");
    let rank = tree_rank.or(gbif_rank).unwrap_or("taxon");
    text.push_str(&format!(" is {} {rank}", article(rank)));

    // The nearest ancestor of a broader major rank than the node's own.
    let own = CONTEXT_RANKS.iter().position(|r| *r == rank);
    let mut context = None;
    // GBIF's family, when the node sits below family level.
    if let Some(family) = species.and_then(|s| s.family.as_deref())
        && own.is_none()
        && family != taxon.name
    {
        context = Some(format!(" in the family {family}"));
    }
    if context.is_none() {
        for ancestor in &taxon.ancestors {
            let rank = ancestor.rank.as_deref().unwrap_or("");
            if let Some(index) = CONTEXT_RANKS.iter().position(|r| *r == rank)
                && own.is_none_or(|own| index > own)
            {
                context = Some(format!(" in the {rank} {}", ancestor.name));
                break;
            }
        }
    }
    if context.is_none()
        && let Some(nearest) = taxon.ancestors.first()
    {
        context = Some(format!(" in {}", nearest.name));
    }
    text.push_str(&context.unwrap_or_default());
    if taxon.leaf_count > 1 && !SPECIES_AND_BELOW.contains(&rank) {
        text.push_str(&format!(
            ", with {} species in the Open Tree synthesis",
            thousands(u64::from(taxon.leaf_count))
        ));
    }
    text.push('.');

    if let Some(occ) = occurrences {
        if occ.total == 0 {
            text.push_str(" GBIF has no occurrence records of it.");
        } else {
            let records = if occ.total == 1 { "record" } else { "records" };
            text.push_str(&format!(
                " GBIF has {} occurrence {records} of it",
                thousands(occ.total)
            ));
            match occ.country_total {
                0 => {}
                1 => text.push_str(" from 1 country"),
                n => text.push_str(&format!(" from {n} countries")),
            }
            text.push('.');
        }
    }
    text
}

/// "a species", "an order".
fn article(word: &str) -> &'static str {
    match word.chars().next() {
        Some('a' | 'e' | 'i' | 'o' | 'u') => "an",
        _ => "a",
    }
}

/// 1234567 → "1,234,567".
pub fn thousands(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, digit) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// Plain text from an HTML fragment (Commons' `Artist`, GBIF's
/// `publishedIn`): tags removed, common entities decoded, whitespace
/// collapsed. The result is shown with `textContent`, never as HTML.
pub fn strip_html(html: &str) -> String {
    let mut text = String::new();
    let mut in_tag = false;
    // LEARN: `.chars()` walks a string by Unicode scalar values, not bytes,
    // so "Onça" gives 'O','n','ç','a'. A `bool` is enough state for this
    // tiny machine: inside a tag or not.
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => {
                in_tag = false;
                // A tag may separate words ("A<br>B").
                text.push(' ');
            }
            _ if !in_tag => text.push(c),
            _ => {}
        }
    }
    let decoded = text
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#039;", "'")
        .replace("&amp;", "&");
    // Collapse runs of whitespace (including the spaces added for tags).
    let words: Vec<&str> = decoded.split_whitespace().collect();
    let joined = words.join(" ");
    // A tag between a word and its punctuation leaves "word ," behind.
    joined
        .replace(" ,", ",")
        .replace(" .", ".")
        .replace(" ;", ";")
        .replace(" :", ":")
}

/// The IUCN codes we show; anything else (NE, LR/cd, …) is ignored.
pub fn known_iucn_code(code: &str) -> Option<&'static str> {
    match code {
        "LC" => Some("LC"),
        "NT" => Some("NT"),
        "VU" => Some("VU"),
        "EN" => Some("EN"),
        "CR" => Some("CR"),
        "EW" => Some("EW"),
        "EX" => Some("EX"),
        "DD" => Some("DD"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
                ancestor("Pselaphinae", "subfamily", 1),
                ancestor("Staphylinidae", "family", 2),
                ancestor("Coleoptera", "order", 3),
            ],
        }
    }

    #[test]
    fn generated_sentence_for_a_species() {
        let occ = gbif::Occurrences {
            total: 1881,
            countries: vec![],
            country_total: 24,
        };
        let gbif = gbif::SpeciesInfo {
            authorship: Some("Herbst, 1791".to_string()),
            ..gbif::SpeciesInfo::default()
        };
        assert_eq!(
            generated_sentence(&beetle(), Some(&gbif), Some(&occ)),
            "Pselaphus heisei Herbst, 1791 is a species in the family Staphylinidae. \
             GBIF has 1,881 occurrence records of it from 24 countries."
        );
    }

    #[test]
    fn generated_sentence_fills_tree_gaps_from_gbif() {
        // The synth lineage of the coelacanth has no ranked family, and OTT
        // gives the species itself "no rank"; GBIF knows both.
        let mut taxon = beetle();
        taxon.name = "Latimeria chalumnae".to_string();
        taxon.rank = Some("no rank".to_string());
        taxon.leaf_count = 2;
        taxon.ancestors = vec![ancestor("Vertebrata", "subphylum", 1)];
        let gbif = gbif::SpeciesInfo {
            authorship: Some("Smith, 1939".to_string()),
            rank: Some("species".to_string()),
            family: Some("Latimeriidae".to_string()),
            ..gbif::SpeciesInfo::default()
        };
        assert_eq!(
            generated_sentence(&taxon, Some(&gbif), None),
            "Latimeria chalumnae Smith, 1939 is a species in the family Latimeriidae."
        );
    }

    #[test]
    fn generated_sentence_for_a_clade_without_data() {
        let mut taxon = beetle();
        taxon.name = "Staphylinidae".to_string();
        taxon.rank = Some("family".to_string());
        taxon.leaf_count = 64_000;
        taxon.ancestors = vec![ancestor("Coleoptera", "order", 3)];
        let none = gbif::Occurrences {
            total: 0,
            countries: vec![],
            country_total: 0,
        };
        assert_eq!(
            generated_sentence(&taxon, None, Some(&none)),
            "Staphylinidae is a family in the order Coleoptera, with 64,000 species in the \
             Open Tree synthesis. GBIF has no occurrence records of it."
        );
        taxon.rank = Some("no rank".to_string());
        taxon.ancestors = vec![ancestor("Polyphaga", "suborder", 4)];
        assert_eq!(
            generated_sentence(&taxon, None, None),
            "Staphylinidae is a taxon in Polyphaga, with 64,000 species in the Open Tree synthesis."
        );
    }

    #[test]
    fn fallbacks_are_genus_family_order_only() {
        let taxon = beetle();
        let names: Vec<&str> = taxon.fallbacks().iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, ["Pselaphus", "Staphylinidae", "Coleoptera"]);
    }

    #[test]
    fn strip_html_keeps_text_only() {
        let artist =
            "<a href=\"//commons.wikimedia.org/wiki/User:T\" title=\"User:T\">Thiago &amp; Co</a>";
        assert_eq!(strip_html(artist), "Thiago & Co");
        assert_eq!(
            strip_html("Smith (1939). <em>Nature (London).</em> v. 143"),
            "Smith (1939). Nature (London). v. 143"
        );
        assert_eq!(strip_html("<span>Jane</span>, <i>2001</i>"), "Jane, 2001");
    }

    #[test]
    fn thousands_separators() {
        assert_eq!(thousands(0), "0");
        assert_eq!(thousands(999), "999");
        assert_eq!(thousands(1000), "1,000");
        assert_eq!(thousands(146_418), "146,418");
        assert_eq!(thousands(1_234_567), "1,234,567");
    }

    #[test]
    fn common_names_are_deduplicated() {
        let mut names = Vec::new();
        push_name(&mut names, "jaguar".to_string(), "Panthera onca");
        push_name(&mut names, "Jaguar".to_string(), "Panthera onca");
        push_name(&mut names, "Panthera onca".to_string(), "Panthera onca");
        assert_eq!(names, ["jaguar"]);
    }

    #[test]
    fn minimal_document_for_unnamed_clades() {
        let doc = minimal("mrcaott1ott2", Some("Felidae"), 12, 5);
        assert!(doc.complete);
        assert_eq!(
            doc.generated,
            "An unnamed clade within Felidae, with 12 species in the Open Tree synthesis."
        );
        assert!(doc.links.opentree.ends_with("@mrcaott1ott2"));
    }
}
