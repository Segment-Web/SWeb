FROM node:22-alpine

RUN npm install --global pnpm@11.13.0 && pnpm config set store-dir /pnpm/store

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/crypto/package.json packages/crypto/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

COPY apps ./apps
COPY packages ./packages
RUN mkdir -p /data && chown node:node /data
USER node
# The blob store must live inside the persistent /data volume, otherwise every
# rebuild would discard uploaded files.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 FILE_DIR=/data/files
EXPOSE 3000
CMD ["node", "apps/server/src/index.js"]
