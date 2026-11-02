// Newick parser for the OpenTree synth tree (PLAN §3.1): one pass over the
// bytes with an explicit stack of open parentheses, no recursion, so a
// 2.7M-node tree cannot overflow the call stack. Labels are "ottN",
// "mrcaottNottM" or empty, optionally single-quoted ('' is a quote).
// Branch lengths are not expected and are an error.
//
// Concepts introduced here:
// - `[]byte` and indexing bytes
// - `switch` on a byte
// - multiple return values
// - wrapping errors with `fmt.Errorf("…: %w", err)`

package tree

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"unicode/utf8"
)

// ParseNewickFile reads and parses a Newick file; errors name the path.
func ParseNewickFile(path string) (*Tree, error) {
	// The whole file (31 MB) in memory is simpler than streaming, and the
	// tree built from it is ten times bigger anyway.
	text, err := os.ReadFile(path)
	if err != nil {
		// os errors already name the path.
		return nil, err
	}
	t, err := ParseNewick(text)
	if err != nil {
		// LEARN: `fmt.Errorf` with `%w` wraps an error: the new message is
		// "parsing <path>: <old message>", and `errors.Is`/`errors.As` can
		// still find the original inside. It is Go's way of adding context
		// on the way up.
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}
	return t, nil
}

// ParseNewick parses one Newick tree ending in ';'. Node 0 is the root and
// every parent index is smaller than its children's.
//
// LEARN: `[]byte` is a slice of bytes: a view (pointer, length, capacity)
// onto an array. Indexing it, `text[i]`, gives one byte, and a scanner over
// bytes is simple because every Newick delimiter is a single ASCII byte.
func ParseNewick(text []byte) (*Tree, error) {
	t := &Tree{}
	// The internal nodes whose '(' is still open, innermost last. A slice
	// is the stack: append pushes, open[:len(open)-1] pops.
	var open []uint32
	// True right after '(' or ',': the next thing must be a node. If a ','
	// or ')' comes instead, that node is a tip with no label.
	expectNode := true
	i := 0

	for i < len(text) {
		// LEARN: a `switch` compares its value with each `case` in order and
		// runs the first match only; Go cases never fall through to the next
		// one. A case can list several values, and `default` takes the rest.
		switch text[i] {
		case '(':
			parent, err := currentParent(t, open, i)
			if err != nil {
				return nil, err
			}
			node := t.AddNode(parent)
			open = append(open, node)
			expectNode = true
			i++
		case ',':
			if len(open) == 0 {
				return nil, fmt.Errorf("byte %d: ',' outside any parentheses", i)
			}
			if expectNode {
				if err := addTip(t, open, Label{}, i); err != nil {
					return nil, err
				}
			}
			expectNode = true
			i++
		case ')':
			if expectNode {
				if err := addTip(t, open, Label{}, i); err != nil {
					return nil, err
				}
			}
			if len(open) == 0 {
				return nil, fmt.Errorf("byte %d: ')' without a matching '('", i)
			}
			node := open[len(open)-1]
			open = open[:len(open)-1]
			label, next, err := readLabel(text, i+1)
			if err != nil {
				return nil, err
			}
			t.Label[node] = label
			expectNode = false
			i = next
		case ';':
			if len(open) != 0 {
				return nil, fmt.Errorf("byte %d: ';' before every '(' was closed", i)
			}
			if t.Len() == 0 {
				return nil, fmt.Errorf("byte %d: ';' before any node", i)
			}
			// Only whitespace may follow the end of the tree.
			for _, b := range text[i+1:] {
				if !isASCIISpace(b) {
					return nil, fmt.Errorf("byte %d: unexpected data after ';'", i)
				}
			}
			return t, nil
		case ' ', '\t', '\n', '\f', '\r': // isASCIISpace
			i++
		default:
			if !expectNode {
				return nil, fmt.Errorf("byte %d: label in an unexpected place", i)
			}
			label, next, err := readLabel(text, i)
			if err != nil {
				return nil, err
			}
			if err := addTip(t, open, label, i); err != nil {
				return nil, err
			}
			expectNode = false
			i = next
		}
	}
	return nil, errors.New("the tree does not end with ';'")
}

