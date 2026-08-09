# syntax=docker/dockerfile:1.7

FROM node:22.23.1-alpine3.24 AS web-build

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

WORKDIR /app
RUN corepack enable \
    && corepack prepare pnpm@11.16.0 --activate

# Keep dependency installation cacheable when only application source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
COPY packages/contracts/package.json ./packages/contracts/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
    && pnpm install --frozen-lockfile --filter @spiderwebrouter/web...

# The web build only needs its source, shared contracts, root TypeScript config,
# and the favicon referenced by apps/web/index.html.
COPY tsconfig.base.json favicon.ico ./
COPY apps/web ./apps/web
COPY packages/contracts ./packages/contracts
RUN pnpm --filter @spiderwebrouter/web... build

FROM caddy:2.11.4-alpine AS runtime

COPY docker/edge/Caddyfile /etc/caddy/Caddyfile
COPY --from=web-build /app/apps/web/dist /srv
