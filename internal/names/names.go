// Package names holds the text rules shared by search (internal/db) and
// common names (internal/vernacular): folding a name the way the FTS5
// tokenizer does, and spotting OTT's placeholder names. It lives on its own
// so that db and vernacular do not import each other.
//
// Concepts introduced here:
// - runes: iterating a string by Unicode code point
// - the `unicode` package
package names

import (
	"strings"
	"unicode"
)

// Fold lowercases text, removes Latin accents and turns every run of
// characters that are not letters or digits into a single space, trimmed:
// "Onça-pintada " → "onca pintada". The same folding the FTS tokenizer
// (`unicode61 remove_diacritics 2`) applies to each word.
func Fold(text string) string {
	var out strings.Builder
	out.Grow(len(text))
	// Starts true so leading separators are dropped.
	afterSpace := true
	// LEARN: `range` over a string steps through it one rune (a Unicode
	// code point, an int32) at a time, decoding UTF-8 as it goes; `i` would
	// be the byte offset, which is why "ç" advances it by 2. Indexing a
	// string (`text[i]`) gives a byte instead.
	for _, r := range lower(text) {
		plain := unaccent(r)
		if isAlphanumeric(plain) {
			out.WriteRune(plain)
			afterSpace = false
		} else if !afterSpace {
			out.WriteByte(' ')
			afterSpace = true
		}
	}
	return strings.TrimSuffix(out.String(), " ")
}

// lower lowercases text with unicode.ToLower, which maps one rune to one
// rune, except for 'İ' (capital I with dot above): Unicode's full mapping
// gives "i" plus a combining dot (U+0307), two runes, and so does this
// (search.go's lowercase does the same, so both sides agree).
func lower(text string) string {
	var out strings.Builder
	out.Grow(len(text))
	for _, r := range text {
		if r == 'İ' {
			out.WriteString("i̇")
		} else {
			out.WriteRune(unicode.ToLower(r))
		}
	}
	return out.String()
}

// unaccent maps a lowercase Latin letter with an accent to its plain
// letter. The ranges are runs of consecutive code points in Latin-1:
// à á â ã ä å, è é ê ë, and so on.
func unaccent(r rune) rune {
	switch {
	case r >= 'à' && r <= 'å', r == 'ā', r == 'ă', r == 'ą':
		return 'a'
	case r == 'ç', r == 'ć', r == 'č':
		return 'c'
	case r >= 'è' && r <= 'ë', r == 'ē', r == 'ė', r == 'ę', r == 'ě':
		return 'e'
	case r >= 'ì' && r <= 'ï', r == 'ī', r == 'į':
		return 'i'
	case r == 'ñ', r == 'ń', r == 'ň':
		return 'n'
	case r >= 'ò' && r <= 'ö', r == 'ø', r == 'ō', r == 'ő':
		return 'o'
	case r >= 'ù' && r <= 'ü', r == 'ū', r == 'ů', r == 'ű':
		return 'u'
	case r == 'ý', r == 'ÿ':
		return 'y'
	case r == 'š', r == 'ś':
		return 's'
	case r == 'ž', r == 'ź', r == 'ż':
		return 'z'
	}
	return r
}

// isAlphanumeric reports whether r has the Unicode
// Alphabetic property (letters, letter numbers like Roman numerals, and
// Other_Alphabetic marks such as many Indic vowel signs) or Numeric
// (categories Nd, Nl, No).
func isAlphanumeric(r rune) bool {
	// LEARN: the `unicode` package answers questions about a rune from
	// Unicode's tables: its category (unicode.IsLetter is category L,
	// unicode.IsNumber category N) or any named property table, checked
	// with unicode.Is(table, r).
	return unicode.IsLetter(r) || unicode.IsNumber(r) || unicode.Is(unicode.Other_Alphabetic, r)
}

// IsPlaceholder reports OTT bookkeeping names that are not taxa a reader
// would recognise: "h2007-1" style codes and "… incertae sedis",
// "unclassified …", "environmental samples" containers. The same rule as
// the frontend's isPlaceholderName (web/src/names.ts).
func IsPlaceholder(name string) bool {
	low := lower(name)
	return strings.Contains(low, "incertae sedis") ||
		strings.HasPrefix(low, "unclassified") ||
		strings.HasPrefix(low, "environmental samples") ||
		isHCode(name)
}

// isHCode reports `h2007-1`: an "h", four digits, a dash, then digits.
func isHCode(name string) bool {
	rest, ok := strings.CutPrefix(name, "h")
	if !ok {
		return false
	}
	year, number, ok := strings.Cut(rest, "-")
	if !ok {
		return false
	}
	return len(year) == 4 && allDigits(year) && allDigits(number)
}

// allDigits reports a non-empty text of ASCII digits only.
func allDigits(text string) bool {
	if text == "" {
		return false
	}
	for i := 0; i < len(text); i++ {
		if text[i] < '0' || text[i] > '9' {
			return false
		}
	}
	return true
}
