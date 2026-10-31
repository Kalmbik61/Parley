# Build from the repository root (the relay uses the workspace package @parley/protocol):
#   docker buildx build --platform linux/amd64,linux/arm64 -f packages/relay/Dockerfile -t parley-relay .
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/protocol/package.json packages/protocol/
COPY packages/relay/package.json packages/relay/
RUN pnpm install --frozen-lockfile --filter @parley/relay... --ignore-scripts
COPY packages/core packages/core
COPY packages/protocol packages/protocol
COPY packages/relay packages/relay
RUN pnpm --filter @parley/relay... build \
 && pnpm --filter @parley/relay deploy --prod --ignore-scripts /out

FROM node:22-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_FILE=/data/relay.json
WORKDIR /app
COPY --from=build /out/ ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
# Inside the container the relay must listen on all interfaces so that Caddy can reach it; deploy/compose.yml
# keeps the port off the host. Set TRUST_PROXY=1 only behind a proxy that sets x-forwarded-for.
CMD ["node", "dist/main.js"]
