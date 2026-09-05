# Volume Gallery

A small self-hosted gallery for CT volumes, viewed in-browser with
[kiln-render](https://github.com/MPanknin/kiln-render) (WebGPU, OME-Zarr).
Three roles:

- **admin** — add/remove/disable users, change roles.
- **editor** — upload/delete volumes, grant or revoke reader access to them.
- **reader** — view the volumes they've been given access to, download meshes.

Admins and editors can see and manage every volume; readers only see volumes
an editor has explicitly granted them.

## How it's put together

```
backend/    FastAPI app (SQLite for users/volumes/access, JWT auth)
frontend/   Static HTML/CSS/JS gallery UI + vendored kiln-render library
data/       (created at runtime) SQLite DB + one folder per volume
```

- Each volume is a folder on disk containing its OME-Zarr store and an
  optional mesh file. The database only stores metadata and access grants.
- **kiln-render runs entirely in the browser** and does many small HTTP
  range-reads directly against the zarr store, so it can't send an
  `Authorization` header the way a normal API client would. Instead, when
  you open a volume the backend hands the page a short-lived signed URL
  (`/api/volumes/{id}/zarr-access-url`, default 30 min) that kiln-render
  fetches chunks from directly. Mesh downloads work the same way. Anyone with
  the raw URL can use it until it expires, but they can't get one without
  first authenticating as a user with access to that volume.
- kiln-render is vendored into `frontend/vendor/kiln-render` at build time
  from this repo — no CDN or internet access is needed at runtime, which
  matters for an appliance sitting on a NAS.
- **Requires a browser with WebGPU** (current Chrome or Edge) to view
  volumes; uploading and user management work in any modern browser.

## Preparing volumes to upload

The uploader expects a **.zip** file containing your OME-Zarr store (v0.5,
single-channel, uint8/uint16 — see kiln-render's
[Data Guide](https://kilnrender.com) for conversion tips from raw CT stacks).
Zip the store's directory itself, e.g.:

```bash
cd my-scan.ome.zarr
zip -r ../my-scan.zip .
```

The mesh field accepts any file (STL/OBJ/PLY/...) — it's stored and served
as-is for download, kiln-render never touches it.

## Local development

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export VG_DATA_DIR=../data
export VG_SECRET_KEY=dev-secret-change-me
export VG_ADMIN_PASSWORD=changeme
uvicorn app.main:app --reload --port 8000
```

Then open `http://localhost:8000`, sign in as `admin` / `changeme`.

## Running with Docker Compose

```bash
cp .env.example .env
# edit .env: set VG_SECRET_KEY and VG_ADMIN_PASSWORD
docker compose up -d --build
```

The app is then at `http://<host>:8000`.

---

## Deploying on TrueNAS SCALE

This guide assumes **TrueNAS SCALE** (22.x/24.x "Dragonfish"/"Electric Eel"
or newer), which runs apps as Docker containers under the hood. TrueNAS
**CORE** uses FreeBSD jails instead of Docker and can't run this directly —
if you're on CORE, either run it in a Linux VM (bhyve) with Docker installed,
or migrate the pool to a SCALE system.

### 1. Create a dataset for the app's data

Storage → your pool → **Add Dataset**:
- Name: `apps/volume-gallery` (or similar), under an existing `apps` dataset
  if you use one.
- Leave defaults; volumes can be large, so consider enabling compression
  (`lz4`, usually already the default) and, if you have the space, setting a
  quota.

Note the resulting path, e.g. `/mnt/tank/apps/volume-gallery`.

### 2. Get the source onto the box

Easiest via the TrueNAS shell (System Settings → Shell, or SSH in):

```bash
cd /mnt/tank/apps/volume-gallery
git clone <this-repo-url> src
cd src
cp .env.example .env
```

Edit `.env` (`nano .env` or the file editor of your choice):
- `VG_SECRET_KEY`: generate one with
  `python3 -c "import secrets; print(secrets.token_hex(32))"`
- `VG_ADMIN_PASSWORD`: a real password for the bootstrap admin account
- `VG_HOST_DATA_DIR`: `/mnt/tank/apps/volume-gallery/data`

### 3. Launch it as a Custom App

TrueNAS SCALE's **Apps → Discover Apps → Custom App** UI can run a
`docker-compose.yml`-style spec, but the most direct route for a project
with its own Dockerfile is to build the image once via shell and then
point a Custom App at it:

```bash
cd /mnt/tank/apps/volume-gallery/src
docker build -f backend/Dockerfile -t volume-gallery:latest .
```

Then in the UI: **Apps → Discover Apps → Custom App**:
- **Application Name**: `volume-gallery`
- **Image repository**: `volume-gallery`, **tag**: `latest`
  (Pull policy: "Never" / "IfNotPresent", since it's a local image)
- **Container entrypoint / command**: leave default (uses the Dockerfile's `CMD`)
- **Port Forwarding**: container port `8000` → node port of your choice
  (e.g. `8000`)
- **Storage → Host Path Volumes**: mount `/mnt/tank/apps/volume-gallery/data`
  as the host path, `/data` as the container mount path
- **Environment Variables**: add `VG_SECRET_KEY`, `VG_ADMIN_USER`,
  `VG_ADMIN_PASSWORD` with the values from your `.env`

Save and start the app. Watch its logs (Apps → volume-gallery → Logs) for
`Created bootstrap admin user 'admin'.`

Alternatively, if you'd rather manage it with plain `docker compose` instead
of the Apps UI (SCALE ships Docker, so this works fine from the shell too):

```bash
docker compose up -d --build
```

### 4. First login and cleanup

- Visit `http://<truenas-ip>:8000`, sign in with the admin account.
- Go to **Users** and create real accounts (editors, readers) — you can
  disable or delete the bootstrap admin later once you have another admin.
- Have an editor upload the first volume and grant readers access.

### 5. Putting it behind HTTPS (recommended)

The app itself serves plain HTTP. If TrueNAS SCALE isn't already fronted by
a reverse proxy, put one in front of it (Traefik, Nginx Proxy Manager, or
Caddy — all installable the same way as a Custom App) and terminate TLS
there. This matters here specifically because JWTs and the signed file
tokens are passed as plain bearer tokens / URL query params, and you don't
want those on the wire unencrypted outside your LAN.

### Backups

Everything that matters lives under the dataset from step 1: `gallery.db`
(users, volumes, access grants) and `volumes/<slug>/` (the actual data).
Snapshot that dataset on your usual TrueNAS snapshot/replication schedule —
no separate backup step is needed inside the app.

### Updating

```bash
cd /mnt/tank/apps/volume-gallery/src
git pull
docker build -f backend/Dockerfile -t volume-gallery:latest .
```

Then restart the app from the Apps UI (or `docker compose up -d --build`
if you went the compose route). The SQLite schema is additive-only in this
version, so no migration step is required between minor updates.
