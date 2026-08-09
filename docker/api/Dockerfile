FROM node:22.23.1-alpine3.24 AS build

WORKDIR /app
RUN apk add --no-cache openssl \
    && corepack enable \
    && corepack prepare pnpm@11.16.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @spiderwebrouter/api... build

FROM node:22.23.1-alpine3.24 AS runtime

ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache dumb-init openssl
COPY --from=build --chown=node:node /app /app
RUN chmod 0755 /app/docker/api/entrypoint.sh

USER node
ENTRYPOINT ["dumb-init", "--", "/app/docker/api/entrypoint.sh"]
CMD ["node", "apps/api/dist/main.js"]
