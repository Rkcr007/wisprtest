.DEFAULT_GOAL := help
.PHONY: help dev build test bench lint typecheck db-up db-down db-logs db-migrate db-reset db-seed db-codegen require-atlas

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

## build: regenerate generated sources, then build every workspace package
# Both generators run before the build so that anything typechecked afterwards is checked
# against the current contract and the current schema, rather than the last generated copy of
# either. `db:codegen` introspects the live database, so this target needs one running and
# migrated; the generated file is committed, and the diff check turns a schema that has outrun
# its types into a build failure rather than a runtime surprise.
build: db-codegen
	pnpm --filter protocol gen:python
	pnpm build

## db-codegen: regenerate the Kysely types of every service that talks to the database
# Each service generates its own file from the same live schema, so the two cannot disagree with
# the database — or, therefore, with each other.
db-codegen: .env
	@set -a; . ./.env; set +a; \
	pnpm --filter gateway db:codegen --url "$$DATABASE_URL"; \
	pnpm --filter indexer db:codegen --url "$$DATABASE_URL"
	@git diff --quiet -- apps/gateway/src/db/schema.generated.ts apps/indexer/src/db/schema.generated.ts || { \
		echo ""; \
		echo "a generated Kysely schema is out of date with the database."; \
		echo "The regenerated file differs from the committed one — review and commit it."; \
		exit 1; \
	}

## test: run every workspace test suite
test:
	pnpm test

## bench: assert the CLAUDE.md latency budgets — the release gate, run on known hardware
# This is the blocking performance gate, and it lives here rather than in CI on purpose.
#
# The budgets in CLAUDE.md § "Performance budgets" describe what a tester experiences in their
# browser. A shared GitHub runner is not that machine — the 8ms scoped-index budget measures
# around 9-13ms p95 there while passing comfortably on a developer machine — so CI publishes the
# numbers on every pull request but does not block on them. This target is what blocks: run it on
# hardware whose performance is known before cutting a release, and treat a failure as a
# regression rather than as noise.
#
# Close anything that competes for CPU first. A benchmark run alongside a video call measures the
# video call.
bench:
	pnpm --filter extension bench:scope
	pnpm --filter extension bench:resolve
	pnpm --filter extension bench:speech-to-reticle

## lint: lint and format-check TypeScript and Python
lint:
	pnpm lint

## typecheck: tsc --noEmit across TS packages, mypy --strict for composer
typecheck:
	pnpm typecheck

## db-up: start postgres, redis, qdrant and minio, blocking until all are healthy
db-up: .env
	$(COMPOSE) up -d --wait

## db-down: stop the infrastructure, keeping volumes
db-down:
	$(COMPOSE) down

## db-logs: tail infrastructure logs
db-logs:
	$(COMPOSE) logs -f

# Fails loudly with install instructions rather than reporting a confusing connection error.
require-atlas:
	@command -v atlas >/dev/null 2>&1 || { \
		echo "atlas is not installed."; \
		echo "install it with: curl -sSf https://atlasgo.sh | sh   (or: brew install ariga/tap/atlas)"; \
		exit 1; \
	}

## db-migrate: apply pending Atlas migrations to the local database
db-migrate: .env require-atlas
	@test -n "$$(ls -A db/migrations 2>/dev/null)" || { \
		echo "db/migrations is empty — the schema is delivered by Phase 3 of docs/BUILD-PLAN.md."; \
		exit 1; \
	}
	set -a; . ./.env; set +a; atlas migrate apply --dir "file://db/migrations" --url "$$DATABASE_URL"

## db-reset: drop and recreate the local database, then migrate and seed it
# Destructive, and only ever aimed at the Compose container — it runs psql through
# `docker compose exec`, so there is no set of environment variables that can point it at a
# database this repository does not own. `db-migrate` and `db-seed` follow, because a dropped
# database with no schema is not a useful state to leave anyone in.
db-reset: .env db-up
	@set -a; . ./.env; set +a; \
	echo "dropping and recreating database $$POSTGRES_DB in the wisprtest compose stack"; \
	$(COMPOSE) exec -T postgres psql -v ON_ERROR_STOP=1 -U "$$POSTGRES_USER" -d postgres \
		-c "DROP DATABASE IF EXISTS \"$$POSTGRES_DB\" WITH (FORCE)" \
		-c "CREATE DATABASE \"$$POSTGRES_DB\" OWNER \"$$POSTGRES_USER\""
	$(MAKE) db-migrate
	$(MAKE) db-seed

## db-seed: load the integration-test fixture into the local database
# One transaction: either the whole fixture lands or none of it does. Every insert is
# ON CONFLICT DO NOTHING, so re-running is a no-op rather than an error.
db-seed: .env
	@set -a; . ./.env; set +a; \
	for file in db/seed/*.sql; do \
		echo "seeding $$file"; \
		$(COMPOSE) exec -T postgres psql -v ON_ERROR_STOP=1 --single-transaction \
			-U "$$POSTGRES_USER" -d "$$POSTGRES_DB" < "$$file" >/dev/null || exit 1; \
	done
	@echo "seed loaded"
