// Package config holds the command-line options of the three subcommands
// (ingest, serve, healthcheck), the User-Agent for upstream requests and the
// base URLs of the upstream APIs.
//
// Every serve option can also come from an environment variable (see
// .env.example), which is how the Docker container is configured. A flag
// beats the environment, which beats the default. The standard `flag`
// package accepts both `-x` and `--x`, so the Makefile's `--data` style
// keeps working.
//
// Concepts introduced here:
// - structs with named fields
// - the `flag` package: one FlagSet per subcommand
// - reading the environment through an injected `getenv` function
// - pointers to fields (`&cfg.Tree`) for flag.StringVar
// - methods on a struct
package config

import (
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"path/filepath"
	"strconv"
	"strings"
)

// Version of the program, sent in the User-Agent and printed by
// `species version`.
const Version = "0.1.0"

// Ingest holds the options of `species ingest` (ARCHITECTURE §3).
type Ingest struct {
	// Tree is the Newick synth tree (labelled_supertree.tre).
	Tree string
	// Taxonomy is OTT's taxonomy.tsv.
	Taxonomy string
	// Vernacular is the GBIF backbone.zip (read through `unzip -p`), its
	// VernacularName.tsv, or "-" for that TSV on stdin. Empty: no common
	// names.
	Vernacular string
	// Langs is the comma-separated list of languages to keep ("en,pt").
	Langs string
	// Out is the output database, written to Out+".tmp" first, then renamed.
	Out string
	// DryRun parses and computes everything, prints statistics, writes nothing.
	DryRun bool
}

// Serve holds the options of `species serve` (ARCHITECTURE §5, §10).
type Serve struct {
	// DataDir holds tree.db and cache.db. Flag --data, env SPECIES_DATA_DIR,
	// default "data".
	DataDir string
	// DB is the tree database's file name inside DataDir. Flag --db,
	// default "tree.db".
	DB string
	// StaticDir is the built frontend. Flag --static, env
	// SPECIES_STATIC_DIR, default "web/dist".
	StaticDir string
	// Port to listen on, all interfaces. Flag --port, env PORT, default 3000.
	Port int
	// Contact (an email or a contact page) for the User-Agent. Flag
	// --contact, env SPECIES_CONTACT. Empty: none. Never hard-coded.
	Contact string
	// PublicURL of this site, also in the User-Agent. Flag --public-url,
	// env SPECIES_PUBLIC_URL. Empty: none.
	PublicURL string
	// LogLevel is the lowest level that is logged. Env LOG_LEVEL (debug,
	// info, warn or error), default info. The zero value is slog.LevelInfo.
	LogLevel slog.Level
}

// Healthcheck holds the options of `species healthcheck`.
type Healthcheck struct {
	// Port the server listens on (the same PORT as serve). Flag --port,
	// env PORT, default 3000.
	Port int
}

// ParseIngest reads the options of `species ingest` from args (the words
// after the subcommand).
func ParseIngest(args []string) (Ingest, error) {
	// LEARN: a struct is a set of named fields. `var cfg Ingest` declares one
	// with every field at its zero value ("" for strings, false for bools,
	// 0 for numbers), so only the fields we set below need a value.
	var cfg Ingest

	// LEARN: the `flag` package parses `-name value`, `--name value` and
	// `--name=value`. A FlagSet is one parser; each subcommand gets its own,
	// built here rather than in a package-level variable, so nothing is
	// shared between calls. ContinueOnError makes Parse return an error
	// instead of exiting the program, which leaves that decision to main.
	fs := flag.NewFlagSet("ingest", flag.ContinueOnError)
	// LEARN: `&cfg.Tree` is a pointer to the field. StringVar keeps the
	// pointer and writes the parsed value through it during Parse, so after
	// Parse the struct holds the options.
	fs.StringVar(&cfg.Tree, "tree", "", "Newick synth tree (labelled_supertree.tre)")
	fs.StringVar(&cfg.Taxonomy, "taxonomy", "", "OTT taxonomy.tsv")
	fs.StringVar(&cfg.Vernacular, "vernacular", "",
		"common names: GBIF backbone.zip, its VernacularName.tsv, or - for that TSV on stdin")
	fs.StringVar(&cfg.Langs, "langs", "en,pt", "comma-separated languages to keep from the vernacular names")
	fs.StringVar(&cfg.Out, "out", "data/tree.db", "output database (written to <out>.tmp, then renamed)")
	fs.BoolVar(&cfg.DryRun, "dry-run", false, "parse and compute everything, print statistics, write nothing")

	if err := fs.Parse(args); err != nil {
		return Ingest{}, err
	}
	if fs.NArg() > 0 {
		return Ingest{}, fmt.Errorf("ingest: unexpected argument %q", fs.Arg(0))
	}
	// These two are required; `flag` has no such notion, so check here.
	if cfg.Tree == "" {
		return Ingest{}, errors.New("ingest: --tree is required")
	}
	if cfg.Taxonomy == "" {
		return Ingest{}, errors.New("ingest: --taxonomy is required")
	}
	return cfg, nil
}

