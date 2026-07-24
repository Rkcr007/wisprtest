.DEFAULT_GOAL := help
.PHONY: help dev build test lint typecheck db-up db-down db-logs db-migrate

COMPOSE := docker compose

## help: list available targets
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/## /  /'

.env:
	@echo "no .env found — creating one from .env.example"
	@cp .env.example .env

## dev: bring up the infrastructure, then run every service in watch mode
# .env is exported into the environment so each service's config validation sees it, and so
# `next dev --port $CONSOLE_PORT` resolves.
dev: db-up
	set -a; . ./.env; set +a; pnpm dev

## build: build every workspace package
build:
	pnpm build

## test: run every workspace test suite
test:
	pnpm test

## lint: lint and format-check TypeScript and Python
lint:
	pnpm lint

## typecheck: tsc --noEmit across TS packages, mypy --strict for composer
typecheck:
	pnpm typecheck

## db-up: start postgres, redis and qdrant, blocking until all are healthy
db-up: .env
	$(COMPOSE) up -d --wait

## db-down: stop the infrastructure, keeping volumes
db-down:
	$(COMPOSE) down

## db-logs: tail infrastructure logs
db-logs:
	$(COMPOSE) logs -f

## db-migrate: apply pending Atlas migrations to the local database
db-migrate: .env
	@command -v atlas >/dev/null 2>&1 || { \
		echo "atlas is not installed."; \
		echo "install it with: curl -sSf https://atlasgo.sh | sh   (or: brew install ariga/tap/atlas)"; \
		exit 1; \
	}
	@test -n "$$(ls -A db/migrations 2>/dev/null)" || { \
		echo "db/migrations is empty — the schema is delivered by Phase 3 of docs/BUILD-PLAN.md."; \
		exit 1; \
	}
	set -a; . ./.env; set +a; atlas migrate apply --dir "file://db/migrations" --url "$$DATABASE_URL"
