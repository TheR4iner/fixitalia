# =====================================================
# fixitalia -- Production backend image (multi-stage)
#
# Stage 1: install full deps + tsc-compile to dist/.
# Stage 2: install prod-only deps + copy dist/ + run with plain node.
# =====================================================

FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json tsconfig.json tsconfig.build.json ./
RUN npm ci --legacy-peer-deps || npm install --legacy-peer-deps

COPY server.ts ./server.ts
COPY routes ./routes
COPY lib ./lib
COPY scripts ./scripts

RUN npm run build


FROM node:20-alpine

WORKDIR /app

# Chromium + the system libs Playwright needs to drive a real browser.
# Senato della Repubblica's transcript URLs sit behind AWS WAF in challenge
# mode (HTTP 202 + inline JS PoW); a real browser is the only way to obtain
# the body. We point Playwright at the system Chromium via the env var so it
# does NOT try to download its own bundled browser (which would fail in this
# Alpine image and would add ~300MB anyway).
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CHROMIUM_PATH=/usr/bin/chromium-browser

# Prod-only deps: tsx and the @types/* packages stay in the builder image,
# never reaching this layer. Pure JS dep tree -- no python/make/g++ needed.
COPY package*.json ./
RUN npm ci --legacy-peer-deps --omit=dev || npm install --legacy-peer-deps --omit=dev

COPY --from=builder /app/dist ./dist

# Persisted data directory (mounted as volume in compose).
RUN mkdir -p /app/data

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3001/api/health || exit 1

CMD ["node", "dist/server.js"]
