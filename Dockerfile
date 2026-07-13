FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/crypto/package.json packages/crypto/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN npm ci --omit=dev

COPY apps ./apps
COPY packages ./packages
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["node", "apps/server/src/index.js"]
