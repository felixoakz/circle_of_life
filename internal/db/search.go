// Search over scientific and common names (ARCHITECTURE §5.2): FTS5 picks
// candidates by bm25, then our own score orders them.
//
// The steps: a whole-word pass, then a prefix
// pass (queries of 3+ characters); several names of one node keep the best
// scoring one (the earlier on a tie); the final order is score, then leaf
// count, then id.
//
// Concepts introduced here:
// - (none beyond the package's)

package db

import (
	"cmp"
	"context"
	"database/sql"
	"math"
	"slices"
	"strings"
	"unicode/utf8"

	"species/internal/names"
)

// searchCandidates is how many FTS rows each pass fetches before
// re-ranking.
const searchCandidates = 64

// contextNamesCount is how many ancestor names a search result shows.
const contextNamesCount = 3

// prefixMinChars: shorter queries (in characters) match whole words only.
const prefixMinChars = 3

// atOrBelowGenus are the ranks a search result's context line skips.
var atOrBelowGenus = [16]string{
	"genus", "subgenus", "section", "subsection", "series",
	"species group", "species subgroup", "species", "subspecies",
	"variety", "varietas", "subvariety", "forma", "form", "subform",
	"infraspecificname",
}

// SearchHit is one search result (ARCHITECTURE §5.1).
type SearchHit struct {
	NodeRow
	// Matched is the name that matched: scientific or common.
	Matched string `json:"matched"`
	// MatchedKind is "scientific" or "vernacular".
	MatchedKind string `json:"matchedKind"`
	// MatchedLang is the language of a vernacular match; nil for a
	// scientific one.
	MatchedLang *string `json:"matchedLang"`
	// Lineage is the 3 nearest named ancestors above genus, broadest first
	// ("Simiiformes, Catarrhini, Homininae"). Never nil.
	Lineage []string `json:"lineage"`
	Score   float64  `json:"-"`
}

// FTSQuery turns "homo  Sap" into `"homo"* AND "sap"*`, with quotes removed
// from every term; false if nothing is left. With prefix false the terms
// match whole words only (`"ox"`).
func FTSQuery(query string, prefix bool) (string, bool) {
	star := ""
	if prefix {
		star = "*"
	}
	var parts []string
	for _, token := range strings.Fields(query) {
		// Quotes are the only special character inside an FTS5 string, so
		// removing them makes any user input a safe term.
		token = strings.ReplaceAll(token, `"`, "")
		if token != "" {
			parts = append(parts, `"`+token+`"`+star)
		}
	}
	if len(parts) == 0 {
		return "", false
	}
	return strings.Join(parts, " AND "), true
}

// Score is the ranking of ARCHITECTURE §5.2. query is already folded
// (names.Fold); kind is KindScientific or KindVernacular.
func Score(query, matched string, kind uint8, node NodeRow) float64 {
	// Folded like the query, so "onça" equals GBIF's "Onca" and
	// "onça pintada" equals "Onça-pintada", as they do in the FTS index.
	name := names.Fold(matched)
	score := 0.0
	if name == query {
		score += 100
	}
	if strings.HasPrefix(name, query) {
		score += 20
	}
	if kind == KindScientific {
		score += 5
	}
	// Each product is wrapped in float64(...): an explicit conversion
	// rounds it, so the compiler may not fuse multiply and add into one
	// FMA instruction (arm64 does), which would round differently on
	// different machines and could swap two results with equal scores.
	//
	// Big clades beat obscure tips of the same name quality.
	score += float64(2 * math.Log10(float64(node.LeafCount)+1))
	// And well-known taxa beat obscure ones: "onça" is the jaguar's name
	// before it is any other cat's. ~1 for a beetle with one common name,
	// ~5 for the lion with ~60.
	score += float64(3 * math.Log10(float64(node.VernacularRows)+1))
	if node.Rank != nil && *node.Rank == "species" {
		score++
	}
	return score
}

