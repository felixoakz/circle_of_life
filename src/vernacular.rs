//! Common names (P11): reads GBIF's `VernacularName.tsv` and keeps the names
//! in the wanted languages (English and Portuguese by default) for the nodes
//! of our tree (PLAN §9 P11, docs/data-sources.md).
//!
//! The file lives inside the 926 MB GBIF backbone archive, `backbone.zip`.
//! We never unpack it to disk: for a `.zip` path ingest starts
//! `unzip -p <zip> VernacularName.tsv` as a child process and reads the
//! inflated text from its stdout as it streams out. `-` reads the same text
//! from our own stdin (`unzip -p … | species ingest --vernacular -`), and any
//! other path is read as a plain `.tsv` file (the test fixtures).
//!
//! Why `unzip -p` and not the `zip` crate: no new dependency, the file is
//! streamed either way, and inflating happens in a separate process, so it
//! runs on another core while we parse. The cost is that `unzip` must be
//! installed where ingest runs (it is a build-time tool, never in the
//! server image).
//!
//! The file is a Darwin Core text table with a header row, tab-separated
//! (tabs shown as two spaces):
//!
//! ```text
//! taxonID  vernacularName  language  country  countryCode  sex  lifeStage  source
//! 5219426  Jaguar  en  …
//! ```
//!
//! Columns are found by their header names, so a reordered file still works.
//! `taxonID` is a GBIF backbone key; OTT's `sourceinfo` gives most of our
//! nodes one (`gbif:5219404`), and that integer join is the whole mapping.
//! Language codes come as 2 letters (`en`) or 3 (`eng`); both are accepted.
//!
//! Concepts introduced here:
//! - starting a child process with `std::process::Command` and reading its
//!   output through a pipe (`Stdio::piped`)
//! - an enum over several readers, so one loop can read any of them
//! - `HashMap::entry` for "insert or update"
//! - `&'static str`: text that lives for the whole program

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Stdin};
use std::path::Path;
use std::process::{Child, ChildStdout, Command, Stdio};

use anyhow::{Context, bail};

use crate::db::queries::fold;

/// The file we want inside `backbone.zip`.
pub const ZIP_MEMBER: &str = "VernacularName.tsv";

/// One common name for one node of our tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommonName {
    /// Pre-order node id (`nodes.id`).
    pub node: u32,
    /// Two-letter language code, `"en"` or `"pt"`.
    pub lang: &'static str,
    /// Trimmed, with runs of spaces collapsed: `"Onça-pintada"`.
    pub name: String,
    /// How many rows gave this name (ignoring case and accents): several
    /// checklists agreeing on "Lion" outweigh one listing "Leon".
    pub support: u32,
}

/// The names kept, plus counts for the ingest report.
#[derive(Debug, Default)]
pub struct Vernaculars {
    /// Sorted by node, then language, then best supported first.
    pub names: Vec<CommonName>,
    /// Node id → rows for that node in *any* language. A rough measure of
    /// how well known a taxon is (the jaguar has dozens, a beetle one or
    /// none); search uses it to order otherwise equal matches.
    pub rows_per_node: HashMap<u32, u32>,
    /// Data rows in the file (not counting the header).
    pub rows_read: usize,
    /// Rows in a wanted language.
    pub rows_in_langs: usize,
    /// Rows in a wanted language whose `taxonID` is not on any of our nodes.
    pub unmatched: usize,
    /// Rows dropped as repeats of a name the node already has (same
    /// language, ignoring case, accents and punctuation) or of its
    /// scientific name.
    pub duplicates: usize,
}

impl Vernaculars {
    /// How many names were kept in `lang`.
    pub fn count(&self, lang: &str) -> usize {
        let mut n = 0;
        for name in &self.names {
            if name.lang == lang {
                n += 1;
            }
        }
        n
    }

    /// How many distinct nodes have at least one name.
    pub fn nodes_covered(&self) -> usize {
        // `names` is sorted by node, so a new node starts wherever the id
        // differs from the previous entry's.
        let mut n = 0;
        let mut previous = None;
        for name in &self.names {
            if previous != Some(name.node) {
                n += 1;
                previous = Some(name.node);
            }
        }
        n
    }

    /// Each named node's display name: its best supported English name,
    /// else its best Portuguese one.
    pub fn best_names(&self) -> HashMap<u32, &str> {
        let mut best: HashMap<u32, &str> = HashMap::new();
        for name in &self.names {
            // Sorted by language ("en" < "pt") and support, so the first
            // name seen for a node is the one we want.
            best.entry(name.node).or_insert(name.name.as_str());
        }
        best
    }
}

