// The read side of tree.db behind the API (PLAN §4, §5): meta, tiles and
// node details. Search is in search.go.
//
// Every function takes a context (the request's, so a client that goes away
// cancels its query) and the *sql.DB pool from OpenTree. The JSON shapes
// are the struct tags below; field order is JSON key order, which the API
// keeps stable.
//
// Concepts introduced here:
// - struct tags (`json:"leafCount"`) shaping JSON
// - embedded structs: their fields appear inline in the JSON
// - nil slice vs empty slice: `null` vs `[]` in JSON

package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"species/internal/jsonfloat"
)

// TopChildren is the most children listed in a node's children.top. The
// biggest polytomy in the real tree has 12,964 children; the panel needs
// only the largest few plus the total.
const TopChildren = 50

// ReadMeta is the stored body of GET /api/meta, verbatim.
func ReadMeta(ctx context.Context, db *sql.DB) ([]byte, error) {
	var meta []byte
	err := db.QueryRowContext(ctx, "SELECT value FROM meta WHERE key = 'meta'").Scan(&meta)
	return meta, err
}

// Tile is the gzipped tile blob, and false for an empty (absent) tile.
func Tile(ctx context.Context, db *sql.DB, level uint8, sector uint32) ([]byte, bool, error) {
	var data []byte
	err := db.QueryRowContext(ctx, "SELECT data FROM tiles WHERE level = ? AND sector = ?",
		level, sector).Scan(&data)
	// QueryRow reports "no row" as the error sql.ErrNoRows: here it is the
	// ordinary answer for an empty tile, not a failure.
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return data, true, nil
}

// RefKind says how a client named a node.
type RefKind uint8

const (
	// RefID is a pre-order id, as stored in tiles: "1134830".
	RefID RefKind = iota
	// RefOtt is an OTT taxon: "ott770315".
	RefOtt
	// RefMrca is an unnamed clade by OpenTree's own id: "mrcaott786ott3428".
	RefMrca
)

// NodeRef is how a client names a node in /api/nodes/{ref} (PLAN §5.1).
type NodeRef struct {
	Kind RefKind
	// Num is the id (RefID) or the OTT id (RefOtt).
	Num uint32
	// Mrca is the full text for RefMrca; never parsed further.
	Mrca string
}

// ParseNodeRef parses "1134830", "ott770315" or "mrcaott…". Numbers may
// have one leading '+' ("+5", "ott+5"). The error message is shown to the
// client.
func ParseNodeRef(text string) (NodeRef, error) {
	if strings.HasPrefix(text, "mrcaott") {
		return NodeRef{Kind: RefMrca, Mrca: text}, nil
	}
	if digits, ok := strings.CutPrefix(text, "ott"); ok {
		if ott, ok := parseU32(digits); ok {
			return NodeRef{Kind: RefOtt, Num: ott}, nil
		}
	} else if id, ok := parseU32(text); ok {
		return NodeRef{Kind: RefID, Num: id}, nil
	}
	return NodeRef{}, fmt.Errorf("bad node reference %q: expected a number, ott<number> or mrcaott…", text)
}

// parseU32 parses a decimal uint32: one optional leading '+', then digits
// only. strconv.ParseUint alone rejects the '+'.
func parseU32(text string) (uint32, bool) {
	digits := strings.TrimPrefix(text, "+")
	// A second sign ("++5") is left in digits and rejected below.
	n, err := strconv.ParseUint(digits, 10, 32)
	if err != nil {
		return 0, false
	}
	return uint32(n), true
}

// LEARN: the backquoted text after a field, `json:"leafCount"`, is a struct
// tag: metadata that packages read by reflection. encoding/json uses the
// name in it as the JSON key, and `json:"-"` leaves the field out. Fields
// are written in declaration order, so the order below is the key order
// the client sees.

// NodeRow is the columns of one nodes row that the API sends.
type NodeRow struct {
	ID         uint32  `json:"id"`
	NodeID     string  `json:"nodeId"`
	Name       *string `json:"name"` // nil (null) for mrca nodes
	Rank       *string `json:"rank"`
	Group      uint8   `json:"group"`
	Flags      uint8   `json:"flags"`
	LeafCount  uint32  `json:"leafCount"`
	ChildCount uint32  `json:"childCount"`
	Level      uint8   `json:"level"`
	Angle      uint32  `json:"angle"`
	ArcLo      uint32  `json:"arcLo"`
	ArcHi      uint32  `json:"arcHi"`
	// R is a float32, as in the tiles: the JSON shows the same short number
	// (0.724) the client decoded from the tile.
	R jsonfloat.F32 `json:"r"`
	// GBIFID and NCBIID are sent inside ids, not at the top level.
	GBIFID *int64 `json:"-"`
	NCBIID *int64 `json:"-"`
	// CommonName is the best English (else Portuguese) common name (P11).
	CommonName *string `json:"commonName"`
	// VernacularRows is GBIF common-name rows in any language: a rough
	// fame measure for ranking search results.
	VernacularRows uint32 `json:"-"`
}

