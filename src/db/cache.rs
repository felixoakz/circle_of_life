//! `cache.db`, the enrichment cache (PLAN §4, §6.1): one JSON document per
//! node, with when it was fetched and whether every source answered.
//!
//! Unlike `tree.db` this file is written while the server runs, so it uses
//! SQLite's write-ahead log: readers never wait for the writer.
//!
//! Concepts introduced here:
//! - `std::time::SystemTime` and the unix epoch
//! - an `enum` that classifies a value (`Freshness`) instead of a bool pair

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Context;
use rusqlite::{Connection, OptionalExtension, params};

/// The `cache.db` schema.
pub const SCHEMA: &str = include_str!("cache.sql");

/// A complete document is fresh for 30 days (PLAN §6.1).
pub const TTL_COMPLETE: i64 = 30 * 24 * 3600;
/// A partial one (some source failed) only for a day, so it is retried soon.
pub const TTL_PARTIAL: i64 = 24 * 3600;

/// One cached row.
#[derive(Debug, Clone)]
pub struct Cached {
    pub body: String,
    pub complete: bool,
    pub fetched_at: i64,
}

/// How a cached row compares with its time to live.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Freshness {
    Fresh,
    /// Past its TTL: still served, and refreshed in the background.
    Stale,
}

impl Cached {
    pub fn freshness(&self, now: i64) -> Freshness {
        let ttl = if self.complete {
            TTL_COMPLETE
        } else {
            TTL_PARTIAL
        };
        if now - self.fetched_at < ttl {
            Freshness::Fresh
        } else {
            Freshness::Stale
        }
    }
}

/// Seconds since 1970-01-01 UTC.
pub fn now() -> i64 {
    // LEARN: `SystemTime` is the wall clock (it can jump, unlike `Instant`).
    // `duration_since(UNIX_EPOCH)` only fails if the clock is set before
    // 1970; then 0 is as good an answer as any.
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(elapsed) => elapsed.as_secs() as i64,
        Err(_) => 0,
    }
}

/// Opens (creating if needed) `cache.db` with WAL, as PLAN §4 says.
pub fn open(path: &Path) -> anyhow::Result<Connection> {
    let conn = Connection::open(path).with_context(|| format!("opening {}", path.display()))?;
    init(&conn)?;
    Ok(conn)
}

/// Pragmas and schema; also used on in-memory databases in tests.
pub fn init(conn: &Connection) -> anyhow::Result<()> {
    // `journal_mode` answers with a row, so it is read back with
    // `pragma_update_and_check` rather than a plain update.
    conn.pragma_update_and_check(None, "journal_mode", "WAL", |_| Ok(()))?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "busy_timeout", 2000)?;
    conn.execute_batch(SCHEMA)
        .context("creating the cache schema")?;
    Ok(())
}

pub fn get(conn: &Connection, node_id: &str) -> rusqlite::Result<Option<Cached>> {
    let mut stmt =
        conn.prepare_cached("SELECT body, complete, fetched_at FROM about WHERE node_id = ?1")?;
    stmt.query_row(params![node_id], |row| {
        Ok(Cached {
            body: row.get(0)?,
            complete: row.get(1)?,
            fetched_at: row.get(2)?,
        })
    })
    .optional()
}

/// Inserts or replaces the document for `node_id`.
pub fn put(conn: &Connection, node_id: &str, cached: &Cached) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare_cached(
        "INSERT OR REPLACE INTO about (node_id, body, complete, fetched_at) VALUES (?1, ?2, ?3, ?4)",
    )?;
    stmt.execute(params![
        node_id,
        cached.body,
        cached.complete,
        cached.fetched_at
    ])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn put_get_round_trip() {
        let conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();
        assert!(get(&conn, "ott1").unwrap().is_none());
        let row = Cached {
            body: "{}".to_string(),
            complete: true,
            fetched_at: 100,
        };
        put(&conn, "ott1", &row).unwrap();
        let back = get(&conn, "ott1").unwrap().unwrap();
        assert_eq!(back.body, "{}");
        assert!(back.complete);
        assert_eq!(back.fetched_at, 100);
    }

    #[test]
    fn partial_documents_go_stale_sooner() {
        let complete = Cached {
            body: String::new(),
            complete: true,
            fetched_at: 0,
        };
        let partial = Cached {
            complete: false,
            ..complete.clone()
        };
        let two_days = 2 * 24 * 3600;
        assert_eq!(complete.freshness(two_days), Freshness::Fresh);
        assert_eq!(partial.freshness(two_days), Freshness::Stale);
        assert_eq!(complete.freshness(TTL_COMPLETE), Freshness::Stale);
    }
}
