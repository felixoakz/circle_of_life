// The server's one error type, httpError, and how it becomes an HTTP
// response: a JSON body {"error": "…"} with the right status code (ARCHITECTURE
// §5). Server faults (database errors) are logged and answered with a
// plain "internal error"; the details never reach the client.
//
// Concepts introduced here:
// - handlers that return an error, adapted to http.Handler

package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
)

// httpError is an ordinary error that also carries the status code; the
// handle adapter below gets it back with `errors.As`.
type httpError struct {
	status int
	msg    string
}

func (e *httpError) Error() string {
	return e.msg
}

func notFound(what string) error {
	return &httpError{status: http.StatusNotFound, msg: "not found: " + what}
}

func badRequest(what string) error {
	return &httpError{status: http.StatusBadRequest, msg: "bad request: " + what}
}

// errorBody is the JSON shape of every error response.
type errorBody struct {
	Error string `json:"error"`
}

// handlerFunc is a handler that may fail. Returning the error, instead of
// writing the response in every branch, keeps each handler's happy path
// straight and puts the error format in one place (handle).
type handlerFunc func(w http.ResponseWriter, r *http.Request) error

// LEARN: http.HandlerFunc is a function type with a ServeHTTP method, so
// any `func(http.ResponseWriter, *http.Request)` becomes an http.Handler by
// conversion. handle adapts our error-returning handlers to that shape: the
// closure it returns calls h and turns a returned error into a response.
func handle(h handlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		err := h(w, r)
		if err == nil {
			return
		}
		var he *httpError
		if errors.As(err, &he) {
			writeError(w, he.status, he.msg)
			return
		}
		// A client that went away cancels the request's context, and the
		// handler's queries or fetches fail with that. Nobody is left to
		// answer and nothing is wrong with the server: no ERROR line.
		if r.Context().Err() != nil {
			slog.Info("client went away", "path", r.URL.Path)
			return
		}
		slog.Error("request failed", "path", r.URL.Path, "error", err)
		writeError(w, http.StatusInternalServerError, "internal error")
	}
}

func writeError(w http.ResponseWriter, status int, msg string) {
	// errorBody always encodes; there is nothing useful to do if it did not.
	_ = writeJSON(w, status, errorBody{Error: msg})
}

// encodeJSON is v as compact JSON: no escaping of
// < > & (json.Marshal turns them into <…) and no trailing newline
// (an Encoder adds one).
func encodeJSON(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

// writeJSON sends v as an application/json response with status.
func writeJSON(w http.ResponseWriter, status int, v any) error {
	body, err := encodeJSON(v)
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	// A failed write means the client went away; there is no one to tell.
	w.Write(body)
	return nil
}

// parseUint parses an unsigned decimal number: one leading '+' is
// allowed, a '-' or anything else is not. bits is the size of the target
// type (8 for a uint8, 32 for a uint32, 64 for a uint64).
func parseUint(text string, bits int) (uint64, error) {
	digits := strings.TrimPrefix(text, "+")
	return strconv.ParseUint(digits, 10, bits)
}
