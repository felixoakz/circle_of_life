// GET /api/search?q=homo%20sap&limit=8 (PLAN §5.2). The ranking itself is
// db.Search. limit defaults to 8 and is clamped to 1..50; a malformed limit
// (abc, -1) is a JSON 400 naming "limit".
//
// Concepts introduced here:
// - (none beyond the package's)

package server

import (
	"fmt"
	"net/http"

	"species/internal/db"
)

const (
	defaultLimit = 8
	maxLimit     = 50
)

func (s *State) search(w http.ResponseWriter, r *http.Request) error {
	query := r.URL.Query()
	limit := defaultLimit
	if query.Has("limit") {
		text := query.Get("limit")
		n, err := parseUint(text, 64)
		if err != nil {
			return badRequest(fmt.Sprintf("limit %q is not a whole number", text))
		}
		limit = int(min(max(n, 1), maxLimit))
	}
	hits, err := db.Search(r.Context(), s.Tree, query.Get("q"), limit)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, hits)
}
