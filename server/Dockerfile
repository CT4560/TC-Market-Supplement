# syntax=docker/dockerfile:1

# ---- 建置：安裝全部相依套件並編譯 TypeScript ----
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- 執行：只帶正式環境的相依套件與編譯結果 ----
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# 物品白名單（scripts/build-items.mjs 產生）跟著映像檔走；資料庫放在 /data 資料卷，不放進映像檔。
COPY data/items.json ./data/items.json

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# 上傳端點預設關閉：要在執行時設環境變數 COMMUNITY_UPLOAD_ENABLED=on（見 docker-compose.yml）。
CMD ["node", "dist/main.js"]
