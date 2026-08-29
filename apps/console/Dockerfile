# syntax=docker/dockerfile:1.7
#
# Console image. Multi-stage, pnpm-workspace-aware, non-root.
#
# Track H owns apps/console/next.config.ts and does not set `output`. Standalone is what
# makes a Next image a copy of this service rather than the whole workspace; it is enabled
# only in this build, by rewriting the config in the build stage. `next dev` on a developer
# machine is unchanged.

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
COPY packages/ui packages/ui
COPY apps/console apps/console
# Standalone + monorepo tracing, without editing the committed next.config.ts.
# outputFileTracingRoot must be the repo root or `protocol` and `ui` are left out
# of .next/standalone and the image dies on `Cannot find package 'protocol'`.
RUN cat > apps/console/next.config.ts <<'EOF'
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'),
  reactStrictMode: true,
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
EOF
RUN pnpm --filter protocol build \
 && pnpm --filter ui build \
 && pnpm --filter console build

FROM node:22-bookworm-slim AS runtime
RUN groupadd --gid 65532 wispr \
 && useradd --uid 65532 --gid 65532 --home /app --shell /usr/sbin/nologin wispr
WORKDIR /app
# Monorepo standalone layout: server.js lives under apps/console/.
COPY --from=build --chown=wispr:wispr /repo/apps/console/.next/standalone ./
COPY --from=build --chown=wispr:wispr /repo/apps/console/.next/static ./apps/console/.next/static
USER 65532:65532
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV CONSOLE_PORT=3000
EXPOSE 3000
CMD ["node", "apps/console/server.js"]
