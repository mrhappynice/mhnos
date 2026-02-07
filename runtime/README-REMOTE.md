# MHNOS Runtime - Remote VPS Deployment Guide

Deploy the MHNOS runtime with MinIO S3 storage to a remote VPS for file persistence and OpenClaw AI agent support.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Your Browser                                    │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                         MHNOS Web OS                                  │   │
│  │  ┌──────────┐  s3push  ┌──────────┐  s3pull  ┌──────────┐            │   │
│  │  │   OPFS   │ ───────► │   S3     │ ◄─────── │   S3     │            │   │
│  │  │  Files   │          │  Upload  │          │ Download │            │   │
│  │  └──────────┘          └──────────┘          └──────────┘            │   │
│  │        ▲                                              │               │   │
│  │        │        WebSocket (Commands/TTL)              │               │   │
│  │        └──────────────────────────────────────────────┘               │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Remote VPS                                      │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │                    Docker Compose Stack                               │    │
│  │                                                                       │    │
│  │  ┌─────────────────┐      ┌─────────────────┐      ┌──────────────┐  │    │
│  │  │  Runtime Bridge │◄────►│    MinIO S3     │      │  OpenClaw    │  │    │
│  │  │   (WebSocket)   │      │ (File Storage)  │      │   (Optional) │  │    │
│  │  │   Port: 18790   │      │  Port: 9000     │      │              │  │    │
│  │  └─────────────────┘      └─────────────────┘      └──────────────┘  │    │
│  │           │                                                           │    │
│  │           └──────────────────────────────────────────────────────┐   │    │
│  │                                                                  ▼   │    │
│  │                                                        ┌──────────┐  │    │
│  │                                                        │ /workspace│  │    │
│  │                                                        │ (runtime) │  │    │
│  │                                                        └──────────┘  │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Prepare Your VPS

Requirements:
- Ubuntu 20.04+ or Debian 11+
- Docker 20.10+ and Docker Compose 2.0+
- At least 2 CPU cores, 4GB RAM
- 20GB+ disk space

```bash
# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker

# Install Docker Compose plugin
sudo apt-get update
sudo apt-get install docker-compose-plugin
```

### 2. Deploy

```bash
# Clone or copy the runtime folder to your VPS
cd runtime

# Run the deployment script
chmod +x deploy-vps.sh
./deploy-vps.sh
```

The script will:
1. Check Docker installation
2. Ask for your VPS host/IP
3. Generate secure credentials
4. Build and start containers
5. Run health checks
6. Display connection information

### 3. Connect from MHNOS

In your MHNOS Web OS shell:

```bash
# Connect to your remote runtime
runtime connect ws://your-vps-ip:18790

# Check S3 status
s3status

# Upload your project files
s3push /myproject

# Work in the remote runtime
rshell

# Download changes back
s3pull
```

## Manual Deployment

If you prefer manual control:

```bash
# Copy the example environment file
cp .env.example .env

# Edit with your settings
nano .env

# Start the stack
docker-compose -f docker-compose.remote.yml up -d

# View logs
docker-compose -f docker-compose.remote.yml logs -f

# Stop
docker-compose -f docker-compose.remote.yml down
```

## File Sync Commands

### s3push - Upload to S3

Push files from your browser's OPFS to the remote S3 bucket:

```bash
# Upload entire workspace
s3push /

# Upload specific project
s3push /myproject

# Upload with exclusions
s3push /myproject --exclude=*.log,temp/
```

Features:
- Automatic file scanning
- Batch upload with progress
- Excludes node_modules, .git, dist by default
- Files larger than 5GB are skipped

### s3pull - Download from S3

Pull files from S3 back to your browser:

```bash
# Download all files
s3pull

# Download specific prefix
s3pull myproject/

# Force overwrite without confirmation
s3pull --force
```

### s3ls - List S3 Files

```bash
# List all files
s3ls

# List with prefix
s3ls myproject/

# Limit results
s3ls --limit=50
```

### s3sync - Bidirectional Sync

```bash
# Push then pull
s3sync /

# Push only
s3sync / --push-only

# Pull only  
s3sync --pull-only
```

### Other Commands

```bash
# Check S3 status
s3status

# Get file metadata
s3meta myproject/package.json

# Delete a file
s3rm myproject/old-file.txt
```

## Workflow Example

### Development Session

```bash
# 1. Connect to remote runtime
runtime connect ws://my-vps.com:18790

# 2. Check connection
runtime status
s3status

# 3. Upload current project
s3push /projects/myapp

# 4. Start a shell in the runtime
rshell

# 5. Inside rshell, work with files
$ cd /workspace/projects/myapp
$ npm install
$ npm run build

# 6. In MHNOS, pull back the results
s3pull projects/myapp/
```

