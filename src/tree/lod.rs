//! Level of detail: which zoom level a node first appears at, and which tile
//! (sector) stores it (PLAN §3.6).
//!
//! At level `L` the circle is cut into `2^L` equal sectors. A node is
//! introduced at the smallest level where its clade is "big enough":
//! `leaf_count · P · 2^L ≥ N`, with `N` the number of tips. Big clades come
//! in early, single tips last, at [`max_level`].
//!
//! Concepts introduced here:
//! - bit shifts (`<<`, `>>`) as multiply/divide by powers of two
//! - why a shift by the full bit width is an error in Rust

/// Tile-size knob: roughly how many nodes one tile holds (stored in meta).
pub const P: u64 = 512;

/// `child_level` of a tip: it has no children to introduce.
pub const NO_CHILD_LEVEL: u8 = 255;

/// The smallest `L` with `leaf_count · P · 2^L ≥ tip_count`.
pub fn intro_level(leaf_count: u32, tip_count: u32) -> u8 {
    // u64 so `leaf_count · P · 2^L` cannot overflow: at most 2.4M · 512 · 2^13.
    let lhs = leaf_count as u64 * P;
    let mut level = 0;
    // LEARN: `x << level` shifts the bits of `x` left by `level` places,
    // which multiplies by 2^level (as long as nothing falls off the top).
    while (lhs << level) < tip_count as u64 {
        level += 1;
    }
    level
}

/// `Lmax`: the level of a single tip. 13 for the full tree.
pub fn max_level(tip_count: u32) -> u8 {
    intro_level(1, tip_count)
}

/// Width of one sector at `level`, in angle units (`2^32 / 2^level`).
pub fn sector_width(level: u8) -> u64 {
    (1u64 << 32) >> level
}

/// The sector at `level` that contains `angle`: its top `level` bits.
pub fn sector_of(angle: u32, level: u8) -> u32 {
    // LEARN: shifting a u32 by 32 or more bits is an error in Rust, not 0:
    // debug builds panic with "attempt to shift right with overflow" (release
    // builds silently shift by `32 % 32 = 0`, which is worse). At level 0 we
    // would shift by 32, so that case gets its own branch.
    if level == 0 {
        0
    } else {
        angle >> (32 - level as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_on_the_full_tree_size() {
        let n = 2_385_875;
        assert_eq!(max_level(n), 13);
        assert_eq!(intro_level(n, n), 0); // the root
        // 512 · 2^12 = 2,097,152 < N, so a single tip needs level 13.
        assert_eq!(intro_level(1, n), 13);
        // A clade of 4,660 tips: 4660 · 512 = 2,385,920 ≥ N.
        assert_eq!(intro_level(4660, n), 0);
        assert_eq!(intro_level(4659, n), 1);
    }

    #[test]
    fn sectors() {
        assert_eq!(sector_of(u32::MAX, 0), 0);
        assert_eq!(sector_of(u32::MAX, 1), 1);
        assert_eq!(sector_of(1 << 31, 1), 1);
        assert_eq!(sector_of((1 << 31) - 1, 1), 0);
        assert_eq!(sector_of(u32::MAX, 13), (1 << 13) - 1);
        assert_eq!(sector_width(0), 1 << 32);
        assert_eq!(sector_width(13), 1 << 19);
    }
}
