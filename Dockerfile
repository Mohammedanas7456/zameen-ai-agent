# syntax=docker/dockerfile:1

# ---------- build ----------------------------------------------------------
FROM node:20-slim AS builder
WORKDIR /app

# Manifests first, so the dependency layer caches independently of source edits.
# --ignore-scripts because @zameen/shared's prepare script compiles src/, which
# has not been copied yet; the explicit build below covers it.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/ingest/package.json packages/ingest/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --ignore-scripts

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
