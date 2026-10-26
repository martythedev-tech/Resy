FROM node:24-bookworm-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ARG VITE_API_URL=/api
ARG VITE_APP_VERSION
ARG VITE_RELEASE_CHANNEL
ARG VITE_BUILD_ID
ENV VITE_API_URL=${VITE_API_URL}
ENV VITE_APP_VERSION=${VITE_APP_VERSION}
ENV VITE_RELEASE_CHANNEL=${VITE_RELEASE_CHANNEL}
ENV VITE_BUILD_ID=${VITE_BUILD_ID}

RUN npm run build

FROM nginxinc/nginx-unprivileged:1.31.7-alpine AS runtime

LABEL org.opencontainers.image.source="https://github.com/martythedev-tech/Resy" \
      org.opencontainers.image.title="Resy Web" \
      org.opencontainers.image.description="Resy conference room booking web application"

COPY docker/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:8080/ >/dev/null || exit 1
