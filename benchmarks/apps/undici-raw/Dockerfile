ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-slim

WORKDIR /app

COPY . .

# The floor app doesn't use nestjs-axios-undici, so it needs only the lockfile
# install (undici itself is a benchmarks dependency already).
RUN npm ci --include=dev

ENV NODE_ENV=production

CMD ["node_modules/.bin/ts-node", "--transpile-only", "--project", "apps/undici-raw/tsconfig.app.json", "apps/undici-raw/src/main.ts"]
