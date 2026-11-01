# syntax=docker/dockerfile:1.7
# Lumi API + worker image. Build context MUST be the monorepo root:
#   docker build -f apps/api/Dockerfile -t yulona/api .
# The same image runs: api (default), worker (`bun dist/worker.js`), migrate (`bun run dist/migrate.js`),
# create-tenant (`bun run dist/create-tenant.js`, first-tenant bootstrap).
ARG BUN_VERSION=1

# ---- manifests: collect every workspace package.json (+ root manifest and lockfile) automatically, so a new
# workspace never requires editing this file. The copy below only changes when a manifest/lockfile changes.
FROM oven/bun:${BUN_VERSION}-slim AS manifests
WORKDIR /src
COPY . .
RUN mkdir /m && cp package.json /m/ && { cp bun.lock* /m/ 2>/dev/null || true; } \
 && find apps packages -maxdepth 2 -name package.json -not -path '*/node_modules/*' -exec cp --parents {} /m/ \;

FROM oven/bun:${BUN_VERSION}-slim AS deps
WORKDIR /repo
COPY --from=manifests /m/ ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# ---- build: bundle everything (deps included) into dist/ so the runtime image needs no node_modules.
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/api apps/api
COPY apps/worker apps/worker
RUN bun build apps/api/src/index.ts --target=bun --minify --outfile=/out/index.js \
 && bun build apps/api/src/migrate.ts --target=bun --minify --outfile=/out/migrate.js \
 && bun build apps/api/scripts/create-tenant.ts --target=bun --minify --outfile=/out/create-tenant.js \
 && bun build apps/api/scripts/clean-env.ts --target=bun --minify --outfile=/out/clean-env.js \
 && bun build apps/worker/src/index.ts --target=bun --minify --outfile=/out/worker.js

# ---- runtime: no source, no dev deps, no package manager cache, non-root, read-only-fs friendly.
FROM oven/bun:${BUN_VERSION}-slim AS runtime
ENV NODE_ENV=production PORT=3000 MIGRATIONS_DIR=/app/migrations
WORKDIR /app
COPY --from=build --chown=root:root /out/ /app/dist/
COPY --from=build --chown=root:root /repo/packages/db/migrations /app/migrations
# Files are root-owned and world-readable only: the process (uid 1000 "bun") cannot modify its own code.
USER bun
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["bun", "run", "--preload", "./dist/clean-env.js", "dist/index.js"]
