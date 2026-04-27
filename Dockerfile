# exe-gateway — production Docker image
# Runs webhook server (HTTP :3100) + WebSocket relay (:3101)
#
# Build:   docker build -f deploy/Dockerfile -t exe-gateway .
# Run:     docker run --env-file deploy/.env -p 3100:3100 -p 3101:3101 exe-gateway

FROM node:20-slim AS base

# Install native dependencies for better-sqlite3 / SQLCipher
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    libsqlcipher-dev \
    && rm -rf /var/lib/apt/lists/*

# Non-root user for security
RUN groupadd --gid 1001 exegateway \
    && useradd --uid 1001 --gid exegateway --shell /bin/sh --create-home exegateway

WORKDIR /app

# ---------- dependency install ----------
FROM base AS deps

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm rebuild

# ---------- build ----------
FROM base AS build

COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts
COPY tsup.config.ts tsconfig.json ./
COPY src/ src/
RUN npx tsup

# ---------- production ----------
FROM base AS production

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Config + data directories
RUN mkdir -p /home/exegateway/.exe-os \
    && chown -R exegateway:exegateway /home/exegateway/.exe-os

# Expose webhook HTTP + WebSocket relay
EXPOSE 3100 3101

# Healthcheck against webhook server /health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "const http=require('http');const r=http.get('http://localhost:3100/health',s=>{process.exit(s.statusCode===200?0:1)});r.on('error',()=>process.exit(1));r.setTimeout(4000,()=>process.exit(1))"

USER exegateway

ENTRYPOINT ["node", "dist/bin/exe-gateway.js"]
