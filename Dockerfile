# syntax=docker/dockerfile:1
#
# ARGUS — wallet-native, security-hardened reference agent for the AICOM economy.
# Multi-stage build: compile TypeScript in `build`, run a lean prod image in `runtime`.
#
# NOTE: @aimarket/agent is an OPTIONAL dependency pointing at file:../aimarket-sdks/typescript,
# which lives OUTSIDE this build context. We install with --omit=optional in both stages so
# npm never tries to resolve that path. The economy module dynamic-imports the SDK and
# degrades gracefully when it is absent, so the default container runs with economy OFF.

# ---- Stage 1: build (compile src/ -> dist/) -------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

# Install deps first for better layer caching. package-lock.json is present in this repo.
COPY package.json package-lock.json ./
RUN npm install --omit=optional

# Bring in the TypeScript sources and compile.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Stage 2: runtime (lean production image) ----------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Production deps only — no dev toolchain, no out-of-context optional SDK.
COPY package.json package-lock.json ./
RUN npm install --omit=dev --omit=optional

# Compiled output + the example config (used as a fallback / reference; the real
# argus.config.json is mounted read-only at runtime, never baked into the image).
COPY --from=build /app/dist ./dist
COPY web ./web
COPY argus.config.example.json ./

# HTTP server (GET /health, GET /arena) — keep in sync with ARGUS_HTTP_PORT / docker-compose.
EXPOSE 8787

# Liveness probe via Node's global fetch (Node 22). Non-zero exit on any failure.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.ARGUS_HTTP_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `argus` CLI entrypoint; default subcommand runs the enabled channels.
ENTRYPOINT ["node", "dist/index.js"]
CMD ["serve"]
