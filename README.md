# Volume Gallery

A small self-hosted gallery for CT volumes, viewed in-browser with [kiln-render](https://github.com/MPanknin/kiln-render) (WebGPU, kiln sharded binary).

## Features and Roles

Volumes, meshes, and point clouds are managed through a web UI. The gallery can be searched, filtered, sorted, and laid out by folder, flat, or by type. Share links last from 1 hour up to 1 year, or never expire.

Three user roles manage the system:
*   **Admin:** Add/remove/disable users, change roles, make password links for new users and resets.
*   **Editor:** Upload/delete volumes, grant or revoke reader access to them. (Editors can also manage metadata, folders, and thumbnails).
*   **Reader:** View the volumes they've been given access to, download meshes.

## Quickstart (Docker Compose)

```bash
cp .env.example .env
# edit .env: set VG_SECRET_KEY and VG_ADMIN_PASSWORD
./nginx/generate-self-signed-cert.sh <your-host-ip-or-name>
docker compose up -d --build
```
*Note: The app is then available at `https://<host>:8443/`. HTTPS is strictly required for the WebGPU viewer.*

## Quickstart (Local Development)

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export VG_DATA_DIR=../data
export VG_SECRET_KEY=$(python -c "import secrets; print(secrets.token_hex(32))")
export VG_ADMIN_PASSWORD='pick-a-password'  # only used to create the first admin
uvicorn app.main:app --reload --port 8000
```
Then open `http://localhost:8000`, sign in as `admin` with the password you set.

## Documentation

Detailed documentation has been split into the following guides:

*   **[Usage & UI Guide](docs/usage_ui_guide.md)**: Uploading volumes, UI features (bookmarks, animations, slice sweeps), branding, and histograms.
*   **[Deployment Guide](docs/deployment_guide.md)**: TrueNAS SCALE deployment, HTTPS/TLS requirements, Docker Hub publishing, and backups.
*   **[Architecture & Internals](docs/architecture_internals.md)**: Backend/frontend design, job queues (Redis), background processing, and permissions.
*   **[Kiln Volume Format](docs/kiln_volume_format.md)**: Deep dive into the sharded volume format specification.