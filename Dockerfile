# Multi-stage Dockerfile for AusLaw MCP
# Stage 1: Builder
FROM node:22-alpine AS builder

WORKDIR /app

# Install build dependencies
COPY package*.json ./
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src ./src

# Build the application
RUN npm run build

# Stage 2: Runtime
FROM node:22-alpine

# Install Tesseract OCR and curl-impersonate runtime deps.
# curl-impersonate bypasses Cloudflare's TLS/JA4 fingerprint gate on AustLII
# by replicating Chrome's ClientHello. We use the lexiforest fork because it
# publishes statically-linked musl binaries (the original lwthiker release
# ships glibc only — incompatible with Alpine).
# bash is required because the curl-impersonate per-profile wrappers use a
# bash shebang (Alpine defaults to busybox ash which rejects the syntax).
RUN apk update && \
    apk add --no-cache tesseract-ocr tesseract-ocr-data-eng ca-certificates wget bash || \
    apk add --no-cache tesseract-ocr ca-certificates wget bash

ARG CURL_IMPERSONATE_VERSION=v1.5.5
RUN set -eux; \
    arch="$(uname -m)"; \
    case "$arch" in \
      x86_64)  asset="curl-impersonate-${CURL_IMPERSONATE_VERSION}.x86_64-linux-musl.tar.gz" ;; \
      aarch64) asset="curl-impersonate-${CURL_IMPERSONATE_VERSION}.aarch64-linux-musl.tar.gz" ;; \
      *) echo "unsupported arch: $arch"; exit 1 ;; \
    esac; \
    cd /tmp && \
    wget -q "https://github.com/lexiforest/curl-impersonate/releases/download/${CURL_IMPERSONATE_VERSION}/${asset}" -O ci.tgz && \
    mkdir -p ci && tar xzf ci.tgz -C ci && \
    install -m 0755 ci/curl-impersonate /usr/local/bin/curl-impersonate && \
    # Copy the per-profile wrapper scripts (curl_chrome124, curl_chrome120, …).
    for f in ci/curl_*; do install -m 0755 "$f" /usr/local/bin/; done && \
    rm -rf /tmp/ci /tmp/ci.tgz && \
    /usr/local/bin/curl_chrome124 --version | head -1

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev --ignore-scripts

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

USER nodejs

# Expose HTTP transport port (used when MCP_TRANSPORT=http)
EXPOSE 3000

# Set environment variables with defaults
ENV NODE_ENV=production \
    AUSTLII_SEARCH_BASE=https://www.austlii.edu.au/cgi-bin/sinosrch.cgi \
    AUSTLII_REFERER=https://www.austlii.edu.au/forms/search1.html \
    AUSTLII_TIMEOUT=60000

# Start the MCP server
CMD ["node", "dist/index.js"]
