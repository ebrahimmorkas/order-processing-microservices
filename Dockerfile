# syntax=docker/dockerfile:1
# One image definition for every service:
#   docker build --build-arg SERVICE=orders -t ops-orders .

FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/common/package.json packages/common/
COPY services/auth/package.json services/auth/
COPY services/gateway/package.json services/gateway/
COPY services/inventory/package.json services/inventory/
COPY services/notifications/package.json services/notifications/
COPY services/orders/package.json services/orders/
RUN npm ci

FROM deps AS build
ARG SERVICE
COPY scripts ./scripts
COPY packages ./packages
COPY services ./services
# Bundles the service together with the shared @ops/common source.
RUN node scripts/build.mjs "$SERVICE" && npm prune --omit=dev

FROM node:26-alpine AS runtime
ARG SERVICE
WORKDIR /app
ENV NODE_ENV=production \
    SERVICE=${SERVICE}
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist/${SERVICE} ./dist
COPY --chown=node:node package.json ./
USER node
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
