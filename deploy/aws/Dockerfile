# syntax=docker/dockerfile:1.7
# Fork-owned images for the AWS install: targets api, app and portal (linux/arm64).
# Build with deploy/aws/docker-bake.hcl from the repository root; the build context is the
# whole monorepo (.dockerignore keeps env files, installs and build output out).

ARG NODE_IMAGE=node:22-slim
ARG BUN_IMAGE=oven/bun:1.3.4

FROM ${BUN_IMAGE} AS bun

# Node 22 (Prisma 7 needs >= 22.12) with the repository's Bun.
FROM ${NODE_IMAGE} AS node22
RUN node -e 'const [major, minor] = process.versions.node.split(".").map(Number); \
  if (major !== 22 || minor < 12) { console.error(`need Node 22.12 or newer 22.x, found ${process.version}`); process.exit(1); }' \
  && node -v

FROM node22 AS base
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx && bun --version
ENV NEXT_TELEMETRY_DISABLED=1 \
    TURBO_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1
WORKDIR /repo

# Only the lockfile, bunfig and every package.json, so dependency layers stay cached while
# source changes (COPY --from is content-addressed).
FROM base AS manifests
COPY . /src
RUN cd /src \
  && mkdir -p /manifests \
  && cp package.json bun.lock bunfig.toml /manifests/ \
  && find . -name package.json -not -path '*/node_modules/*' -not -path './package.json' \
     -exec sh -c 'mkdir -p "/manifests/$(dirname "$1")" && cp "$1" "/manifests/$1"' _ {} \;

FROM base AS deps
COPY --from=manifests /manifests/ ./
RUN --mount=type=cache,id=comp-bun-install,sharing=locked,target=/root/.bun/install/cache \
    HUSKY=0 ELECTRON_SKIP_BINARY_DOWNLOAD=1 bun install --frozen-lockfile

# Every workspace library the api, app and portal import, built once for all three. Only
# packages/ is copied here, so a change confined to one app does not rebuild the libraries.
FROM deps AS libs
COPY turbo.json ./
COPY packages ./packages
RUN node_modules/.bin/turbo run build --ui=stream --concurrency=4 \
    --filter='@trycompai/api^...' \
    --filter='@trycompai/app^...' \
    --filter='@trycompai/portal^...'

# ---------------------------------------------------------------- api
FROM libs AS api-build
COPY apps/api ./apps/api
RUN cd apps/api && NODE_OPTIONS=--max-old-space-size=4096 bun run build

FROM base AS api-prod-deps
COPY --from=manifests /manifests/ ./
RUN --mount=type=cache,id=comp-bun-install,sharing=locked,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production --ignore-scripts --filter=@trycompai/api

FROM api-build AS api-context
COPY deploy/aws/assemble-api-context.sh ./deploy/aws/
RUN --mount=type=bind,from=api-prod-deps,source=/repo,target=/prod \
    bash deploy/aws/assemble-api-context.sh --repo /repo --prod /prod --out /out

# ---------------------------------------------------------------- next builds
FROM libs AS app-build
COPY apps/app ./apps/app
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_PORTAL_URL
ARG NEXT_PUBLIC_BETTER_AUTH_URL
ARG NEXT_PUBLIC_SELF_HOSTED
ARG NEXT_PUBLIC_APP_ENV
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL} \
    NEXT_PUBLIC_PORTAL_URL=${NEXT_PUBLIC_PORTAL_URL} \
    NEXT_PUBLIC_BETTER_AUTH_URL=${NEXT_PUBLIC_BETTER_AUTH_URL} \
    NEXT_PUBLIC_SELF_HOSTED=${NEXT_PUBLIC_SELF_HOSTED} \
    NEXT_PUBLIC_APP_ENV=${NEXT_PUBLIC_APP_ENV}
# SKIP_ENV_VALIDATION is set for this command only: the build has no runtime secrets, and
# the runtime image must validate its env.
RUN cd apps/app \
  && bun run db:getschema \
  && SKIP_ENV_VALIDATION=1 NEXT_OUTPUT_STANDALONE=true NODE_ENV=production \
     NODE_OPTIONS=--max-old-space-size=6144 bun run build:docker \
  && cp -R .next/static .next/standalone/apps/app/.next/static \
  && cp -R public .next/standalone/apps/app/public

FROM libs AS portal-build
COPY apps/portal ./apps/portal
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_PORTAL_URL
ARG NEXT_PUBLIC_BETTER_AUTH_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL} \
    NEXT_PUBLIC_PORTAL_URL=${NEXT_PUBLIC_PORTAL_URL} \
    NEXT_PUBLIC_BETTER_AUTH_URL=${NEXT_PUBLIC_BETTER_AUTH_URL}
RUN cd apps/portal \
  && bun run db:getschema \
  && SKIP_ENV_VALIDATION=1 NEXT_OUTPUT_STANDALONE=true NODE_ENV=production \
     NODE_OPTIONS=--max-old-space-size=6144 bun run build:docker \
  && cp -R .next/static .next/standalone/apps/portal/.next/static \
  && cp -R public .next/standalone/apps/portal/public

# ---------------------------------------------------------------- runtime images
# Every image carries the public Supabase root CA and verifies the database against it.
FROM node22 AS runtime
COPY deploy/aws/certs/supabase-ca.crt /app/certs/supabase-ca.crt
ENV NODE_ENV=production \
    DATABASE_SSL_CA=/app/certs/supabase-ca.crt \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

FROM runtime AS api
# Fonts let sharp/librsvg draw text in browser-automation screenshot overlays.
RUN apt-get update \
  && apt-get install -y --no-install-recommends fontconfig fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*
COPY --from=api-context /out/ /app/
WORKDIR /app/apps/api
ENV PORT=3333
EXPOSE 3333
USER node
CMD ["node", "src/main.js"]

FROM runtime AS app
COPY --from=app-build /repo/apps/app/.next/standalone/ /app/
# The image optimizer caches under .next/cache; everything else stays read-only.
RUN mkdir -p apps/app/.next/cache && chown node:node apps/app/.next/cache
ENV PORT=3000 \
    HOSTNAME=0.0.0.0
EXPOSE 3000
USER node
CMD ["node", "apps/app/server.js"]

FROM runtime AS portal
COPY --from=portal-build /repo/apps/portal/.next/standalone/ /app/
RUN mkdir -p apps/portal/.next/cache && chown node:node apps/portal/.next/cache
ENV PORT=3000 \
    HOSTNAME=0.0.0.0
EXPOSE 3000
USER node
CMD ["node", "apps/portal/server.js"]
