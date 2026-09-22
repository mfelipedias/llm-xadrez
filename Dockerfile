# LLM Xadrez — imagem única: builda o frontend e roda o servidor (tsx).
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json providers.json ./
COPY shared ./shared
COPY server ./server
COPY web ./web
COPY scripts ./scripts
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3939 \
    DATA_DIR=/app/data
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/tsconfig.base.json /app/providers.json ./
COPY --from=build /app/shared ./shared
COPY --from=build /app/server ./server
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/web/dist ./web/dist
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3939
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3939/api/health >/dev/null 2>&1 || exit 1
CMD ["npx", "tsx", "server/src/index.ts"]
