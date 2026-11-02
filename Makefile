# Project tasks (PLAN §10.1). Run `make help` for the list.
# Targets for later phases are present and say which phase implements them.

SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

# Optional local settings (copy .env.example to .env); exported to every recipe.
-include .env
export

SYNTH_URL := https://files.opentreeoflife.org/synthesis/opentree16.1/output/labelled_supertree/labelled_supertree.tre
OTT_URL   := https://files.opentreeoflife.org/ott/ott3.7.3/ott3.7.3.tgz
GBIF_URL  := https://hosted-datasets.gbif.org/datasets/backbone/current/backbone.zip
RAW       := data/raw

# The server binary. CGO_ENABLED=0: modernc's SQLite is pure Go, so the
# binary is static and needs no C toolchain.
BIN := bin/species

.PHONY: help fetch-data fetch-gbif ingest ingest-mini golden server server-mini web dev \
        test check lint-design shot shot-parity smoke build bin docker

help: ## List targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-12s %s\n", $$1, $$2}'

fetch-data: ## Download the synth tree and OTT 3.7.3 into data/raw (skips existing files)
	mkdir -p $(RAW)
	test -f $(RAW)/labelled_supertree.tre || curl -fL -o $(RAW)/labelled_supertree.tre $(SYNTH_URL)
	test -f $(RAW)/ott3.7.3/taxonomy.tsv || { curl -fL -o $(RAW)/ott3.7.3.tgz $(OTT_URL) && tar -xzf $(RAW)/ott3.7.3.tgz -C $(RAW) && rm $(RAW)/ott3.7.3.tgz; }

fetch-gbif: ## Download the GBIF backbone (926 MB) for common names (P11)
	mkdir -p $(RAW)
	@# Download to a .part file and resume it (-C -) if interrupted; rename only when complete.
	test -f $(RAW)/backbone.zip || { curl -fL -C - -o $(RAW)/backbone.zip.part $(GBIF_URL) && mv $(RAW)/backbone.zip.part $(RAW)/backbone.zip; }

bin: ## Static Go binary bin/species (no cgo)
	CGO_ENABLED=0 go build -o $(BIN) ./cmd/species

# Common names come from backbone.zip when it is there (`make fetch-gbif`, P11).
ingest: bin ## Build data/tree.db from the full data (+ common names if backbone.zip is present)
	./$(BIN) ingest --tree $(RAW)/labelled_supertree.tre \
		--taxonomy $(RAW)/ott3.7.3/taxonomy.tsv \
		$(if $(wildcard $(RAW)/backbone.zip),--vernacular $(RAW)/backbone.zip) \
		--out data/tree.db

ingest-mini: bin ## Build data/mini.db from the test fixtures
	mkdir -p data
	./$(BIN) ingest --tree tests/fixtures/mini.tre \
		--taxonomy tests/fixtures/mini_taxonomy.tsv \
		--vernacular tests/fixtures/mini_vernacular.tsv --out data/mini.db

golden: ## Regenerate tests/fixtures/golden_tile.bin (after a deliberate tile format change)
	UPDATE_GOLDEN=1 go test ./internal/ingest -run TestGoldenTile

server: bin ## Run the API + static server on data/tree.db
	./$(BIN) serve --data data

server-mini: bin ## Run the server on data/mini.db
	./$(BIN) serve --data data --db mini.db

web: ## Vite dev server (proxies /api to :3000)
	pnpm -C web dev

dev: ## Run server and web together; Ctrl+C stops both
	trap 'kill 0' INT TERM EXIT; $(MAKE) server & $(MAKE) web & wait

test: ## Go and TypeScript tests
	go test ./...
	pnpm -C web exec vitest run

check: ## Everything that must pass before handing back: gofmt, go vet, go test, tsc, vitest
	test -z "$$(gofmt -l .)" || { gofmt -l .; echo "gofmt: run gofmt -w on the files above"; exit 1; }
	go vet ./...
	go test ./...
	pnpm -C web exec tsc --noEmit
	pnpm -C web exec vitest run

lint-design: ## Grep web/src for banned design tokens (DESIGN.md §9)
	@if grep -rnE 'backdrop-filter|box-shadow|text-shadow|(linear|radial|conic)-gradient|\bInter\b|Geist|JetBrains|Space Grotesk|Roboto|border-radius: *([5-9]|[1-9][0-9]+)px' \
		web/src --include='*.css' --include='*.ts'; then \
		echo "lint-design: banned tokens found (DESIGN.md §9)"; exit 1; \
	else echo "lint-design: clean"; fi

shot: ## Playwright screenshots into screens/ (needs a fresh web build and the server running)
	pnpm -C web shot

# WebGPU against WebGL on the same states (docs/plan-webgpu.md §5): shots in
# screens/{webgl,webgpu}/, heatmaps and report.json in screens/diff/, exit 1
# over the thresholds. STATES="overview mammals" picks states.
STATES ?=
shot-parity: ## WebGL vs WebGPU screenshots and pixel diffs (server running, as for shot)
	SHOT_RENDERER=both pnpm -C web shot $(STATES)

# Starts its own server on SMOKE_PORT ($(SMOKE_DATA)/$(SMOKE_DB)), so it is not part of `check`.
SMOKE_PORT ?= 3077
SMOKE_DB   ?= tree.db
# The server's data dir (tree.db and its own cache.db); point it elsewhere to
# keep data/cache.db untouched.
SMOKE_DATA ?= data
smoke: bin ## Playwright smoke test: load, search "homo sapiens", panel opens (builds first)
	pnpm -C web build
	./$(BIN) serve --data $(SMOKE_DATA) --db $(SMOKE_DB) --static web/dist --port $(SMOKE_PORT) & \
	pid=$$!; trap 'kill $$pid' EXIT; \
	for i in $$(seq 50); do curl -sf http://localhost:$(SMOKE_PORT)/healthz >/dev/null && break; sleep 0.2; done; \
	SMOKE_BASE=http://localhost:$(SMOKE_PORT) pnpm -C web test:e2e

build: bin ## Production frontend and bin/species
	pnpm -C web build

docker: ## Container image `species` (Dockerfile; data is mounted at /data, see README)
	docker build -t species .
