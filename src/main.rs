//! The `species` command-line program: `species ingest …` builds tree.db from
//! the raw data, `species serve …` runs the web server.
//!
//! This file stays small on purpose: it parses arguments, sets up logging and
//! hands over to the library (`src/lib.rs`).
//!
//! Concepts introduced here:
//! - the binary crate using the library crate (`use species::…`)
//! - deriving a CLI with clap (`Parser`, `Subcommand`)
//! - `#[tokio::main]`: an async `main`
//! - `anyhow::Result` as the return type of `main`

use std::io::IsTerminal;

use clap::{Parser, Subcommand};
use species::config::{IngestArgs, ServeArgs};
use species::healthcheck::HealthcheckArgs;
use tracing_subscriber::EnvFilter;

/// Circle of Life: a zoomable radial tree of all species in the Open Tree of Life.
#[derive(Debug, Parser)]
#[command(version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

// LEARN: each enum variant here becomes a subcommand (`species ingest`,
// `species serve`). The variant holds that subcommand's parsed arguments.
#[derive(Debug, Subcommand)]
enum Command {
    /// Build tree.db from the synth tree and the OTT taxonomy.
    Ingest(IngestArgs),
    /// Serve the API and the built frontend.
    Serve(ServeArgs),
    /// Exit 0 if the local server answers /healthz (Docker HEALTHCHECK).
    Healthcheck(HealthcheckArgs),
}

// LEARN: Rust's `main` cannot be `async` by itself; something has to run the
// futures. `#[tokio::main]` rewrites this into a normal `main` that starts the
// tokio runtime (a pool of worker threads) and runs our async body on it.
//
// Returning `anyhow::Result<()>` means any error that bubbles up with `?` is
// printed (with its context chain) and the process exits with code 1.
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Log level comes from RUST_LOG (e.g. `RUST_LOG=debug`). At the default
    // `info`, the server logs one line per request (`server::log_request`).
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    // Colours only on a terminal: `docker logs` and Coolify show raw escape codes.
    let ansi = std::io::stdout().is_terminal();
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_ansi(ansi)
        .init();

    let cli = Cli::parse();
    match cli.command {
        Command::Ingest(args) => species::ingest::run(&args),
        Command::Serve(args) => species::server::run(args).await,
        Command::Healthcheck(args) => species::healthcheck::run(&args),
    }
}
