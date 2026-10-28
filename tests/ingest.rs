//! End-to-end checks of `species ingest` (PLAN §9 P3): build `tree.db` from
//! the mini fixtures, then read it back with plain SQL and the tile decoder.
//! Also writes/checks the golden tile used by the TypeScript decoder tests.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use flate2::read::GzDecoder;
use rusqlite::{Connection, params};
use species::config::IngestArgs;
use species::tiles::{self, FLAG_HOME, FLAG_NAMED, FLAG_SPECIES, FLAG_TIP};
use species::tree::lod;
use species::tree::taxonomy::Taxonomy;
use species::tree::{layout, newick};

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

/// Runs the real ingest on the mini fixtures into a temp dir.
fn build_mini(dir: &Path) -> PathBuf {
    let out = dir.join("mini.db");
    let args = IngestArgs {
        tree: fixture("mini.tre"),
        taxonomy: fixture("mini_taxonomy.tsv"),
        vernacular: Some(fixture("mini_vernacular.tsv")),
        langs: "en,pt".to_string(),
        out: out.clone(),
        dry_run: false,
    };
    species::ingest::run(&args).unwrap();
    out
}

fn gunzip(gz: &[u8]) -> Vec<u8> {
    let mut raw = Vec::new();
    GzDecoder::new(gz).read_to_end(&mut raw).unwrap();
    raw
}

/// Every tile in the database, ungzipped: `(level, sector, raw bytes)`.
fn all_tiles(conn: &Connection) -> Vec<(u8, u32, Vec<u8>)> {
    let mut stmt = conn
        .prepare("SELECT level, sector, data FROM tiles ORDER BY level, sector")
        .unwrap();
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, u8>(0)?,
                row.get::<_, u32>(1)?,
                row.get::<_, Vec<u8>>(2)?,
            ))
        })
        .unwrap();
    let mut tiles = Vec::new();
    for row in rows {
        let (level, sector, gz) = row.unwrap();
        tiles.push((level, sector, gunzip(&gz)));
    }
    tiles
}

/// Every node appears in exactly one tile, the one at
/// `(level, sector_of(angle, level))`, with the same values as `nodes`; the
/// records are internal-first and angle-sorted; decode → encode is lossless.
fn check_tiles_against_nodes(conn: &Connection) {
    // id → (level, angle, parent, flags, name)
    let mut stmt = conn
        .prepare("SELECT id, level, angle, parent, flags, name FROM nodes")
        .unwrap();
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, u32>(0)?,
                (
                    row.get::<_, u8>(1)?,
                    row.get::<_, u32>(2)?,
                    row.get::<_, Option<u32>>(3)?,
                    row.get::<_, u8>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ),
            ))
        })
        .unwrap();
    let mut nodes = HashMap::new();
    for row in rows {
        let (id, values) = row.unwrap();
        nodes.insert(id, values);
    }

    let tip_count = nodes.values().filter(|n| n.3 & FLAG_TIP != 0).count() as u32;
    let mut seen = HashMap::new();
    for (level, sector, raw) in all_tiles(conn) {
        let tile = tiles::decode(&raw).unwrap();
        assert_eq!(tiles::encode(&tile), raw, "re-encoding is byte-identical");
        assert_eq!((tile.level, tile.sector), (level, sector));
        assert!(!tile.nodes.is_empty(), "empty tiles are not stored");

        let internal = tile.internal_count as usize;
        for (i, node) in tile.nodes.iter().enumerate() {
            assert_eq!(node.flags & FLAG_TIP == 0, i < internal, "internal first");
            if i > 0 && i != internal {
                assert!(tile.nodes[i - 1].angle <= node.angle, "sorted by angle");
            }
            let (n_level, n_angle, n_parent, n_flags, n_name) = &nodes[&node.id];
            assert_eq!(*n_level, level);
            assert_eq!(lod::sector_of(*n_angle, level), sector);
            assert_eq!(node.angle, *n_angle);
            // A clade's tips are ranks first_tip .. first_tip + leaf_count.
            let last = node.first_tip + node.leaf_count - 1;
            assert!(layout::tip_angle(node.first_tip, tip_count) <= node.arc_lo);
            assert!(node.arc_hi <= layout::tip_angle(last, tip_count));
            assert_eq!(node.parent, n_parent.unwrap_or(u32::MAX));
            assert_eq!(node.flags, *n_flags);
            assert_eq!(node.name, n_name.clone().unwrap_or_default());
            assert!(seen.insert(node.id, (level, sector)).is_none(), "twice");
        }
    }
    assert_eq!(seen.len(), nodes.len(), "every node is in some tile");
}