### OpenClaw AI Agent

```bash
# 1. Ensure OpenClaw is enabled (in .env: INSTALL_OPENCLAW=true)
# 2. Connect and start OpenClaw
runtime connect ws://my-vps.com:18790
openclaw start

# 3. Attach to interact
openclaw attach

# 4. Files created by OpenClaw are in S3 - pull them
s3pull
```

## SSL/TLS Setup (Production)

For production, use a reverse proxy with SSL:

### Option 1: Nginx + Let's Encrypt

```bash
# Install certbot
sudo apt-get install certbot

# Get certificate
sudo certbot certonly --standalone -d your-domain.com

# Use provided nginx.conf.template and customize
```

### Option 2: Cloudflare Tunnel

```bash
# Install cloudflared
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
sudo mv cloudflared-linux-amd64 /usr/local/bin/cloudflared
sudo chmod +x /usr/local/bin/cloudflared

# Authenticate and create tunnel
cloudflared tunnel login
cloudflared tunnel create mhnos-runtime
```

## Troubleshooting

### Connection Refused

```bash
# Check if containers are running
docker-compose -f docker-compose.remote.yml ps

# Check logs
docker-compose -f docker-compose.remote.yml logs runtime

# Check firewall
sudo ufw status
sudo ufw allow 18790/tcp
sudo ufw allow 9000/tcp
```

### S3 Upload Fails

```bash
# Check MinIO is healthy
curl http://localhost:9000/minio/health/live

# Check credentials in .env
cat .env | grep MINIO

# Restart MinIO
docker-compose -f docker-compose.remote.yml restart minio
```

### Large File Issues

- Files > 5GB: Use multipart upload (not yet implemented)
- Network timeouts: Increase S3_PRESIGN_EXPIRY in .env
- Browser memory: Sync in smaller batches

### Runtime Won't Start

```bash
# Check logs
docker-compose -f docker-compose.remote.yml logs runtime

# Common issues:
# - Port already in use: Change MHNOS_RUNTIME_PORT in .env
# - Permission issues: Check volume permissions
# - Missing dependencies: Rebuild image

# Rebuild and restart
docker-compose -f docker-compose.remote.yml build --no-cache runtime
docker-compose -f docker-compose.remote.yml up -d
```

## Security Considerations

1. **Firewall**: Restrict ports 18790 and 9000 to your IP if possible
2. **Credentials**: Keep .env and .credentials files secure
3. **SSL**: Use HTTPS/WSS in production
4. **Updates**: Regularly update base images

```bash
# Update images
docker-compose -f docker-compose.remote.yml pull
docker-compose -f docker-compose.remote.yml up -d
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VPS_HOST` | required | Your VPS IP or domain |
| `MHNOS_RUNTIME_PORT` | 18790 | WebSocket port |
| `MINIO_ROOT_USER` | mhnosadmin | S3 access key |
| `MINIO_ROOT_PASSWORD` | generated | S3 secret key |
| `INSTALL_OPENCLAW` | true | Enable OpenClaw |
| `MHNOS_SANDBOX` | relaxed | Sandbox mode |
| `MHNOS_MAX_MEMORY` | 4g | Per-process memory limit |
| `S3_PRESIGN_EXPIRY` | 3600 | URL expiry in seconds |

## API Reference

The runtime exposes these WebSocket message types for S3:

### Client → Server

```json
// Get S3 status
{ "type": "s3Status", "id": "req-1" }

// Get upload URL
{ "type": "s3GetUploadUrl", "id": "req-2", "key": "file.txt", "contentType": "text/plain" }

// Get batch upload URLs
{ "type": "s3GetBatchUploadUrls", "id": "req-3", "files": [{"key": "a.txt"}, {"key": "b.txt"}] }

// Get download URL
{ "type": "s3GetDownloadUrl", "id": "req-4", "key": "file.txt" }

// List objects
{ "type": "s3List", "id": "req-5", "prefix": "myproject/", "maxKeys": 100 }

// Delete object
{ "type": "s3Delete", "id": "req-6", "key": "old.txt" }

// Get metadata
{ "type": "s3GetMetadata", "id": "req-7", "key": "file.txt" }
```

### Server → Client

```json
// Upload URL response
{ "type": "s3UploadUrl", "id": "req-2", "status": "success", "url": "https://...", "key": "file.txt" }

// List response
{ "type": "s3List", "id": "req-5", "status": "success", "objects": [{"key": "...", "size": 123}] }
```

## Support

- Issues: Open a GitHub issue
- Logs: `docker-compose -f docker-compose.remote.yml logs -f`
- Health: `curl http://localhost:18790/health`
