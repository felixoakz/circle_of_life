//! The read side of `tree.db` (PLAN §4, §5): opening it read-only and the
//! queries behind the API (meta, tiles, search, node details).
//!
//! Every function here is plain blocking code that takes a `&Connection`.
//! The server decides *where* it runs (on a blocking thread, see
//! `server::run_query`); this module only knows SQL.
//!
//! Concepts introduced here:
//! - `#[derive(Serialize)]`: serde writes the JSON for a struct
//! - `#[serde(rename_all, flatten, skip)]`: shaping that JSON
//! - `FromStr`: parsing a string into our own type with `.parse()`
//! - `OptionalExtension::optional()`: "no row" as `None` instead of an error
//! - `prepare_cached`: reusing compiled statements across calls

use std::path::Path;
use std::str::FromStr;

use anyhow::{Context, bail};
use rusqlite::{Connection, OpenFlags, OptionalExtension, Row, params};
use serde::Serialize;

use super::KIND_SCIENTIFIC;

/// At most this many children are listed in a node's `children.top`. The
/// biggest polytomy in the real tree has 12,964 children; the panel only
/// needs the largest few plus the total.
pub const TOP_CHILDREN: u32 = 50;

/// Candidates fetched from the FTS index before re-ranking (PLAN §5.2).
const SEARCH_CANDIDATES: u32 = 64;

/// How many ancestor names a search result shows as context.
const CONTEXT_NAMES: usize = 3;

/// Ranks at or below genus. A search result's context line skips them: the
/// genus is already in a species' name, and "Homo" says little next to
/// "Homo sapiens". Everything else counts, including named "no rank" clades
/// such as Primates, which OTT leaves unranked.
const AT_OR_BELOW_GENUS: [&str; 16] = [
    "genus",
    "subgenus",
    "section",
    "subsection",
    "series",
    "species group",
    "species subgroup",
    "species",
    "subspecies",
    "variety",
    "varietas",
    "subvariety",
    "forma",
    "form",
    "subform",
    "infraspecificname",
];

/// Queries shorter than this (in characters) match whole words only, not
/// prefixes (see [`search`]).
const PREFIX_MIN_CHARS: usize = 3;

/// Opens `tree.db` for reading only (PLAN §4 "Connections").
pub fn open(path: &Path) -> anyhow::Result<Connection> {
    if !path.exists() {
        bail!(
            "tree database not found at {}; build it with `make ingest` (or `make ingest-mini` and serve with `--db mini.db`)",
            path.display()
        );
    }
    // The READ_ONLY flag is the same as the `file:…?mode=ro` URI in the plan.
    // NO_MUTEX: SQLite's own locking is redundant, our `Mutex` already
    // guarantees one user at a time.
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = Connection::open_with_flags(path, flags)
        .with_context(|| format!("opening {}", path.display()))?;
    // query_only refuses writes even through a bug; mmap lets SQLite read
    // pages straight from the OS page cache instead of copying them.
    conn.pragma_update(None, "query_only", true)?;
    conn.pragma_update(None, "mmap_size", 1_i64 << 30)?;
    Ok(conn)
}

/// The stored body of `GET /api/meta`, verbatim.
pub fn meta_json(conn: &Connection) -> rusqlite::Result<String> {
    conn.query_row("SELECT value FROM meta WHERE key = 'meta'", [], |row| {
        row.get(0)
    })
}

/// The gzipped tile blob, or `None` for an empty (absent) tile.
pub fn tile(conn: &Connection, level: u8, sector: u32) -> rusqlite::Result<Option<Vec<u8>>> {
    // LEARN: `prepare_cached` is `prepare` plus a small per-connection cache
    // keyed by the SQL text: the second call skips compiling the statement.
    // Worth it here because the same few queries run thousands of times.
    let mut stmt =
        conn.prepare_cached("SELECT data FROM tiles WHERE level = ?1 AND sector = ?2")?;
    // LEARN: `query_row` treats "no row" as an error (`QueryReturnedNoRows`).
    // `.optional()` (from the `OptionalExtension` trait, which must be in
    // scope via `use`) turns exactly that case into `Ok(None)` and a found
    // row into `Ok(Some(…))`, while real errors stay errors.
    stmt.query_row(params![level, sector], |row| row.get(0))
        .optional()
}

