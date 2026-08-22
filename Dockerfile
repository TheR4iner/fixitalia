# =====================================================
# fixitalia -- Frontend extractor image
#
# Stage 1: build the Vite SPA with node.
# Stage 2: minimal Alpine image that copies the built dist into the
#          fixitalia-static Docker volume on first `up -d`.
#          The shared edge Caddy (configured outside this repo) mounts that volume and
#          serves the files directly -- no per-project Caddy needed.
# =====================================================

# ---- Stage 1: build ----
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --legacy-peer-deps

COPY . .

# Vite inlines these at build time.
ARG VITE_API_URL=/api
ARG VITE_ENVIRONMENT=production
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_ENVIRONMENT=$VITE_ENVIRONMENT

RUN npm run build

# ---- Stage 2: extractor ----
FROM alpine:3.20

COPY --from=builder /app/dist /dist

CMD ["sh", "-c", "cp -a /dist/. /srv/fixitalia/"]
