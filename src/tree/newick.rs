//! Parses the synth tree's Newick text into a [`Tree`] (PLAN §3.2 step 1).
//!
//! Newick writes a tree as nested parentheses: `((A,B)C,D)E;` is a root `E`
//! with children `C` and `D`, and `C` has children `A` and `B`. An internal
//! node's label comes *after* its closing `)`.
//!
//! The parser walks the bytes once, left to right, and keeps the chain of
//! currently open `(` nodes on an explicit stack instead of recursing. The
//! real tree is only 111 levels deep, but a stack in a `Vec` can never
//! overflow the call stack, whatever the input.
//!
//! Supported: `ott123` and `mrcaott1ott2` labels, quoted labels (`'ott123'`,
//! with `''` for a literal quote), missing labels, whitespace between tokens.
//! Not supported: branch lengths (`:0.5`), which the synth tree does not have.
//!
//! Concepts introduced here:
//! - byte strings and slices: `&[u8]`, `b'('`, `text[start..end]`
//! - a `while` loop over an index, the usual shape of a hand-written scanner
//! - `Vec` as a stack (`push`, `pop`, `last`)
//! - `let … else` to unwrap or leave early
//! - `anyhow::bail!` and `anyhow::ensure!` for errors with a message
//! - turning bytes into a number with `str::parse::<u32>()`

use std::path::Path;

use anyhow::{Context, bail, ensure};

use super::{Label, NO_PARENT, Tree};

/// Reads and parses a Newick file.
pub fn parse_file(path: &Path) -> anyhow::Result<Tree> {
    // The whole file (31 MB) in memory is simpler than streaming, and the
    // tree we build from it is ten times bigger anyway.
    let text = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    parse(&text).with_context(|| format!("parsing {}", path.display()))
}

/// Parses Newick text holding exactly one tree that ends with `;`.
// LEARN: `&[u8]` is a *slice*: a borrowed view of some bytes (here, the whole
// file). Working on bytes instead of `&str` is simpler and faster for a
// scanner, because every Newick delimiter is a single ASCII byte.
pub fn parse(text: &[u8]) -> anyhow::Result<Tree> {
    let mut tree = Tree::default();
    // LEARN: a `Vec` doubles as a stack: `push` adds on top, `pop` removes
    // from the top and returns `Option` (`None` when empty), `last` peeks.
    // It holds the internal nodes whose `(` is open, innermost on top.
    let mut open: Vec<u32> = Vec::new();
    // True right after `(` or `,`: the next thing must be a node. If a `,` or
    // `)` comes instead, that node is a tip with no label.
    let mut expect_node = true;
    let mut i = 0;

    // LEARN: a `while` loop over an index lets each branch decide how far to
    // move `i`: one byte for a delimiter, a whole word for a label.
    while i < text.len() {
        // LEARN: `b'('` is the byte value of the ASCII character `(`.
        // `text[i]` indexes the slice and panics if `i` is out of bounds,
        // which the loop condition rules out.
        match text[i] {
            b'(' => {
                let parent = current_parent(&tree, &open, i)?;
                let node = tree.add_node(parent);
                open.push(node);
                expect_node = true;
                i += 1;
            }
            b',' => {
                ensure!(!open.is_empty(), "byte {i}: ',' outside any parentheses");
                if expect_node {
                    add_tip(&mut tree, &open, Label::None, i)?;
                }
                expect_node = true;
                i += 1;
            }
            b')' => {
                if expect_node {
                    add_tip(&mut tree, &open, Label::None, i)?;
                }
                // LEARN: `let … else` unwraps a pattern or runs the `else`
                // block, which must leave the function (here, with an error).
                // It keeps the happy path unindented.
                let Some(node) = open.pop() else {
                    bail!("byte {i}: ')' without a matching '('");
                };
                let (label, next) = read_label(text, i + 1)?;
                tree.label[node as usize] = label;
                expect_node = false;
                i = next;
            }
            b';' => {
                ensure!(open.is_empty(), "byte {i}: ';' before every '(' was closed");
                ensure!(!tree.is_empty(), "byte {i}: ';' before any node");
                // Only whitespace may follow the end of the tree.
                for &byte in &text[i + 1..] {
                    ensure!(
                        byte.is_ascii_whitespace(),
                        "byte {i}: unexpected data after ';'"
                    );
                }
                return Ok(tree);
            }
            byte if byte.is_ascii_whitespace() => i += 1,
            _ => {
                ensure!(expect_node, "byte {i}: label in an unexpected place");
                let (label, next) = read_label(text, i)?;
                add_tip(&mut tree, &open, label, i)?;
                expect_node = false;
                i = next;
            }
        }
    }
    bail!("the tree does not end with ';'")
}

