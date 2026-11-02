// Plain text from HTML fragments (Commons' Artist, GBIF's publishedIn).
//
// Concepts introduced here:
// - a tiny state machine over the runes of a string

package enrich

import "strings"

// StripHTML removes tags, decodes the common entities and collapses
// whitespace. The result is shown with textContent, never as HTML.
func StripHTML(html string) string {
	var text strings.Builder
	inTag := false
	// Ranging over the string gives runes, not bytes. A bool is enough state for this tiny machine: inside a tag or not.
	for _, c := range html {
		switch {
		case c == '<':
			inTag = true
		case c == '>' && inTag:
			inTag = false
			// A tag may separate words ("A<br>B").
			text.WriteRune(' ')
		case !inTag:
			text.WriteRune(c)
		}
	}
	decoded := text.String()
	decoded = strings.ReplaceAll(decoded, "&nbsp;", " ")
	decoded = strings.ReplaceAll(decoded, "&lt;", "<")
	decoded = strings.ReplaceAll(decoded, "&gt;", ">")
	decoded = strings.ReplaceAll(decoded, "&quot;", "\"")
	decoded = strings.ReplaceAll(decoded, "&#39;", "'")
	decoded = strings.ReplaceAll(decoded, "&#039;", "'")
	decoded = strings.ReplaceAll(decoded, "&amp;", "&")

	// Collapse runs of whitespace (including the spaces added for tags).
	joined := strings.Join(strings.Fields(decoded), " ")
	// A tag between a word and its punctuation leaves "word ," behind.
	joined = strings.ReplaceAll(joined, " ,", ",")
	joined = strings.ReplaceAll(joined, " .", ".")
	joined = strings.ReplaceAll(joined, " ;", ";")
	joined = strings.ReplaceAll(joined, " :", ":")
	return joined
}
