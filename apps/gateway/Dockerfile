# syntax=docker/dockerfile:1.7
#
# Gateway image. Multi-stage, pnpm-workspace-aware, non-root.
#
# The gateway is a workspace package: it imports `protocol` and `fingerprint` by name, and
# `pg` at runtime even though apps/gateway/package.json lists `pg` under devDependencies
# (kysely-codegen). Track G owns that file; this image does not rewrite it. `pnpm deploy`
# is run without `--prod` so `pg` lands in the runtime node_modules.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
RUN corepack enable && corepack prepare pnpm@11.5.2 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/fingerprint/package.json packages/fingerprint/
COPY packages/ui/package.json packages/ui/
COPY apps/gateway/package.json apps/gateway/
COPY apps/indexer/package.json apps/indexer/
COPY apps/console/package.json apps/console/
COPY apps/composer/package.json apps/composer/
COPY apps/extension/package.json apps/extension/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY packages/protocol packages/protocol
COPY packages/fingerprint packages/fingerprint
COPY apps/gateway apps/gateway
RUN pnpm --filter protocol build \
 && pnpm --filter fingerprint build \
 && pnpm --filter gateway build \
 && pnpm --filter gateway deploy /out

FROM node:22-bookworm-slim AS runtime
RUN groupadd --gid 65532 wispr \
 && useradd --uid 65532 --gid 65532 --home /app --shell /usr/sbin/nologin wispr
WORKDIR /app
COPY --from=build --chown=wispr:wispr /out ./
USER 65532:65532
ENV NODE_ENV=production
ENV GATEWAY_HOST=0.0.0.0
EXPOSE 8080
# dist/main.js is the package "main". node resolves workspace packages from the deploy layout.
CMD ["node", "dist/main.js"]
