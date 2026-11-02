// Tests of `species healthcheck` against a local test server.
//
// Concepts introduced here:
// - (none beyond the package's)

package healthcheck

import (
	"net"
	"net/http"
	"net/http/httptest"
	"testing"

	"species/internal/config"
)

// serve starts a server on 127.0.0.1 answering /healthz with status and
// returns its port.
func serve(t *testing.T, status int) int {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(status)
		w.Write([]byte("ok"))
	}))
	t.Cleanup(srv.Close)
	return srv.Listener.Addr().(*net.TCPAddr).Port
}

// A 200 from /healthz is healthy.
func TestHealthyServer(t *testing.T) {
	port := serve(t, http.StatusOK)
	if err := Run(config.Healthcheck{Port: port}); err != nil {
		t.Errorf("healthy server: %v", err)
	}
}

// Any other status is unhealthy.
func TestUnhealthyServer(t *testing.T) {
	port := serve(t, http.StatusServiceUnavailable)
	if err := Run(config.Healthcheck{Port: port}); err == nil {
		t.Error("503: want an error")
	}
}

// Nothing listening is unhealthy.
func TestNoServer(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	if err := Run(config.Healthcheck{Port: port}); err == nil {
		t.Error("closed port: want an error")
	}
}
