//! `species ingest`: turns the raw synth tree and taxonomy into `tree.db`
//! (PLAN §3).
//!
//! The steps: parse the tree, read the taxonomy, compute the layout, groups
//! and LOD levels, read the GBIF common names (with `--vernacular`, P11),
//! cut and gzip the tiles, and write `tree.db` (via
//! `<out>.tmp` and an atomic rename). Every step prints its timing; the end
//! prints the database size, tile statistics and peak memory. With
//! `--dry-run` it stops before the tiles and writes nothing.
//!
//! Concepts introduced here:
//! - timing work with `std::time::Instant`
//! - formatting numbers with `format!` and `{:.1}`
//! - reading a Linux `/proc` file to learn about our own process

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::path::Path;
use std::time::Instant;

use crate::config::IngestArgs;
use crate::db;
use crate::tiles::{self, Tiles};
use crate::tree::layout::{self, Layout};
use crate::tree::taxonomy::Taxonomy;
use crate::tree::{Tree, groups, lod, newick, taxonomy};
use crate::vernacular::{self, Vernaculars};

/// Largest gzipped tile we accept (PLAN §3.6, P3): above this, P should be
/// lowered to 256.
pub const MAX_TILE_GZ: usize = 120 * 1024;

/// Runs `species ingest`.
pub fn run(args: &IngestArgs) -> anyhow::Result<()> {
    let total = Instant::now();

    // LEARN: `Instant::now()` is a point on a monotonic clock (one that never
    // jumps back like wall-clock time can); `.elapsed()` is the `Duration`
    // since then.
    let started = Instant::now();
    let tree = newick::parse_file(&args.tree)?;
    let parse_time = started.elapsed();

    let started = Instant::now();
    let taxonomy = taxonomy::read(&args.taxonomy, &tree)?;
    let taxonomy_time = started.elapsed();

    let started = Instant::now();
    let layout = layout::compute(&tree)?;
    let layout_time = started.elapsed();

    // LEARN: `{:>10}` right-aligns in 10 columns; `{:.1}` prints a float
    // with one decimal. `as_secs_f64()` turns a `Duration` into seconds.
    println!("nodes             {:>10}", thousands(tree.len()));
    println!("tips              {:>10}", thousands(tree.tip_count()));
    println!("mrca nodes        {:>10}", thousands(tree.mrca_count()));
    println!("taxonomy rows     {:>10}", thousands(taxonomy.rows_read));
    println!("missing taxonomy  {:>10}", thousands(taxonomy.missing));
    println!("parse tree        {:>9.1}s", parse_time.as_secs_f64());
    println!("read taxonomy     {:>9.1}s", taxonomy_time.as_secs_f64());
    println!("layout            {:>9.1}s", layout_time.as_secs_f64());
    print_layout(&tree, &layout);

    let mut vernaculars = None;
    if let Some(source) = &args.vernacular {
        let started = Instant::now();
        let names = read_vernaculars(source, &args.langs, &taxonomy, &layout)?;
        println!(
            "common names      {:>9.1}s",
            started.elapsed().as_secs_f64()
        );
        print_vernaculars(&names, &args.langs)?;
        vernaculars = Some(names);
    }

    if !args.dry_run {
        let started = Instant::now();
        let tiles = tiles::build(&tree, &taxonomy, &layout)?;
        println!(
            "tiles             {:>9.1}s",
            started.elapsed().as_secs_f64()
        );
        print_tiles(&tiles);

        let started = Instant::now();
        let bytes = db::write(
            &args.out,
            &tree,
            &taxonomy,
            &layout,
            &tiles,
            vernaculars.as_ref(),
        )?;
        println!(
            "write db          {:>9.1}s",
            started.elapsed().as_secs_f64()
        );
        println!(
            "database          {:>7} MB  {}",
            thousands((bytes / (1024 * 1024)) as usize),
            args.out.display()
        );
        println!("dataVersion       {}", db::data_version(tiles.hash));
    }

    println!("total             {:>9.1}s", total.elapsed().as_secs_f64());
    match peak_rss_mb() {
        Some(mb) => println!("peak RSS          {:>7} MB", thousands(mb)),
        None => println!("peak RSS          (unknown on this OS)"),
    }
    Ok(())
}

/// Reads the GBIF common names for our nodes (P11). The join is GBIF key →
/// pre-order node id, through the `gbif:` ids OTT lists in `sourceinfo`.
fn read_vernaculars(
    source: &Path,
    langs: &str,
    taxonomy: &Taxonomy,
    layout: &Layout,
) -> anyhow::Result<Vernaculars> {
    let mut node_of_gbif: HashMap<u32, u32> = HashMap::new();
    let mut scientific: Vec<Option<&str>> = Vec::with_capacity(layout.len());
    let mut shared = 0;
    for id in 0..layout.len() {
        let node = layout.node[id] as usize;
        scientific.push(taxonomy.name(node));
        let Some(gbif) = taxonomy.taxa[node].as_ref().and_then(|taxon| taxon.gbif) else {
            continue;
        };
        // A GBIF key on two OTT taxa is rare; the first in pre-order (the
        // ancestor) keeps it.
        match node_of_gbif.entry(gbif) {
            Entry::Occupied(_) => shared += 1,
            Entry::Vacant(slot) => {
                slot.insert(id as u32);
            }
        }
    }
    println!("nodes with gbif   {:>10}", thousands(node_of_gbif.len()));
    if shared > 0 {
        println!("shared gbif keys  {:>10}", thousands(shared));
    }
    vernacular::read(source, langs, &node_of_gbif, &scientific)
}

