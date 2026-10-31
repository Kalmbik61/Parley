# Build from the repository root:
#   docker build -f packages/push-gateway/Dockerfile -t parley-push-gateway .
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/protocol/package.json packages/protocol/
COPY packages/push-gateway/package.json packages/push-gateway/
RUN pnpm install --frozen-lockfile --filter @parley/push-gateway... --ignore-scripts
COPY packages/core packages/core
COPY packages/protocol packages/protocol
COPY packages/push-gateway packages/push-gateway
RUN pnpm --filter @parley/push-gateway... build \
 && pnpm --filter @parley/push-gateway deploy --prod /out

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/ ./
USER node
EXPOSE 8080
# APNS_KEY (PEM) or APNS_KEY_PATH, APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC come from the environment.
CMD ["node", "dist/main.js"]
