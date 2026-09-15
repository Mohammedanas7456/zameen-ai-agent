# syntax=docker/dockerfile:1

# ---------- build ----------------------------------------------------------
FROM node:20-slim AS builder
WORKDIR /app

# Manifests first, so the dependency layer caches independently of source edits.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/ingest/package.json packages/ingest/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

# @zameen/shared's prepare script compiles src/ during the install, and npm runs
# prepare for linked workspaces even under --ignore-scripts. Its sources must
# therefore exist before `npm ci`, not after. The package is small and changes
# rarely, so copying it early costs little cache.
COPY packages/shared/tsconfig.json packages/shared/
COPY packages/shared/src packages/shared/src

RUN npm ci

COPY . .
# Builds shared, then the server, then the web client into apps/web/dist.
RUN npm run build && npm prune --omit=dev

# ---------- runtime --------------------------------------------------------
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# config.ts derives ROOT three levels up from apps/server/dist/, so the
# workspace layout has to survive into this stage -- and node_modules holds the
# @zameen/shared symlink that points back at packages/shared.
COPY --from=builder /app/node_modules             ./node_modules
COPY --from=builder /app/package.json             ./package.json
COPY --from=builder /app/packages/shared          ./packages/shared
COPY --from=builder /app/apps/server/package.json ./apps/server/package.json
COPY --from=builder /app/apps/server/dist         ./apps/server/dist
COPY --from=builder /app/apps/web/dist            ./apps/web/dist
# /api/facets reads data/facets.json at runtime.
COPY --from=builder /app/data                     ./data

USER node

# Documentation only -- Cloud Run injects PORT, which config.ts already reads.
EXPOSE 8080

CMD ["node", "apps/server/dist/index.js"]
