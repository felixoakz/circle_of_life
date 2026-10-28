//! Reads OTT's `taxonomy.tsv` and keeps the rows for taxa that are in the tree
//! (PLAN §2.2, §3.2 step 2).
//!
//! The file is 417 MB with about 4.5M rows, so it is streamed line by line
//! and only the ~2.4M rows we need are kept. Its format:
//!
//! ```text
//! uid\t|\tparent_uid\t|\tname\t|\trank\t|\tsourceinfo\t|\tuniqname\t|\tflags\t|\t
//! 770315\t|\t770309\t|\tHomo sapiens\t|\tspecies\t|\tncbi:9606,gbif:2436436,…\t|\t\t|\textinct,…\t|\t
//! ```
//!
//! A header row comes first, the separator is `\t|\t`, and every line also
//! *ends* with `\t|\t`, which we strip before splitting.
//!
//! Concepts introduced here:
//! - reading a big file line by line with `BufReader` and one reused `String`
//! - `&str` methods: `strip_suffix`, `split`, `split_once`
//! - collecting pieces of a line into a `Vec<&str>` that borrows from it
//! - `String` (owned) vs `&str` (borrowed), and `.to_string()` to copy

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use anyhow::{Context, bail};

use super::newick::parse_u32;
use super::{Label, Tree};

/// What we keep from one taxonomy row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Taxon {
    /// Scientific name, e.g. "Homo sapiens".
    pub name: String,
    /// e.g. "species", "genus", "no rank - terminal".
    pub rank: String,
    /// Comma-separated OTT flags, e.g. "extinct,sibling_higher". Often empty.
    pub flags: String,
    /// GBIF backbone key, joined to vernacular names in P11.
    pub gbif: Option<u32>,
    /// NCBI taxonomy id.
    pub ncbi: Option<u32>,
}

/// The taxonomy rows for the nodes of one tree.
#[derive(Debug)]
pub struct Taxonomy {
    /// One entry per tree node, by node index. `None` for `mrca` nodes and
    /// for OTT ids the file has no row for.
    pub taxa: Vec<Option<Taxon>>,
    /// Data rows in the file (not counting the header).
    pub rows_read: usize,
    /// Tree nodes labelled `ottN` with no row in the file. Should be 0.
    pub missing: usize,
}

impl Taxonomy {
    /// Scientific name of arena node `node`, or `None` (`mrca` nodes have
    /// none).
    pub fn name(&self, node: usize) -> Option<&str> {
        // `as_ref()` borrows the `Taxon` inside the `Option` instead of
        // moving it out; `map` then picks its name.
        self.taxa[node].as_ref().map(|taxon| taxon.name.as_str())
    }
}

/// Streams `path` and returns the rows for the OTT ids in `tree`.
pub fn read(path: &Path, tree: &Tree) -> anyhow::Result<Taxonomy> {
    let file = File::open(path).with_context(|| format!("opening {}", path.display()))?;
    // LEARN: `BufReader` reads the file in large chunks behind the scenes, so
    // asking it for one line at a time is cheap. Without it, every small read
    // would be a separate system call.
    let mut reader = BufReader::new(file);

    let node_of_ott = tree.ott_index();
    // LEARN: `vec![None; n]` makes a Vec of `n` copies of `None`. It needs
    // `Clone` on the element type, which is why `Taxon` derives it.
    let mut taxa: Vec<Option<Taxon>> = vec![None; tree.len()];
    let mut rows_read = 0;

    // LEARN: one `String` reused for every line. `read_line` appends to it,
    // so we `clear()` it first; the memory it already has is kept, so after
    // the first few lines there are no more allocations for reading.
    let mut line = String::new();
    let mut line_number = 0;
    loop {
        line.clear();
        let bytes = reader
            .read_line(&mut line)
            .with_context(|| format!("reading {}", path.display()))?;
        if bytes == 0 {
            break; // end of file
        }
        line_number += 1;

        let fields = split_row(&line);
        if line_number == 1 && fields.first() == Some(&"uid") {
            continue; // the header
        }
        rows_read += 1;
        if fields.len() < 7 {
            bail!(
                "{} line {line_number}: expected 7 fields, found {}",
                path.display(),
                fields.len()
            );
        }

        // Most rows are not in the tree. Check the uid before copying
        // any strings, so skipped rows cost almost nothing.
        let Some(uid) = parse_u32(fields[0].as_bytes()) else {
            bail!(
                "{} line {line_number}: bad uid {:?}",
                path.display(),
                fields[0]
            );
        };
        let Some(&node) = node_of_ott.get(&uid) else {
            continue;
        };
        taxa[node as usize] = Some(parse_taxon(&fields));
    }

    let mut missing = 0;
    for (node, label) in tree.label.iter().enumerate() {
        if matches!(label, Label::Ott(_)) && taxa[node].is_none() {
            missing += 1;
        }
    }

    Ok(Taxonomy {
        taxa,
        rows_read,
        missing,
    })
}

