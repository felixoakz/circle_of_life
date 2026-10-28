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

.PHONY: help fetch-data fetch-gbif ingest ingest-mini golden server server-mini web dev \
        test check lint-design shot smoke build docker

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

# Common names come from backbone.zip when it is there (`make fetch-gbif`, P11).
ingest: ## Build data/tree.db from the full data (+ common names if backbone.zip is present)
	cargo run --release -- ingest --tree $(RAW)/labelled_supertree.tre \
		--taxonomy $(RAW)/ott3.7.3/taxonomy.tsv \
		$(if $(wildcard $(RAW)/backbone.zip),--vernacular $(RAW)/backbone.zip) \
		--out data/tree.db

ingest-mini: ## Build data/mini.db from the test fixtures
	mkdir -p data
	cargo run -- ingest --tree tests/fixtures/mini.tre \
		--taxonomy tests/fixtures/mini_taxonomy.tsv \
		--vernacular tests/fixtures/mini_vernacular.tsv --out data/mini.db

golden: ## Regenerate tests/fixtures/golden_tile.bin (after a deliberate tile format change)
	UPDATE_GOLDEN=1 cargo test --test ingest golden_tile

server: ## Run the API + static server on data/tree.db
	cargo run -- serve --data data

server-mini: ## Run the server on data/mini.db
	cargo run -- serve --data data --db mini.db

web: ## Vite dev server (proxies /api to :3000)
	pnpm -C web dev

dev: ## Run server and web together; Ctrl+C stops both
	trap 'kill 0' INT TERM EXIT; $(MAKE) server & $(MAKE) web & wait

test: ## Rust and TypeScript tests
	cargo test
	pnpm -C web exec vitest run

check: ## Everything that must pass before handing back
	cargo fmt --check
	cargo clippy --all-targets -- -D warnings
	cargo test
	pnpm -C web exec tsc --noEmit
	pnpm -C web exec vitest run

lint-design: ## Grep web/src for banned design tokens (DESIGN.md §9)
	@if grep -rnE 'backdrop-filter|box-shadow|text-shadow|(linear|radial|conic)-gradient|\bInter\b|Geist|JetBrains|Space Grotesk|Roboto|border-radius: *([5-9]|[1-9][0-9]+)px' \
		web/src --include='*.css' --include='*.ts'; then \
		echo "lint-design: banned tokens found (DESIGN.md §9)"; exit 1; \
	else echo "lint-design: clean"; fi

shot: ## Playwright screenshots into screens/ (needs a fresh web build and the server running)
	pnpm -C web shot

# Starts its own server on SMOKE_PORT (data/$(SMOKE_DB)), so it is not part of `check`.
SMOKE_PORT ?= 3077
SMOKE_DB   ?= tree.db
smoke: ## Playwright smoke test: load, search "homo sapiens", panel opens (builds first)
	pnpm -C web build
	cargo build --release
	./target/release/species serve --data data --db $(SMOKE_DB) --static web/dist --port $(SMOKE_PORT) & \
	pid=$$!; trap 'kill $$pid' EXIT; \
	for i in $$(seq 50); do curl -sf http://localhost:$(SMOKE_PORT)/healthz >/dev/null && break; sleep 0.2; done; \
	SMOKE_BASE=http://localhost:$(SMOKE_PORT) pnpm -C web test:e2e

build: ## Production frontend and release binary
	pnpm -C web build
	cargo build --release

docker: ## Container image `species` (Dockerfile; data is mounted at /data, see README)
	docker build -t species .
