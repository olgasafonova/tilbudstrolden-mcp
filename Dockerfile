# Container image for MCP hosts that run the server themselves (Glama and
# friends). Without a Dockerfile in the repo, Glama infers one with an LLM and
# rebuilds it per run, so the build is only as stable as the guess. Checking
# one in makes the result deterministic.
#
# The server speaks stdio, so nothing is exposed and nothing listens.

FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM node:22-slim

ENV NODE_ENV=production

WORKDIR /app

# package.json lands in the runtime stage as well, not just the builder:
# src/version.ts reads the version out of it at startup.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

CMD ["node", "dist/server.js"]
