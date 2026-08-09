FROM node:22.23.1-alpine3.24 AS web-build

WORKDIR /app
RUN corepack enable \
    && corepack prepare pnpm@11.16.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @spiderwebrouter/web... build

FROM caddy:2.11.4-alpine AS runtime

COPY docker/edge/Caddyfile /etc/caddy/Caddyfile
COPY --from=web-build /app/apps/web/dist /srv