/// Reads the names from `source` (a `.zip`, `-` for stdin, or a `.tsv`).
///
/// `langs` is the `--langs` list (`"en,pt"`). `node_of_gbif` maps a GBIF key
/// to our node id, and `scientific[node]` is a node's scientific name, so
/// names that only repeat it are skipped.
pub fn read(
    source: &Path,
    langs: &str,
    node_of_gbif: &HashMap<u32, u32>,
    scientific: &[Option<&str>],
) -> anyhow::Result<Vernaculars> {
    let wanted = parse_langs(langs)?;
    let mut input = Input::open(source)?;

    let mut out = Vernaculars::default();
    // LEARN: `HashMap::entry(key)` looks the key up once and gives back a
    // handle to its slot, filled or empty. `.or_insert(v)` fills an empty
    // slot with `v`, and either way returns `&mut` to the value inside, so
    // "insert or update" is one lookup instead of a `get` then an `insert`.
    //
    // The key is (node, language, the name folded to lowercase without
    // accents or punctuation), so "Jaguar", "jaguar" and "JAGUAR" are one
    // name; the value is where that name sits in `out.names`.
    let mut index_of: HashMap<(u32, &'static str, String), usize> = HashMap::new();
    // Rows per exact spelling of each kept name ("Jaguar" 5, "jaguar" 3),
    // so the most common spelling is the one shown.
    let mut spelling_rows: HashMap<(usize, String), u32> = HashMap::new();

    let mut columns: Option<Columns> = None;
    let mut line = String::new();
    loop {
        line.clear();
        if input.read_line(&mut line)? == 0 {
            break;
        }
        let row = line.trim_end_matches(['\n', '\r']);
        let Some(cols) = &columns else {
            columns = Some(Columns::from_header(row)?);
            continue;
        };
        out.rows_read += 1;

        let fields: Vec<&str> = row.split('\t').collect();
        let node = cols.gbif(&fields).and_then(|gbif| node_of_gbif.get(&gbif));
        if let Some(&node) = node {
            *out.rows_per_node.entry(node).or_insert(0) += 1;
        }
        let Some((lang, name)) = cols.name_in(&fields, &wanted) else {
            continue;
        };
        out.rows_in_langs += 1;
        let Some(&node) = node else {
            out.unmatched += 1;
            continue;
        };

        let key = (node, lang, fold(&name));
        if let Some(&i) = index_of.get(&key) {
            out.duplicates += 1;
            let rows = spelling_rows.entry((i, name.clone())).or_insert(0);
            *rows += 1;
            let rows = *rows;
            let kept = &mut out.names[i];
            kept.support += 1;
            let kept_rows = spelling_rows[&(i, kept.name.clone())];
            // The spelling with accents wins ("Onça" over "Onca"), then the
            // more common one.
            let (accents, kept_accents) = (non_ascii(&name), non_ascii(&kept.name));
            if accents > kept_accents || (accents == kept_accents && rows > kept_rows) {
                kept.name = name;
            }
            continue;
        }
        let same_as_scientific = match scientific.get(node as usize) {
            Some(Some(sci)) => fold(sci) == key.2,
            _ => false,
        };
        if same_as_scientific {
            out.duplicates += 1;
            continue;
        }
        index_of.insert(key, out.names.len());
        spelling_rows.insert((out.names.len(), name.clone()), 1);
        out.names.push(CommonName {
            node,
            lang,
            name,
            support: 1,
        });
    }
    input.finish(source)?;

    // Best supported first within a node and language. The sort is stable,
    // so equal support keeps the file's order.
    out.names
        .sort_by_key(|n| (n.node, n.lang, std::cmp::Reverse(n.support)));
    Ok(out)
}

/// `"en,pt"` → `["en", "pt"]`, each checked against [`LANGUAGES`].
pub fn parse_langs(langs: &str) -> anyhow::Result<Vec<&'static str>> {
    let mut wanted = Vec::new();
    for part in langs.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        match lang_code(part) {
            Some(code) => wanted.push(code),
            None => bail!("unknown language {part:?} in --langs (known: en, pt, es, fr, de, …)"),
        }
    }
    if wanted.is_empty() {
        bail!("--langs is empty");
    }
    Ok(wanted)
}

// LEARN: `&'static str` is a string slice that lives for the whole run of
// the program; string literals like "en" are baked into the binary, so they
// are all `'static`. Returning one of these instead of a new `String` costs
// nothing, and millions of `CommonName`s can share the same two bytes.
/// Two-letter code and the three-letter codes that mean the same language
/// (ISO 639-1 and 639-2, bibliographic and terminology forms).
const LANGUAGES: [(&str, &str, &str); 8] = [
    ("en", "eng", "eng"),
    ("pt", "por", "por"),
    ("es", "spa", "spa"),
    ("fr", "fra", "fre"),
    ("de", "deu", "ger"),
    ("it", "ita", "ita"),
    ("nl", "nld", "dut"),
    ("la", "lat", "lat"),
];

