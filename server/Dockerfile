FROM node:25-bookworm-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:25-bookworm-slim AS runtime

WORKDIR /app

LABEL org.opencontainers.image.source="https://github.com/martythedev-tech/Resy" \
      org.opencontainers.image.title="Resy API" \
      org.opencontainers.image.description="Resy conference room booking API"

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=5000
ENV DATA_DIR=/app/data
ENV UPLOADS_DIR=/app/uploads

RUN apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends ca-certificates gosu \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev \
  && rm -rf /root/.npm /usr/local/lib/node_modules/npm \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/config/schema-sqlite.sql ./dist/config/schema-sqlite.sql
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /app/data /app/uploads /app/certs \
  && chown -R node:node /app \
  && chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 5000

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
