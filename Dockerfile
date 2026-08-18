FROM node:24-bookworm-slim AS build

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
RUN pnpm prune --prod

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    OPS_HOST=0.0.0.0 \
    OPS_PORT=8787 \
    OPS_FRONTEND_DIR=/app/dist \
    OPS_DB_PATH=/data/ops-console.sqlite

WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/docs ./docs
COPY --from=build /app/README.md ./README.md

VOLUME ["/data"]
EXPOSE 8787
USER node
CMD ["node", "server/dist/index.js"]
