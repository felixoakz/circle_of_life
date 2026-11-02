// GET /api/v/{ver}/tiles/{level}/{sector} (PLAN §5.1, docs/tile-format.md):
// the gzipped tile blob exactly as ingest stored it, with
// Content-Encoding: gzip (so the gzip middleware leaves it alone). A wrong
// version is a 404, a bad number a 400, an empty tile a 204.
//
// Concepts introduced here:
// - `r.PathValue`: the text a pattern's {wildcard} matched

package server

import (
	"fmt"
	"net/http"

	"species/internal/db"
)

// immutable is the Cache-Control of a tile (its URL carries the data
// version, so its content never changes) and of hashed /assets files.
const immutable = "public, max-age=31536000, immutable"

func (s *State) tile(w http.ResponseWriter, r *http.Request) error {
	// LEARN: r.PathValue("ver") is the text the {ver} wildcard of the
	// route pattern matched, already percent-decoded. It is a string; the
	// handler parses numbers itself, so a bad one gets our JSON 400.
	ver := r.PathValue("ver")
	levelText := r.PathValue("level")
	sectorText := r.PathValue("sector")

	// The client sees 404, reloads meta and asks again with the new version.
	if ver != s.Meta.DataVersion {
		return notFound(fmt.Sprintf("data version %s (current: %s)", ver, s.Meta.DataVersion))
	}
	level, err := parseUint(levelText, 8)
	if err != nil {
		return badRequest(fmt.Sprintf("level %q", levelText))
	}
	sector, err := parseUint(sectorText, 32)
	if err != nil {
		return badRequest(fmt.Sprintf("sector %q", sectorText))
	}

	blob, found, err := db.Tile(r.Context(), s.Tree, uint8(level), uint32(sector))
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", immutable)
	if !found {
		// Empty tiles are not stored. That is as permanent as the version.
		w.WriteHeader(http.StatusNoContent)
		return nil
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	// Already gzip: tells the browser to unzip it and the gzip middleware
	// to leave it alone.
	w.Header().Set("Content-Encoding", "gzip")
	w.Write(blob)
	return nil
}