/// `"eng"`, `"EN"` or `"pt-BR"` → `Some("en")` / `Some("pt")`; unknown codes
/// give `None`.
pub fn lang_code(code: &str) -> Option<&'static str> {
    // A region suffix (`pt-BR`, `en_GB`) does not change the language.
    let base = code.split(['-', '_']).next().unwrap_or("");
    let base = base.trim().to_ascii_lowercase();
    for (two, three, other) in LANGUAGES {
        if base == two || base == three || base == other {
            return Some(two);
        }
    }
    None
}

/// Trims a name and collapses inner runs of whitespace to one space.
pub fn clean_name(raw: &str) -> String {
    let words: Vec<&str> = raw.split_whitespace().collect();
    words.join(" ")
}

/// Counts the characters outside ASCII (accented letters, mostly).
fn non_ascii(text: &str) -> usize {
    text.chars().filter(|c| !c.is_ascii()).count()
}

/// Positions of the three columns we use, from the header row.
#[derive(Debug)]
struct Columns {
    taxon: usize,
    name: usize,
    lang: usize,
}

impl Columns {
    fn from_header(header: &str) -> anyhow::Result<Columns> {
        let mut taxon = None;
        let mut name = None;
        let mut lang = None;
        for (i, column) in header.split('\t').enumerate() {
            match column.trim() {
                "taxonID" | "id" | "coreid" => taxon = Some(i),
                "vernacularName" => name = Some(i),
                "language" => lang = Some(i),
                _ => {}
            }
        }
        match (taxon, name, lang) {
            (Some(taxon), Some(name), Some(lang)) => Ok(Columns { taxon, name, lang }),
            _ => bail!("{ZIP_MEMBER}: header {header:?} lacks taxonID, vernacularName or language"),
        }
    }

    /// The row's GBIF key, if it has a usable one.
    fn gbif(&self, fields: &[&str]) -> Option<u32> {
        fields.get(self.taxon)?.trim().parse().ok()
    }

    /// `(language, cleaned name)` for a row in a wanted language with a
    /// non-empty name; `None` otherwise.
    fn name_in(&self, fields: &[&str], wanted: &[&'static str]) -> Option<(&'static str, String)> {
        let lang = lang_code(fields.get(self.lang)?)?;
        if !wanted.contains(&lang) {
            return None;
        }
        let name = clean_name(fields.get(self.name)?);
        if name.is_empty() {
            return None;
        }
        Some((lang, name))
    }
}

/// Where the text comes from. Each variant holds a different reader type;
/// the enum lets one loop read from any of them without generics.
enum Input {
    /// `unzip -p` running as a child process; we read its stdout.
    Unzip(Child, BufReader<ChildStdout>),
    /// Our own stdin (`--vernacular -`).
    Stdin(BufReader<Stdin>),
    /// A plain `.tsv` file.
    File(BufReader<File>),
}

impl Input {
    fn open(source: &Path) -> anyhow::Result<Input> {
        if source == Path::new("-") {
            return Ok(Input::Stdin(BufReader::new(std::io::stdin())));
        }
        let is_zip = source
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"));
        if !is_zip {
            let file =
                File::open(source).with_context(|| format!("opening {}", source.display()))?;
            return Ok(Input::File(BufReader::new(file)));
        }
        if !source.exists() {
            bail!(
                "{} not found; download it with `make fetch-gbif`",
                source.display()
            );
        }
        // LEARN: `Command` builds a child process like a shell command line,
        // one argument at a time (no shell, so no quoting problems).
        // `Stdio::piped()` connects the child's stdout to a pipe we can
        // read; `spawn()` starts it and returns at once, so the child
        // inflates the next chunk while we parse the previous one.
        let mut child = Command::new("unzip")
            .arg("-p")
            .arg(source)
            .arg(ZIP_MEMBER)
            .stdout(Stdio::piped())
            .spawn()
            .context("starting `unzip` (is it installed?)")?;
        // `take()` moves the pipe out of the `Child`, leaving `None` there;
        // the `Child` itself stays with us to wait on later.
        let Some(stdout) = child.stdout.take() else {
            bail!("unzip started without a stdout pipe");
        };
        // A bigger buffer than the default 8 KB: fewer reads from the pipe.
        Ok(Input::Unzip(
            child,
            BufReader::with_capacity(1 << 20, stdout),
        ))
    }

