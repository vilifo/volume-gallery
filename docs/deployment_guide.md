# Deployment Guide

## Putting it behind HTTPS (Required)

**HTTPS is not optional.** WebGPU — which the viewer needs to render anything — is only exposed by browsers on a *secure context* (`https://` or `http://localhost`). If you open the app over plain HTTP, the viewer page will correctly report that WebGPU isn't available.

This repo ships an **nginx** reverse proxy (`nginx/nginx.conf`) wired into `docker-compose.yml`. It terminates TLS, redirects plain HTTP to HTTPS, and handles fast chunk delivery. 

**Getting a Certificate:**
1.  **Self-signed (LAN/internal):** 
    Run `./nginx/generate-self-signed-cert.sh <your-truenas-ip>`. Browsers will show a warning, but it satisfies WebGPU's secure-context check.
2.  **Real Certificate:**
    Place your own `fullchain.pem` and `privkey.pem` in `VG_CERT_DIR` (default `./nginx/certs`).

## Deploying on TrueNAS SCALE

This guide assumes **TrueNAS SCALE** (22.x/24.x "Dragonfish"/"Electric Eel" or newer).

### 1. Create a Dataset
Under Storage → your pool → Add Dataset, create a dataset named `apps/volume-gallery`. Note the path (e.g., `/mnt/tank/apps/volume-gallery`).

### 2. Setup Script
SSH into TrueNAS:
```bash
cd /mnt/tank/apps/volume-gallery
git clone <this-repo-url> src
cd src

cp .env.example .env
sed -i 's#^VG_HOST_DATA_DIR=.*#VG_HOST_DATA_DIR=/mnt/tank/apps/volume-gallery/data#' .env
```
Run the setup script:
```bash
./setup.sh <truenas-ip-or-hostname>
```
*Note: This script generates the self-signed cert, sets up secrets, and starts the containers.*

### 3. First Login
Visit `https://<host>:8443/`, sign in with the admin account, and create real accounts (editors, readers) under the **Users** tab.

## Publishing to Docker Hub

Pulling a prebuilt image is the easiest way to deploy on NAS hardware. 
1. Create a Docker Hub token.
2. In GitHub: Settings → Secrets and variables → Actions, add `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`.
3. Push to the `main` branch to trigger the GitHub Action.

To deploy via Docker Hub, set this in your `.env` before running `setup.sh`:
```env
VG_IMAGE=yourusername/volume-gallery:latest
```

## Backups & Updating

**Backups:** Everything that matters lives under your mapped data dataset (`gallery.db` and the `volumes/` directory). Snapshot that dataset on your usual TrueNAS schedule.

**Updating via Docker Hub:**
```bash
docker compose pull
docker compose up -d
```
**Updating from Source:**
```bash
git pull
docker compose up -d --build
```
The SQLite schema migrates itself automatically on startup.

*For internal configuration details, see the [Architecture Guide](architecture.md).*