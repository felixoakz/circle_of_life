// gzip for responses. The rules: skip when Content-Encoding or
// Content-Range is set, bodies under 32
// bytes, image/* except image/svg+xml, font/*, gRPC and text/event-stream;
// add "Vary: accept-encoding" whenever compression was allowed, even if the
// client did not accept gzip.
//
// Concepts introduced here:
// - wrapping http.ResponseWriter by embedding an interface

package server

import (
	"bytes"
	"compress/gzip"
	"net/http"
	"strconv"
	"strings"
)

// minGzipSize: smaller bodies are sent as they are; a body of exactly 32
// bytes is zipped. Below this, gzip's own header outweighs the savings.
const minGzipSize = 32

// compress is the gzip middleware.
func compress(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gw := &gzipWriter{
			ResponseWriter: w,
			acceptsGzip:    acceptsGzip(r.Header.Get("Accept-Encoding")),
			status:         http.StatusOK,
		}
		next.ServeHTTP(gw, r)
		gw.finish()
	})
}

// LEARN: a struct that embeds an interface (`http.ResponseWriter` with no
// field name) gets all of that interface's methods, forwarded to whatever
// value is stored in the field. gzipWriter is therefore an
// http.ResponseWriter itself, and only the methods it declares (Write,
// WriteHeader) behave differently; Header() is the real writer's.
//
// gzipWriter decides when the handler sends its status: if the headers
// already rule compression out it passes everything straight through;
// otherwise it holds the body back until the handler is done, because the
// size rule needs the whole length.
type gzipWriter struct {
	http.ResponseWriter
	acceptsGzip bool

	status      int
	wroteHeader bool // the handler called WriteHeader (or Write)
	passThrough bool // decided: no compression, write directly
	buf         bytes.Buffer
}

func (g *gzipWriter) WriteHeader(status int) {
	if g.wroteHeader {
		return
	}
	g.wroteHeader = true
	g.status = status
	if !mayCompress(g.Header()) {
		g.passThrough = true
		g.ResponseWriter.WriteHeader(status)
	}
}

func (g *gzipWriter) Write(b []byte) (int, error) {
	if !g.wroteHeader {
		g.WriteHeader(http.StatusOK)
	}
	if g.passThrough {
		return g.ResponseWriter.Write(b)
	}
	return g.buf.Write(b)
}

// finish sends what the handler left in the buffer, zipped if the rules
// and the client allow it.
func (g *gzipWriter) finish() {
	if !g.wroteHeader {
		g.WriteHeader(http.StatusOK)
	}
	if g.passThrough {
		return
	}
	body := g.buf.Bytes()
	header := g.Header()
	if len(body) < minGzipSize {
		g.ResponseWriter.WriteHeader(g.status)
		g.ResponseWriter.Write(body)
		return
	}
	// A shared cache must keep zipped and plain answers apart, so the Vary
	// goes on both.
	header.Add("Vary", "accept-encoding")
	if !g.acceptsGzip {
		g.ResponseWriter.WriteHeader(g.status)
		g.ResponseWriter.Write(body)
		return
	}
	// net/http would sniff a missing type from the zipped bytes; sniff the
	// real ones instead.
	if header.Get("Content-Type") == "" {
		header.Set("Content-Type", http.DetectContentType(body))
	}
	var zipped bytes.Buffer
	zw := gzip.NewWriter(&zipped)
	// Writes to a bytes.Buffer cannot fail.
	zw.Write(body)
	zw.Close()
	header.Del("Accept-Ranges")
	header.Set("Content-Encoding", "gzip")
	header.Set("Content-Length", strconv.Itoa(zipped.Len()))
	g.ResponseWriter.WriteHeader(g.status)
	g.ResponseWriter.Write(zipped.Bytes())
}

// mayCompress applies the rules that depend on headers only.
func mayCompress(header http.Header) bool {
	if header.Get("Content-Encoding") != "" || header.Get("Content-Range") != "" {
		return false
	}
	contentType := header.Get("Content-Type")
	if strings.HasPrefix(contentType, "image/") && !strings.HasPrefix(contentType, "image/svg+xml") {
		return false
	}
	// woff2 is Brotli inside already; application/font-woff is not font/*
	// and so is zipped.
	for _, prefix := range []string{"font/", "application/grpc", "text/event-stream"} {
		if strings.HasPrefix(contentType, prefix) {
			return false
		}
	}
	return true
}

// acceptsGzip reads an Accept-Encoding header such as "gzip, deflate, br"
// or "gzip;q=0.5": gzip is accepted unless it is missing or has q=0.
func acceptsGzip(header string) bool {
	for _, part := range strings.Split(header, ",") {
		name, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		name = strings.ToLower(strings.TrimSpace(name))
		if name != "gzip" && name != "x-gzip" {
			continue
		}
		q := 1.0
		if value, ok := strings.CutPrefix(strings.TrimSpace(params), "q="); ok {
			parsed, err := strconv.ParseFloat(value, 64)
			if err != nil {
				continue
			}
			q = parsed
		}
		if q > 0 {
			return true
		}
	}
	return false
}