// ParseServe reads the options of `species serve` from args, falling back
// to the environment (looked up with getenv, os.Getenv in main) and then to
// the defaults.
func ParseServe(args []string, getenv func(string) string) (Serve, error) {
	// The environment becomes each flag's default, so a flag given on the
	// command line overrides it and an unset variable leaves the built-in
	// default: flag beats environment beats default.
	port, err := envPort(getenv)
	if err != nil {
		return Serve{}, err
	}

	var cfg Serve
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.StringVar(&cfg.DataDir, "data", envOr(getenv, "SPECIES_DATA_DIR", "data"),
		"directory holding tree.db and cache.db (env SPECIES_DATA_DIR)")
	fs.StringVar(&cfg.DB, "db", "tree.db", "file name of the tree database inside the data directory")
	fs.StringVar(&cfg.StaticDir, "static", envOr(getenv, "SPECIES_STATIC_DIR", "web/dist"),
		"directory of the built frontend (env SPECIES_STATIC_DIR)")
	fs.IntVar(&cfg.Port, "port", port, "TCP port to listen on, all interfaces (env PORT)")
	fs.StringVar(&cfg.Contact, "contact", getenv("SPECIES_CONTACT"),
		"contact for upstream APIs, sent in the User-Agent (env SPECIES_CONTACT)")
	fs.StringVar(&cfg.PublicURL, "public-url", getenv("SPECIES_PUBLIC_URL"),
		"public URL of this site, sent in the User-Agent (env SPECIES_PUBLIC_URL)")

	if err := fs.Parse(args); err != nil {
		return Serve{}, err
	}
	if fs.NArg() > 0 {
		return Serve{}, fmt.Errorf("serve: unexpected argument %q", fs.Arg(0))
	}
	if err := checkPort(cfg.Port); err != nil {
		return Serve{}, err
	}
	cfg.Contact = strings.TrimSpace(cfg.Contact)
	cfg.PublicURL = strings.TrimSpace(cfg.PublicURL)
	level, err := envLogLevel(getenv)
	if err != nil {
		return Serve{}, err
	}
	cfg.LogLevel = level
	return cfg, nil
}

// ParseHealthcheck reads the options of `species healthcheck`, like
// ParseServe.
func ParseHealthcheck(args []string, getenv func(string) string) (Healthcheck, error) {
	port, err := envPort(getenv)
	if err != nil {
		return Healthcheck{}, err
	}

	var cfg Healthcheck
	fs := flag.NewFlagSet("healthcheck", flag.ContinueOnError)
	fs.IntVar(&cfg.Port, "port", port, "port the server listens on (env PORT)")
	if err := fs.Parse(args); err != nil {
		return Healthcheck{}, err
	}
	if fs.NArg() > 0 {
		return Healthcheck{}, fmt.Errorf("healthcheck: unexpected argument %q", fs.Arg(0))
	}
	if err := checkPort(cfg.Port); err != nil {
		return Healthcheck{}, err
	}
	return cfg, nil
}

// envOr returns the environment variable key, or fallback when it is unset
// or empty.
//
// LEARN: getenv is a function passed in as a parameter (main passes
// os.Getenv). Functions are values in Go, and taking the lookup as a
// parameter instead of calling os.Getenv directly lets tests hand in a fake
// environment without touching the real one.
func envOr(getenv func(string) string, key, fallback string) string {
	if v := getenv(key); v != "" {
		return v
	}
	return fallback
}

