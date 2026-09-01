# PageSpatial public control plane. The root Dockerfile remains the qualified
# parse-worker image used by Modal.
FROM node:26-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8580

WORKDIR /app

COPY package.json package-lock.json ./
COPY service/api/package.json service/api/package.json
RUN npm ci --omit=dev --workspace=@pagespatial/api --include-workspace-root=false \
    && npm cache clean --force

COPY schemas ./schemas
COPY service/api/migrations ./service/api/migrations
COPY service/api/scripts ./service/api/scripts
COPY service/api/src ./service/api/src

RUN useradd --create-home --uid 10001 pagespatial
USER pagespatial

EXPOSE 8580
CMD ["node", "service/api/src/server.mjs"]
