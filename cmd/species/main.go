// The species command: `species ingest …` builds tree.db from the raw
// data, `species serve …` runs the web server, `species healthcheck` asks
// a running server whether it is up (the Docker HEALTHCHECK), and
// `species version` prints the version.
//
// This file stays small on purpose: it picks the subcommand, parses its
// options (internal/config) and hands over to the package that does the
// work.
//
// Concepts introduced here:
// - modules, packages and import paths
// - exported (capitalised) and unexported names
// - the `internal/` directory rule
// - `package main`, `os.Args` and `os.Exit`
// - errors as values: returning, wrapping and inspecting them
// - a custom error type (any type with an `Error() string` method)
//
// LEARN: `package main` is special: it builds into a program rather than a
// library, and its `func main()` is where the program starts. Every other
// package is a library that some `main` imports.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"

	// LEARN: go.mod at the repository root declares the module path
	// `species`. Every directory with .go files is a package, imported by
	// the module path plus its directory: internal/config is
	// "species/internal/config". Directories under `internal/` can only be
	// imported by code inside this module, so nothing outside can depend
	// on them. A package is named by the last element of its path, so the
	// code below says `config.ParseIngest`.
	"species/internal/config"
	"species/internal/healthcheck"
	"species/internal/ingest"
	"species/internal/server"
)

// usage is the top-level help: the subcommands and a one-line summary each.
// Each subcommand also answers -h with its own flags (from internal/config).
const usage = `Circle of Life: a zoomable radial tree of all species in the Open Tree of Life

Usage: species <COMMAND>

Commands:
  ingest       Build tree.db from the synth tree and the OTT taxonomy
  serve        Serve the API and the built frontend
  healthcheck  Exit 0 if the local server answers /healthz (Docker HEALTHCHECK)
  version      Print the version
  help         Print this message

Options:
  -h, --help     Print help
  -V, --version  Print version

Run 'species <COMMAND> -h' for the options of a command.
`

// usageError is a mistake on the command line (an unknown subcommand, a
// missing or bad flag), as opposed to a failure while doing the work.
// main exits with 2 for these, the usual code for bad usage, and 1 for
// the rest.
//
// LEARN: `error` is an interface with one method, `Error() string`. Any
// type with that method is an error, so a plain struct can carry extra
// data and still be returned wherever an error is expected. An Unwrap
// method lets errors.Is and errors.As look inside it; errors.As in main
// asks "is there a usageError anywhere in this chain?" and, if so, copies
// it into the variable it is given.
type usageError struct {
	err error
}

func (e usageError) Error() string { return e.err.Error() }
func (e usageError) Unwrap() error { return e.err }

func main() {
	// LEARN: os.Args is the command line as a slice of strings: os.Args[0]
	// is the program's own path, the rest are its arguments, so
	// os.Args[1:] (a slice from index 1 to the end) is what the user typed
	// after `species`.
	err := run(os.Args[1:])
	if err == nil {
		return
	}
	// The flag package has already printed the help for -h / --help; that
	// is a success, not a usage error.
	if errors.Is(err, flag.ErrHelp) {
		return
	}
	fmt.Fprintln(os.Stderr, "error:", err)
	// LEARN: os.Exit ends the process at once with that exit status (0 is
	// success). It skips deferred calls, so it belongs here in main, after
	// everything else has finished, never deep inside the program. Go's
	// main returns nothing; os.Exit is how a program reports failure.
	var usageErr usageError
	if errors.As(err, &usageErr) {
		fmt.Fprintln(os.Stderr, "\nFor more information, try '--help'.")
		os.Exit(2)
	}
	os.Exit(1)
}

// run dispatches to the subcommand named by args[0].
//
// LEARN: Go has no exceptions. A function that can fail returns an `error`
// value as its last result, nil meaning success, and the caller checks it
// with `if err != nil` straight away: handle it, or return it (often
// wrapped with more context) to its own caller. Here every error ends up
// back in main, which prints it once.
func run(args []string) error {
	if len(args) == 0 {
		fmt.Fprint(os.Stderr, usage)
		return usageError{errors.New("no command given")}
	}
	// LEARN: a name starting with a capital letter (config.ParseIngest,
	// ingest.Run) is exported: other packages may use it. A lower-case
	// name (run, usage) is visible only inside its own package. That one
	// rule replaces keywords like `public` or `export`.
	switch args[0] {
	case "ingest":
		cfg, err := config.ParseIngest(args[1:])
		if err != nil {
			return asUsage(err)
		}
		return ingest.Run(cfg, os.Stdout)
	case "serve":
		cfg, err := config.ParseServe(args[1:], os.Getenv)
		if err != nil {
			return asUsage(err)
		}
		// The default logger prints "2026/10/30 12:00:00 INFO msg k=v" to
		// stderr; LOG_LEVEL only moves its threshold.
		slog.SetLogLoggerLevel(cfg.LogLevel)
		// server.Run stops cleanly on Ctrl+C or SIGTERM by itself
		// (signal.NotifyContext on this context).
		return server.Run(context.Background(), cfg)
	case "healthcheck":
		cfg, err := config.ParseHealthcheck(args[1:], os.Getenv)
		if err != nil {
			return asUsage(err)
		}
		return healthcheck.Run(cfg)
	case "version", "--version", "-V":
		fmt.Println("species", config.Version)
		return nil
	case "help", "--help", "-h":
		fmt.Print(usage)
		return nil
	default:
		return usageError{fmt.Errorf("unrecognized subcommand %q", args[0])}
	}
}

// asUsage marks a parse error as a command-line mistake, except -h, which
// main treats as success.
func asUsage(err error) error {
	if errors.Is(err, flag.ErrHelp) {
		return err
	}
	return usageError{err}
}
