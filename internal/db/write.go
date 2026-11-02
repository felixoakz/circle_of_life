// Package db is tree.db and cache.db: the writer ingest uses (write.go),
// the read side the API uses (open.go, queries.go, search.go) and the
// enrichment cache (cache.go). Schemas are the .sql files next to this one,
// embedded into the binary.
//
// tree.db is written once, inside one transaction, to "<out>.tmp", and
// renamed over <out> only when complete, so a server reading the old file
// never sees a half-written one.
//
// Concepts introduced here:
// - `database/sql` with the pure-Go modernc.org/sqlite driver
// - `//go:embed`: a file's contents baked into the binary
// - transactions and `defer tx.Rollback()`
// - prepared statements
// - binding a nil pointer to write SQL NULL
package db

import (
	"database/sql"
	_ "embed"
	"encoding/json"
	"fmt"
	"os"

	"species/internal/jsonfloat"
	"species/internal/tiles"
	"species/internal/tree"
	"species/internal/vernacular"
)

// LEARN: a `//go:embed file` comment directly above a package-level string
// (or []byte) variable makes the compiler store that file's contents in the
// variable. The SQL stays a real .sql file, yet the binary needs no extra
// file at run time. It needs the "embed" package imported, here as `_`
// because nothing else from it is used.

// Schema is the tree.db schema (schema.sql).
//
//go:embed schema.sql
var Schema string

// Sources names the source data versions, the first part of dataVersion
// (PLAN §5.1).
const Sources = "otl16.1-ott3.7.3"

// kind values in names_fts.
const (
	// KindScientific is a scientific name (lang NULL).
	KindScientific uint8 = 0
	// KindVernacular is a common name with its language (P11).
	KindVernacular uint8 = 1
)

// Write writes the whole database to out+".tmp", then renames it to out.
// v holds the common names, or is nil when ingest was given none. It
// returns the size of the finished file in bytes.
func Write(out string, t *tree.Tree, x *tree.Taxonomy, l *tree.Layout, set *tiles.Set, v *vernacular.Vernaculars) (int64, error) {
	tmp := tmpPath(out)
	// Left over from a crashed run; start clean.
	if err := os.Remove(tmp); err != nil && !os.IsNotExist(err) {
		return 0, fmt.Errorf("removing %s: %w", tmp, err)
	}
	if err := writeFile(tmp, t, x, l, set, v); err != nil {
		return 0, err
	}
	// Renaming within one filesystem is atomic: anyone opening out gets
	// either the old file or the new one, never a mix.
	if err := os.Rename(tmp, out); err != nil {
		return 0, fmt.Errorf("renaming %s to %s: %w", tmp, out, err)
	}
	info, err := os.Stat(out)
	if err != nil {
		return 0, err
	}
	return info.Size(), nil
}

// writeFile builds the whole database in the file at path. It is its own
// function so the deferred Close runs (closing the file) before Write
// renames it.
func writeFile(path string, t *tree.Tree, x *tree.Taxonomy, l *tree.Layout, set *tiles.Set, v *vernacular.Vernaculars) error {
	// LEARN: package `database/sql` is Go's one interface to every SQL
	// database; a driver (here modernc.org/sqlite, registered by the blank
	// import in open.go) does the database-specific work. sql.Open only
	// checks its arguments: the file is opened on first use. The *sql.DB it
	// returns is a pool of connections, not one connection.
	conn, err := sql.Open("sqlite", path)
	if err != nil {
		return fmt.Errorf("creating %s: %w", path, err)
	}
	defer conn.Close()
	// One connection: the pragmas below are per connection, and the
	// optimize after the commit should see the same settings.
	conn.SetMaxOpenConns(1)

	// This is a scratch file until the rename: if we crash, it is thrown
	// away, so SQLite can skip its rollback journal and fsyncs. That makes
	// the bulk insert several times faster.
	if _, err := conn.Exec("PRAGMA journal_mode = OFF"); err != nil {
		return fmt.Errorf("creating %s: %w", path, err)
	}
	if _, err := conn.Exec("PRAGMA synchronous = OFF"); err != nil {
		return err
	}
	if _, err := conn.Exec(Schema); err != nil {
		return fmt.Errorf("creating the schema: %w", err)
	}

	tx, err := conn.Begin()
	if err != nil {
		return err
	}
	// LEARN: a transaction groups many statements into one all-or-nothing
	// unit; outside one SQLite commits after every INSERT, which for 2.7M
	// rows would take hours. `defer tx.Rollback()` is the usual safety net:
	// on any early return the work is undone. After a successful Commit the
	// deferred Rollback does nothing (it returns sql.ErrTxDone, ignored).
	defer tx.Rollback()

	if err := insertNodes(tx, t, x, l, v); err != nil {
		return err
	}
	if v != nil {
		if err := insertCommonNames(tx, v); err != nil {
			return err
		}
	}
	if err := insertTiles(tx, set); err != nil {
		return err
	}
	meta, err := MetaJSON(t, x, l, set)
	if err != nil {
		return err
	}
	if _, err := tx.Exec("INSERT INTO meta (key, value) VALUES ('meta', ?)", string(meta)); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("committing tree.db: %w", err)
	}

	// Merge the FTS index's many small segments into one: smaller file,
	// faster searches. Worth it because tree.db is never written again.
	if _, err := conn.Exec("INSERT INTO names_fts(names_fts) VALUES ('optimize')"); err != nil {
		return fmt.Errorf("optimizing the search index: %w", err)
	}
	return conn.Close()
}

