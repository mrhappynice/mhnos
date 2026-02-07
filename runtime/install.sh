#!/bin/bash
#
# MHNOS Workerd Runtime - Native Installation Script
# Installs the runtime bridge as a systemd service
#

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
SERVICE_NAME="mhnos-runtime"
SERVICE_USER="mhnos"
INSTALL_DIR="/opt/mhnos-runtime"
WORKSPACE_DIR="/var/lib/mhnos/workspace"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

# Functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_command() {
    if ! command -v "$1" &> /dev/null; then
        log_error "$1 is required but not installed"
        return 1
    fi
}

check_node_version() {
    local version
    version=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$version" -lt 22 ]; then
        log_error "Node.js 22+ required, found $(node --version)"
        return 1
    fi
    log_info "Node.js version: $(node --version)"
}

check_workerd() {
    if command -v workerd &> /dev/null; then
        log_info "Workerd version: $(workerd --version)"
    else
        log_warn "Workerd not found. Install from: https://github.com/cloudflare/workerd"
        log_warn "Or run: npm install -g workerd"
    fi
}

# Main installation
main() {
    log_info "MHNOS Workerd Runtime Installer"
    log_info "================================"
    
    # Check prerequisites
    log_info "Checking prerequisites..."
    check_command "node"
    check_command "npm"
    check_command "systemctl"
    check_node_version
    check_workerd
    
    # Check if running as root
    if [ "$EUID" -ne 0 ]; then
        log_error "Please run as root (use sudo)"
        exit 1
    fi
    
    # Create user
    log_info "Creating service user..."
    if id "$SERVICE_USER" &>/dev/null; then
        log_warn "User $SERVICE_USER already exists"
    else
        useradd -r -m -s /bin/false "$SERVICE_USER"
        log_info "Created user: $SERVICE_USER"
    fi
    
    # Create directories
    log_info "Creating directories..."
    mkdir -p "$INSTALL_DIR"
    mkdir -p "$WORKSPACE_DIR"
    chown "$SERVICE_USER:$SERVICE_USER" "$WORKSPACE_DIR"
    
    # Copy files
    log_info "Installing runtime files..."
    cp -r "$(dirname "$0")"/package.json "$INSTALL_DIR/"
    cp -r "$(dirname "$0")"/server.js "$INSTALL_DIR/"
    cp -r "$(dirname "$0")"/lib "$INSTALL_DIR/" 2>/dev/null || true
    cp -r "$(dirname "$0")"/templates "$INSTALL_DIR/" 2>/dev/null || true
    
    # Install dependencies
    log_info "Installing Node.js dependencies..."
    cd "$INSTALL_DIR"
    npm install --production
    
    # Set ownership
    chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
    
    # Create systemd service file
    log_info "Creating systemd service..."
    cat > "$SERVICE_FILE" << EOF
[Unit]
Description=MHNOS Workerd Runtime Bridge
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10
Environment="MHNOS_RUNTIME_PORT=18790"
Environment="MHNOS_WORKSPACE=$WORKSPACE_DIR"
Environment="MHNOS_SANDBOX=strict"
Environment="MHNOS_LOG_LEVEL=info"
Environment="NODE_ENV=production"

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$WORKSPACE_DIR
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictRealtime=true
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=false
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

# Resource limits
LimitAS=2G
LimitRSS=1G
LimitNOFILE=65536
LimitNPROC=100

[Install]
WantedBy=multi-user.target
EOF
    
    # Reload systemd
    log_info "Reloading systemd..."
    systemctl daemon-reload
    
    # Start service
    log_info "Starting service..."
    systemctl enable "$SERVICE_NAME"
    systemctl start "$SERVICE_NAME"
    
    # Check status
    sleep 2
    if systemctl is-active --quiet "$SERVICE_NAME"; then
        log_info "Service is running!"
        log_info ""
        log_info "Status:"
        systemctl status "$SERVICE_NAME" --no-pager | head -n 10
        log_info ""
        log_info "Health check:"
        curl -s http://localhost:18790/health || log_warn "Health check failed (service may still be starting)"
    else
        log_error "Service failed to start"
        systemctl status "$SERVICE_NAME" --no-pager || true
        exit 1
    fi
    
    log_info ""
    log_info "Installation complete!"
    log_info ""
    log_info "Service commands:"
    log_info "  sudo systemctl status $SERVICE_NAME"
    log_info "  sudo systemctl start $SERVICE_NAME"
    log_info "  sudo systemctl stop $SERVICE_NAME"
    log_info "  sudo systemctl restart $SERVICE_NAME"
    log_info "  sudo journalctl -u $SERVICE_NAME -f"
    log_info ""
    log_info "WebSocket endpoint: ws://localhost:18790"
    log_info "Health check: http://localhost:18790/health"
}

# Uninstall function
uninstall() {
    log_info "Uninstalling MHNOS Workerd Runtime..."
    
    if [ "$EUID" -ne 0 ]; then
        log_error "Please run as root (use sudo)"
        exit 1
    fi
    
    # Stop and disable service
    systemctl stop "$SERVICE_NAME" 2>/dev/null || true
    systemctl disable "$SERVICE_NAME" 2>/dev/null || true
    
    # Remove service file
    rm -f "$SERVICE_FILE"
    systemctl daemon-reload
    
    # Remove installation directory
    rm -rf "$INSTALL_DIR"
    
    log_info "Uninstallation complete"
    log_warn "Workspace directory preserved at: $WORKSPACE_DIR"
    log_warn "Remove manually if desired: sudo rm -rf $WORKSPACE_DIR"
}

# Show usage
usage() {
    echo "Usage: $0 [install|uninstall]"
    echo ""
    echo "Commands:"
    echo "  install    Install the runtime service (default)"
    echo "  uninstall  Remove the runtime service"
    echo ""
    echo "Examples:"
    echo "  sudo $0 install"
    echo "  sudo $0 uninstall"
}

# Parse arguments
case "${1:-install}" in
    install)
        main
        ;;
    uninstall)
        uninstall
        ;;
    -h|--help|help)
        usage
        exit 0
        ;;
    *)
        log_error "Unknown command: $1"
        usage
        exit 1
        ;;
esac
