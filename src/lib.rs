//! The `species` library: everything the `species` binary does lives here, so
//! that tests (unit tests inside each module and integration tests in `tests/`)
//! can call it directly. `main.rs` only parses the command line and dispatches.
//!
//! Concepts introduced here:
//! - crates and modules: `lib.rs` is the root of the library crate
//! - `pub mod` to declare a module and make it visible outside the crate

// LEARN: `pub mod config;` tells the compiler "there is a module called
// `config`; its code is in `src/config.rs`" (or `src/config/mod.rs`). A module
// is a namespace. `pub` lets other crates (including our own binary, which is
// a separate crate that depends on this library) use it as `species::config`.
pub mod config;
pub mod db;
pub mod enrich;
pub mod error;
pub mod healthcheck;
pub mod ingest;
pub mod server;
pub mod tiles;
pub mod tree;
pub mod vernacular;
