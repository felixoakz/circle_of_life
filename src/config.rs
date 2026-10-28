//! Command-line arguments for the two subcommands, `ingest` and `serve`.
//!
//! clap reads these structs and generates the parser, the `--help` text and
//! the error messages. Each `serve` option can also come from an environment
//! variable (see `.env.example`), which is how the Docker container is
//! configured.
//!
//! Concepts introduced here:
//! - structs with named fields
//! - `#[derive(...)]`: asking the compiler (or a library) to write code for us
//! - attributes on fields (`#[arg(...)]`)
//! - `Option<T>`: a value that may be absent
//! - `PathBuf` vs `&Path`: owned vs borrowed file paths
//! - `impl` blocks and methods that borrow `&self`
//! - unit tests: `#[cfg(test)]` and `#[test]`
//! - `Option::as_deref`: borrowing the inside of an `Option<String>` as `&str`

use std::path::PathBuf;

use clap::Args;

// LEARN: `#[derive(Debug, Args)]` generates code at compile time. `Debug`
// gives the struct a `{:?}` printout; `Args` (from clap) generates the
// command-line parser for these fields. Doc comments (`///`) on the fields
// become the `--help` text.
/// Arguments for `species ingest` (PLAN §3).
#[derive(Debug, Args)]
pub struct IngestArgs {
    /// Newick synth tree (labelled_supertree.tre).
    // LEARN: `PathBuf` is an owned, growable file path, the path equivalent of
    // `String`. Its borrowed form is `&Path`, like `&str` is for `String`.
    #[arg(long)]
    pub tree: PathBuf,

    /// OTT taxonomy.tsv.
    #[arg(long)]
    pub taxonomy: PathBuf,

    /// Common names (P11): GBIF backbone.zip (read through `unzip -p`), its
    /// VernacularName.tsv, or `-` for that TSV on stdin.
    // LEARN: `Option<PathBuf>` is either `Some(path)` or `None`. Rust has no
    // null; a value that may be missing says so in its type, and the compiler
    // makes you handle the `None` case before you can use the path.
    #[arg(long)]
    pub vernacular: Option<PathBuf>,

    /// Comma-separated languages to keep from the vernacular names.
    #[arg(long, default_value = "en,pt")]
    pub langs: String,

    /// Output database. Written to `<out>.tmp` first, then renamed into place.
    #[arg(long, default_value = "data/tree.db")]
    pub out: PathBuf,

    /// Parse and compute everything, print statistics, write nothing.
    #[arg(long)]
    pub dry_run: bool,
}

/// Arguments for `species serve` (PLAN §5, §11).
#[derive(Debug, Args)]
pub struct ServeArgs {
    /// Directory holding tree.db and cache.db.
    #[arg(long = "data", env = "SPECIES_DATA_DIR", default_value = "data")]
    pub data_dir: PathBuf,

    /// File name of the tree database inside the data directory
    /// (`mini.db` for the fixture build).
    #[arg(long, default_value = "tree.db")]
    pub db: String,

    /// Directory of the built frontend (`pnpm -C web build`).
    #[arg(
        long = "static",
        env = "SPECIES_STATIC_DIR",
        default_value = "web/dist"
    )]
    pub static_dir: PathBuf,

    /// TCP port to listen on (all interfaces).
    #[arg(long, env = "PORT", default_value_t = 3000)]
    pub port: u16,

    /// Contact for upstream APIs (an email or a contact page), sent in the
    /// User-Agent of every enrichment request. Wikimedia asks for one.
    #[arg(long, env = "SPECIES_CONTACT")]
    pub contact: Option<String>,

    /// Public URL of this site, also sent in the User-Agent.
    #[arg(long, env = "SPECIES_PUBLIC_URL")]
    pub public_url: Option<String>,
}

// LEARN: an `impl` block attaches functions to a type. A function whose first
// parameter is `&self` is a method: it borrows the struct (read-only) without
// taking ownership, so the caller can keep using it afterwards.
impl ServeArgs {
    /// Full path of the tree database, e.g. `data/tree.db`.
    pub fn tree_db_path(&self) -> PathBuf {
        self.data_dir.join(&self.db)
    }

    /// Full path of the enrichment cache, `data/cache.db`.
    pub fn cache_db_path(&self) -> PathBuf {
        self.data_dir.join("cache.db")
    }

