FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production CAPYRA_IDENTITY_HOST=0.0.0.0 CAPYRA_IDENTITY_PORT=4320 CAPYRA_IDENTITY_STATE=/data
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY cloud/start.mjs ./cloud/start.mjs
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 4320
VOLUME ["/data"]
CMD ["node", "cloud/start.mjs"]
