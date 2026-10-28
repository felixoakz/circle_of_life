-- tree.db: written once by `species ingest`, then opened read-only by the
-- server (PLAN §4). Ingest runs this whole file before inserting anything.
-- The cache.db schema (enrichment, P10) is in cache.sql next to it.

-- One row: key 'meta', value the JSON body of GET /api/meta (PLAN §5.1).
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE nodes (
  id          INTEGER PRIMARY KEY,      -- pre-order index (rowid alias); == tile `id`
  parent      INTEGER,                  -- NULL for the root
  node_id     TEXT NOT NULL UNIQUE,     -- OpenTree id: 'ott770315' or 'mrcaott1ott2'
  name        TEXT,                     -- NULL for mrca nodes
  rank        TEXT,                     -- NULL for mrca nodes
  grp         INTEGER NOT NULL,         -- 0..5, or 255 for mixed
  flags       INTEGER NOT NULL,         -- same bits as the tile flags
  leaf_count  INTEGER NOT NULL,
  child_count INTEGER NOT NULL,
  depth       INTEGER NOT NULL,
  level       INTEGER NOT NULL,
  angle INTEGER NOT NULL, arc_lo INTEGER NOT NULL, arc_hi INTEGER NOT NULL,
  r REAL NOT NULL,
  gbif_id INTEGER, ncbi_id INTEGER,
  common_name TEXT,                     -- best English (else Portuguese) common name, P11
  vernacular_rows INTEGER NOT NULL DEFAULT 0  -- GBIF common-name rows, all languages: how well known
);
CREATE INDEX nodes_parent ON nodes(parent, leaf_count DESC);

-- Search (PLAN §5.2). kind 0 = scientific name (lang NULL), 1 = vernacular
-- (P11, lang 'en' or 'pt'; a node's names are inserted best first).
-- `node` is nodes.id.
CREATE VIRTUAL TABLE names_fts USING fts5(
  name, node UNINDEXED, kind UNINDEXED, lang UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3');

-- Gzipped tile blobs (PLAN §3.7, docs/tile-format.md). Empty tiles are absent.
CREATE TABLE tiles (level INTEGER, sector INTEGER, data BLOB NOT NULL,
                    PRIMARY KEY (level, sector)) WITHOUT ROWID;
