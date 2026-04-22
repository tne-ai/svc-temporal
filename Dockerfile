FROM node:20-slim AS builder

WORKDIR /app

# git is needed to install the @tne-ai/agent-harness GitHub dependency
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

# Configure git auth for private GitHub repos. npm resolves github URLs to
# git+ssh://git@github.com/... even when package.json specifies https, so we
# rewrite both forms to HTTPS with a token.
ARG GITHUB_TOKEN=""
RUN if [ -n "$GITHUB_TOKEN" ]; then \
      git config --global --add url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/" && \
      git config --global --add url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "ssh://git@github.com/" && \
      git config --global --add url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "git@github.com:"; \
    fi

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci

# Build TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Production image
FROM node:20-slim

WORKDIR /app

# ca-certificates needed for S3/HTTPS; git needed for agent-harness git dep
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

ARG GITHUB_TOKEN=""
RUN if [ -n "$GITHUB_TOKEN" ]; then \
      git config --global --add url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/" && \
      git config --global --add url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "ssh://git@github.com/" && \
      git config --global --add url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "git@github.com:"; \
    fi

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && \
    git config --global --unset-all url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf 2>/dev/null || true

COPY --from=builder /app/dist ./dist

# Bundle the tne-plugins submodule so parseConfig can resolve p-* SKILL.md
# files. Mirrors the layout orion-backend uses (/app/tne-plugins/plugins/tne).
# Fetched via troopship's recursive submodule checkout at build time.
COPY tne-plugins/plugins/tne ./tne-plugins/plugins/tne

ENV NODE_ENV=production

CMD ["node", "dist/worker.js"]
