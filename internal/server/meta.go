// GET /api/meta (PLAN §5.1): the document the client loads first. Ingest
// stored it as JSON text, so it is sent verbatim, never re-encoded, with
// Cache-Control: no-cache (a new ingest changes dataVersion).
//
// Concepts introduced here:
// - (none beyond the package's)

package server

import "net/http"

func (s *State) meta(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	// no-cache: the browser may keep it but must revalidate every time.
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(s.Meta.JSON)
}