fn print_vernaculars(names: &Vernaculars, langs: &str) -> anyhow::Result<()> {
    println!("vernacular rows   {:>10}", thousands(names.rows_read));
    println!("  in {:<12} {:>10}", langs, thousands(names.rows_in_langs));
    println!("  not in tree     {:>10}", thousands(names.unmatched));
    println!("  duplicates      {:>10}", thousands(names.duplicates));
    for lang in vernacular::parse_langs(langs)? {
        println!(
            "names kept {:<6} {:>10}",
            lang,
            thousands(names.count(lang))
        );
    }
    println!("nodes with names  {:>10}", thousands(names.nodes_covered()));
    Ok(())
}

/// Tile count, sizes, and the largest tile against [`MAX_TILE_GZ`].
fn print_tiles(tiles: &Tiles) {
    let mut gz_total = 0;
    let mut raw_total = 0;
    let mut largest = &tiles.tiles[0];
    let mut most_nodes = 0;
    for tile in &tiles.tiles {
        gz_total += tile.gz.len();
        raw_total += tile.raw_len;
        most_nodes = most_nodes.max(tile.count);
        if tile.gz.len() > largest.gz.len() {
            largest = tile;
        }
    }
    println!("tile count        {:>10}", thousands(tiles.tiles.len()));
    println!(
        "tiles total       {:>7} KB gz, {} KB raw",
        thousands(gz_total / 1024),
        thousands(raw_total / 1024)
    );
    println!(
        "largest tile      {:>7} KB gz, {} KB raw, {} nodes (level {}, sector {})",
        thousands(largest.gz.len() / 1024),
        thousands(largest.raw_len / 1024),
        thousands(largest.count as usize),
        largest.level,
        largest.sector
    );
    println!("most nodes/tile   {:>10}", thousands(most_nodes as usize));
    if largest.gz.len() > MAX_TILE_GZ {
        println!(
            "WARNING: largest tile exceeds {} KB gz; lower lod::P to 256 (PLAN §3.6)",
            MAX_TILE_GZ / 1024
        );
    }
}

/// Group totals, level histogram, group runs and a Homo sapiens sanity line.
fn print_layout(tree: &Tree, layout: &Layout) {
    let mut tips_per_group = [0usize; groups::GROUP_COUNT];
    let mut ungrouped_tips = 0;
    let mut nodes_per_level = vec![0usize; layout.max_level as usize + 1];
    for id in 0..layout.len() {
        nodes_per_level[layout.level[id] as usize] += 1;
        if layout.is_tip(id) {
            let group = layout.group[id] as usize;
            if group < groups::GROUP_COUNT {
                tips_per_group[group] += 1;
            } else {
                ungrouped_tips += 1;
            }
        }
    }

    println!("tips per group");
    for (group, &tips) in tips_per_group.iter().enumerate() {
        println!(
            "  {:<15} {:>10}",
            groups::name(group as u8),
            thousands(tips)
        );
    }
    if ungrouped_tips > 0 {
        println!(
            "  {:<15} {:>10}  (should be 0)",
            "no group",
            thousands(ungrouped_tips)
        );
    }

    println!(
        "nodes per level (P = {}, Lmax = {})",
        lod::P,
        layout.max_level
    );
    for (level, &nodes) in nodes_per_level.iter().enumerate() {
        println!("  {level:>2}              {:>10}", thousands(nodes));
    }

    println!("group runs        {:>10}", layout.group_runs.len());
    for run in &layout.group_runs {
        let percent = 100.0 * run.tips as f64 / layout.tip_count as f64;
        println!(
            "  {:<15} {:>10} tips {:>6.2}% of the circle",
            groups::name(run.group),
            thousands(run.tips as usize),
            percent
        );
    }

    match tiles::home_id(tree, layout) {
        Some(id) => println!(
            "Homo sapiens      id {} depth {} tips {} angle {} ({:.4} turns) r {} level {} group {}",
            id,
            layout.depth[id],
            layout.leaf_count[id],
            layout.angle[id],
            layout.angle[id] as f64 / 4_294_967_296.0,
            layout.r[id],
            layout.level[id],
            groups::name(layout.group[id])
        ),
        None => println!("Homo sapiens      not in the tree"),
    }
}

/// `2725682` → `"2,725,682"`, so the counts are easy to compare with PLAN §2.2.
fn thousands(n: usize) -> String {
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

/// The most memory this process has held at once, in MB. Linux keeps it as
/// `VmHWM` ("high water mark") in `/proc/self/status`; elsewhere this is
/// `None`.
fn peak_rss_mb() -> Option<usize> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    for line in status.lines() {
        // The line looks like `VmHWM:   1234567 kB`.
        if let Some(rest) = line.strip_prefix("VmHWM:") {
            let kb: usize = rest.trim().trim_end_matches("kB").trim().parse().ok()?;
            return Some(kb / 1024);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thousands_separators() {
        assert_eq!(thousands(0), "0");
        assert_eq!(thousands(999), "999");
        assert_eq!(thousands(1000), "1,000");
        assert_eq!(thousands(2725682), "2,725,682");
    }
}
