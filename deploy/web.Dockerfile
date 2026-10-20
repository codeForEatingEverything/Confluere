# Confluere web app (apps/web) as a standalone Next.js server. Build from the repository root:
#   docker compose -f deploy/docker-compose.yml build
# NEXT_PUBLIC_* values are compiled into the browser bundle, so they are build arguments, not runtime env.

FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.1.1 --activate
WORKDIR /repo

FROM base AS build
# ride out flaky registry connections instead of failing the build
ENV npm_config_fetch_retries=6 npm_config_fetch_retry_mintimeout=20000 npm_config_fetch_retry_maxtimeout=120000 npm_config_network_concurrency=8
ARG NEXT_PUBLIC_DEFAULT_CHAIN_ID=998
ARG NEXT_PUBLIC_RPC_URL_998=https://rpcs.chain.link/hyperevm/testnet
ARG NEXT_PUBLIC_RPC_URL_10143=https://testnet-rpc.monad.xyz
ARG NEXT_PUBLIC_REOWN_PROJECT_ID=
ENV NEXT_PUBLIC_DEFAULT_CHAIN_ID=$NEXT_PUBLIC_DEFAULT_CHAIN_ID \
    NEXT_PUBLIC_RPC_URL_998=$NEXT_PUBLIC_RPC_URL_998 \
    NEXT_PUBLIC_RPC_URL_10143=$NEXT_PUBLIC_RPC_URL_10143 \
    NEXT_PUBLIC_REOWN_PROJECT_ID=$NEXT_PUBLIC_REOWN_PROJECT_ID \
    NEXT_TELEMETRY_DISABLED=1
COPY . .
# only the web app and what it depends on (the SDK); contracts, docs and services are not part of the image
RUN pnpm install --frozen-lockfile --filter "web..."
RUN pnpm --filter @confluere/sdk build && pnpm --filter web build

FROM node:24-alpine AS run
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    CONFLUERE_INDEX_DIR=/data
WORKDIR /app
# the server's chain index persists here (a volume), so a restart starts warm instead of rescanning the chain
RUN mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
