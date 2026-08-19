# syntax=docker/dockerfile:1

# This image is used only as an immutable source for target-host runtimes. The
# two platform stages are copied, never executed, so a regular amd64 builder can
# package both supported target architectures without emulation.
ARG OPS_AGENT_NODE_IMAGE=node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
FROM --platform=linux/amd64 ${OPS_AGENT_NODE_IMAGE} AS agent-runtime-linux-x64
FROM --platform=linux/arm64 ${OPS_AGENT_NODE_IMAGE} AS agent-runtime-linux-arm64

FROM node:24-bookworm-slim AS build

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
RUN pnpm prune --prod
COPY --chmod=0755 --from=agent-runtime-linux-x64 /usr/local/bin/node ./agent/runtime/linux-x64/node
COPY --chmod=0755 --from=agent-runtime-linux-arm64 /usr/local/bin/node ./agent/runtime/linux-arm64/node
RUN node scripts/verify-agent-runtimes.mjs

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    OPS_HOST=0.0.0.0 \
    OPS_PORT=8787 \
    OPS_FRONTEND_DIR=/app/dist \
    OPS_DB_PATH=/data/ops-console.sqlite \
    OPS_AGENT_RUNTIME_X64_PATH=/app/agent/runtime/linux-x64/node \
    OPS_AGENT_RUNTIME_ARM64_PATH=/app/agent/runtime/linux-arm64/node

WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/agent/dist/ops-agent.cjs ./agent/dist/ops-agent.cjs
COPY --from=build /app/agent/runtime ./agent/runtime
COPY --from=build /app/docs ./docs
COPY --from=build /app/README.md ./README.md

VOLUME ["/data"]
EXPOSE 8787
USER node
CMD ["node", "server/dist/index.js"]
