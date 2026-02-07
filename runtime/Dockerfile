# MHNOS Workerd Runtime - Phase 1
# Multi-stage build for isolated Node.js/Workerd execution environment

# =============================================================================
# Stage 1: Base image with Node.js 22
# =============================================================================
FROM node:22-slim AS base

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    git \
    python3 \
    python3-pip \
    unzip \
    sudo \
    # For node-pty and native modules
    build-essential \
    python3-dev \
    # For networking tools
    netcat-openbsd \
    iputils-ping \
    # For TTY support
    socat \
    # For workerd dependencies
    libc6 \
    libstdc++6 \
    # Cleanup
    && rm -rf /var/lib/apt/lists/*

# =============================================================================
# Stage 2: Final runtime image
# =============================================================================
FROM base AS runtime

# Build argument for optional OpenClaw installation
ARG INSTALL_OPENCLAW=false

# Install workerd from npm
# The npm package downloads the correct binary for the architecture
RUN npm install -g workerd@latest && \
    ln -sf /usr/local/lib/node_modules/workerd/bin/workerd /usr/local/bin/workerd 2>/dev/null || \
    ln -sf /usr/local/lib/node_modules/.bin/workerd /usr/local/bin/workerd 2>/dev/null || \
    echo "Workerd binary location will be detected at runtime"

# Install OpenClaw if requested (do this as root before switching users)
RUN if [ "$INSTALL_OPENCLAW" = "true" ]; then \
    echo "Installing OpenClaw..." && \
    npm install -g openclaw@latest && \
    echo "OpenClaw installed successfully"; \
else \
    echo "OpenClaw installation skipped (set INSTALL_OPENCLAW=true to enable)"; \
fi

# Create non-root user for security (use higher UID/GID to avoid conflicts)
RUN groupadd -r mhnos -g 9999 && \
    useradd -r -u 9999 -g mhnos -m -s /bin/bash mhnos && \
    mkdir -p /workspace /opt/mhnos-runtime && \
    chown -R mhnos:mhnos /workspace /opt/mhnos-runtime

# Setup workspace
WORKDIR /workspace
VOLUME ["/workspace"]

# Copy runtime bridge code - use wildcards to handle missing directories gracefully
COPY --chown=mhnos:mhnos package.json server.js *.js /opt/mhnos-runtime/
COPY --chown=mhnos:mhnos templates/ /opt/mhnos-runtime/templates/

# Create lib directory (might be empty)
RUN mkdir -p /opt/mhnos-runtime/lib && chown -R mhnos:mhnos /opt/mhnos-runtime/lib

# Install runtime dependencies
WORKDIR /opt/mhnos-runtime
RUN npm install --production && \
    chown -R mhnos:mhnos node_modules

# Create a wrapper script to find workerd at runtime
RUN cat > /usr/local/bin/workerd-wrapper << 'EOF'
#!/bin/bash
# Find workerd binary
WORKERD_PATH=""

if [ -x "/usr/local/bin/workerd" ]; then
    WORKERD_PATH="/usr/local/bin/workerd"
elif [ -x "/usr/local/lib/node_modules/workerd/bin/workerd" ]; then
    WORKERD_PATH="/usr/local/lib/node_modules/workerd/bin/workerd"
elif [ -x "/usr/local/lib/node_modules/.bin/workerd" ]; then
    WORKERD_PATH="/usr/local/lib/node_modules/.bin/workerd"
fi

if [ -z "$WORKERD_PATH" ]; then
    echo "Error: workerd binary not found" >&2
    exit 1
fi

exec "$WORKERD_PATH" "$@"
EOF
RUN chmod +x /usr/local/bin/workerd-wrapper && \
    ln -sf /usr/local/bin/workerd-wrapper /usr/local/bin/workerd

# Switch to non-root user
RUN echo "mhnos ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/mhnos && \
    chmod 0440 /etc/sudoers.d/mhnos
USER mhnos


# Environment configuration
ENV MHNOS_RUNTIME_PORT=18790
ENV MHNOS_WORKSPACE=/workspace
ENV MHNOS_SANDBOX=strict
ENV MHNOS_ALLOW_OPENCLAW=${INSTALL_OPENCLAW}
ENV NODE_ENV=production
ENV PATH="/usr/local/bin:/usr/bin:/bin:/opt/mhnos-runtime/node_modules/.bin"

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD nc -z localhost ${MHNOS_RUNTIME_PORT} || exit 1

# Expose WebSocket port for MHNOS communication
EXPOSE ${MHNOS_RUNTIME_PORT}

# Start runtime bridge
CMD ["node", "server.js"]