// nodeColumns is the column list scanNode reads, in order.
const nodeColumns = `id, node_id, name, rank, grp, flags, leaf_count, child_count, level,
	angle, arc_lo, arc_hi, r, gbif_id, ncbi_id, common_name, vernacular_rows`

// scanNode reads one row selected with nodeColumns.
func scanNode(row interface{ Scan(dest ...any) error }) (NodeRow, error) {
	var n NodeRow
	// Stored as a float64 that came from a float32, so narrowing is exact.
	var r float64
	err := row.Scan(&n.ID, &n.NodeID, &n.Name, &n.Rank, &n.Group, &n.Flags, &n.LeafCount,
		&n.ChildCount, &n.Level, &n.Angle, &n.ArcLo, &n.ArcHi, &r, &n.GBIFID, &n.NCBIID,
		&n.CommonName, &n.VernacularRows)
	n.R = jsonfloat.F32(r)
	return n, err
}

// nodeByID is the row with pre-order id, and false if there is none.
func nodeByID(ctx context.Context, db *sql.DB, id uint32) (NodeRow, bool, error) {
	row := db.QueryRowContext(ctx, "SELECT "+nodeColumns+" FROM nodes WHERE id = ?", id)
	n, err := scanNode(row)
	if errors.Is(err, sql.ErrNoRows) {
		return NodeRow{}, false, nil
	}
	if err != nil {
		return NodeRow{}, false, err
	}
	return n, true, nil
}

// Resolve is the pre-order id ref points at, and false if no such node.
func Resolve(ctx context.Context, db *sql.DB, ref NodeRef) (uint32, bool, error) {
	var row *sql.Row
	switch ref.Kind {
	case RefID:
		row = db.QueryRowContext(ctx, "SELECT id FROM nodes WHERE id = ?", ref.Num)
	case RefOtt:
		row = db.QueryRowContext(ctx, "SELECT id FROM nodes WHERE node_id = ?", fmt.Sprintf("ott%d", ref.Num))
	default:
		row = db.QueryRowContext(ctx, "SELECT id FROM nodes WHERE node_id = ?", ref.Mrca)
	}
	var id uint32
	err := row.Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return id, true, nil
}

// LineageEntry is one ancestor in a node's lineage: enough to label it and
// to draw the selection path (each ancestor's point is at (angle, r)).
type LineageEntry struct {
	ID     uint32        `json:"id"`
	NodeID string        `json:"nodeId"`
	Name   *string       `json:"name"`
	Rank   *string       `json:"rank"`
	Group  uint8         `json:"group"`
	Angle  uint32        `json:"angle"`
	R      jsonfloat.F32 `json:"r"`
}

// Ancestors is every ancestor of id, root first, parent last; empty (not
// nil) for the root.
func Ancestors(ctx context.Context, db *sql.DB, id uint32) ([]LineageEntry, error) {
	// A recursive CTE walks up the parent links inside SQLite: start at the
	// node's parent, then repeatedly add the parent of the last row added.
	rows, err := db.QueryContext(ctx, `WITH RECURSIVE up(id) AS (
			SELECT parent FROM nodes WHERE id = ? AND parent IS NOT NULL
			UNION ALL
			SELECT n.parent FROM nodes n JOIN up ON n.id = up.id WHERE n.parent IS NOT NULL
		)
		SELECT n.id, n.node_id, n.name, n.rank, n.grp, n.angle, n.r
		FROM up JOIN nodes n ON n.id = up.id
		ORDER BY n.depth`, id)
	if err != nil {
		return nil, err
	}
	// Rows hold a connection from the pool until closed.
	defer rows.Close()

	// LEARN: encoding/json tells a nil slice from an empty one, although
	// Go code treats them alike: nil is written as `null`, empty as `[]`.
	// The client expects `[]` for the root, so the slice starts empty,
	// never nil.
	lineage := []LineageEntry{}
	for rows.Next() {
		var e LineageEntry
		var r float64
		if err := rows.Scan(&e.ID, &e.NodeID, &e.Name, &e.Rank, &e.Group, &e.Angle, &r); err != nil {
			return nil, err
		}
		e.R = jsonfloat.F32(r)
		lineage = append(lineage, e)
	}
	// Next returns false both at the end and on an error; Err tells them
	// apart.
	return lineage, rows.Err()
}

