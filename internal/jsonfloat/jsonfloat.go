// Package jsonfloat holds float types with the API's own JSON number format,
// so a float always reads as a float and never carries float32 noise:
// a whole number keeps a ".0" (`1.0`, `-123.0`) where Go's encoding/json
// would print `1`, and a float32 prints its shortest float32 form
// (`0.724`, not the widened `0.7239999771118164`).
//
// Used for `r` in nodes, lineage and search hits, `r0` in meta, and the
// distribution `bbox` in /about.
//
// Concepts introduced here:
// - methods on named types (`type F32 float32`)
// - implementing `json.Marshaler`
package jsonfloat

import (
	"strconv"
	"strings"
)

// LEARN: `type F32 float32` declares a new named type with float32 as its
// underlying type. It converts freely to and from float32 (`F32(x)`,
// `float32(f)`) but is a different type, so it can carry its own methods,
// which a plain float32 cannot.

// F32 is a float32 that marshals in its shortest float32 form.
type F32 float32

// F64 is a float64 that marshals in its shortest form, with ".0" if whole.
type F64 float64

// LEARN: encoding/json checks whether a value has the method
// `MarshalJSON() ([]byte, error)`, the one method of the `json.Marshaler`
// interface. If it does, json calls it and writes the bytes it returns
// as-is. Go interfaces are satisfied implicitly: nothing here says
// "implements json.Marshaler", having the method is enough.

// MarshalJSON writes the shortest decimal that reads back as the same
// float32, with ".0" appended to whole numbers.
func (f F32) MarshalJSON() ([]byte, error) {
	return format(float64(f), 32), nil
}

// MarshalJSON writes the shortest decimal that reads back as the same
// float64, with ".0" appended to whole numbers.
func (f F64) MarshalJSON() ([]byte, error) {
	return format(float64(f), 64), nil
}

// format prints v in plain decimal notation, shortest form for the given
// bit size ('f' with precision -1), then adds ".0" to a whole number the
// ("1.0", "-123.0").
//
// Plain 'f' never uses exponent notation. Our values are radii in
// [0.08, 1], bounding boxes in degrees and similar, so the output stays
// short.
func format(v float64, bits int) []byte {
	text := strconv.FormatFloat(v, 'f', -1, bits)
	if !strings.Contains(text, ".") {
		text += ".0"
	}
	return []byte(text)
}
