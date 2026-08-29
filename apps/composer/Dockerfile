# syntax=docker/dockerfile:1.7
#
# Composer image. Multi-stage, non-root. The generated pydantic models in
# src/composer/protocol/models.py are already in the tree (`pnpm --filter protocol gen:python`);
# this build does not regenerate them, so it does not need the TypeScript workspace.

FROM python:3.13-slim-bookworm AS build
COPY --from=ghcr.io/astral-sh/uv:0.8.15 /uv /usr/local/bin/uv
WORKDIR /src
COPY apps/composer/pyproject.toml apps/composer/uv.lock ./
COPY apps/composer/src ./src
# Frozen lock, no dev group (pytest, mypy, ruff, datamodel-code-generator). The service
# imports only what [project].dependencies lists.
RUN uv sync --frozen --no-dev --no-editable

FROM python:3.13-slim-bookworm AS runtime
RUN groupadd --gid 65532 wispr \
 && useradd --uid 65532 --gid 65532 --home /app --shell /usr/sbin/nologin wispr
WORKDIR /app
COPY --from=build --chown=wispr:wispr /src/.venv /app/.venv
COPY --from=build --chown=wispr:wispr /src/src /app/src
ENV PATH="/app/.venv/bin:${PATH}"
ENV PYTHONPATH=/app/src
ENV PYTHONUNBUFFERED=1
ENV COMPOSER_HOST=0.0.0.0
USER 65532:65532
EXPOSE 8090
CMD ["python", "-m", "composer"]
