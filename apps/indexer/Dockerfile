# syntax=docker/dockerfile:1.7
#
# Indexer image. Multi-stage, pnpm-workspace-aware, non-root.
#
# Chromium comes from the Playwright image pinned to the same version as
# apps/indexer/package.json (`playwright@1.61.0`). The worker launches Chromium *with*
# the sandbox (apps/indexer/src/crawl/browser.ts — "nothing here weakens the sandbox"),
# so this image does not add `--no-sandbox`. Kind nodes are privileged Docker containers
# and usually allow that; a crawl that still fails with `browser_failed` is documented
# in docs/runbooks/deploy.md rather than papered over here.

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
COPY apps/indexer apps/indexer
RUN pnpm --filter protocol build \
 && pnpm --filter fingerprint build \
 && pnpm --filter indexer build \
 && pnpm --filter indexer --prod deploy /out

FROM mcr.microsoft.com/playwright:v1.61.0-noble AS runtime
WORKDIR /app
COPY --from=build --chown=pwuser:pwuser /out ./
USER pwuser
ENV NODE_ENV=production
ENV INDEXER_HOST=0.0.0.0
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
EXPOSE 8081
CMD ["node", "dist/main.js"]
