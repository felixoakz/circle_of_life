//! `species healthcheck`: asks the running server for `/healthz` and exits
//! with 0 if it answered `200`, 1 otherwise. The Docker `HEALTHCHECK` runs
//! it, so the runtime image needs neither curl nor wget.
//!
//! Concepts introduced here:
//! - a blocking TCP client with `std::net::TcpStream`
//! - the `Read` and `Write` traits from `std::io`
//! - timeouts on a socket

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use anyhow::Context;
use clap::Args;

/// Arguments for `species healthcheck`.
#[derive(Debug, Args)]
pub struct HealthcheckArgs {
    /// Port the server listens on (the same `PORT` as `serve`).
    #[arg(long, env = "PORT", default_value_t = 3000)]
    pub port: u16,
}

/// How long to wait for the connection and for the answer.
const TIMEOUT: Duration = Duration::from_secs(3);

/// Sends `GET /healthz` to localhost and fails unless the status is 200.
pub fn run(args: &HealthcheckArgs) -> anyhow::Result<()> {
    let addr = SocketAddr::from(([127, 0, 0, 1], args.port));
    // LEARN: `TcpStream` is a plain blocking socket from the standard library.
    // No async runtime is needed for one tiny request; each call simply waits
    // (at most `TIMEOUT`) until the other side answers.
    let mut stream = TcpStream::connect_timeout(&addr, TIMEOUT)
        .with_context(|| format!("connecting to {addr}"))?;
    stream.set_read_timeout(Some(TIMEOUT))?;
    stream.set_write_timeout(Some(TIMEOUT))?;

    // LEARN: `write_all` and `read_to_string` come from the `Write` and `Read`
    // traits, which is why they are imported above: a trait's methods are
    // only callable where the trait is in scope. HTTP/1.0 with
    // `Connection: close` makes the server close the socket after answering,
    // so reading "to the end" finishes.
    stream.write_all(b"GET /healthz HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .context("reading the answer")?;

    let status_line = response.lines().next().unwrap_or_default();
    if status_line.split_whitespace().nth(1) == Some("200") {
        Ok(())
    } else {
        anyhow::bail!("unhealthy: {status_line:?}")
    }
}