/// How a client names a node in `/api/nodes/{ref}` (PLAN §5.1).
#[derive(Debug, Clone, PartialEq)]
pub enum NodeRef {
    /// Pre-order id, as stored in tiles: `1134830`.
    Id(u32),
    /// OTT taxon: `ott770315`.
    Ott(u32),
    /// Unnamed clade, OpenTree's own id: `mrcaott786ott3428`. Never parsed further.
    Mrca(String),
}

// LEARN: implementing the standard `FromStr` trait is what makes
// `"ott770315".parse::<NodeRef>()` work, exactly like `"42".parse::<u32>()`.
// `type Err` names the error type `parse` returns; a `String` message is
// enough here because the caller only shows it to the client.
impl FromStr for NodeRef {
    type Err = String;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        if text.starts_with("mrcaott") {
            return Ok(NodeRef::Mrca(text.to_string()));
        }
        if let Some(digits) = text.strip_prefix("ott") {
            if let Ok(ott) = digits.parse() {
                return Ok(NodeRef::Ott(ott));
            }
        } else if let Ok(id) = text.parse() {
            return Ok(NodeRef::Id(id));
        }
        Err(format!(
            "bad node reference {text:?}: expected a number, ott<number> or mrcaott…"
        ))
    }
}

// LEARN: `#[derive(Serialize)]` asks serde to write the code that turns this
// struct into JSON (or any other format). `rename_all = "camelCase"` renames
// the fields on the way out (`leaf_count` → `leafCount`), so Rust keeps its
// snake_case and the JavaScript client gets its camelCase.
/// The columns of one `nodes` row that the API sends.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeRow {
    pub id: u32,
    pub node_id: String,
    pub name: Option<String>,
    pub rank: Option<String>,
    pub group: u8,
    pub flags: u8,
    pub leaf_count: u32,
    pub child_count: u32,
    pub level: u8,
    pub angle: u32,
    pub arc_lo: u32,
    pub arc_hi: u32,
    /// f32, as in the tiles: the JSON shows the same short number (`0.724`)
    /// the client decoded from the tile, not a widened `0.7239999771118164`.
    pub r: f32,
    /// Sent inside `ids`, not at the top level.
    // LEARN: `#[serde(skip)]` leaves a field out of the JSON entirely.
    #[serde(skip)]
    pub gbif_id: Option<i64>,
    #[serde(skip)]
    pub ncbi_id: Option<i64>,
    /// Best English (else Portuguese) common name from GBIF, if any (P11).
    pub common_name: Option<String>,
    /// GBIF common-name rows in any language: a rough fame measure for
    /// ranking search results.
    #[serde(skip)]
    pub vernacular_rows: u32,
}

/// Column list matching [`node_from_row`].
const NODE_COLUMNS: &str = "id, node_id, name, rank, grp, flags, leaf_count, child_count, level,
                            angle, arc_lo, arc_hi, r, gbif_id, ncbi_id, common_name,
                            vernacular_rows";

fn node_from_row(row: &Row) -> rusqlite::Result<NodeRow> {
    Ok(NodeRow {
        id: row.get(0)?,
        node_id: row.get(1)?,
        name: row.get(2)?,
        rank: row.get(3)?,
        group: row.get(4)?,
        flags: row.get(5)?,
        leaf_count: row.get(6)?,
        child_count: row.get(7)?,
        level: row.get(8)?,
        angle: row.get(9)?,
        arc_lo: row.get(10)?,
        arc_hi: row.get(11)?,
        // Stored as an f64 that came from an f32, so this cast is exact.
        r: row.get::<_, f64>(12)? as f32,
        gbif_id: row.get(13)?,
        ncbi_id: row.get(14)?,
        common_name: row.get(15)?,
        vernacular_rows: row.get(16)?,
    })
}

fn node_by_id(conn: &Connection, id: u32) -> rusqlite::Result<Option<NodeRow>> {
    let sql = format!("SELECT {NODE_COLUMNS} FROM nodes WHERE id = ?1");
    let mut stmt = conn.prepare_cached(&sql)?;
    stmt.query_row(params![id], node_from_row).optional()
}

/// The pre-order id a reference points at, if that node exists.
pub fn resolve(conn: &Connection, node: &NodeRef) -> rusqlite::Result<Option<u32>> {
    let node_id = match node {
        NodeRef::Id(id) => {
            let mut stmt = conn.prepare_cached("SELECT id FROM nodes WHERE id = ?1")?;
            return stmt.query_row(params![id], |row| row.get(0)).optional();
        }
        NodeRef::Ott(ott) => format!("ott{ott}"),
        NodeRef::Mrca(text) => text.clone(),
    };
    let mut stmt = conn.prepare_cached("SELECT id FROM nodes WHERE node_id = ?1")?;
    stmt.query_row(params![node_id], |row| row.get(0))
        .optional()
}

