//! The `tree.db` writer (PLAN §4): nodes, search names, tiles and the meta
//! document, written by `species ingest` in one transaction.
//!
//! The file is built as `<out>.tmp` and renamed over `<out>` only when it is
//! complete, so a server reading the old file never sees a half-written one.
//! The read side (queries for the API) is [`queries`].
//!
//! Concepts introduced here:
//! - `include_str!`: a file's text baked into the binary at compile time
//! - rusqlite: opening a database, `execute_batch`, prepared statements and
//!   `params!`
//! - transactions, and why prepared statements must be dropped before commit
//! - building JSON with `serde_json::json!`
//! - an atomic file replace with `std::fs::rename`

pub mod cache;
pub mod queries;

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, bail};
use rusqlite::{Connection, Transaction, params};
use serde_json::json;

use crate::tiles::{self, Tiles};
use crate::tree::layout::{self, Layout};
use crate::tree::taxonomy::Taxonomy;
use crate::tree::{NO_PARENT, Tree, groups, lod};
use crate::vernacular::Vernaculars;

// LEARN: `include_str!` reads a file *at compile time* (the path is relative
// to this source file) and embeds its text as a `&'static str`. The SQL stays
// in a real `.sql` file with syntax highlighting, yet the binary needs no
// extra file at run time; edit the file and the next build picks it up.
/// The `tree.db` schema.
pub const SCHEMA: &str = include_str!("schema.sql");

/// Source data versions, the first part of `dataVersion` (PLAN §5.1).
pub const SOURCES: &str = "otl16.1-ott3.7.3";

/// `kind` of a scientific name in `names_fts`.
pub const KIND_SCIENTIFIC: u8 = 0;
/// `kind` of a common (vernacular) name in `names_fts` (P11).
pub const KIND_VERNACULAR: u8 = 1;

/// Writes the whole database to `<out>.tmp`, then renames it to `out`.
/// `vernaculars` holds the common names, when ingest was given them.
/// Returns the size of the finished file in bytes.
pub fn write(
    out: &Path,
    tree: &Tree,
    taxonomy: &Taxonomy,
    layout: &Layout,
    tiles: &Tiles,
    vernaculars: Option<&Vernaculars>,
) -> anyhow::Result<u64> {
    let tmp = tmp_path(out);
    if tmp.exists() {
        // Left over from a crashed run; start clean.
        std::fs::remove_file(&tmp).with_context(|| format!("removing {}", tmp.display()))?;
    }

    // Everything that borrows `conn` lives in this block, so the connection
    // is dropped (closing the file) before the rename below.
    {
        let mut conn =
            Connection::open(&tmp).with_context(|| format!("creating {}", tmp.display()))?;
        // This is a scratch file until the rename: if we crash, it is thrown
        // away, so SQLite can skip its rollback journal and fsyncs. That makes
        // the bulk insert several times faster.
        conn.pragma_update(None, "journal_mode", "OFF")?;
        conn.pragma_update(None, "synchronous", "OFF")?;
        // LEARN: `execute_batch` runs a string of several `;`-separated SQL
        // statements that take no parameters, such as a schema file.
        conn.execute_batch(SCHEMA).context("creating the schema")?;

        // LEARN: a transaction groups many statements into one all-or-nothing
        // unit. Outside a transaction SQLite commits after *every* INSERT,
        // which for 2.7M rows would take hours instead of seconds.
        // `transaction()` needs `&mut conn`, so nothing else can use the
        // connection while it is open; if `tx` is dropped without `commit()`
        // (for example when `?` returns early), everything is rolled back.
        let tx = conn.transaction()?;
        insert_nodes(&tx, tree, taxonomy, layout, vernaculars)?;
        if let Some(vernaculars) = vernaculars {
            insert_common_names(&tx, vernaculars)?;
        }
        insert_tiles(&tx, tiles)?;
        let meta = meta_json(tree, taxonomy, layout, tiles);
        tx.execute(
            "INSERT INTO meta (key, value) VALUES ('meta', ?1)",
            params![meta.to_string()],
        )?;
        tx.commit().context("committing tree.db")?;

        // Merge the FTS index's many small segments into one: smaller file,
        // faster searches. Worth it because tree.db is never written again.
        conn.execute_batch("INSERT INTO names_fts(names_fts) VALUES ('optimize')")?;
    }

    // LEARN: `rename` within one filesystem is atomic: anyone opening `out`
    // gets either the old file or the new one, never a mix. A server that
    // already has the old file open keeps reading it until it restarts.
    std::fs::rename(&tmp, out)
        .with_context(|| format!("renaming {} to {}", tmp.display(), out.display()))?;
    Ok(std::fs::metadata(out)?.len())
}