    /// The User-Agent for upstream requests (see [`user_agent`]).
    pub fn user_agent(&self) -> String {
        // LEARN: `as_deref` turns `&Option<String>` into `Option<&str>`:
        // it borrows the text inside (if any) instead of copying it.
        user_agent(self.public_url.as_deref(), self.contact.as_deref())
    }
}

/// `species-circle/0.1.0 (+https://example.org; contact)` (PLAN §6.2).
///
/// Both parts come from the environment and are never hard-coded. Without
/// them (local development) the agent still says what it is, so upstream
/// operators can tell this traffic apart; the server logs a warning at start.
pub fn user_agent(public_url: Option<&str>, contact: Option<&str>) -> String {
    let mut parts = Vec::new();
    if let Some(url) = public_url.filter(|u| !u.trim().is_empty()) {
        parts.push(format!("+{}", url.trim()));
    }
    if let Some(contact) = contact.filter(|c| !c.trim().is_empty()) {
        parts.push(contact.trim().to_string());
    }
    if parts.is_empty() {
        parts.push("Circle of Life tree viewer, local development".to_string());
    }
    // `env!` reads a variable at compile time; Cargo sets this one to the
    // version in Cargo.toml.
    let version = env!("CARGO_PKG_VERSION");
    format!("species-circle/{version} ({})", parts.join("; "))
}

/// Base URLs of the upstream APIs used by enrichment (PLAN §6). Tests point
/// them all at a local mock server.
#[derive(Debug, Clone)]
pub struct Endpoints {
    /// Wikidata Action API (`…/w/api.php`).
    pub wikidata: String,
    /// English Wikipedia REST API (`…/api/rest_v1`).
    pub wikipedia: String,
    /// Wikimedia Commons Action API (`…/w/api.php`).
    pub commons: String,
    /// GBIF API root (`https://api.gbif.org`, without `/v1`).
    pub gbif: String,
    /// iNaturalist API (`…/v1`).
    pub inat: String,
}

impl Endpoints {
    /// The real services.
    pub fn live() -> Endpoints {
        Endpoints {
            wikidata: "https://www.wikidata.org/w/api.php".to_string(),
            wikipedia: "https://en.wikipedia.org/api/rest_v1".to_string(),
            commons: "https://commons.wikimedia.org/w/api.php".to_string(),
            gbif: "https://api.gbif.org".to_string(),
            inat: "https://api.inaturalist.org/v1".to_string(),
        }
    }

    /// Every service under one base URL, one path prefix each
    /// (`{base}/wikidata`, `{base}/gbif`, …): how tests use a mock server.
    pub fn under(base: &str) -> Endpoints {
        Endpoints {
            wikidata: format!("{base}/wikidata"),
            wikipedia: format!("{base}/wikipedia"),
            commons: format!("{base}/commons"),
            gbif: format!("{base}/gbif"),
            inat: format!("{base}/inat"),
        }
    }
}

// LEARN: `#[cfg(test)]` compiles this module only for `cargo test`, so test
// code never ends up in the release binary. `use super::*;` imports everything
// from the parent module (this file) into the test module.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tree_db_path_joins_dir_and_file() {
        let args = ServeArgs {
            data_dir: PathBuf::from("data"),
            db: "mini.db".to_string(),
            static_dir: PathBuf::from("web/dist"),
            port: 3000,
            contact: None,
            public_url: None,
        };
        assert_eq!(args.tree_db_path(), PathBuf::from("data/mini.db"));
        assert_eq!(args.cache_db_path(), PathBuf::from("data/cache.db"));
    }

    #[test]
    fn user_agent_contains_contact_and_url() {
        let ua = user_agent(
            Some("https://circle.example"),
            Some("ops at circle.example"),
        );
        assert!(ua.starts_with("species-circle/"), "{ua}");
        assert!(
            ua.ends_with("(+https://circle.example; ops at circle.example)"),
            "{ua}"
        );
    }

    #[test]
    fn user_agent_without_contact_is_still_descriptive() {
        let ua = user_agent(None, Some("  "));
        assert!(ua.contains("local development"), "{ua}");
        assert!(!ua.contains('@'), "{ua}");
        let ua = user_agent(Some("https://circle.example"), None);
        assert!(ua.ends_with("(+https://circle.example)"), "{ua}");
    }
}
