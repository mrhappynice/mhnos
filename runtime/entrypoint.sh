#!/bin/bash
# MHNOS Runtime Entrypoint
# Mounts S3 bucket (as root) and starts the runtime server (as mhnos)

set -e

# Debug: show what env vars we have
echo "[Entrypoint] Environment check:"
echo "  S3_BUCKET=${S3_BUCKET:-NOT_SET}"
echo "  S3_ENDPOINT=${S3_ENDPOINT:-NOT_SET}"
echo "  S3_ACCESS_KEY=${S3_ACCESS_KEY:+SET}"
echo "  S3_SECRET_KEY=${S3_SECRET_KEY:+SET}"

S3_BUCKET=${S3_BUCKET:-workspace}
S3_ENDPOINT=${S3_ENDPOINT:-http://minio:9000}
S3_ACCESS_KEY=${S3_ACCESS_KEY:-}
S3_SECRET_KEY=${S3_SECRET_KEY:-}
MOUNT_POINT=${S3_MOUNT_POINT:-/workspace}

# Mount S3 bucket if credentials are available (run as root)
if [ -n "$S3_ACCESS_KEY" ] && [ -n "$S3_SECRET_KEY" ]; then
    echo "[Entrypoint] Setting up S3 mount..."
    
    # Create credentials file
    echo "$S3_ACCESS_KEY:$S3_SECRET_KEY" > /etc/passwd-s3fs
    chmod 600 /etc/passwd-s3fs
    
    # Wait for MinIO
    echo "[Entrypoint] Waiting for MinIO at $S3_ENDPOINT..."
    for i in {1..30}; do
        if curl -s "$S3_ENDPOINT/minio/health/live" > /dev/null 2>&1; then
            echo "[Entrypoint] MinIO is ready"
            break
        fi
        sleep 1
    done
    
    # Ensure mount point exists and has correct ownership
    mkdir -p "$MOUNT_POINT"
    chown mhnos:mhnos "$MOUNT_POINT"
    
    # Mount S3 bucket as root with debug output
    echo "[Entrypoint] Mounting s3://$S3_BUCKET to $MOUNT_POINT..."
    s3fs "$S3_BUCKET" "$MOUNT_POINT" \
        -o passwd_file=/etc/passwd-s3fs \
        -o url="$S3_ENDPOINT" \
        -o use_path_request_style \
        -o allow_other \
        -o uid=9999,gid=9999,umask=0002 \
        -o use_cache=/tmp/s3fs-cache \
        -o del_cache \
        -o max_stat_cache_size=10000 \
        -o stat_cache_expire=60 \
        -o noatime \
        -o nonempty \
        -o dbglevel=warn 2>&1 || {
            echo "[Entrypoint] Mount command failed with exit code $?"
        }
    
    # Verify mount
    sleep 1
    if mountpoint -q "$MOUNT_POINT"; then
        echo "[Entrypoint] S3 bucket mounted successfully at $MOUNT_POINT"
    else
        echo "[Entrypoint] Warning: S3 mount not active at $MOUNT_POINT"
        echo "[Entrypoint] Listing /workspace contents:"
        ls -la "$MOUNT_POINT" || true
    fi
else
    echo "[Entrypoint] S3 credentials not set (ACCESS_KEY or SECRET_KEY missing)"
    echo "[Entrypoint] Using local filesystem only"
fi

# Change ownership of workspace to mhnos
chown -R mhnos:mhnos /workspace 2>/dev/null || true

# Create env file for mhnos user to load
echo "[Entrypoint] Creating env file for mhnos user..."
cat > /tmp/mhnos-env << EOF
export S3_ENDPOINT="${S3_ENDPOINT}"
export S3_PUBLIC_ENDPOINT="${S3_PUBLIC_ENDPOINT}"
export S3_BUCKET="${S3_BUCKET}"
export S3_ACCESS_KEY="${S3_ACCESS_KEY}"
export S3_SECRET_KEY="${S3_SECRET_KEY}"
export S3_REGION="${S3_REGION}"
export S3_FORCE_PATH_STYLE="${S3_FORCE_PATH_STYLE}"
export S3_PRESIGN_EXPIRY="${S3_PRESIGN_EXPIRY}"
export MHNOS_RUNTIME_PORT="${MHNOS_RUNTIME_PORT}"
export MHNOS_WORKSPACE="${MHNOS_WORKSPACE}"
export MHNOS_SANDBOX="${MHNOS_SANDBOX}"
export MHNOS_ALLOW_OPENCLAW="${MHNOS_ALLOW_OPENCLAW}"
export MHNOS_LOG_LEVEL="${MHNOS_LOG_LEVEL}"
export PATH="${PATH}"
export HOME="/home/mhnos"
EOF

chmod 644 /tmp/mhnos-env
chown mhnos:mhnos /tmp/mhnos-env

# Start the runtime server as mhnos user, preserving environment
echo "[Entrypoint] Starting MHNOS Runtime Server as mhnos user..."
exec su - mhnos -c "source /tmp/mhnos-env && cd /opt/mhnos-runtime && node server-remote.js"
