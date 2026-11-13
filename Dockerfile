# Sratchpad: one image, one process. Serves the Studio (/), the hosted viewer (/view/) and the API
# (/bi-api/*) on a single port, for AWS ECS (Fargate). See docs/DEPLOYMENT.md.
#
#   docker build -t sratchpad .                       # linux/amd64 by default on most CI
#   docker build --platform linux/arm64 -t sratchpad .  # for Graviton (cheaper on Fargate)

ARG NODE_IMAGE=node:22-bookworm-slim

# Every workspace manifest, so npm ci can use the lockfile before the sources are copied (layer cache).
FROM ${NODE_IMAGE} AS manifests
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/spec/package.json packages/spec/
COPY packages/renderer/package.json packages/renderer/
COPY packages/auth-client/package.json packages/auth-client/
COPY services/api/package.json services/api/
COPY apps/studio/package.json apps/studio/
COPY apps/viewer/package.json apps/viewer/
COPY apps/host-ops/package.json apps/host-ops/
COPY apps/host-sales/package.json apps/host-sales/
COPY tests/integration/package.json tests/integration/

# Build: the two frontends (static files) and the API bundle (dist/server.mjs, plain node).
FROM manifests AS build
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build -w @yourorg/studio \
 && npm run build -w @yourorg/viewer \
 && npm run build -w @yourorg/bi-api

# Runtime dependencies of the API only (DuckDB native module, Snowflake SDK, pg, Hono, …).
FROM manifests AS deps
RUN npm ci --omit=dev --no-audit --no-fund -w @yourorg/bi-api \
 && mkdir -p services/api/node_modules \
 && npm cache clean --force

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    PORT=8080 \
    BI_LOG=json \
    BI_STATIC_DIR=/app/public \
    BI_DATA_DIR=/tmp/sratchpad \
    BI_EXAMPLES_DIR=/app/examples/dashboards
WORKDIR /app/services/api
COPY --from=deps /src/node_modules /app/node_modules
COPY --from=deps /src/services/api/node_modules /app/services/api/node_modules
COPY --from=build /src/services/api/package.json ./package.json
COPY --from=build /src/services/api/dist ./dist
COPY --from=build /src/apps/studio/dist /app/public/studio
COPY --from=build /src/apps/viewer/dist /app/public/viewer
COPY examples /app/examples
USER node
EXPOSE 8080
# ECS uses the task definition's health check; this one serves `docker run` and local testing.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/server.mjs"]