/// One ancestor in a node's lineage: enough to label it and to draw the
/// selection path (each ancestor's point is at `(angle, r)`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineageEntry {
    pub id: u32,
    pub node_id: String,
    pub name: Option<String>,
    pub rank: Option<String>,
    pub group: u8,
    pub angle: u32,
    pub r: f32,
}

/// Every ancestor of `id`, root first, parent last (empty for the root).
pub fn ancestors(conn: &Connection, id: u32) -> rusqlite::Result<Vec<LineageEntry>> {
    // A recursive CTE walks up the parent links inside SQLite: start at the
    // node's parent, then repeatedly add the parent of the last row added.
    let mut stmt = conn.prepare_cached(
        "WITH RECURSIVE up(id) AS (
             SELECT parent FROM nodes WHERE id = ?1 AND parent IS NOT NULL
             UNION ALL
             SELECT n.parent FROM nodes n JOIN up ON n.id = up.id WHERE n.parent IS NOT NULL
         )
         SELECT n.id, n.node_id, n.name, n.rank, n.grp, n.angle, n.r
         FROM up JOIN nodes n ON n.id = up.id
         ORDER BY n.depth",
    )?;
    let rows = stmt.query_map(params![id], |row| {
        Ok(LineageEntry {
            id: row.get(0)?,
            node_id: row.get(1)?,
            name: row.get(2)?,
            rank: row.get(3)?,
            group: row.get(4)?,
            angle: row.get(5)?,
            r: row.get::<_, f64>(6)? as f32,
        })
    })?;
    let mut lineage = Vec::new();
    for row in rows {
        lineage.push(row?);
    }
    Ok(lineage)
}

/// A child in `children.top`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildEntry {
    pub id: u32,
    pub node_id: String,
    pub name: Option<String>,
    pub rank: Option<String>,
    pub group: u8,
    pub leaf_count: u32,
}

/// `total` direct children; `top` holds the [`TOP_CHILDREN`] largest by
/// leaf count (ties by id), so a 12k-child polytomy stays a small response.
#[derive(Debug, Clone, Serialize)]
pub struct Children {
    pub total: u32,
    pub top: Vec<ChildEntry>,
}

/// External ids, for links in the panel.
#[derive(Debug, Clone, Serialize)]
pub struct Ids {
    pub ott: Option<u32>,
    pub gbif: Option<i64>,
    pub ncbi: Option<i64>,
}

/// The body of `GET /api/nodes/{ref}`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeDetail {
    // LEARN: `#[serde(flatten)]` writes the inner struct's fields directly
    // into this object instead of nesting them under a `node` key, so the
    // JSON has `id`, `nodeId`, … next to `ids` and `lineage`.
    #[serde(flatten)]
    pub node: NodeRow,
    pub ids: Ids,
    /// Root first, parent last; the node itself is not included.
    pub lineage: Vec<LineageEntry>,
    pub children: Children,
    /// For an unnamed (`mrca…`) node, the nearest named ancestor.
    pub named_ancestor: Option<LineageEntry>,
}

/// Everything the panel needs about one node, or `None` if it does not exist.
pub fn node_detail(conn: &Connection, node: &NodeRef) -> rusqlite::Result<Option<NodeDetail>> {
    let Some(id) = resolve(conn, node)? else {
        return Ok(None);
    };
    let Some(row) = node_by_id(conn, id)? else {
        return Ok(None);
    };

    let lineage = ancestors(conn, id)?;
    let mut named_ancestor = None;
    if row.name.is_none() {
        // Walk from the parent towards the root; the first name wins.
        for entry in lineage.iter().rev() {
            if entry.name.is_some() {
                named_ancestor = Some(entry.clone());
                break;
            }
        }
    }

    // `nodes_parent (parent, leaf_count DESC)` serves this without sorting
    // all children of a huge polytomy.
    let mut stmt = conn.prepare_cached(
        "SELECT id, node_id, name, rank, grp, leaf_count FROM nodes
         WHERE parent = ?1 ORDER BY leaf_count DESC, id LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![id, TOP_CHILDREN], |row| {
        Ok(ChildEntry {
            id: row.get(0)?,
            node_id: row.get(1)?,
            name: row.get(2)?,
            rank: row.get(3)?,
            group: row.get(4)?,
            leaf_count: row.get(5)?,
        })
    })?;
    let mut top = Vec::new();
    for child in rows {
        top.push(child?);
    }

    let ids = Ids {
        ott: row
            .node_id
            .strip_prefix("ott")
            .and_then(|digits| digits.parse().ok()),
        gbif: row.gbif_id,
        ncbi: row.ncbi_id,
    };
    let children = Children {
        total: row.child_count,
        top,
    };
    Ok(Some(NodeDetail {
        node: row,
        ids,
        lineage,
        children,
        named_ancestor,
    }))
}

