ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-slim

WORKDIR /app

COPY . .

# Install from the lockfile, including devDependencies: the apps run through the
# workspace's pinned TypeScript/ts-node (a global ts-node pulls in the latest
# TypeScript, whose 7.x native compiler has no JS API and crashes ts-node).
# Then install the library build from .lib/ (see scripts/pack-lib.sh).
RUN npm ci --include=dev && node scripts/install-lib.js

ENV NODE_ENV=production

# CLIENT (axios|undici), PLATFORM (express|fastify), INTERCEPTOR (0|1) and PORT
# are set per service in the compose files - this is the one shared app image.
CMD ["node_modules/.bin/ts-node", "--transpile-only", "--project", "apps/nestjs-app/tsconfig.app.json", "apps/nestjs-app/src/main.ts"]