/// `data/tree.db` → `data/tree.db.tmp`.
fn tmp_path(out: &Path) -> PathBuf {
    let mut name = out.as_os_str().to_owned();
    name.push(".tmp");
    PathBuf::from(name)
}

/// One `nodes` row, plus one `names_fts` row per named node.
fn insert_nodes(
    tx: &Transaction,
    tree: &Tree,
    taxonomy: &Taxonomy,
    layout: &Layout,
    vernaculars: Option<&Vernaculars>,
) -> anyhow::Result<()> {
    // Without common names both maps stay empty: every node gets NULL / 0.
    let mut best_names = HashMap::new();
    let no_rows = HashMap::new();
    let mut rows_per_node = &no_rows;
    if let Some(vernaculars) = vernaculars {
        best_names = vernaculars.best_names();
        rows_per_node = &vernaculars.rows_per_node;
    }

    // LEARN: `prepare` compiles the SQL once into a statement; `execute` then
    // only binds new values and runs it. Re-parsing the SQL for each of 2.7M
    // rows would be far slower. The statement borrows `tx`, so it must be
    // dropped before `tx.commit()`; returning from this function does that.
    let mut insert_node = tx.prepare(
        "INSERT INTO nodes (id, parent, node_id, name, rank, grp, flags, leaf_count,
                            child_count, depth, level, angle, arc_lo, arc_hi, r,
                            gbif_id, ncbi_id, common_name, vernacular_rows)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
                 ?18, ?19)",
    )?;
    let mut insert_name =
        tx.prepare("INSERT INTO names_fts (name, node, kind, lang) VALUES (?1, ?2, ?3, NULL)")?;

    for id in 0..layout.len() {
        let node = layout.node[id] as usize;
        let Some(node_id) = tree.label[node].node_id() else {
            bail!("node {id} has no label; every synth node has one");
        };
        // The root's parent is SQL NULL, which rusqlite writes for `None`.
        let parent = if layout.parent[id] == NO_PARENT {
            None
        } else {
            Some(layout.parent[id])
        };
        let taxon = taxonomy.taxa[node].as_ref();
        let name = taxon.map(|t| t.name.as_str());
        let rank = taxon.map(|t| t.rank.as_str());
        let gbif = taxon.and_then(|t| t.gbif);
        let ncbi = taxon.and_then(|t| t.ncbi);

        // LEARN: `params![a, b, …]` binds values to the `?1, ?2, …`
        // placeholders in order. Each value can be a different type (u32,
        // &str, Option<…>, f32, …) as long as rusqlite knows how to turn it
        // into an SQL value (the `ToSql` trait); `None` becomes NULL. Values
        // are never pasted into the SQL text, so a name containing a quote
        // cannot break the statement (no SQL injection).
        insert_node.execute(params![
            id as u32,
            parent,
            node_id,
            name,
            rank,
            layout.group[id],
            tiles::node_flags(tree, taxonomy, layout, id),
            layout.leaf_count[id],
            tree.children[node].len() as u32,
            layout.depth[id],
            layout.level[id],
            layout.angle[id],
            layout.arc_lo[id],
            layout.arc_hi[id],
            layout.r[id],
            gbif,
            ncbi,
            best_names.get(&(id as u32)),
            rows_per_node.get(&(id as u32)).copied().unwrap_or(0),
        ])?;

        if let Some(name) = name {
            insert_name.execute(params![name, id as u32, KIND_SCIENTIFIC])?;
        }
    }
    Ok(())
}

