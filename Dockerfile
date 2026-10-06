# syntax=docker/dockerfile:1
# The map renderer: the built app + a Bun server that drives it in headless
# Chromium (software WebGL). README "Docker" has the commands.

# 1. Build the app (index.html editor + render.html headless page).
FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY index.html render.html vite.config.js tsconfig.json ./
COPY public ./public
COPY src ./src
RUN bun run build

# 2. The server's only dependency (playwright-core), production install.
FROM oven/bun:1.4.2 AS server-deps
WORKDIR /srv/server
COPY server/package.json server/bun.lock ./
RUN bun install --production --frozen-lockfile

# 3. Runtime: Bun + Chromium headless shell and its system libraries only.
FROM oven/bun:1.4.2-slim AS runtime
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production \
    PORT=3000 \
    GEOCODE_CACHE_DIR=/data/geocode
WORKDIR /srv
COPY --from=server-deps /srv/server/node_modules ./server/node_modules
RUN bun ./server/node_modules/playwright-core/cli.js install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* /tmp/* \
 && mkdir -p /data/geocode && chown -R bun:bun /data
COPY --from=build /app/dist ./dist
COPY server ./server
COPY presets ./presets
COPY LICENSE LICENSE-OLD TRADEMARK.md README.md ./
USER bun
EXPOSE 3000
CMD ["bun", "server/index.ts"]
