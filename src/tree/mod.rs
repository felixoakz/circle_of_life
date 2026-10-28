//! The in-memory tree: every node of the synth tree in one "arena" (PLAN §3.1).
//!
//! Nodes are numbered 0, 1, 2, … in the order the Newick parser creates them,
//! which is pre-order: a parent always has a smaller index than its children,
//! and node 0 is the root. Everything about a node lives at that index in a
//! few parallel `Vec`s.
//!
//! Concepts introduced here:
//! - an arena: nodes in a `Vec`, linked by index instead of by pointer
//! - `const` items and sentinel values (`u32::MAX` for "no parent")
//! - `#[derive(Default)]` and `Clone`/`PartialEq` for comparing in tests
//! - `usize` vs `u32`, and converting between them with `as`
//! - `HashMap` from the standard library

use std::collections::HashMap;

pub mod groups;
pub mod layout;
pub mod lod;
pub mod newick;
pub mod taxonomy;

// LEARN: a `const` is a value fixed at compile time and inlined wherever it is
// used. Naming the sentinel ("no parent") reads better than a bare u32::MAX.
/// The `parent` of the root.
pub const NO_PARENT: u32 = u32::MAX;

/// What a node is called in the synth tree.
// LEARN: `Clone` lets you make an explicit copy with `.clone()`; `PartialEq`
// and `Eq` make `==` work, which `assert_eq!` in the tests needs.
// LEARN: deriving `PartialOrd` and `Ord` on an enum orders values by variant
// first (in declaration order: every `Ott` < every `Mrca` < `None`), then by
// the data inside. Ladderizing (layout.rs) uses it as the tie-break.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum Label {
    /// `ott770315`: a taxon in the OTT taxonomy.
    Ott(u32),
    /// `mrcaott42ott150`: a clade with no taxon of its own, named after two
    /// tips whose most recent common ancestor it is. Kept as the full text.
    Mrca(String),
    /// No label at all. The real file never has this; tests do.
    None,
}

// LEARN: an "arena" stores every node in one Vec and links nodes by u32 index
// instead of Box/Rc pointers. No lifetimes, no RefCell, cache-friendly, and
// 2.7M nodes fit in a few hundred MB. `#[derive(Default)]` gives
// `Tree::default()`, a tree with three empty Vecs.
impl Label {
    /// The OpenTree node id string (`ott770315`, `mrcaott42ott150`), as used
    /// in `nodes.node_id` and public URLs. `None` for an unlabelled node.
    pub fn node_id(&self) -> Option<String> {
        match self {
            Label::Ott(ott) => Some(format!("ott{ott}")),
            Label::Mrca(text) => Some(text.clone()),
            Label::None => None,
        }
    }
}

/// The whole tree. Index `i` in each Vec describes node `i`.
#[derive(Debug, Default)]
pub struct Tree {
    pub label: Vec<Label>,
    /// Index of the parent, or [`NO_PARENT`] for the root.
    pub parent: Vec<u32>,
    /// Indices of the children, in file order. Empty for a tip.
    pub children: Vec<Vec<u32>>,
}

impl Tree {
    /// Number of nodes.
    pub fn len(&self) -> usize {
        self.label.len()
    }

    /// True when the tree has no nodes (clippy asks for this next to `len`).
    pub fn is_empty(&self) -> bool {
        self.label.is_empty()
    }

    /// Appends a node with no label under `parent` (or as the root when
    /// `parent` is [`NO_PARENT`]) and returns its index.
    pub fn add_node(&mut self, parent: u32) -> u32 {
        // LEARN: Vec lengths and indices are `usize` (64-bit here), but we
        // store indices as `u32` to halve the memory. `as` converts between
        // number types. It never fails: it truncates instead, so we only use
        // it where the value is known to fit (2.7M nodes is far below 4.29
        // billion).
        let node = self.len() as u32;
        self.label.push(Label::None);
        self.parent.push(parent);
        self.children.push(Vec::new());
        if parent != NO_PARENT {
            self.children[parent as usize].push(node);
        }
        node
    }

    /// Number of tips (nodes without children).
    pub fn tip_count(&self) -> usize {
        let mut count = 0;
        for children in &self.children {
            if children.is_empty() {
                count += 1;
            }
        }
        count
    }

    /// Number of `mrcaott…` nodes.
    pub fn mrca_count(&self) -> usize {
        let mut count = 0;
        for label in &self.label {
            // LEARN: `matches!` is `match` that answers true/false: "does this
            // value fit this pattern?". `_` ignores the String inside.
            if matches!(label, Label::Mrca(_)) {
                count += 1;
            }
        }
        count
    }

    /// Map from OTT id to node index, for every `Label::Ott` node.
    pub fn ott_index(&self) -> HashMap<u32, u32> {
        // LEARN: `HashMap<K, V>` is the standard hash table. Reserving the
        // capacity up front avoids growing (and rehashing) it many times.
        let mut index = HashMap::with_capacity(self.len());
        // LEARN: `.iter().enumerate()` yields `(index, item)` pairs.
        for (node, label) in self.label.iter().enumerate() {
            // LEARN: `if let` is a one-armed `match`: the body runs only when
            // `label` is the `Ott` variant, with `ott` bound to the id inside.
            // `label` is borrowed, so `ott` is a `&u32`; `*ott` copies it out.
            if let Label::Ott(ott) = label {
                index.insert(*ott, node as u32);
            }
        }
        index
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_node_links_parent_and_child() {
        let mut tree = Tree::default();
        let root = tree.add_node(NO_PARENT);
        let a = tree.add_node(root);
        let b = tree.add_node(root);
        tree.label[a as usize] = Label::Ott(1);
        assert_eq!(tree.len(), 3);
        assert_eq!(tree.parent, vec![NO_PARENT, 0, 0]);
        assert_eq!(tree.children[0], vec![a, b]);
        assert_eq!(tree.tip_count(), 2);
        assert_eq!(tree.ott_index().get(&1), Some(&a));
    }
}
