# syntax=docker/dockerfile:1.7

FROM node:22.23.1-alpine3.24 AS build

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"

WORKDIR /app
RUN apk add --no-cache openssl \
    && corepack enable \
    && corepack prepare pnpm@11.16.0 --activate

# Keep dependency installation independent from application source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --store-dir=/pnpm/store --filter @spiderwebrouter/api... install --frozen-lockfile

# The API build only needs its own sources and the shared TypeScript settings.
COPY tsconfig.base.json ./
COPY apps/api/tsconfig.json apps/api/tsconfig.build.json apps/api/
COPY apps/api/prisma apps/api/prisma
COPY apps/api/src apps/api/src
RUN pnpm --filter @spiderwebrouter/api... build

# Produce a portable production package. Prisma is a runtime dependency because
# the migrate service executes its CLI from this same image.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --store-dir=/pnpm/store --filter @spiderwebrouter/api --prod deploy --legacy /prod/apps/api \
    && cd /prod/apps/api \
    && ./node_modules/.bin/prisma generate --schema prisma/schema.prisma

FROM node:22.23.1-alpine3.24 AS runtime

ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache dumb-init openssl

COPY --from=build --chown=node:node /prod/apps/api /app/apps/api
COPY --chown=node:node docker/api/entrypoint.sh /app/docker/api/entrypoint.sh
RUN chmod 0755 /app/docker/api/entrypoint.sh

USER node
ENTRYPOINT ["dumb-init", "--", "/app/docker/api/entrypoint.sh"]
CMD ["node", "apps/api/dist/main.js"]
