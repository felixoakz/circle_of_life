//! Major groups: Animals, Fungi, Plants, Protists, Bacteria, Archaea
//! (PLAN §2.2, §3.2 step 4). The group picks a node's colour on the wheel.
//!
//! Groups are defined by the OTT ids of their root clades, never by name
//! (there is a genus called "Archaea" too). Two passes over the arena:
//!
//! 1. Forward (parents before children): every node inherits the group of its
//!    nearest ancestor-or-self that is a root clade. Eukaryota is a root for
//!    Protists, so any eukaryote that is not under an Animal, Fungus or Plant
//!    root ends up a Protist. Tips keep this value.
//! 2. Backward (children before parents): an internal node takes its
//!    children's group when they all agree, and [`MIXED`] otherwise. That
//!    keeps Eukaryota, Opisthokonta and the root out of every single group.
//!
//! Both passes only need "a parent's index is smaller than its children's",
//! which the Newick parser guarantees.
//!
//! Concepts introduced here:
//! - a fixed-size array of tuples as a small lookup table
//! - looping over a range backwards with `.rev()`

use anyhow::bail;

use super::{Label, NO_PARENT, Tree};

pub const ANIMALS: u8 = 0;
pub const FUNGI: u8 = 1;
pub const PLANTS: u8 = 2;
pub const PROTISTS: u8 = 3;
pub const BACTERIA: u8 = 4;
pub const ARCHAEA: u8 = 5;
/// An internal node whose descendants are in more than one group, or a node
/// outside every root clade (the root of the tree).
pub const MIXED: u8 = 255;

/// Number of real groups (0..GROUP_COUNT).
pub const GROUP_COUNT: usize = 6;

// LEARN: `[(u32, u8); 8]` is a fixed-size array of 8 tuples, stored inline
// with no heap allocation. For a table this small, a plain loop over it is
// simpler (and as fast) as a HashMap.
/// Root clade OTT id → group (PLAN §2.2). Archaeplastida (5268475) is broken
/// in the synth tree, so Plants has three roots instead.
pub const ROOTS: [(u32, u8); 8] = [
    (691846, ANIMALS),  // Metazoa
    (352914, FUNGI),    // Fungi
    (361838, PLANTS),   // Chloroplastida
    (878953, PLANTS),   // Rhodophyta
    (664970, PLANTS),   // Glaucophyta
    (304358, PROTISTS), // Eukaryota: whatever the roots above leave over
    (844192, BACTERIA), // Bacteria
    (996421, ARCHAEA),  // Archaea (not the homonym genus 3573640)
];

/// Display name of a group, for logs.
pub fn name(group: u8) -> &'static str {
    match group {
        ANIMALS => "Animals",
        FUNGI => "Fungi",
        PLANTS => "Plants",
        PROTISTS => "Protists",
        BACTERIA => "Bacteria",
        ARCHAEA => "Archaea",
        _ => "mixed",
    }
}

/// The group of every node, by arena index. Fails if a root id from the
/// table is not in the tree, because the colours would then be silently
/// wrong.
pub fn assign(tree: &Tree) -> anyhow::Result<Vec<u8>> {
    let mut group = vec![MIXED; tree.len()];

    // Mark the root clades themselves. One scan over all labels, checking the
    // 8-entry table for each OTT label.
    let mut found = [false; ROOTS.len()];
    for (node, label) in tree.label.iter().enumerate() {
        if let Label::Ott(ott) = label {
            for (i, &(root_ott, root_group)) in ROOTS.iter().enumerate() {
                if *ott == root_ott {
                    group[node] = root_group;
                    found[i] = true;
                }
            }
        }
    }
    for (i, &(root_ott, root_group)) in ROOTS.iter().enumerate() {
        if !found[i] {
            bail!(
                "group root ott{root_ott} ({}) is not in the tree; PLAN §2.2 lists the root ids",
                name(root_group)
            );
        }
    }

    // Pass 1, forward: inherit from the parent unless this node is a root
    // clade itself (then it keeps its own group from the scan above). So the
    // nearest root wins: Metazoa, inside Eukaryota, restarts as Animals.
    for node in 0..tree.len() {
        let parent = tree.parent[node];
        if parent != NO_PARENT && !is_root_clade(&tree.label[node]) {
            group[node] = group[parent as usize];
        }
    }

    // Pass 2, backward: recompute internal nodes from their children. Clear
    // them first; a child always comes after its parent, so walking indices
    // from high to low finishes every child before its parent.
    const UNSET: u8 = 254;
    for (node, children) in tree.children.iter().enumerate() {
        if !children.is_empty() {
            group[node] = UNSET;
        }
    }
    // LEARN: `(1..n).rev()` walks the range backwards: n-1, n-2, …, 1. Node 0
    // (the root) has no parent to merge into, so the range starts at 1.
    for node in (1..tree.len()).rev() {
        let parent = tree.parent[node] as usize;
        let child_group = group[node];
        if group[parent] == UNSET {
            group[parent] = child_group;
        } else if group[parent] != child_group {
            group[parent] = MIXED;
        }
    }
    Ok(group)
}

fn is_root_clade(label: &Label) -> bool {
    if let Label::Ott(ott) = label {
        for &(root_ott, _) in &ROOTS {
            if *ott == root_ott {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tree::newick;

    fn group_of(tree: &Tree, groups: &[u8], ott: u32) -> u8 {
        groups[tree.ott_index()[&ott] as usize]
    }

    #[test]
    fn mini_fixture_groups() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mini.tre");
        let tree = newick::parse_file(&path).unwrap();
        let groups = assign(&tree).unwrap();

        assert_eq!(group_of(&tree, &groups, 770315), ANIMALS); // Homo sapiens
        assert_eq!(group_of(&tree, &groups, 75257), FUNGI); // Amanita
        assert_eq!(group_of(&tree, &groups, 309263), PLANTS); // Arabidopsis
        assert_eq!(group_of(&tree, &groups, 878946), PLANTS); // Chondrus (red alga)
        assert_eq!(group_of(&tree, &groups, 801157), PLANTS); // Cyanoptyche (glaucophyte)
        assert_eq!(group_of(&tree, &groups, 201128), PROTISTS); // Plasmodium
        assert_eq!(group_of(&tree, &groups, 474506), BACTERIA); // E. coli
        assert_eq!(group_of(&tree, &groups, 44033), ARCHAEA);
        // Internal nodes: one group if all children agree, else mixed.
        assert_eq!(group_of(&tree, &groups, 691846), ANIMALS); // Metazoa
        assert_eq!(group_of(&tree, &groups, 5246039), PROTISTS); // SAR
        assert_eq!(group_of(&tree, &groups, 332573), MIXED); // Opisthokonta
        assert_eq!(group_of(&tree, &groups, 304358), MIXED); // Eukaryota
        assert_eq!(group_of(&tree, &groups, 93302), MIXED); // the root

        // Every tip is in a real group.
        for (node, children) in tree.children.iter().enumerate() {
            if children.is_empty() {
                assert!((groups[node] as usize) < GROUP_COUNT);
            }
        }
    }

    #[test]
    fn missing_root_is_an_error() {
        let tree = newick::parse(b"(ott1,ott2)ott3;").unwrap();
        let err = assign(&tree).unwrap_err();
        assert!(format!("{err}").contains("ott691846"), "{err}");
    }
}
