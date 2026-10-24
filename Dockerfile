# syntax=docker/dockerfile:1.7

# ---- dependencies (production only, lockfile enforced, no install scripts)
FROM oven/bun:1.4.4-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

# ---- runtime: non-root, no build tools, source only
FROM oven/bun:1.4.4-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json tsconfig.json ./
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun scripts/setup.ts ./scripts/setup.ts
USER bun
EXPOSE 3000 9464
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health/live >/dev/null || exit 1
CMD ["bun", "src/main.ts"]
