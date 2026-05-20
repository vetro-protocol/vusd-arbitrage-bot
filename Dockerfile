# syntax=docker/dockerfile:1

# One image serves both products. PRODUCT (VUSD | VETBTC) is selected at
# runtime via an env var — there is no product-specific build.

# ── Build stage — compile TypeScript to dist/ ──────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Runtime stage — production deps + compiled output only ─────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "dist/index.js"]