/// One `names_fts` row per common name, `kind` 1 with its language. A
/// node's names go in best supported first (`Vernaculars::names` order).
fn insert_common_names(tx: &Transaction, vernaculars: &Vernaculars) -> anyhow::Result<()> {
    let mut insert =
        tx.prepare("INSERT INTO names_fts (name, node, kind, lang) VALUES (?1, ?2, ?3, ?4)")?;
    for name in &vernaculars.names {
        insert.execute(params![name.name, name.node, KIND_VERNACULAR, name.lang])?;
    }
    Ok(())
}

fn insert_tiles(tx: &Transaction, tiles: &Tiles) -> anyhow::Result<()> {
    let mut insert = tx.prepare("INSERT INTO tiles (level, sector, data) VALUES (?1, ?2, ?3)")?;
    for tile in &tiles.tiles {
        // A `&Vec<u8>` is stored as a BLOB.
        insert.execute(params![tile.level, tile.sector, &tile.gz])?;
    }
    Ok(())
}

/// The body of `GET /api/meta` (PLAN §5.1), stored once so the server can
/// send it verbatim.
pub fn meta_json(
    tree: &Tree,
    taxonomy: &Taxonomy,
    layout: &Layout,
    tiles: &Tiles,
) -> serde_json::Value {
    let mut tips_per_group = [0u32; groups::GROUP_COUNT];
    let mut species_tips = 0u32;
    for id in 0..layout.len() {
        if !layout.is_tip(id) {
            continue;
        }
        let group = layout.group[id] as usize;
        if group < groups::GROUP_COUNT {
            tips_per_group[group] += 1;
        }
        if tiles::node_flags(tree, taxonomy, layout, id) & tiles::FLAG_SPECIES != 0 {
            species_tips += 1;
        }
    }

    let mut group_list = Vec::new();
    for (group, &tip_count) in tips_per_group.iter().enumerate() {
        let mut root_ids = Vec::new();
        for &(ott, root_group) in &groups::ROOTS {
            if root_group as usize == group {
                root_ids.push(format!("ott{ott}"));
            }
        }
        // LEARN: `json!` builds a `serde_json::Value` from JSON-looking
        // syntax; any Rust expression can be a value. (Keys come out sorted
        // alphabetically, serde_json's default map; JSON readers do not care.)
        group_list.push(json!({
            "id": group,
            "name": groups::name(group as u8),
            "rootIds": root_ids,
            "tipCount": tip_count,
        }));
    }

    let mut runs = Vec::new();
    for run in &layout.group_runs {
        runs.push(json!({ "group": run.group, "angleLo": run.angle_lo, "angleHi": run.angle_hi }));
    }

    let home = match tiles::home_id(tree, layout) {
        Some(id) => json!({
            "id": id,
            "nodeId": format!("ott{}", tiles::HOME_OTT),
            "angle": layout.angle[id],
        }),
        None => serde_json::Value::Null,
    };

    json!({
        "dataVersion": data_version(tiles.hash),
        "tipCount": layout.tip_count,
        "speciesCount": species_tips,
        "nodeCount": layout.len(),
        "tileP": lod::P,
        "maxLevel": layout.max_level,
        "r0": layout::R0,
        "groups": group_list,
        "runs": runs,
        "home": home,
    })
}

/// `otl16.1-ott3.7.3-` plus the first 6 hex digits of the tile hash.
pub fn data_version(hash: u64) -> String {
    // `{:016x}`: lowercase hex, zero-padded to all 16 digits of a u64.
    let hex = format!("{hash:016x}");
    format!("{SOURCES}-{}", &hex[..6])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tmp_path_appends_suffix() {
        assert_eq!(
            tmp_path(Path::new("data/tree.db")),
            PathBuf::from("data/tree.db.tmp")
        );
    }

    #[test]
    fn data_version_format() {
        assert_eq!(
            data_version(0x7f3a_9c00_0000_0001),
            "otl16.1-ott3.7.3-7f3a9c"
        );
        assert_eq!(data_version(1), "otl16.1-ott3.7.3-000000");
    }

    #[test]
    fn schema_creates_every_table() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        for table in ["meta", "nodes", "names_fts", "tiles"] {
            let count: i64 = conn
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE name = ?1",
                    params![table],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 1, "{table}");
        }
    }
}