/// One search result (PLAN §5.1).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    #[serde(flatten)]
    pub node: NodeRow,
    /// The name that matched: scientific, or a common name (P11).
    pub matched: String,
    /// `"scientific"` or `"vernacular"`.
    pub matched_kind: &'static str,
    /// The language of a vernacular match (`"en"`, `"pt"`); `None` for a
    /// scientific one.
    pub matched_lang: Option<String>,
    /// The 3 nearest named ancestors above genus, broadest first: for Homo
    /// sapiens "Simiiformes, Catarrhini, Homininae" (see [`context_names`]).
    pub lineage: Vec<String>,
    #[serde(skip)]
    pub score: f64,
}

/// `homo  Sap` → `Some("\"homo\"* AND \"sap\"*")`; `None` if nothing is left.
/// With `prefix` false the terms match whole words only (`"ox"`).
pub fn fts_query(query: &str, prefix: bool) -> Option<String> {
    let star = if prefix { "*" } else { "" };
    let mut parts = Vec::new();
    for token in query.split_whitespace() {
        // Quotes are the only special character inside an FTS5 string, so
        // removing them makes any user input a safe prefix term.
        let token = token.replace('"', "");
        if !token.is_empty() {
            parts.push(format!("\"{token}\"{star}"));
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" AND "))
    }
}

/// The ranking of PLAN §5.2. `query` is already [`fold`]ed.
pub fn score(query: &str, matched: &str, kind: u8, node: &NodeRow) -> f64 {
    // Folded like the query, so "onça" equals GBIF's "Onca" and
    // "onça pintada" equals "Onça-pintada", as they do in the FTS index.
    let name = fold(matched);
    let mut score = 0.0;
    if name == query {
        score += 100.0;
    }
    if name.starts_with(query) {
        score += 20.0;
    }
    if kind == KIND_SCIENTIFIC {
        score += 5.0;
    }
    // Big clades beat obscure tips of the same name quality.
    score += 2.0 * (node.leaf_count as f64 + 1.0).log10();
    // And well-known taxa beat obscure ones: "onça" is the jaguar's name
    // before it is any other cat's. ~1 for a beetle with one common name,
    // ~5 for the lion with ~60.
    score += 3.0 * (node.vernacular_rows as f64 + 1.0).log10();
    if node.rank.as_deref() == Some("species") {
        score += 1.0;
    }
    score
}

/// Lowercase, Latin accents removed, and anything that is not a letter or
/// digit turned into a single space: `"Onça-pintada "` → `"onca pintada"`.
/// The same folding the FTS tokenizer (`unicode61 remove_diacritics 2`)
/// applies to each word, so scoring agrees with what matched.
pub fn fold(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    // Starts true so leading separators are dropped.
    let mut after_space = true;
    for c in text.chars().flat_map(char::to_lowercase) {
        // LEARN: a `match` arm can be a range of characters (`'à'..='å'`,
        // both ends included) or several patterns joined with `|`. These
        // ranges are runs of consecutive code points in Unicode's Latin-1
        // block: à á â ã ä å, è é ê ë, and so on.
        let plain = match c {
            'à'..='å' | 'ā' | 'ă' | 'ą' => 'a',
            'ç' | 'ć' | 'č' => 'c',
            'è'..='ë' | 'ē' | 'ė' | 'ę' | 'ě' => 'e',
            'ì'..='ï' | 'ī' | 'į' => 'i',
            'ñ' | 'ń' | 'ň' => 'n',
            'ò'..='ö' | 'ø' | 'ō' | 'ő' => 'o',
            'ù'..='ü' | 'ū' | 'ů' | 'ű' => 'u',
            'ý' | 'ÿ' => 'y',
            'š' | 'ś' => 's',
            'ž' | 'ź' | 'ż' => 'z',
            other => other,
        };
        if plain.is_alphanumeric() {
            out.push(plain);
            after_space = false;
        } else if !after_space {
            out.push(' ');
            after_space = true;
        }
    }
    if out.ends_with(' ') {
        out.pop();
    }
    out
}