// Search searches scientific and common names; best match first, at most
// limit hits. The result is never nil (an empty search is `[]`).
func Search(ctx context.Context, db *sql.DB, q string, limit int) ([]SearchHit, error) {
	hits := []SearchHit{}

	// Normalise: collapse whitespace, lowercase.
	query := lowercase(strings.Join(strings.Fields(q), " "))
	folded := names.Fold(query)
	chars := utf8.RuneCountInString(query)
	if chars < 2 {
		return hits, nil
	}
	// A two-letter prefix matches tens of thousands of names ("ho"* →
	// 27k), and bm25 has to score all of them to pick 64. So a short query
	// matches whole words only: still cheap, and it still finds the
	// genuinely short names ("Aa", an orchid genus; "ox").
	prefix := chars >= prefixMinChars
	fts, ok := FTSQuery(query, prefix)
	if !ok {
		return hits, nil
	}

	// bm25 only picks the candidates; the final order is our own score.
	// A prefix can match thousands of names ("cat"* → 10k), and bm25's
	// best 64 of those need not include the plain "Cat". So whole words
	// are asked for first, and the prefix candidates are added after.
	var rows []candidate
	if prefix {
		if words, ok := FTSQuery(query, false); ok {
			wordRows, err := candidates(ctx, db, words)
			if err != nil {
				return nil, err
			}
			rows = wordRows
		}
	}
	prefixRows, err := candidates(ctx, db, fts)
	if err != nil {
		return nil, err
	}
	rows = append(rows, prefixRows...)

	for _, c := range rows {
		node, found, err := nodeByID(ctx, db, c.node)
		if err != nil {
			return nil, err
		}
		if !found {
			continue
		}
		score := Score(folded, c.name, c.kind, node)
		// Several names can point at one node; keep its best match. On a
		// tie the earlier candidate stays: bm25 put it first.
		existing := -1
		for i := range hits {
			if hits[i].ID == c.node {
				existing = i
				break
			}
		}
		if existing >= 0 {
			if score > hits[existing].Score {
				hits[existing].Score = score
				hits[existing].Matched = c.name
				hits[existing].MatchedKind = kindName(c.kind)
				hits[existing].MatchedLang = c.lang
			}
			continue
		}
		hits = append(hits, SearchHit{
			NodeRow:     node,
			Matched:     c.name,
			MatchedKind: kindName(c.kind),
			MatchedLang: c.lang,
			Lineage:     []string{},
			Score:       score,
		})
	}

	// Highest score first; ties go to the bigger clade, then the lower id.
	// That is a total order, so the result is the same on every run.
	slices.SortFunc(hits, func(a, b SearchHit) int {
		if c := cmp.Compare(b.Score, a.Score); c != 0 {
			return c
		}
		if c := cmp.Compare(b.LeafCount, a.LeafCount); c != 0 {
			return c
		}
		return cmp.Compare(a.ID, b.ID)
	})
	if len(hits) > limit {
		hits = hits[:limit]
	}

	for i := range hits {
		lineage, err := contextNames(ctx, db, hits[i].ID)
		if err != nil {
			return nil, err
		}
		hits[i].Lineage = lineage
	}
	return hits, nil
}

// lowercase is strings.ToLower, except that 'İ' (capital I with dot)
// becomes "i̇" (i plus a combining dot), two characters, as in Unicode's
// full lowercase mapping; Go's simple mapping would give a plain 'i'. (The
// full mapping also lowercases a word-final Σ to ς; this does not. That
// only touches Greek queries.)
func lowercase(text string) string {
	return strings.ToLower(strings.ReplaceAll(text, "İ", "i\u0307"))
}

// candidate is one names_fts row that matched a query.
type candidate struct {
	node uint32
	name string
	kind uint8
	lang *string
}

// candidates are the best searchCandidates names for an FTS query, by bm25.
func candidates(ctx context.Context, db *sql.DB, fts string) ([]candidate, error) {
	rows, err := db.QueryContext(ctx, `SELECT node, name, kind, lang FROM names_fts
		WHERE names_fts MATCH ? ORDER BY rank LIMIT ?`, fts, searchCandidates)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []candidate
	for rows.Next() {
		var c candidate
		if err := rows.Scan(&c.node, &c.name, &c.kind, &c.lang); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// kindName is "scientific" or "vernacular".
func kindName(kind uint8) string {
	if kind == KindScientific {
		return "scientific"
	}
	return "vernacular"
}

// contextNames are the names of the nearest named ancestors above genus,
// broadest first: the one-line context under a search result.
func contextNames(ctx context.Context, db *sql.DB, id uint32) ([]string, error) {
	lineage, err := Ancestors(ctx, db, id)
	if err != nil {
		return nil, err
	}
	found := []string{}
	// Nearest first (the parent is last in lineage)...
	for i := len(lineage) - 1; i >= 0; i-- {
		entry := lineage[i]
		// Unnamed (mrca) nodes have neither.
		if entry.Name == nil || entry.Rank == nil {
			continue
		}
		// The root (id 0, "cellular organisms") is above everything and
		// says nothing. Genus and below are already in a species' name.
		if entry.ID == 0 || slices.Contains(atOrBelowGenus[:], *entry.Rank) || names.IsPlaceholder(*entry.Name) {
			continue
		}
		found = append(found, *entry.Name)
		if len(found) == contextNamesCount {
			break
		}
	}
	// ...then flipped so the line reads from broad to narrow.
	slices.Reverse(found)
	return found, nil
}