/// The node a new node at byte `pos` hangs under: the innermost open `(`, or
/// nothing if this is the very first node. A second top-level node is an
/// error, because a tree has one root.
fn current_parent(tree: &Tree, open: &[u32], pos: usize) -> anyhow::Result<u32> {
    // LEARN: `.last()` gives `Option<&u32>`; `.copied()` turns it into
    // `Option<u32>`, which is easier to work with for small Copy values.
    match open.last().copied() {
        Some(parent) => Ok(parent),
        None if tree.is_empty() => Ok(NO_PARENT),
        None => bail!("byte {pos}: more than one root"),
    }
}

/// Adds a tip with `label` under the innermost open node.
fn add_tip(tree: &mut Tree, open: &[u32], label: Label, pos: usize) -> anyhow::Result<()> {
    let parent = current_parent(tree, open, pos)?;
    let node = tree.add_node(parent);
    tree.label[node as usize] = label;
    Ok(())
}

/// Reads the label that starts at byte `start` (possibly empty, possibly
/// after some whitespace) and returns it with the index of the first byte
/// after it.
fn read_label(text: &[u8], start: usize) -> anyhow::Result<(Label, usize)> {
    let mut start = start;
    while start < text.len() && text[start].is_ascii_whitespace() {
        start += 1;
    }
    if start < text.len() && text[start] == b'\'' {
        return read_quoted_label(text, start);
    }
    let mut end = start;
    while end < text.len() && !is_delimiter(text[end]) {
        end += 1;
    }
    // LEARN: `text[start..end]` is a sub-slice: bytes `start` up to, but not
    // including, `end`. It borrows; nothing is copied.
    let label = parse_label(&text[start..end], start)?;
    Ok((label, end))
}

/// Reads `'…'`, where `''` inside stands for one `'`.
fn read_quoted_label(text: &[u8], start: usize) -> anyhow::Result<(Label, usize)> {
    let mut word = Vec::new();
    let mut i = start + 1;
    loop {
        ensure!(i < text.len(), "byte {start}: quoted label is never closed");
        if text[i] == b'\'' {
            if i + 1 < text.len() && text[i + 1] == b'\'' {
                word.push(b'\'');
                i += 2;
                continue;
            }
            break;
        }
        word.push(text[i]);
        i += 1;
    }
    let label = parse_label(&word, start)?;
    Ok((label, i + 1))
}

fn is_delimiter(byte: u8) -> bool {
    matches!(byte, b'(' | b')' | b',' | b';') || byte.is_ascii_whitespace()
}

/// Turns a label's text into a [`Label`]. `pos` is only for error messages.
fn parse_label(word: &[u8], pos: usize) -> anyhow::Result<Label> {
    if word.is_empty() {
        return Ok(Label::None);
    }
    // LEARN: a `b"…"` literal is a byte string, the `&[u8]` cousin of `"…"`.
    if word.starts_with(b"mrcaott") {
        let text = std::str::from_utf8(word)?;
        return Ok(Label::Mrca(text.to_string()));
    }
    // LEARN: `strip_prefix` returns `Some(rest)` if the slice starts with the
    // prefix and `None` otherwise: a check and a cut in one call. Joining two
    // `if let`s with `&&` (a "let chain") runs the body only if both match.
    if let Some(digits) = word.strip_prefix(b"ott")
        && let Some(ott) = parse_u32(digits)
    {
        return Ok(Label::Ott(ott));
    }
    bail!(
        "byte {pos}: unknown label {:?} (expected ottN or mrcaottNottM)",
        String::from_utf8_lossy(word)
    )
}

