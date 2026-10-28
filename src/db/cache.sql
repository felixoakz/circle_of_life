-- cache.db: the enrichment cache (PLAN §4, §6). Created by `species serve`
-- if missing; safe to delete at any time (it refills on demand).

-- One JSON document per node: the body of GET /api/nodes/{ref}/about.
CREATE TABLE IF NOT EXISTS about (
  node_id    TEXT PRIMARY KEY,     -- OpenTree id, 'ott770315'
  body       TEXT NOT NULL,        -- JSON of GET /about
  complete   INTEGER NOT NULL,     -- 0 if any source failed or timed out
  fetched_at INTEGER NOT NULL      -- unix seconds
) WITHOUT ROWID;
