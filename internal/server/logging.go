// One log line per request: "GET /api/meta 200 312.4µs".
//
// Concepts introduced here:
// - (none beyond the package's)

package server

import (
	"fmt"
	"log/slog"
	"net/http"
	"time"
)

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		slog.Info(fmt.Sprintf("%s %s %d %s", r.Method, r.URL.Path, sw.status, oneDecimal(time.Since(start))))
	})
}

// statusWriter remembers the status the handler sent (200 if it never
// called WriteHeader).
type statusWriter struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (s *statusWriter) WriteHeader(status int) {
	if !s.wroteHeader {
		s.status = status
		s.wroteHeader = true
	}
	s.ResponseWriter.WriteHeader(status)
}

func (s *statusWriter) Write(b []byte) (int, error) {
	s.wroteHeader = true
	return s.ResponseWriter.Write(b)
}

// oneDecimal rounds d to one decimal in its own unit, so log lines read
// 312.4µs, 1.2ms, 2.5s.
func oneDecimal(d time.Duration) time.Duration {
	switch {
	case d < time.Microsecond:
		return d
	case d < time.Millisecond:
		return d.Round(100 * time.Nanosecond)
	case d < time.Second:
		return d.Round(100 * time.Microsecond)
	default:
		return d.Round(100 * time.Millisecond)
	}
}