// currentParent is the innermost open '(' node, NoParent for the very first
// node, or an error for a second root. pos is the byte offset, for errors.
func currentParent(t *Tree, open []uint32, pos int) (uint32, error) {
	if len(open) > 0 {
		return open[len(open)-1], nil
	}
	if t.Len() == 0 {
		return NoParent, nil
	}
	return 0, fmt.Errorf("byte %d: more than one root", pos)
}

// addTip appends a tip with label under the current parent.
func addTip(t *Tree, open []uint32, label Label, pos int) error {
	parent, err := currentParent(t, open, pos)
	if err != nil {
		return err
	}
	node := t.AddNode(parent)
	t.Label[node] = label
	return nil
}

// readLabel reads the label starting at start (after optional whitespace)
// and returns it with the offset just past it.
//
// LEARN: a Go function can return several values. By convention the error
// comes last, and callers write `label, next, err := readLabel(…)`; the
// values are meaningless when err is not nil.
func readLabel(text []byte, start int) (Label, int, error) {
	for start < len(text) && isASCIISpace(text[start]) {
		start++
	}
	if start < len(text) && text[start] == '\'' {
		return readQuotedLabel(text, start)
	}
	end := start
	for end < len(text) && !isDelimiter(text[end]) {
		end++
	}
	// text[start:end] is a sub-slice sharing text's memory: nothing is
	// copied.
	label, err := parseLabel(text[start:end], start)
	if err != nil {
		return Label{}, 0, err
	}
	return label, end, nil
}

// readQuotedLabel reads a single-quoted label starting at the quote.
func readQuotedLabel(text []byte, start int) (Label, int, error) {
	var word []byte
	i := start + 1
	for {
		if i >= len(text) {
			return Label{}, 0, fmt.Errorf("byte %d: quoted label is never closed", start)
		}
		if text[i] == '\'' {
			if i+1 < len(text) && text[i+1] == '\'' {
				word = append(word, '\'')
				i += 2
				continue
			}
			break
		}
		word = append(word, text[i])
		i++
	}
	label, err := parseLabel(word, start)
	if err != nil {
		return Label{}, 0, err
	}
	return label, i + 1, nil
}

// isDelimiter reports the bytes that end an unquoted label.
func isDelimiter(b byte) bool {
	return b == '(' || b == ')' || b == ',' || b == ';' || isASCIISpace(b)
}

// isASCIISpace is ASCII whitespace: space, tab, newline,
// form feed and carriage return (not vertical tab).
func isASCIISpace(b byte) bool {
	return b == ' ' || b == '\t' || b == '\n' || b == '\f' || b == '\r'
}

// parseLabel turns a label's text into a Label; empty is LabelNone.
func parseLabel(word []byte, pos int) (Label, error) {
	if len(word) == 0 {
		return Label{}, nil
	}
	if bytes.HasPrefix(word, []byte("mrcaott")) {
		// The mrca text becomes a JSON string and a database key, so it
		// must be valid UTF-8.
		if !utf8.Valid(word) {
			return Label{}, fmt.Errorf("byte %d: label is not valid UTF-8", pos)
		}
		// string(word) copies the bytes: the label outlives the file text.
		return MrcaLabel(string(word)), nil
	}
	if digits, ok := bytes.CutPrefix(word, []byte("ott")); ok {
		if ott, ok := parseUint32(digits); ok {
			return OttLabel(ott), nil
		}
	}
	return Label{}, fmt.Errorf("byte %d: unknown label %q (expected ottN or mrcaottNottM)", pos, word)
}

// parseUint32 parses ASCII digits into a uint32: no sign, no spaces, no
// overflow. Shared with taxonomy.go.
//
// A hand-written loop rather than strconv.ParseUint, which takes a string:
// converting the bytes could allocate for each of the ~4.5M taxonomy rows.
func parseUint32(digits []byte) (uint32, bool) {
	if len(digits) == 0 {
		return 0, false
	}
	var n uint64
	for _, b := range digits {
		if b < '0' || b > '9' {
			return 0, false
		}
		n = n*10 + uint64(b-'0')
		if n > 1<<32-1 {
			return 0, false
		}
	}
	return uint32(n), true
}
