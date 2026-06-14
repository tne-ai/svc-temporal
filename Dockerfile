FROM node:20-slim AS builder

WORKDIR /app

# git is needed to install the @tne-ai/agent-harness GitHub dependency;
# Python/build tools are needed when npm dependencies compile native modules.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git python3 python3-yaml make g++ \
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

# Runtime toolbelt for command-mode FSM steps and implementation jobs.
# Keep this broad enough for deterministic skills: Python scripts, package
# installs, Postgres checks, JSON processing, repo operations, and archives.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    openssh-client \
    python3 \
    python3-yaml \
    python3-pip \
    python3-venv \
    make \
    g++ \
    postgresql-client \
    jq \
    zip \
    unzip \
    rsync \
    wget \
    less \
    tree \
    && rm -rf /var/lib/apt/lists/*

ARG GITHUB_TOKEN=""
RUN if [ -n "$GITHUB_TOKEN" ]; then \
      git config --global --add url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/" && \
      git config --global --add url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "ssh://git@github.com/" && \
      git config --global --add url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "git@github.com:"; \
    fi

# Install Claude Code CLI. The Claude Agent SDK spawns the `claude` binary
# as a subprocess, so the worker image must ship it. Uses the same installer
# and move-to-/usr/local/bin pattern as horizon/backend/Dockerfile so the
# binary is on PATH for node (UID 0) at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ripgrep \
    && rm -rf /var/lib/apt/lists/*
RUN export USE_BUILTIN_RIPGREP=0 && \
    for i in 1 2 3; do \
      curl -fsSL https://claude.ai/install.sh | bash && break || \
      echo "Attempt $i failed, retrying in 10s..." && sleep 10; \
    done && \
    chmod a+rx /root /root/.local /root/.local/share && \
    chmod -R a+rX /root/.local/share/claude && \
    mv /root/.local/bin/claude /usr/local/bin/claude && \
    chmod +x /usr/local/bin/claude

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && \
    git config --global --unset-all url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf 2>/dev/null || true

COPY --from=builder /app/dist ./dist

# Bundle the FULL tne-plugins submodule so both parseConfig (orchestrator
# p-* skill resolution) and loadLeafSkillSchema (leaf skill output_schema_path
# resolution for Anthropic Structured Outputs) can find every plugin's
# SKILL.md + sidecar JSON schemas. Fetched via troopship's recursive
# submodule checkout at build time.
#
# Was previously narrowed to plugins/tne only — that broke structured outputs
# for any non-tne plugin (jpm, oli, navigator, ...) because loadLeafSkillSchema
# silently returns null when the skill file isn't found on disk. Symptom: model
# freeforms, downstream Zod rejects, no diagnostic log fires.
COPY tne-plugins/plugins ./tne-plugins/plugins

# Run as the built-in `node` user (UID 1000) rather than root. The Claude
# Agent SDK invokes `claude --allow-dangerously-skip-permissions`, which
# the CLI rejects when running as root:
#   "--dangerously-skip-permissions cannot be used with root/sudo privileges
#    for security reasons"
# Ensure /app and the node user's HOME are writable for runtime state.
RUN chown -R node:node /app && mkdir -p /home/node/.claude && chown -R node:node /home/node
USER node

ENV NODE_ENV=production

CMD ["node", "dist/worker.js"]
