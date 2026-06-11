# Copyright (c) 2026 Hemi Labs, Inc.
# Use of this source code is governed by the MIT License,
# which can be found in the LICENSE file.

# syntax=docker/dockerfile:1

# One image serves both products. PRODUCT (VUSD | VETBTC) is selected at
# runtime via an env var — there is no product-specific build.

# Build stage - compile TypeScript to dist/
FROM node:24.16.0-alpine3.24@sha256:fb71d01345f11b708a3553c66e7c74074f2d506400ea81973343d915cb64eef0 AS builder

WORKDIR /build

# Install dependencies.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# Dependency build stage
FROM node:24.16.0-alpine3.24@sha256:fb71d01345f11b708a3553c66e7c74074f2d506400ea81973343d915cb64eef0 AS deps-builder

WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev

# Run stage
FROM alpine:3.24.0@sha256:a2d49ea686c2adfe3c992e47dc3b5e7fa6e6b5055609400dc2acaeb241c829f4

# Install libstdc++ (required by the copied node binary) and dumb-init.
RUN apk add --no-cache \
	libstdc++=~15.2.0 \
	dumb-init=~1.2.5

# Add non-root node user
WORKDIR /app
RUN addgroup -g 1000 -S node && \
	adduser -u 1000 -S -s /bin/false -G node -D -H node

# Labels
ARG VERSION
ARG VCS_REF
ARG BUILD_DATE
LABEL org.opencontainers.image.created=$BUILD_DATE \
      org.opencontainers.image.authors="Hemi Labs" \
      org.opencontainers.image.url="https://github.com/vetro-protocol/vusd-arbitrage-bot" \
      org.opencontainers.image.source="https://github.com/vetro-protocol/vusd-arbitrage-bot" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.vendor="Hemi Labs" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.title="VUSD Arbitrage Bot" \
      org.label-schema.build-date=$BUILD_DATE \
      org.label-schema.name="VUSD Arbitrage Bot" \
      org.label-schema.url="https://github.com/vetro-protocol/vusd-arbitrage-bot" \
      org.label-schema.vcs-url="https://github.com/vetro-protocol/vusd-arbitrage-bot" \
      org.label-schema.vcs-ref=$VCS_REF \
      org.label-schema.vendor="Hemi Labs" \
      org.label-schema.version=$VERSION \
      org.label-schema.schema-version="1.0"

# Copy node binary from builder
COPY --from=builder /usr/local/bin/node /usr/local/bin/

# Copy application files and dependencies. Owned by root (no --chown) and
# world-readable, so the non-root runtime user can read+execute but cannot
# overwrite its own code or dependencies.
COPY --from=builder /build/dist ./dist
COPY --from=deps-builder /build/node_modules ./node_modules

USER node
ENV NODE_ENV=production

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