#[test]
fn mini_database() {
    let dir = tempfile::tempdir().unwrap();
    let db = build_mini(dir.path());
    assert!(!dir.path().join("mini.db.tmp").exists(), "tmp file renamed");
    let conn = Connection::open(&db).unwrap();

    // Node count: everything in mini.tre.
    let tree = newick::parse_file(&fixture("mini.tre")).unwrap();
    let count: u32 = conn
        .query_row("SELECT count(*) FROM nodes", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count as usize, tree.len());
    assert_eq!(count, 57);

    // Lookup by OpenTree node id; Homo sapiens is the home node. (It is a tip
    // in the mini tree; in the real synth tree it has two subspecies, and
    // the flag still sits on the species node itself.)
    let (id, name, rank, flags, leaf_count, gbif): (u32, String, String, u8, u32, Option<u32>) =
        conn.query_row(
            "SELECT id, name, rank, flags, leaf_count, gbif_id FROM nodes WHERE node_id = ?1",
            params!["ott770315"],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(name, "Homo sapiens");
    assert_eq!(rank, "species");
    assert_eq!(flags, FLAG_TIP | FLAG_HOME | FLAG_NAMED | FLAG_SPECIES);
    assert_eq!(leaf_count, 1);
    assert_eq!(gbif, Some(2436436));
    let homes: u32 = conn
        .query_row(
            "SELECT count(*) FROM nodes WHERE flags & ?1",
            params![FLAG_HOME],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(homes, 1);

    // An mrca node: no name, no rank, not "named".
    let (name, rank, flags): (Option<String>, Option<String>, u8) = conn
        .query_row(
            "SELECT name, rank, flags FROM nodes WHERE node_id = 'mrcaott786ott3428'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!((name, rank, flags & FLAG_NAMED), (None, None, 0));

    // The root has a NULL parent and id 0.
    let root: (u32, Option<u32>) = conn
        .query_row(
            "SELECT id, parent FROM nodes WHERE node_id = 'ott93302'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(root, (0, None));

    // Search: one scientific-name row per named node, prefix queries work.
    let found: u32 = conn
        .query_row(
            "SELECT node FROM names_fts WHERE names_fts MATCH '\"homo\"* AND \"sap\"*' AND kind = 0",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(found, id);
    let (fts_rows, named): (u32, u32) = conn
        .query_row(
            "SELECT (SELECT count(*) FROM names_fts WHERE kind = 0),
                    (SELECT count(*) FROM nodes WHERE name IS NOT NULL)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(fts_rows, named);

    // Common names (P11, mini_vernacular.tsv): kind 1 with a language,
    // repeats and the "Fungi" that only repeats the scientific name dropped,
    // the German and Swedish rows and the unknown key skipped.
    let count_lang = |lang: &str| -> u32 {
        conn.query_row(
            "SELECT count(*) FROM names_fts WHERE kind = 1 AND lang = ?1",
            params![lang],
            |row| row.get(0),
        )
        .unwrap()
    };
    assert_eq!(count_lang("en"), 17);
    assert_eq!(count_lang("pt"), 10);
    let other: u32 = conn
        .query_row(
            "SELECT count(*) FROM names_fts WHERE kind = 1 AND lang NOT IN ('en', 'pt')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(other, 0);
    // Accents fold away in the index: "chimpanze" finds "Chimpanzé".
    let (found, name, lang): (u32, String, String) = conn
        .query_row(
            "SELECT node, name, lang FROM names_fts WHERE names_fts MATCH '\"chimpanze\"' AND kind = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    let pan: u32 = conn
        .query_row(
            "SELECT id FROM nodes WHERE node_id = 'ott417950'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        (found, name.as_str(), lang.as_str()),
        (pan, "Chimpanzé", "pt")
    );
    // Each node keeps its best English name and how many GBIF rows it has.
    let (common, rows): (Option<String>, u32) = conn
        .query_row(
            "SELECT common_name, vernacular_rows FROM nodes WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(common.as_deref(), Some("Human"));
    assert_eq!(rows, 7);

    // Meta: the /api/meta document.
    let meta: String = conn
        .query_row("SELECT value FROM meta WHERE key = 'meta'", [], |row| {
            row.get(0)
        })
        .unwrap();
    let meta: serde_json::Value = serde_json::from_str(&meta).unwrap();
    assert_eq!(meta["nodeCount"], 57);
    assert_eq!(meta["tileP"], 512);
    assert_eq!(meta["home"]["nodeId"], "ott770315");
    assert_eq!(meta["home"]["id"], id);
    assert!(
        meta["dataVersion"]
            .as_str()
            .unwrap()
            .starts_with("otl16.1-ott3.7.3-")
    );
    assert_eq!(meta["groups"].as_array().unwrap().len(), 6);
    assert_eq!(meta["groups"][2]["rootIds"].as_array().unwrap().len(), 3);
    let mut group_tips = 0;
    for group in meta["groups"].as_array().unwrap() {
        group_tips += group["tipCount"].as_u64().unwrap();
    }
    assert_eq!(meta["tipCount"].as_u64().unwrap(), group_tips);

    check_tiles_against_nodes(&conn);
}

/// A generated tree with ~5,000 tips (all group roots present, so layout
/// accepts it) has several LOD levels and many tiles, unlike the one-tile
/// mini tree.
#[test]
fn generated_tree_spreads_over_levels() {
    let mut rng = 12345u64;
    let mut next_ott = 10_000_000u32;
    let mut clade = |tips: usize, ott: u32| {
        let mut text = String::new();
        random_clade(&mut text, tips, &mut rng, &mut next_ott);
        format!("({text})ott{ott}")
    };
    let eukaryota = format!(
        "({},{},{},{},{},{})ott304358",
        clade(3000, 691846),
        clade(400, 352914),
        clade(600, 361838),
        clade(100, 878953),
        clade(20, 664970),
        clade(300, 5246039),
    );
    let newick = format!(
        "({eukaryota},{},{})ott93302;",
        clade(500, 844192),
        clade(50, 996421)
    );
    let tree = newick::parse(newick.as_bytes()).unwrap();
    let taxonomy = Taxonomy {
        taxa: vec![None; tree.len()],
        rows_read: 0,
        missing: 0,
    };
    let layout = layout::compute(&tree).unwrap();
    assert!(layout.max_level >= 3, "Lmax {}", layout.max_level);
    let tiles = tiles::build(&tree, &taxonomy, &layout).unwrap();
    assert!(tiles.tiles.len() > 10);

    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("gen.db");
    species::db::write(&out, &tree, &taxonomy, &layout, &tiles, None).unwrap();
    let conn = Connection::open(&out).unwrap();
    check_tiles_against_nodes(&conn);
}

/// Appends a random clade with `tips` tips (without its own label) to `out`:
/// a mix of binary splits and polytomies, like the real tree.
fn random_clade(out: &mut String, tips: usize, rng: &mut u64, next_ott: &mut u32) {
    let parts = if tips <= 8 { tips } else { 2 + below(rng, 4) };
    let mut left = tips;
    for part in 0..parts {
        let size = if part + 1 == parts {
            left
        } else {
            1 + below(rng, left - (parts - part - 1))
        };
        left -= size;
        if part > 0 {
            out.push(',');
        }
        *next_ott += 1;
        if size == 1 {
            out.push_str(&format!("ott{next_ott}"));
        } else {
            let ott = *next_ott;
            out.push('(');
            random_clade(out, size, rng, next_ott);
            out.push_str(&format!(")ott{ott}"));
        }
    }
}

/// A tiny linear congruential generator: a "random" number below `bound`.
fn below(rng: &mut u64, bound: usize) -> usize {
    *rng = rng
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407);
    ((*rng >> 33) as usize) % bound
}

/// The mini tree fits in one tile, (0, 0). Its raw bytes are the golden
/// fixture the TypeScript decoder is tested against. `make golden`
/// (`UPDATE_GOLDEN=1`) rewrites the file; otherwise the test fails when the
/// encoder's output drifts from it.
#[test]
fn golden_tile() {
    let dir = tempfile::tempdir().unwrap();
    let conn = Connection::open(build_mini(dir.path())).unwrap();
    let tiles = all_tiles(&conn);
    assert_eq!(tiles.len(), 1, "the mini tree is a single tile");
    let (level, sector, raw) = &tiles[0];
    assert_eq!((*level, *sector), (0, 0));

    let path = fixture("golden_tile.bin");
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        std::fs::write(&path, raw).unwrap();
    }
    let golden = std::fs::read(&path).expect("missing golden_tile.bin: run `make golden`");
    assert!(
        golden == *raw,
        "tile bytes changed; if deliberate, run `make golden`"
    );
}
