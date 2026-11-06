# syntax=docker/dockerfile:1
# Node security baseline: 22.23.4 (2026-10-21 security release).
#
# ARGUS — wallet-native, security-hardened reference agent for the AICOM economy.
# Multi-stage build: compile TypeScript in `build`, run a lean prod image in `runtime`.
#
# NOTE: @aimarket/agent is an optional PEER dependency, resolved from the npm registry by the
# lockfile. The economy module dynamic-imports the SDK and degrades gracefully when it is absent.
# The build stage uses `npm ci` with optional packages: TypeScript 7's compiler is a
# platform-specific optional package (@typescript/typescript-linux-x64 …), so --omit=optional
# there leaves no compiler and `npm run build` fails.

# ---- Stage 1: build (compile src/ -> dist/) -------------------------------------------------
FROM node:22.23.4-slim AS build
WORKDIR /app

# Install deps first for better layer caching. package-lock.json is present in this repo.
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci

# Bring in the TypeScript sources and compile.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Stage 2: runtime (lean production image) ----------------------------------------------
FROM node:22.23.4-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Production deps only — no dev toolchain, no out-of-context optional SDK.
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm install --omit=dev --omit=optional

# Compiled output + the example config (used as a fallback / reference; the real
# argus.config.json is mounted read-only at runtime, never baked into the image).
COPY --from=build /app/dist ./dist
COPY web ./web
COPY argus.config.example.json ./
# Not root. ARGUS keeps its state (keystore, memory) under $HOME/.argus, which is why
# an earlier `USER node` without a HOME broke it: /root is not node's.
ENV HOME=/home/node
RUN mkdir -p /home/node/.argus && chown -R node:node /home/node/.argus
USER node

# HTTP server (GET /health, GET /arena) — keep in sync with ARGUS_HTTP_PORT / docker-compose.
EXPOSE 8787

# Liveness probe via Node's global fetch (Node 22). Non-zero exit on any failure.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.ARGUS_HTTP_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `argus` CLI entrypoint; default subcommand runs the enabled channels.
ENTRYPOINT ["node", "dist/index.js"]
CMD ["serve"]