// envPort is the port from PORT, or 3000 when unset. A PORT that is not a
// number is an error rather than a silent default.
func envPort(getenv func(string) string) (int, error) {
	text := getenv("PORT")
	if text == "" {
		return 3000, nil
	}
	port, err := strconv.Atoi(text)
	if err != nil {
		return 0, fmt.Errorf("PORT=%q is not a port number: %w", text, err)
	}
	if err := checkPort(port); err != nil {
		return 0, err
	}
	return port, nil
}

// envLogLevel is the level named by LOG_LEVEL ("debug", "info", "warn",
// "error", any case), or info when unset. Anything else is an error, so a
// typo in the deployment's settings shows up at start rather than as
// missing logs.
func envLogLevel(getenv func(string) string) (slog.Level, error) {
	text := strings.TrimSpace(getenv("LOG_LEVEL"))
	if text == "" {
		return slog.LevelInfo, nil
	}
	switch strings.ToLower(text) {
	case "debug":
		return slog.LevelDebug, nil
	case "info":
		return slog.LevelInfo, nil
	case "warn", "warning":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	}
	return 0, fmt.Errorf("LOG_LEVEL=%q is not one of debug, info, warn, error", text)
}

// checkPort rejects numbers that are not TCP ports (0-65535).
func checkPort(port int) error {
	if port < 0 || port > 65535 {
		return fmt.Errorf("port %d is out of range 0-65535", port)
	}
	return nil
}

// TreeDBPath is the full path of the tree database, e.g. "data/tree.db".
//
// LEARN: `(s Serve)` before the name makes this a method: it is called as
// cfg.TreeDBPath() and gets a copy of the struct as s. A copy is fine here
// because the method only reads it.
func (s Serve) TreeDBPath() string {
	return filepath.Join(s.DataDir, s.DB)
}

// CacheDBPath is the full path of the enrichment cache, "data/cache.db".
func (s Serve) CacheDBPath() string {
	return filepath.Join(s.DataDir, "cache.db")
}

// UserAgent is the User-Agent for upstream requests (see the UserAgent
// function).
func (s Serve) UserAgent() string {
	return UserAgent(s.PublicURL, s.Contact)
}

// UserAgent builds `species-circle/0.1.0 (+https://example.org; contact)`
// (ARCHITECTURE §6.2). Blank parts are left out; with neither, the agent still says
// what it is ("Circle of Life tree viewer, local development").
func UserAgent(publicURL, contact string) string {
	// Both parts come from the environment or flags and are never
	// hard-coded. Without them the agent still says what it is, so upstream
	// operators can tell this traffic apart.
	var parts []string
	if url := strings.TrimSpace(publicURL); url != "" {
		parts = append(parts, "+"+url)
	}
	if c := strings.TrimSpace(contact); c != "" {
		parts = append(parts, c)
	}
	if len(parts) == 0 {
		parts = append(parts, "Circle of Life tree viewer, local development")
	}
	return "species-circle/" + Version + " (" + strings.Join(parts, "; ") + ")"
}

// Endpoints are the base URLs of the upstream APIs used by enrichment
// (ARCHITECTURE §6). Tests point them all at a local mock server.
type Endpoints struct {
	// Wikidata Action API (…/w/api.php).
	Wikidata string
	// English Wikipedia REST API (…/api/rest_v1).
	Wikipedia string
	// Wikimedia Commons Action API (…/w/api.php).
	Commons string
	// GBIF API root (https://api.gbif.org, without /v1).
	GBIF string
	// iNaturalist API (…/v1).
	INat string
}

// LiveEndpoints are the real services.
func LiveEndpoints() Endpoints {
	return Endpoints{
		Wikidata:  "https://www.wikidata.org/w/api.php",
		Wikipedia: "https://en.wikipedia.org/api/rest_v1",
		Commons:   "https://commons.wikimedia.org/w/api.php",
		GBIF:      "https://api.gbif.org",
		INat:      "https://api.inaturalist.org/v1",
	}
}

// EndpointsUnder puts every service under one base URL, one path prefix
// each ({base}/wikidata, {base}/wikipedia, {base}/commons, {base}/gbif,
// {base}/inat): how the tests point the enricher at one mock server.
func EndpointsUnder(base string) Endpoints {
	return Endpoints{
		Wikidata:  base + "/wikidata",
		Wikipedia: base + "/wikipedia",
		Commons:   base + "/commons",
		GBIF:      base + "/gbif",
		INat:      base + "/inat",
	}
}
