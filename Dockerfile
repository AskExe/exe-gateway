FROM node:20-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY pair-whatsapp.mjs ./
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-slim AS production

ENV NODE_ENV=production
ENV EXE_GATEWAY_HOME=/data
ENV EXE_GATEWAY_CONFIG=/data/gateway.json

WORKDIR /app

RUN groupadd --gid 1001 exegateway \
    && useradd --uid 1001 --gid exegateway --shell /bin/sh --create-home exegateway \
    && mkdir -p /data \
    && chown -R exegateway:exegateway /data

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/pair-whatsapp.mjs ./pair-whatsapp.mjs

EXPOSE 3100 3101

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "const http=require('http');const r=http.get('http://127.0.0.1:3100/health',s=>{process.exit(s.statusCode===200?0:1)});r.on('error',()=>process.exit(1));r.setTimeout(4000,()=>process.exit(1))"

USER exegateway

ENTRYPOINT ["node", "dist/bin/exe-gateway.js"]