// ChildEntry is a child in children.top.
type ChildEntry struct {
	ID        uint32  `json:"id"`
	NodeID    string  `json:"nodeId"`
	Name      *string `json:"name"`
	Rank      *string `json:"rank"`
	Group     uint8   `json:"group"`
	LeafCount uint32  `json:"leafCount"`
}

// Children is the node's direct child count, and the TopChildren largest by
// leaf count (ties by id). Top is never nil.
type Children struct {
	Total uint32       `json:"total"`
	Top   []ChildEntry `json:"top"`
}

// IDs are external ids, for links in the panel.
type IDs struct {
	Ott  *uint32 `json:"ott"`
	GBIF *int64  `json:"gbif"`
	NCBI *int64  `json:"ncbi"`
}

// LEARN: a field with a type but no name (`NodeRow` below) embeds that
// struct: its fields are promoted, so `detail.LeafCount` works as if it were
// declared here, and encoding/json writes them inline at that position
// instead of under a "NodeRow" key.

// NodeDetail is the body of GET /api/nodes/{ref}. The embedded NodeRow's
// fields come first in the JSON, at the top level.
type NodeDetail struct {
	NodeRow
	IDs IDs `json:"ids"`
	// Lineage is root first, parent last, without the node itself.
	Lineage  []LineageEntry `json:"lineage"`
	Children Children       `json:"children"`
	// NamedAncestor is, for an unnamed (mrca) node, the nearest named
	// ancestor; nil otherwise.
	NamedAncestor *LineageEntry `json:"namedAncestor"`
}

// NodeDetailFor is everything the panel needs about one node, and false if
// it does not exist.
func NodeDetailFor(ctx context.Context, db *sql.DB, ref NodeRef) (NodeDetail, bool, error) {
	id, found, err := Resolve(ctx, db, ref)
	if err != nil || !found {
		return NodeDetail{}, false, err
	}
	row, found, err := nodeByID(ctx, db, id)
	if err != nil || !found {
		return NodeDetail{}, false, err
	}

	lineage, err := Ancestors(ctx, db, id)
	if err != nil {
		return NodeDetail{}, false, err
	}
	var namedAncestor *LineageEntry
	if row.Name == nil {
		// Walk from the parent towards the root; the first name wins.
		for i := len(lineage) - 1; i >= 0; i-- {
			if lineage[i].Name != nil {
				entry := lineage[i]
				namedAncestor = &entry
				break
			}
		}
	}

	top, err := topChildren(ctx, db, id)
	if err != nil {
		return NodeDetail{}, false, err
	}

	var ids IDs
	if digits, ok := strings.CutPrefix(row.NodeID, "ott"); ok {
		if ott, ok := parseU32(digits); ok {
			ids.Ott = &ott
		}
	}
	ids.GBIF = row.GBIFID
	ids.NCBI = row.NCBIID

	detail := NodeDetail{
		NodeRow:       row,
		IDs:           ids,
		Lineage:       lineage,
		Children:      Children{Total: row.ChildCount, Top: top},
		NamedAncestor: namedAncestor,
	}
	return detail, true, nil
}

// topChildren is the TopChildren largest children of id by leaf count
// (ties by id); empty, not nil, for a tip.
func topChildren(ctx context.Context, db *sql.DB, id uint32) ([]ChildEntry, error) {
	// The index nodes_parent (parent, leaf_count DESC) serves this without
	// sorting all children of a huge polytomy.
	rows, err := db.QueryContext(ctx, `SELECT id, node_id, name, rank, grp, leaf_count FROM nodes
		WHERE parent = ? ORDER BY leaf_count DESC, id LIMIT ?`, id, TopChildren)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	top := []ChildEntry{}
	for rows.Next() {
		var c ChildEntry
		if err := rows.Scan(&c.ID, &c.NodeID, &c.Name, &c.Rank, &c.Group, &c.LeafCount); err != nil {
			return nil, err
		}
		top = append(top, c)
	}
	return top, rows.Err()
}
