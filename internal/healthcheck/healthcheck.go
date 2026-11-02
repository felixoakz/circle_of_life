// Package healthcheck is `species healthcheck`: it asks the running server
// for /healthz and succeeds only on a 200. The Docker HEALTHCHECK runs it,
// so the runtime image needs neither curl nor wget.
//
// Its options live in config.Healthcheck.
//
// Concepts introduced here:
// - an `http.Client` with a timeout
package healthcheck

import (
	"fmt"
	"io"
	"net/http"
	"time"

	"species/internal/config"
)

// timeout covers connecting and the whole answer.
const timeout = 3 * time.Second

// Run sends GET http://127.0.0.1:PORT/healthz and returns an error unless
// the status is 200.
func Run(cfg config.Healthcheck) error {
	// LEARN: http.Get uses http.DefaultClient, which never gives up on a
	// server that accepts the connection and then says nothing. A Client of
	// our own with Timeout bounds the whole exchange: connecting, sending,
	// and reading the answer to the end.
	client := &http.Client{Timeout: timeout}
	url := fmt.Sprintf("http://127.0.0.1:%d/healthz", cfg.Port)
	res, err := client.Get(url)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	// Read the body too, so a server that stalls mid-answer is unhealthy.
	if _, err := io.Copy(io.Discard, res.Body); err != nil {
		return fmt.Errorf("reading the answer: %w", err)
	}
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("unhealthy: %s", res.Status)
	}
	return nil
}
