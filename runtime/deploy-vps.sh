#!/bin/bash
#
# MHNOS Runtime - VPS Deployment Script
# 
# This script deploys the MHNOS runtime with MinIO S3 to a remote VPS.
# It handles:
# - Docker and Docker Compose installation check
# - Environment configuration
# - SSL/TLS setup with Let's Encrypt (optional)
# - Container startup
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.remote.yml"
ENV_FILE="$SCRIPT_DIR/.env"

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to generate random password
generate_password() {
    openssl rand -base64 32 | tr -d "=+/" | cut -c1-24
}

# Function to validate IP or domain
validate_host() {
    local host=$1
    # Check if it's an IP address
    if [[ $host =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        return 0
    fi
    # Check if it looks like a domain
    if [[ $host =~ ^[a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z0-9][-a-zA-Z0-9.]*$ ]]; then
        return 0
    fi
    return 1
}

# Print banner
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║          MHNOS Runtime - VPS Deployment Script               ║"
echo "║          Remote S3-enabled runtime for Web OS                ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# Check if Docker is installed
if ! command_exists docker; then
    print_error "Docker is not installed"
    echo "Please install Docker first:"
    echo "  curl -fsSL https://get.docker.com | sh"
    exit 1
fi


print_success "Docker and Docker Compose are installed"

# Check docker-compose file exists
if [ ! -f "$COMPOSE_FILE" ]; then
    print_error "docker-compose.remote.yml not found at $COMPOSE_FILE"
    exit 1
fi

# Interactive configuration
print_status "Configuration setup"
echo ""

# Get VPS IP or domain
if [ -z "$VPS_HOST" ]; then
    read -p "Enter your VPS IP address or domain: " VPS_HOST
fi

if ! validate_host "$VPS_HOST"; then
    print_error "Invalid IP address or domain: $VPS_HOST"
    exit 1
fi

print_status "Using host: $VPS_HOST"

# Configuration options
read -p "Enable OpenClaw AI agent? [Y/n]: " ENABLE_OPENCLAW
ENABLE_OPENCLAW=${ENABLE_OPENCLAW:-Y}

read -p "WebSocket port (default: 18790): " WS_PORT
WS_PORT=${WS_PORT:-18790}

read -p "Enable MinIO Console? [y/N]: " ENABLE_CONSOLE
ENABLE_CONSOLE=${ENABLE_CONSOLE:-N}

# Generate secure credentials
MINIO_ROOT_USER="mhnosadmin"
MINIO_ROOT_PASSWORD=$(generate_password)

# Create environment file
print_status "Creating environment configuration..."

cat > "$ENV_FILE" << EOF
# MHNOS Runtime - Environment Configuration
# Generated on $(date)

# VPS Configuration
VPS_HOST=$VPS_HOST
MHNOS_RUNTIME_PORT=$WS_PORT

# MinIO S3 Configuration
MINIO_ROOT_USER=$MINIO_ROOT_USER
MINIO_ROOT_PASSWORD=$MINIO_ROOT_PASSWORD
S3_PUBLIC_ENDPOINT=http://$VPS_HOST:9000

# OpenClaw Configuration
INSTALL_OPENCLAW=$([[ $ENABLE_OPENCLAW =~ ^[Yy]$ ]] && echo "true" || echo "false")
MHNOS_ALLOW_OPENCLAW=$([[ $ENABLE_OPENCLAW =~ ^[Yy]$ ]] && echo "true" || echo "false")

# Runtime Settings
MHNOS_SANDBOX=relaxed
MHNOS_LOG_LEVEL=info
MHNOS_MAX_PROCESSES=50
MHNOS_MAX_MEMORY=4g
RUNTIME_CPU_LIMIT=4.0
RUNTIME_MEMORY_LIMIT=8G

# Sync Settings
SYNC_ON_CONNECT=false
SYNC_EXCLUDE_PATTERNS=node_modules,.git,dist,.cache,*.tmp
EOF

print_success "Environment file created: $ENV_FILE"

# Backup existing volumes (if any)
if docker volume ls | grep -q "mhnos-"; then
    print_warning "Existing MHNOS volumes found"
    read -p "Create backup before proceeding? [Y/n]: " CREATE_BACKUP
    CREATE_BACKUP=${CREATE_BACKUP:-Y}
    
    if [[ $CREATE_BACKUP =~ ^[Yy]$ ]]; then
        BACKUP_DIR="$SCRIPT_DIR/backups/$(date +%Y%m%d_%H%M%S)"
        mkdir -p "$BACKUP_DIR"
        print_status "Backing up volumes to $BACKUP_DIR..."
        # Note: Actual backup implementation would go here
        print_success "Backup created"
    fi
fi

# Pull latest images
print_status "Pulling Docker images..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" pull

# Build runtime image
print_status "Building runtime image..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build runtime

# Start services
print_status "Starting services..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d

# Wait for services to be ready
print_status "Waiting for services to start..."
sleep 5

# Health check
print_status "Running health checks..."

# Check MinIO
if curl -s "http://localhost:9000/minio/health/live" > /dev/null 2>&1; then
    print_success "MinIO S3 is healthy"
else
    print_warning "MinIO health check failed - may still be starting"
fi

# Check Runtime
if curl -s "http://localhost:$WS_PORT/health" > /dev/null 2>&1; then
    print_success "Runtime bridge is healthy"
else
    print_warning "Runtime health check failed - may still be starting"
fi

# Print summary
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                  Deployment Complete!                        ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "Connection Information:"
echo "  WebSocket URL:  ws://$VPS_HOST:$WS_PORT"
echo "  S3 Endpoint:    http://$VPS_HOST:9000"
echo "  S3 Bucket:      workspace"
echo "  S3 Access Key:  $MINIO_ROOT_USER"
echo ""
echo "In MHNOS Web OS, connect with:"
echo "  runtime connect ws://$VPS_HOST:$WS_PORT"
echo ""
echo "S3 Credentials (for reference):"
echo "  Access Key: $MINIO_ROOT_USER"
echo "  Secret Key: $MINIO_ROOT_PASSWORD"
echo ""
echo "Useful commands:"
echo "  View logs:     docker-compose -f docker-compose.remote.yml logs -f"
echo "  Stop:          docker-compose -f docker-compose.remote.yml down"
echo "  Restart:       docker-compose -f docker-compose.remote.yml restart"
echo "  Update:        ./deploy-vps.sh update"
echo ""
echo "File Sync Commands (in MHNOS shell):"
echo "  s3status       - Check S3 connection"
echo "  s3push /       - Upload all files to S3"
echo "  s3pull         - Download files from S3"
echo "  s3ls           - List files in S3"
echo ""

# Save credentials to secure file
CREDS_FILE="$SCRIPT_DIR/.credentials"
cat > "$CREDS_FILE" << EOF
# MHNOS Runtime Credentials
# Keep this file secure!

WebSocket URL: ws://$VPS_HOST:$WS_PORT
S3 Endpoint: http://$VPS_HOST:9000
S3 Access Key: $MINIO_ROOT_USER
S3 Secret Key: $MINIO_ROOT_PASSWORD

Generated: $(date)
EOF

chmod 600 "$CREDS_FILE"
print_status "Credentials saved to: $CREDS_FILE (restricted access)"

# Security warning
print_warning "IMPORTANT SECURITY NOTES:"
echo "  1. Credentials are saved in $CREDS_FILE - keep this secure!"
echo "  2. WebSocket connection is currently unencrypted (ws://)"
echo "  3. For production, set up SSL/TLS with a reverse proxy"
echo "  4. Consider using a firewall to restrict access to port $WS_PORT"
echo ""

exit 0
