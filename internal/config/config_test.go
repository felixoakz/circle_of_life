// Unit tests of the options, paths and User-Agent, and of where each serve
// option comes from (flag, environment or default).
//
// Concepts introduced here:
// - (none beyond the package's)

package config

import (
	"log/slog"
	"path/filepath"
	"strings"
	"testing"
)

func TestTreeDBPathJoinsDirAndFile(t *testing.T) {
	s := Serve{DataDir: "data", DB: "mini.db", StaticDir: "web/dist", Port: 3000}
	if got, want := s.TreeDBPath(), filepath.Join("data", "mini.db"); got != want {
		t.Errorf("TreeDBPath = %q, want %q", got, want)
	}
	if got, want := s.CacheDBPath(), filepath.Join("data", "cache.db"); got != want {
		t.Errorf("CacheDBPath = %q, want %q", got, want)
	}
}

func TestUserAgentContainsContactAndURL(t *testing.T) {
	ua := UserAgent("https://circle.example", "ops at circle.example")
	if !strings.HasPrefix(ua, "species-circle/") {
		t.Errorf("%q lacks the product", ua)
	}
	if !strings.HasSuffix(ua, "(+https://circle.example; ops at circle.example)") {
		t.Errorf("%q lacks url and contact", ua)
	}
}

func TestUserAgentWithoutContactIsStillDescriptive(t *testing.T) {
	ua := UserAgent("", "  ")
	if !strings.Contains(ua, "local development") {
		t.Errorf("%q does not say local development", ua)
	}
	if strings.Contains(ua, "@") {
		t.Errorf("%q contains an email", ua)
	}
	ua = UserAgent("https://circle.example", "")
	if !strings.HasSuffix(ua, "(+https://circle.example)") {
		t.Errorf("%q", ua)
	}
}

// The version in the User-Agent is Version, and Serve.UserAgent
// uses the configured parts.
func TestServeUserAgent(t *testing.T) {
	s := Serve{PublicURL: " https://circle.example ", Contact: "ops"}
	if got, want := s.UserAgent(), "species-circle/"+Version+" (+https://circle.example; ops)"; got != want {
		t.Errorf("UserAgent = %q, want %q", got, want)
	}
}

// fakeEnv is a getenv over a fixed map.
func fakeEnv(vars map[string]string) func(string) string {
	return func(key string) string { return vars[key] }
}

// A flag beats the environment, which beats the default.
func TestServeFlagBeatsEnvBeatsDefault(t *testing.T) {
	env := map[string]string{
		"SPECIES_DATA_DIR":   "/env/data",
		"SPECIES_STATIC_DIR": "/env/static",
		"PORT":               "4000",
		"SPECIES_CONTACT":    "env-contact",
		"SPECIES_PUBLIC_URL": "https://env.example",
	}
	tests := []struct {
		name string
		args []string
		env  map[string]string
		want Serve
	}{
		{
			name: "defaults",
			args: nil,
			env:  map[string]string{},
			want: Serve{DataDir: "data", DB: "tree.db", StaticDir: "web/dist", Port: 3000},
		},
		{
			name: "environment",
			args: nil,
			env:  env,
			want: Serve{DataDir: "/env/data", DB: "tree.db", StaticDir: "/env/static", Port: 4000,
				Contact: "env-contact", PublicURL: "https://env.example"},
		},
		{
			name: "flags over environment",
			args: []string{"--data", "/flag/data", "--db=mini.db", "--static", "/flag/static",
				"--port", "5000", "--contact", "flag-contact", "-public-url", "https://flag.example"},
			env: env,
			want: Serve{DataDir: "/flag/data", DB: "mini.db", StaticDir: "/flag/static", Port: 5000,
				Contact: "flag-contact", PublicURL: "https://flag.example"},
		},
		{
			name: "one flag, the rest from the environment",
			args: []string{"--port", "5000"},
			env:  env,
			want: Serve{DataDir: "/env/data", DB: "tree.db", StaticDir: "/env/static", Port: 5000,
				Contact: "env-contact", PublicURL: "https://env.example"},
		},
	}
	for _, tt := range tests {
		got, err := ParseServe(tt.args, fakeEnv(tt.env))
		if err != nil {
			t.Errorf("%s: %v", tt.name, err)
			continue
		}
		if got != tt.want {
			t.Errorf("%s:\ngot  %+v\nwant %+v", tt.name, got, tt.want)
		}
	}
}

