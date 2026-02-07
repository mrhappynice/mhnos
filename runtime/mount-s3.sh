#!/bin/bash
# Mount S3 bucket to /workspace using s3fs

set -e

S3_BUCKET=${S3_BUCKET:-workspace}
S3_ENDPOINT=${S3_ENDPOINT:-http://minio:9000}
S3_ACCESS_KEY=${S3_ACCESS_KEY:-}
S3_SECRET_KEY=${S3_SECRET_KEY:-}
MOUNT_POINT=${S3_MOUNT_POINT:-/workspace}

if [ -z "$S3_ACCESS_KEY" ] || [ -z "$S3_SECRET_KEY" ]; then
    echo "Error: S3_ACCESS_KEY and S3_SECRET_KEY must be set"
    echo "S3 will not be mounted. Files in /workspace are local only."
    exit 0
fi

# Create credentials file for s3fs (in home directory, no root needed)
mkdir -p ~/.passwd-s3fs
echo "$S3_ACCESS_KEY:$S3_SECRET_KEY" > ~/.passwd-s3fs/s3fs
chmod 600 ~/.passwd-s3fs/s3fs

# Wait for MinIO to be ready
echo "Waiting for MinIO at $S3_ENDPOINT..."
for i in {1..30}; do
    if curl -s "$S3_ENDPOINT/minio/health/live" > /dev/null 2>&1; then
        echo "MinIO is ready"
        break
    fi
    sleep 1
done

# Create mount point (ensure it exists and is owned by user)
mkdir -p "$MOUNT_POINT"

# Extract host from endpoint (remove http://)
S3_HOST=$(echo "$S3_ENDPOINT" | sed 's|http://||' | sed 's|https://||')

# Mount the bucket using sudo (required for FUSE)
echo "Mounting s3://$S3_BUCKET to $MOUNT_POINT..."

# Use sudo for mount command
sudo s3fs "$S3_BUCKET" "$MOUNT_POINT" \
    -o passwd_file=~/.passwd-s3fs/s3fs \
    -o url="$S3_ENDPOINT" \
    -o use_path_request_style \
    -o allow_other \
    -o uid=$(id -u),gid=$(id -g),umask=0002 \
    -o use_cache=/tmp/s3fs-cache \
    -o del_cache \
    -o max_stat_cache_size=10000 \
    -o stat_cache_expire=60 \
    -o dbglevel=warn \
    -f 2>&1 &

# Wait a moment and check if mount succeeded
sleep 2

if mountpoint -q "$MOUNT_POINT" 2>/dev/null; then
    echo "S3 bucket mounted successfully at $MOUNT_POINT"
    echo "Files in /workspace are now synced with S3 bucket: $S3_BUCKET"
    exit 0
else
    echo "Warning: S3 mount may have failed. Checking..."
    # Try without sudo as fallback (in case we're root)
    s3fs "$S3_BUCKET" "$MOUNT_POINT" \
        -o passwd_file=~/.passwd-s3fs/s3fs \
        -o url="$S3_ENDPOINT" \
        -o use_path_request_style \
        -o allow_other \
        -o uid=$(id -u),gid=$(id -g),umask=0002 \
        -o use_cache=/tmp/s3fs-cache \
        -o del_cache 2>&1 || {
            echo "Error: Failed to mount S3 bucket"
            echo "Continuing with local filesystem"
            exit 0
        }
fi

if mountpoint -q "$MOUNT_POINT" 2>/dev/null; then
    echo "S3 bucket mounted successfully at $MOUNT_POINT"
else
    echo "Warning: S3 mount not active, using local filesystem"
fi