// tmpPath turns "data/tree.db" into "data/tree.db.tmp".
func tmpPath(out string) string {
	return out + ".tmp"
}

// insertNodes writes one nodes row per node, plus one names_fts row per
// named node, in id order.
func insertNodes(tx *sql.Tx, t *tree.Tree, x *tree.Taxonomy, l *tree.Layout, v *vernacular.Vernaculars) error {
	// Without common names both maps stay empty: every node gets NULL / 0.
	bestNames := map[uint32]string{}
	rowsPerNode := map[uint32]uint32{}
	if v != nil {
		bestNames = v.BestNames()
		rowsPerNode = v.RowsPerNode
	}

	// LEARN: Prepare compiles the SQL once; each Exec then only binds new
	// values and runs it. Re-parsing the SQL for each of 2.7M rows would
	// be far slower. A statement holds resources until it is closed, hence
	// the deferred Close.
	insertNode, err := tx.Prepare(`INSERT INTO nodes (id, parent, node_id, name, rank, grp, flags,
		leaf_count, child_count, depth, level, angle, arc_lo, arc_hi, r,
		gbif_id, ncbi_id, common_name, vernacular_rows)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer insertNode.Close()
	insertName, err := tx.Prepare("INSERT INTO names_fts (name, node, kind, lang) VALUES (?, ?, ?, NULL)")
	if err != nil {
		return err
	}
	defer insertName.Close()

	for id := 0; id < l.Len(); id++ {
		node := int(l.Node[id])
		nodeID, ok := t.Label[node].NodeID()
		if !ok {
			return fmt.Errorf("node %d has no label; every synth node has one", id)
		}

		// LEARN: database/sql writes a nil value as SQL NULL. A pointer
		// field or variable that is nil therefore stores NULL, and one that
		// points at a value stores that value: the Go way to say "maybe a
		// number".
		var parent *uint32
		if l.Parent[id] != tree.NoParent {
			parent = &l.Parent[id]
		}
		var name, rank *string
		var gbif, ncbi *uint32
		if taxon, ok := x.Taxon(node); ok {
			name = &taxon.Name
			rank = &taxon.Rank
			if taxon.GBIF != tree.NoID {
				gbif = &taxon.GBIF
			}
			if taxon.NCBI != tree.NoID {
				ncbi = &taxon.NCBI
			}
		}
		var commonName *string
		if best, ok := bestNames[uint32(id)]; ok {
			commonName = &best
		}

		_, err := insertNode.Exec(
			uint32(id),
			parent,
			nodeID,
			name,
			rank,
			l.Group[id],
			tiles.NodeFlags(t, x, l, id),
			l.LeafCount[id],
			uint32(len(t.Children[node])),
			l.Depth[id],
			l.Level[id],
			l.Angle[id],
			l.ArcLo[id],
			l.ArcHi[id],
			// SQLite REAL is a float64; widening a float32 is exact.
			float64(l.R[id]),
			gbif,
			ncbi,
			commonName,
			rowsPerNode[uint32(id)],
		)
		if err != nil {
			return fmt.Errorf("inserting node %d: %w", id, err)
		}
		if name != nil {
			if _, err := insertName.Exec(*name, uint32(id), KindScientific); err != nil {
				return err
			}
		}
	}
	return nil
}

// insertCommonNames writes one names_fts row per common name, kind 1 with
// its language, in the order of v.Names (a node's best supported first).
func insertCommonNames(tx *sql.Tx, v *vernacular.Vernaculars) error {
	insert, err := tx.Prepare("INSERT INTO names_fts (name, node, kind, lang) VALUES (?, ?, ?, ?)")
	if err != nil {
		return err
	}
	defer insert.Close()
	for _, name := range v.Names {
		if _, err := insert.Exec(name.Name, name.Node, KindVernacular, name.Lang); err != nil {
			return err
		}
	}
	return nil
}

// insertTiles writes every gzipped tile blob.
func insertTiles(tx *sql.Tx, set *tiles.Set) error {
	insert, err := tx.Prepare("INSERT INTO tiles (level, sector, data) VALUES (?, ?, ?)")
	if err != nil {
		return err
	}
	defer insert.Close()
	for _, tile := range set.Tiles {
		// A []byte is stored as a BLOB.
		if _, err := insert.Exec(tile.Level, tile.Sector, tile.Gz); err != nil {
			return err
		}
	}
	return nil
}

// Meta is the body of GET /api/meta (PLAN §5.1), stored once in the meta
// table so the server sends it verbatim.
//
// Its keys are sorted at every level, so every meta struct declares its
// fields in alphabetical order of their JSON names.
type Meta struct {
	DataVersion  string        `json:"dataVersion"`
	Groups       []MetaGroup   `json:"groups"`
	Home         *MetaHome     `json:"home"` // null when the tree lacks Homo sapiens
	MaxLevel     uint8         `json:"maxLevel"`
	NodeCount    int           `json:"nodeCount"`
	R0           jsonfloat.F64 `json:"r0"`
	Runs         []MetaRun     `json:"runs"`
	SpeciesCount uint32        `json:"speciesCount"`
	TileP        uint64        `json:"tileP"`
	TipCount     uint32        `json:"tipCount"`
}

// MetaGroup is one major group in meta.groups.
type MetaGroup struct {
	ID       int      `json:"id"`
	Name     string   `json:"name"`
	RootIDs  []string `json:"rootIds"`
	TipCount uint32   `json:"tipCount"`
}

// MetaRun is one tip run in meta.runs.
type MetaRun struct {
	AngleHi uint32 `json:"angleHi"`
	AngleLo uint32 `json:"angleLo"`
	Group   uint8  `json:"group"`
}

// MetaHome is meta.home, the node the client starts at.
type MetaHome struct {
	Angle  uint32 `json:"angle"`
	ID     int    `json:"id"`
	NodeID string `json:"nodeId"`
}

// MetaJSON builds the meta document and returns its JSON text, exactly as
// it is stored and served.
func MetaJSON(t *tree.Tree, x *tree.Taxonomy, l *tree.Layout, set *tiles.Set) ([]byte, error) {
	var tipsPerGroup [tree.GroupCount]uint32
	var speciesTips uint32
	for id := 0; id < l.Len(); id++ {
		if !l.IsTip(id) {
			continue
		}
		group := int(l.Group[id])
		if group < tree.GroupCount {
			tipsPerGroup[group]++
		}
		if tiles.NodeFlags(t, x, l, id)&tiles.FlagSpecies != 0 {
			speciesTips++
		}
	}

	groups := []MetaGroup{}
	for group, tipCount := range tipsPerGroup {
		rootIDs := []string{}
		for _, root := range tree.Roots {
			if int(root.Group) == group {
				rootIDs = append(rootIDs, fmt.Sprintf("ott%d", root.Ott))
			}
		}
		groups = append(groups, MetaGroup{
			ID:       group,
			Name:     tree.GroupName(uint8(group)),
			RootIDs:  rootIDs,
			TipCount: tipCount,
		})
	}

	runs := []MetaRun{}
	for _, run := range l.GroupRuns {
		runs = append(runs, MetaRun{AngleHi: run.AngleHi, AngleLo: run.AngleLo, Group: run.Group})
	}

	var home *MetaHome
	if id, ok := tiles.HomeID(t, l); ok {
		home = &MetaHome{
			Angle:  l.Angle[id],
			ID:     id,
			NodeID: fmt.Sprintf("ott%d", tiles.HomeOtt),
		}
	}

	meta := Meta{
		DataVersion:  DataVersion(set.Hash),
		Groups:       groups,
		Home:         home,
		MaxLevel:     l.MaxLevel,
		NodeCount:    l.Len(),
		R0:           jsonfloat.F64(tree.R0),
		Runs:         runs,
		SpeciesCount: speciesTips,
		TileP:        tree.P,
		TipCount:     l.TipCount,
	}
	return json.Marshal(meta)
}

// DataVersion is Sources plus "-" and the first 6 hex digits of the tile
// hash, zero-padded to 16: "otl16.1-ott3.7.3-7f3a9c".
func DataVersion(hash uint64) string {
	// %016x: lowercase hex, zero-padded to all 16 digits of a uint64.
	hex := fmt.Sprintf("%016x", hash)
	return Sources + "-" + hex[:6]
}