/// Search scientific and common (P11) names; best match first.
pub fn search(
    conn: &Connection,
    raw_query: &str,
    limit: usize,
) -> rusqlite::Result<Vec<SearchHit>> {
    // Normalise: collapse whitespace, lowercase.
    let words: Vec<&str> = raw_query.split_whitespace().collect();
    let query = words.join(" ").to_lowercase();
    let folded = fold(&query);
    let chars = query.chars().count();
    if chars < 2 {
        return Ok(Vec::new());
    }
    // A two-letter prefix matches tens of thousands of names ("ho"* → 27k),
    // and bm25 has to score all of them to pick 64: ~30 ms warm and up to a
    // second cold, for a list of arbitrary names nobody wanted. Ordering
    // those by clade size instead costs as much (every match needs its
    // `nodes` row). So a short query matches whole words only: still cheap
    // (a handful of rows), and it still finds the genuinely short names
    // ("Aa", an orchid genus; "ox" once common names arrive in P11). The
    // palette debounces typing, so "ho" on the way to "homo" is rarely sent.
    let prefix = chars >= PREFIX_MIN_CHARS;
    let Some(fts) = fts_query(&query, prefix) else {
        return Ok(Vec::new());
    };

    // bm25 (`ORDER BY rank`) only picks the candidates; the final order is
    // our own score, which knows about exact matches and clade size.
    //
    // With common names a prefix can match thousands of names ("cat"* →
    // 10k: Catostomus catostomus, Cattleya, …), and bm25's best 64 of those
    // need not include the plain "Cat". So whole words are asked for first
    // (`"cat"` → a few hundred), and the prefix candidates are added after.
    let mut rows = Vec::new();
    if prefix && let Some(words) = fts_query(&query, false) {
        rows = candidates(conn, &words)?;
    }
    rows.extend(candidates(conn, &fts)?);

    let mut hits: Vec<SearchHit> = Vec::new();
    for candidate in rows {
        let Candidate {
            node: id,
            name: matched,
            kind,
            lang,
        } = candidate;
        let Some(node) = node_by_id(conn, id)? else {
            continue;
        };
        let score = score(&folded, &matched, kind, &node);
        // Several names can point at one node (P11); keep its best match.
        // On a tie the earlier candidate stays: bm25 put it first.
        if let Some(existing) = hits.iter_mut().find(|hit| hit.node.id == id) {
            if score > existing.score {
                existing.score = score;
                existing.matched = matched;
                existing.matched_kind = kind_name(kind);
                existing.matched_lang = lang;
            }
            continue;
        }
        hits.push(SearchHit {
            node,
            matched,
            matched_kind: kind_name(kind),
            matched_lang: lang,
            lineage: Vec::new(),
            score,
        });
    }

    // Highest score first; ties go to the bigger clade, then the lower id,
    // so the order is stable between runs.
    hits.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then(b.node.leaf_count.cmp(&a.node.leaf_count))
            .then(a.node.id.cmp(&b.node.id))
    });
    hits.truncate(limit);

    for hit in &mut hits {
        hit.lineage = context_names(conn, hit.node.id)?;
    }
    Ok(hits)
}

/// One `names_fts` row that matched a query.
struct Candidate {
    node: u32,
    name: String,
    kind: u8,
    lang: Option<String>,
}

