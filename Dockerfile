# syntax=docker/dockerfile:1
# Backend image (api and worker share it; compose picks the command).
# Stages: deps (all backend deps) -> build (bundle) -> prod-deps -> runtime.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/backend/package.json packages/backend/
COPY packages/extension/package.json packages/extension/
# --ignore-scripts: skips the root "prepare" (husky) and any install hooks.
RUN npm ci --workspace @cst/backend --ignore-scripts --no-audit --no-fund

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared/src packages/shared/src
COPY packages/core/src packages/core/src
COPY packages/backend/src packages/backend/src
COPY packages/backend/scripts packages/backend/scripts
RUN npm -w @cst/backend run build

FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/backend/package.json packages/backend/
COPY packages/extension/package.json packages/extension/
RUN npm ci --workspace @cst/backend --omit=dev --ignore-scripts --no-audit --no-fund \
 # workspace links would dangle: @cst/* is bundled into dist/cli.js
 && rm -rf node_modules/@cst \
 && npm cache clean --force

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/packages/backend/dist ./dist
COPY --chown=root:root packages/backend/migrations ./migrations
# Files stay root-owned and read-only to the app user.
USER node
EXPOSE 8787
CMD ["node", "dist/cli.js", "api"]