    fn read_line(&mut self, line: &mut String) -> anyhow::Result<usize> {
        let bytes = match self {
            Input::Unzip(_, reader) => reader.read_line(line),
            Input::Stdin(reader) => reader.read_line(line),
            Input::File(reader) => reader.read_line(line),
        };
        bytes.context("reading the vernacular names")
    }

    /// For `unzip`, waits for it to exit and fails if it did not succeed
    /// (a truncated download, or no `VernacularName.tsv` in the archive).
    fn finish(self, source: &Path) -> anyhow::Result<()> {
        if let Input::Unzip(mut child, reader) = self {
            // Close our end of the pipe first, so an unzip that still has
            // output left cannot block forever writing to it.
            drop(reader);
            let status = child.wait().context("waiting for unzip")?;
            if !status.success() {
                bail!(
                    "`unzip -p {} {ZIP_MEMBER}` failed: {status}",
                    source.display()
                );
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_codes() {
        assert_eq!(lang_code("en"), Some("en"));
        assert_eq!(lang_code("eng"), Some("en"));
        assert_eq!(lang_code("EN"), Some("en"));
        assert_eq!(lang_code("por"), Some("pt"));
        assert_eq!(lang_code("pt-BR"), Some("pt"));
        assert_eq!(lang_code(" pt "), Some("pt"));
        assert_eq!(lang_code("ger"), Some("de"));
        assert_eq!(lang_code("xx"), None);
        assert_eq!(lang_code(""), None);
        assert_eq!(parse_langs("en, por").unwrap(), vec!["en", "pt"]);
        assert!(parse_langs("en,klingon").is_err());
        assert!(parse_langs(" , ").is_err());
    }

    #[test]
    fn cleans_names() {
        assert_eq!(clean_name("  Onça \t pintada  "), "Onça pintada");
        assert_eq!(clean_name("   "), "");
    }

    #[test]
    fn header_columns_by_name() {
        let cols = Columns::from_header("language\tvernacularName\ttaxonID").unwrap();
        assert_eq!((cols.taxon, cols.name, cols.lang), (2, 1, 0));
        assert!(Columns::from_header("taxonID\tname").is_err());
    }

    /// The fixture has a header and rows in en, eng, pt, por, pt-BR and
    /// other languages, with repeats, stray spaces and an unknown key.
    #[test]
    fn reads_the_fixture() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/vernacular.tsv");
        // GBIF key → node id, as ingest builds it from OTT sourceinfo.
        let mut node_of_gbif = HashMap::new();
        node_of_gbif.insert(5219426, 10); // Panthera onca
        node_of_gbif.insert(5219404, 11); // Panthera leo
        node_of_gbif.insert(2436436, 12); // Homo sapiens
        let mut scientific = vec![None; 13];
        scientific[10] = Some("Panthera onca");
        let v = read(&path, "en,pt", &node_of_gbif, &scientific).unwrap();

        let got: Vec<(u32, &str, &str, u32)> = v
            .names
            .iter()
            .map(|n| (n.node, n.lang, n.name.as_str(), n.support))
            .collect();
        assert_eq!(
            got,
            vec![
                // "jaguar" twice beats "Jaguar" once.
                (10, "en", "jaguar", 3),
                // Two rows agree on it ("onca  pintada" folds the same), and
                // the accented spelling is kept.
                (10, "pt", "Onça-pintada", 2),
                (10, "pt", "Onca", 1),
                (11, "en", "Lion", 2),
                (11, "en", "African lion", 1),
                (11, "pt", "Leão", 1),
                (12, "en", "Human", 1),
                (12, "pt", "Ser humano", 1),
            ]
        );
        assert_eq!(v.rows_read, 19);
        // Not counted: es, de (twice), a blank code, and an empty name.
        assert_eq!(v.rows_in_langs, 14);
        assert_eq!(v.unmatched, 1);
        // "jaguar" twice, "onca  pintada", "LION" and the scientific name.
        assert_eq!(v.duplicates, 5);
        assert_eq!(v.count("en"), 4);
        assert_eq!(v.count("pt"), 4);
        assert_eq!(v.nodes_covered(), 3);
        // Every row with a known key counts, whatever its language.
        assert_eq!(v.rows_per_node[&10], 8);
        assert_eq!(v.rows_per_node[&11], 6);
        assert_eq!(v.rows_per_node[&12], 4);
        let best = v.best_names();
        assert_eq!(best[&10], "jaguar");
        assert_eq!(best[&11], "Lion");
    }
}