/// Parses ASCII digits as a `u32`; `None` for anything else.
// LEARN: `pub(crate)` makes an item visible to the whole crate (so
// `taxonomy.rs` can use it) but not to other crates such as the binary.
pub(crate) fn parse_u32(digits: &[u8]) -> Option<u32> {
    let text = std::str::from_utf8(digits).ok()?;
    // LEARN: `parse::<u32>()` (the `::<…>` is called a "turbofish") picks the
    // type to parse into. It returns a `Result`; `.ok()` turns that into an
    // `Option`, dropping the error detail we do not need here. It also
    // accepts a leading `+`, which we rule out to keep labels strict.
    if text.starts_with('+') {
        return None;
    }
    text.parse::<u32>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_str(text: &str) -> Tree {
        parse(text.as_bytes()).unwrap()
    }

    #[test]
    fn ott_and_mrca_labels() {
        let tree = parse_str("((ott1,ott2)mrcaott1ott2,ott3)ott93302;");
        assert_eq!(
            tree.label,
            vec![
                Label::Ott(93302),
                Label::Mrca("mrcaott1ott2".to_string()),
                Label::Ott(1),
                Label::Ott(2),
                Label::Ott(3),
            ]
        );
        // Pre-order: every parent index is smaller than its child's.
        assert_eq!(tree.parent, vec![NO_PARENT, 0, 1, 1, 0]);
        assert_eq!(tree.children[0], vec![1, 4]);
        assert_eq!(tree.tip_count(), 3);
        assert_eq!(tree.mrca_count(), 1);
    }

    #[test]
    fn quoted_label() {
        let tree = parse_str("('ott5',ott6)'ott7';");
        assert_eq!(tree.label[0], Label::Ott(7));
        assert_eq!(tree.label[1], Label::Ott(5));
        // `''` inside quotes is one quote, which makes this an unknown label.
        let err = parse(b"('ott''5',ott6)ott7;").unwrap_err();
        assert!(format!("{err:#}").contains("ott'5"), "{err:#}");
    }

    #[test]
    fn unlabelled_nodes() {
        let tree = parse_str("((,ott2),);");
        assert_eq!(tree.len(), 5);
        assert_eq!(tree.label[0], Label::None);
        assert_eq!(tree.label[1], Label::None);
        assert_eq!(tree.label[2], Label::None);
        assert_eq!(tree.label[3], Label::Ott(2));
        assert_eq!(tree.label[4], Label::None);
        assert_eq!(tree.tip_count(), 3);
    }

    #[test]
    fn polytomy() {
        let tree = parse_str("(ott1,ott2,ott3,ott4,ott5,ott6,ott7,ott8)ott9;");
        assert_eq!(tree.children[0].len(), 8);
        assert_eq!(tree.children[0], vec![1, 2, 3, 4, 5, 6, 7, 8]);
    }

    #[test]
    fn trailing_semicolon() {
        // Whitespace and a final newline are fine…
        assert_eq!(parse_str(" ( ott1 , ott2 ) ott3 ;\n").len(), 3);
        // …a missing `;` or data after it is not.
        assert!(parse(b"(ott1,ott2)ott3").is_err());
        assert!(parse(b"(ott1,ott2)ott3;ott4").is_err());
    }

    #[test]
    fn malformed_input_is_an_error() {
        assert!(parse(b"(ott1,ott2;").is_err());
        assert!(parse(b"ott1)ott2;").is_err());
        assert!(parse(b"(ott1)ott2,(ott3)ott4;").is_err());
        assert!(parse(b"(ott1:0.5)ott2;").is_err());
        assert!(parse(b"(Homo_sapiens)ott2;").is_err());
        assert!(parse(b";").is_err());
    }

    #[test]
    fn mini_fixture() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mini.tre");
        let tree = parse_file(&path).unwrap();
        assert_eq!(tree.len(), 57);
        assert_eq!(tree.tip_count(), 30);
        assert_eq!(tree.mrca_count(), 1);
        assert_eq!(tree.label[0], Label::Ott(93302));
        // The root has three children: Eukaryota, Bacteria, Archaea.
        let mut root_children = Vec::new();
        for &child in &tree.children[0] {
            root_children.push(tree.label[child as usize].clone());
        }
        assert_eq!(
            root_children,
            vec![Label::Ott(304358), Label::Ott(844192), Label::Ott(996421)]
        );
        // Homo sapiens hangs under Homo.
        let index = tree.ott_index();
        let human = index[&770315];
        assert_eq!(tree.parent[human as usize], index[&770309]);
    }
}
