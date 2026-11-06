// GET /api/nodes/{ref} (ARCHITECTURE §5.1): one node with its lineage and largest
// children. ref is a pre-order id, ott… or mrcaott… (db.ParseNodeRef). A
// malformed ref is a 400; one that matches nothing is a 404.
//
// Concepts introduced here:
// - (none beyond the package's)

package server

import (
	"net/http"

	"species/internal/db"
)

func (s *State) node(w http.ResponseWriter, r *http.Request) error {
	detail, err := s.nodeDetail(r)
	if err != nil {
		return err
	}
	return writeJSON(w, http.StatusOK, detail)
}

// nodeDetail is the node the request's {ref} names: a 400 if the ref is
// malformed, a 404 if nothing matches. /about uses it too.
func (s *State) nodeDetail(r *http.Request) (db.NodeDetail, error) {
	text := r.PathValue("ref")
	ref, err := db.ParseNodeRef(text)
	if err != nil {
		return db.NodeDetail{}, badRequest(err.Error())
	}
	detail, found, err := db.NodeDetailFor(r.Context(), s.Tree, ref)
	if err != nil {
		return db.NodeDetail{}, err
	}
	if !found {
		return db.NodeDetail{}, notFound("node " + text)
	}
	return detail, nil
}
