// Atlas configuration.
//
// Versioned SQL rather than declarative HCL, and consistently so: `db/migrations` holds plain
// `.sql` files applied in order, with `atlas.sum` as their integrity check.
//
// The choice is not stylistic. This schema's substance is row-level security policies, a
// `FORCE ROW LEVEL SECURITY` on every table, a NOLOGIN role, `ON DELETE SET NULL (column)`
// clauses on composite foreign keys, partial unique indexes and PL/pgSQL triggers. Declarative
// HCL covers some of that and not the rest, which would leave the security-critical half of the
// schema in hand-written SQL anyway — split across two mechanisms, with the diffing engine
// unable to see the half that matters. One mechanism, fully reviewable, is worth more here than
// automatic diffing.
//
// `make db-migrate` and `make db-reset` wrap the two commands you need; this file exists so
// `atlas migrate lint` and `atlas migrate validate` have a dev database to work against.

variable "database_url" {
  type    = string
  default = getenv("DATABASE_URL")
}

// A throwaway database Atlas uses to replay migrations when linting. It is created and dropped
// per invocation, so it must not be the database you are working in.
variable "dev_url" {
  type    = string
  default = getenv("ATLAS_DEV_URL")
}

env "local" {
  url     = var.database_url
  dev     = var.dev_url
  exclude = ["atlas_schema_revisions"]

  migration {
    dir    = "file://db/migrations"
    format = golang-migrate
  }

  format {
    migrate {
      apply = format("{{ json .Applied }}\n")
    }
  }
}