/// The best [`SEARCH_CANDIDATES`] names for an FTS query, by bm25.
fn candidates(conn: &Connection, fts: &str) -> rusqlite::Result<Vec<Candidate>> {
    let mut stmt = conn.prepare_cached(
        "SELECT node, name, kind, lang FROM names_fts WHERE names_fts MATCH ?1
         ORDER BY rank LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![fts, SEARCH_CANDIDATES], |row| {
        Ok(Candidate {
            node: row.get(0)?,
            name: row.get(1)?,
            kind: row.get(2)?,
            lang: row.get(3)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

fn kind_name(kind: u8) -> &'static str {
    if kind == KIND_SCIENTIFIC {
        "scientific"
    } else {
        "vernacular"
    }
}

/// The names of the [`CONTEXT_NAMES`] nearest named ancestors above genus,
/// broadest first: the one-line context under a search result.
///
/// Rank alone is a poor filter on real data: Homo sapiens has Homo (genus),
/// Homininae (subfamily), Catarrhini (parvorder), Simiiformes (infraorder)
/// and Primates ("no rank") above it, while the tree has no Hominidae node
/// at all. Picking only phylum/class/order/family gave "Chordata, Mammalia",
/// which says nothing about apes. So any named ancestor counts, except
/// genus-and-below ranks, OTT's placeholder names and the root.
fn context_names(conn: &Connection, id: u32) -> rusqlite::Result<Vec<String>> {
    let mut names = Vec::new();
    // Nearest first (the parent is last in `ancestors`)...
    for entry in ancestors(conn, id)?.into_iter().rev() {
        // Unnamed (mrca) nodes have neither.
        let (Some(name), Some(rank)) = (entry.name, entry.rank) else {
            continue;
        };
        // The root (pre-order id 0, "cellular organisms") is above everything
        // and says nothing.
        if entry.id == 0 || AT_OR_BELOW_GENUS.contains(&rank.as_str()) || is_placeholder_name(&name)
        {
            continue;
        }
        names.push(name);
        if names.len() == CONTEXT_NAMES {
            break;
        }
    }
    // ...then flipped so the line reads from broad to narrow.
    names.reverse();
    Ok(names)
}

/// OTT bookkeeping names that are not taxa a reader would recognise:
/// "h2007-1" style codes and "… incertae sedis", "unclassified …",
/// "environmental samples" containers. The same rule as the frontend's
/// `isPlaceholderName` (web/src/names.ts).
pub fn is_placeholder_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.contains("incertae sedis")
        || lower.starts_with("unclassified")
        || lower.starts_with("environmental samples")
        || is_h_code(name)
}

/// `h2007-1`: an `h`, four digits, a dash, then digits.
fn is_h_code(name: &str) -> bool {
    let Some(rest) = name.strip_prefix('h') else {
        return false;
    };
    let Some((year, number)) = rest.split_once('-') else {
        return false;
    };
    let all_digits = |text: &str| !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit());
    year.len() == 4 && all_digits(year) && all_digits(number)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_node_refs() {
        assert_eq!("1134830".parse(), Ok(NodeRef::Id(1134830)));
        assert_eq!("ott770315".parse(), Ok(NodeRef::Ott(770315)));
        assert_eq!(
            "mrcaott786ott3428".parse(),
            Ok(NodeRef::Mrca("mrcaott786ott3428".to_string()))
        );
        assert!("ott".parse::<NodeRef>().is_err());
        assert!("ottx1".parse::<NodeRef>().is_err());
        assert!("felis".parse::<NodeRef>().is_err());
        assert!("-1".parse::<NodeRef>().is_err());
    }

    #[test]
    fn builds_fts_queries() {
        assert_eq!(
            fts_query("homo  sap", true).as_deref(),
            Some("\"homo\"* AND \"sap\"*")
        );
        assert_eq!(fts_query("a\"b", true).as_deref(), Some("\"ab\"*"));
        assert_eq!(fts_query("ox", false).as_deref(), Some("\"ox\""));
        assert_eq!(fts_query("\" \"", true), None);
    }

    #[test]
    fn folds_like_the_fts_tokenizer() {
        assert_eq!(fold("Onça-pintada "), "onca pintada");
        assert_eq!(fold("  onca   PINTADA"), "onca pintada");
        assert_eq!(fold("Leão"), "leao");
        assert_eq!(fold("Lion's mane"), "lion s mane");
        assert_eq!(fold("Homo sapiens"), "homo sapiens");
        assert_eq!(fold("--"), "");
    }

    #[test]
    fn spots_placeholder_names() {
        assert!(is_placeholder_name("h2007-1"));
        assert!(is_placeholder_name("Fungi incertae sedis"));
        assert!(is_placeholder_name("unclassified Bacteria"));
        assert!(is_placeholder_name("environmental samples"));
        assert!(!is_placeholder_name("Homininae"));
        assert!(!is_placeholder_name("h2007"));
        assert!(!is_placeholder_name("hominoid-1"));
        assert!(!is_placeholder_name("BD1-5"));
    }
}
