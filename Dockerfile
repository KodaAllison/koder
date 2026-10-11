# Koder API (Node + Postgres). Build from the repo root:
#   docker build -t koder-api .
# Node 22.18+ strips .ts types unflagged, so there is no build step: the image is
# the api/ sources, its production dependencies, and the PWA files the server
# serves from the repo root (api/src/static.ts resolves them two levels above
# api/src, i.e. /app). No secrets: configuration comes from env vars at run time.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8000

WORKDIR /app

# Manifests first so the dependency layer is cached until they change.
COPY api/package.json api/package-lock.json ./api/
RUN cd api && npm ci --omit=dev && npm cache clean --force

COPY api/src ./api/src
COPY index.html sw.js manifest.webmanifest ./
COPY css ./css
COPY js ./js
COPY icons ./icons

USER node
EXPOSE 8000

# GET / is served from disk without auth or a database round trip. Uses node
# itself (no curl in the image) and honours a PORT override.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "api/src/main.ts"]