// LOG_LEVEL picks the slog level; unset is info, junk is an error.
func TestServeLogLevel(t *testing.T) {
	tests := []struct {
		env  string
		want slog.Level
	}{
		{"", slog.LevelInfo},
		{"debug", slog.LevelDebug},
		{"INFO", slog.LevelInfo},
		{"warn", slog.LevelWarn},
		{" error ", slog.LevelError},
	}
	for _, tt := range tests {
		got, err := ParseServe(nil, fakeEnv(map[string]string{"LOG_LEVEL": tt.env}))
		if err != nil {
			t.Errorf("LOG_LEVEL=%q: %v", tt.env, err)
			continue
		}
		if got.LogLevel != tt.want {
			t.Errorf("LOG_LEVEL=%q: got %v, want %v", tt.env, got.LogLevel, tt.want)
		}
	}
	if _, err := ParseServe(nil, fakeEnv(map[string]string{"LOG_LEVEL": "species=debug"})); err == nil {
		t.Error("LOG_LEVEL=species=debug: want an error")
	}
}

// A port that is not a number is an error, from a flag or from
// PORT.
func TestServeRejectsBadPort(t *testing.T) {
	if _, err := ParseServe([]string{"--port", "abc"}, fakeEnv(nil)); err == nil {
		t.Error("--port abc: want an error")
	}
	if _, err := ParseServe(nil, fakeEnv(map[string]string{"PORT": "abc"})); err == nil {
		t.Error("PORT=abc: want an error")
	}
}

// Healthcheck reads PORT like serve does.
func TestHealthcheckFlagBeatsEnvBeatsDefault(t *testing.T) {
	tests := []struct {
		args []string
		env  map[string]string
		want int
	}{
		{nil, map[string]string{}, 3000},
		{nil, map[string]string{"PORT": "4000"}, 4000},
		{[]string{"--port", "5000"}, map[string]string{"PORT": "4000"}, 5000},
	}
	for _, tt := range tests {
		got, err := ParseHealthcheck(tt.args, fakeEnv(tt.env))
		if err != nil {
			t.Errorf("%v %v: %v", tt.args, tt.env, err)
			continue
		}
		if got.Port != tt.want {
			t.Errorf("%v %v: port %d, want %d", tt.args, tt.env, got.Port, tt.want)
		}
	}
}

// Ingest's defaults (langs en,pt, out data/tree.db) and the optional flags.
func TestIngestDefaults(t *testing.T) {
	got, err := ParseIngest([]string{"--tree", "t.tre", "--taxonomy", "x.tsv"})
	if err != nil {
		t.Fatal(err)
	}
	want := Ingest{Tree: "t.tre", Taxonomy: "x.tsv", Langs: "en,pt", Out: "data/tree.db"}
	if got != want {
		t.Errorf("got  %+v\nwant %+v", got, want)
	}
	got, err = ParseIngest([]string{"--tree", "t.tre", "--taxonomy", "x.tsv", "--vernacular", "-", "--dry-run"})
	if err != nil {
		t.Fatal(err)
	}
	if got.Vernacular != "-" || !got.DryRun {
		t.Errorf("got %+v", got)
	}
}

// EndpointsUnder puts each service under its own prefix.
func TestEndpointsUnder(t *testing.T) {
	got := EndpointsUnder("http://127.0.0.1:3099")
	want := Endpoints{
		Wikidata:  "http://127.0.0.1:3099/wikidata",
		Wikipedia: "http://127.0.0.1:3099/wikipedia",
		Commons:   "http://127.0.0.1:3099/commons",
		GBIF:      "http://127.0.0.1:3099/gbif",
		INat:      "http://127.0.0.1:3099/inat",
	}
	if got != want {
		t.Errorf("got  %+v\nwant %+v", got, want)
	}
}