/// Splits one line into its fields, without the line ending and without the
/// trailing `\t|\t`. The fields borrow from `line`; nothing is copied.
// LEARN: the returned `Vec<&str>` holds slices *of `line`*. The compiler
// checks that `line` outlives them: changing `line` while the Vec is still in
// use would be a compile error, not a bug at run time.
fn split_row(line: &str) -> Vec<&str> {
    let line = line.trim_end_matches(['\n', '\r']);
    // LEARN: `strip_suffix` gives `Some(rest)` when the text ends with the
    // suffix. `unwrap_or(line)` falls back to the whole line when it does not,
    // which keeps us lenient about a missing trailing separator.
    let line = line.strip_suffix("\t|\t").unwrap_or(line);
    let mut fields = Vec::new();
    for field in line.split("\t|\t") {
        fields.push(field);
    }
    fields
}

/// Builds a [`Taxon`] from the fields of a data row (at least 7).
fn parse_taxon(fields: &[&str]) -> Taxon {
    let (gbif, ncbi) = parse_sourceinfo(fields[4]);
    // LEARN: `fields[2]` is a borrowed `&str` pointing into the line buffer,
    // which is overwritten by the next line. `.to_string()` copies it into a
    // new owned `String` that the `Taxon` can keep.
    Taxon {
        name: fields[2].to_string(),
        rank: fields[3].to_string(),
        flags: fields[6].to_string(),
        gbif,
        ncbi,
    }
}

