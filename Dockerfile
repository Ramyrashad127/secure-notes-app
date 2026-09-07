# ============================================================
# Secure Notes — production image
# Multi-stage build so the runtime image ships no build toolchain
# and runs as a non-root user.
# ============================================================

# ---- deps: install all dependencies + build artifacts ---------------------
FROM node:22-alpine AS build
WORKDIR /app

# Standalone output for a self-contained production server.
ENV NEXT_TELEMETRY_DISABLED=1

# A placeholder is needed at build time because src/db/index.ts throws when
# DATABASE_URL is absent; real credentials are injected at runtime by
# docker-compose via env_file/environment.
ENV DATABASE_URL=postgres://build:build@localhost:5432/build

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

RUN npm run build

# ---- runtime --------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Create a non-root user and give it ownership of the app dir.
RUN addgroup -S nodejs && adduser -S nodejs -G nodejs

COPY --from=build --chown=nodejs:nodejs /app/package.json ./package.json
COPY --from=build --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=nodejs:nodejs /app/.next ./.next
COPY --from=build --chown=nodejs:nodejs /app/public ./public
COPY --from=build --chown=nodejs:nodejs /app/next.config.ts ./next.config.ts

USER nodejs

EXPOSE 3000

CMD ["node_modules/.bin/next", "start"]