# syntax=docker/dockerfile:1

# ---- Stage 1: Build static Web SPA (including pdf.js assets & CJK font) ----
FROM node:22-alpine AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY index.html tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts ./
COPY public ./public
COPY scripts ./scripts
COPY src ./src

RUN pnpm build

# ---- Stage 2: Minimal zero-dependency runtime (Web + CORS Proxy + Cloud Sync) ----
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    WEB_DIR=/app/dist \
    SYNC_DATA_DIR=/data \
    ALLOW_REGISTER=1 \
    ALLOWED_HOSTS=*

COPY --from=builder /app/dist ./dist
COPY proxy ./proxy
COPY sync ./sync
COPY docker/server.mjs ./docker/server.mjs

RUN mkdir -p /data && chown -R node:node /app /data
USER node

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "docker/server.mjs"]