/// Finds the GBIF and NCBI ids in a `sourceinfo` field such as
/// `ncbi:9606,gbif:2436436,irmng:11388931`. Some taxa list a source twice
/// (`gbif:106,gbif:8029077`); the first one wins, as it is OTT's primary.
pub fn parse_sourceinfo(sourceinfo: &str) -> (Option<u32>, Option<u32>) {
    let mut gbif = None;
    let mut ncbi = None;
    for entry in sourceinfo.split(',') {
        // LEARN: `split_once(':')` cuts at the first `:` into a pair, or gives
        // `None` if there is no `:`. Here a tuple pattern takes it apart.
        let Some((source, id)) = entry.split_once(':') else {
            continue;
        };
        if source == "gbif" && gbif.is_none() {
            gbif = parse_u32(id.as_bytes());
        } else if source == "ncbi" && ncbi.is_none() {
            ncbi = parse_u32(id.as_bytes());
        }
    }
    (gbif, ncbi)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tree::newick;

    #[test]
    fn split_row_strips_trailing_separator() {
        let line =
            "770315\t|\t770309\t|\tHomo sapiens\t|\tspecies\t|\tncbi:9606\t|\t\t|\textinct\t|\t\n";
        assert_eq!(
            split_row(line),
            vec![
                "770315",
                "770309",
                "Homo sapiens",
                "species",
                "ncbi:9606",
                "",
                "extinct"
            ]
        );
        // Without the trailing separator (or with Windows line endings) the
        // fields come out the same.
        let line = "1\t|\t2\t|\tx\t|\tgenus\t|\t\t|\t\t|\t\t|\t\r\n";
        assert_eq!(split_row(line), vec!["1", "2", "x", "genus", "", "", ""]);
        assert_eq!(split_row("1\t|\t2"), vec!["1", "2"]);
    }

    #[test]
    fn sourceinfo_parsing() {
        assert_eq!(
            parse_sourceinfo("ncbi:9606,gbif:2436436,irmng:11388931,irmng:10857762"),
            (Some(2436436), Some(9606))
        );
        // First of two gbif ids; silva ids with `/#` are skipped.
        assert_eq!(
            parse_sourceinfo("silva:L19345/#3,ncbi:2763,worms:852,gbif:106,gbif:8029077"),
            (Some(106), Some(2763))
        );
        assert_eq!(
            parse_sourceinfo("silva:E17133/#2,worms:582419"),
            (None, None)
        );
        assert_eq!(parse_sourceinfo(""), (None, None));
        assert_eq!(
            parse_sourceinfo("study713:361838,ncbi:33090"),
            (None, Some(33090))
        );
    }

    /// Writes `contents` to a temporary taxonomy file and reads it for `tree`.
    fn read_str(tree: &Tree, contents: &str) -> Taxonomy {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("taxonomy.tsv");
        std::fs::write(&path, contents).unwrap();
        read(&path, tree).unwrap()
    }

    #[test]
    fn header_is_skipped_and_rows_are_filtered() {
        let tree = newick::parse(b"(ott2,ott3)mrcaott2ott3;").unwrap();
        let contents = "uid\t|\tparent_uid\t|\tname\t|\trank\t|\tsourceinfo\t|\tuniqname\t|\tflags\t|\t\n\
                        1\t|\t\t|\tlife\t|\tno rank\t|\t\t|\t\t|\t\t|\t\n\
                        2\t|\t1\t|\tAlpha\t|\tspecies\t|\tgbif:7\t|\t\t|\textinct\t|\t\n";
        let taxonomy = read_str(&tree, contents);
        assert_eq!(taxonomy.rows_read, 2);
        // Node 0 is the mrca node, node 1 is ott2, node 2 is ott3 (no row).
        assert_eq!(taxonomy.taxa[0], None);
        assert_eq!(
            taxonomy.taxa[1],
            Some(Taxon {
                name: "Alpha".to_string(),
                rank: "species".to_string(),
                flags: "extinct".to_string(),
                gbif: Some(7),
                ncbi: None,
            })
        );
        assert_eq!(taxonomy.taxa[2], None);
        assert_eq!(taxonomy.missing, 1);
    }

    #[test]
    fn short_row_is_an_error() {
        let tree = newick::parse(b"ott2;").unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("taxonomy.tsv");
        std::fs::write(&path, "2\t|\t1\t|\tAlpha\t|\t\n").unwrap();
        assert!(read(&path, &tree).is_err());
    }

    #[test]
    fn mini_fixture() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
        let tree = newick::parse_file(&root.join("mini.tre")).unwrap();
        let taxonomy = read(&root.join("mini_taxonomy.tsv"), &tree).unwrap();
        assert_eq!(taxonomy.missing, 0);
        // Every tree ott id plus "life" (805080), which is not in the tree.
        assert_eq!(taxonomy.rows_read, 57);

        let human = tree.ott_index()[&770315];
        let taxon = taxonomy.taxa[human as usize].as_ref().unwrap();
        assert_eq!(taxon.name, "Homo sapiens");
        assert_eq!(taxon.rank, "species");
        assert_eq!(taxon.gbif, Some(2436436));
        assert_eq!(taxon.ncbi, Some(9606));
    }
}
