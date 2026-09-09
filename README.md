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
nginx/      Reverse proxy config + self-signed cert generator (see below)
.github/    GitHub Actions workflow that builds & publishes to Docker Hub
data/       (created at runtime) SQLite DB + one folder per volume
```

- Each volume is a folder on disk containing its OME-Zarr store and an
  optional mesh file. The database only stores metadata and access grants.
- **Uploads are processed in the background**, not while you wait: the
  upload request returns as soon as the file is saved, with the volume
  marked `processing`. Extraction (or TIFF→OME-Zarr conversion, for TIFF
  stack uploads) then runs server-side; the gallery page polls
  `GET /api/volumes/{id}/status` and shows live progress on that volume's
  row until it flips to `ready` (or `failed`, with the reason shown inline —
  editors can delete a failed upload from its Manage page to retry).
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
- **Requires a browser with WebGPU** (current Chrome/Edge 113+, Safari 26+,
  Firefox 141+) **loaded over a secure origin** (HTTPS, or `http://localhost`)
  to view volumes — see "Putting it behind HTTPS" below, this trips people up
  on a bare LAN IP. Uploading and user management work over plain HTTP in any
  modern browser.
- The viewer's control panel is a custom widget built to match kilnrender.com's
  own demo: a segmented DVR/MIP/ISO/Slice mode switch, an interactive transfer
  function editor (click to add an opacity point, drag to move one,
  double-click to remove one) with 8 color presets, mode-dependent windowing
  controls, per-axis clip range sliders in voxel coordinates, LOD/jitter/TAA/
  indirection toggles, and a live stats readout (fps, dataset dimensions,
  brick/atlas counts, bytes streamed).

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

### Uploading a TIFF stack instead

The uploader can also take a **.zip of a flat TIFF stack** (one .tif/.tiff
file per Z slice) and convert it to OME-Zarr on the server — pick "TIFF
stack" instead of "OME-Zarr" on the upload page. Slice order is taken from
sorting the filenames, so name them so alphabetical order matches
acquisition order (`slice_0001.tif`, `slice_0002.tif`, ...; a plain numeric
`1.tif, 2.tif, ...` sorts wrong once you hit two digits, so zero-pad).
Conversion runs synchronously as part of the upload request and can take a
while for large stacks — the whole stack is decoded into memory at once, so
keep an eye on available RAM for very large scans. Once conversion finishes,
the original TIFF files are deleted; only the resulting OME-Zarr store is
kept on disk.

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

The fast path — one script does the `.env` setup, cert generation, and
`docker compose up` in one go:

```bash
./setup.sh <your-host-ip-or-name>          # e.g. ./setup.sh 192.168.1.50
```

It fills in a generated `VG_SECRET_KEY`, prompts for an admin password (or
generates and prints one if run non-interactively), generates a self-signed
cert for the host/IP you gave it, and starts everything. Safe to re-run — it
never overwrites an existing `.env` or existing certs, only fills in what's
missing. Pass alternate ports as a second/third argument if you want
something other than the 8443/8080 default (see "Putting it behind HTTPS"
below for why those aren't 443/80 by default):

```bash
./setup.sh 192.168.1.50 8443 8080
```

Or do the same steps by hand if you'd rather see each one:

```bash
cp .env.example .env
# edit .env: set VG_SECRET_KEY and VG_ADMIN_PASSWORD
./nginx/generate-self-signed-cert.sh <your-host-ip-or-name>
docker compose up -d --build
```

The app is then at `https://<host>:8443/` (or whatever `VG_HTTPS_PORT` you
set — nginx redirects plain `http://` to `https://` automatically). See
"Putting it behind HTTPS" below for what that cert script does and your
options if you'd rather use a real certificate.

---

## Publishing to Docker Hub

Pulling a prebuilt image instead of building on the NAS itself is the
easiest way to deploy this on TrueNAS — no waiting for `pip install` inside
the Docker build on modest NAS hardware, no source tree needed on the box
beyond `docker-compose.yml` and `nginx/`. Getting an image onto Docker Hub in
the first place needs a Docker Hub account and either GitHub or a machine
with Docker installed — set up one of these two ways once, then every
deployment afterward is just a pull.

**Automatically, on every push (recommended).** This repo includes
`.github/workflows/docker-publish.yml`, which builds and pushes the image on
every push to `main` (tagged `:latest` and `:<short-sha>`) and on version
tags like `v1.2.0` (tagged to match). One-time setup once this is a GitHub
repo of your own:
1. Docker Hub → Account Settings → Personal access tokens → generate one
   (Read & Write is enough).
2. In the GitHub repo: Settings → Secrets and variables → Actions, add
   secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` (the token from step 1).
3. Optionally, in the same place under the **Variables** tab, add
   `DOCKERHUB_IMAGE` = `yourusername/volume-gallery` if you want a repo name
   other than `<your-username>/volume-gallery`.

Push to `main` and check the Actions tab — once it's green, the image is on
Docker Hub.

**Manually, once, from any machine with Docker:**
```bash
docker login
docker build -f backend/Dockerfile -t yourusername/volume-gallery:latest .
docker push yourusername/volume-gallery:latest
```

**Either way, point your deployment at it** by setting in `.env`:
```
VG_IMAGE=yourusername/volume-gallery:latest
```
`docker-compose.yml` uses this if set (`docker compose pull && docker compose
up -d`) and falls back to building locally from source if it's blank
(`docker compose up -d --build`) — `setup.sh` checks `.env` for `VG_IMAGE`
and picks the right one automatically, so on TrueNAS this is just:
```bash
./setup.sh <truenas-ip-or-hostname>
```
after adding `VG_IMAGE=...` to `.env` (do this before running `setup.sh`, or
edit `.env` and re-run it — re-running is safe, see below).

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

### 2. Get the source onto the box, and run the setup script

Easiest via the TrueNAS shell (System Settings → Shell, or SSH in):

```bash
cd /mnt/tank/apps/volume-gallery
git clone <this-repo-url> src
cd src
```

Set `VG_HOST_DATA_DIR` so the app's data lands on the dataset from step 1
instead of a local `./data` folder next to the source, and — if you've
published an image per "Publishing to Docker Hub" above — `VG_IMAGE` so
`setup.sh` pulls it instead of building on the NAS:

```bash
cp .env.example .env
sed -i 's#^VG_HOST_DATA_DIR=.*#VG_HOST_DATA_DIR=/mnt/tank/apps/volume-gallery/data#' .env
sed -i 's#^VG_IMAGE=.*#VG_IMAGE=yourusername/volume-gallery:latest#' .env   # optional — skip to build from source instead
```

Then hand off to the setup script — it takes care of the rest (secret key,
admin password, TLS cert, and starting the containers):

```bash
./setup.sh <truenas-ip-or-hostname>
```

Watch for `Created bootstrap admin user 'admin'.` in the output, or check
`docker compose logs volume-gallery` afterward if you missed it.

### 3. First login and cleanup

- Visit the URL `setup.sh` printed (`https://<host>:8443/` by default), sign
  in with the admin account.
- Go to **Users** and create real accounts (editors, readers) — you can
  disable or delete the bootstrap admin later once you have another admin.
- Have an editor upload the first volume and grant readers access.

### 4. If you'd rather not use docker compose

TrueNAS SCALE's **Apps → Discover Apps → Custom App** UI runs a single
container, which doesn't map cleanly onto this stack (app + nginx +
mounted config/cert files) — `docker compose` (steps above) is the
better-supported path here. If you still want the Apps UI specifically —
e.g. to get this app's status/logs alongside your other Apps in one place —
you can point a Custom App at just the `volume-gallery` image (built via
`docker build -f backend/Dockerfile -t volume-gallery:latest .`) with its
`/data` volume and env vars set as in `.env`, and put your own separately-
managed reverse proxy in front of its exposed port for HTTPS — you'd be
reimplementing what `nginx/nginx.conf` already does, so this is only worth
it if you specifically want everything inside the Apps UI.

### 5. Putting it behind HTTPS (required for the viewer, not just recommended)

**This isn't optional the way it sounds.** WebGPU — which kiln-render needs to
render anything — is only exposed by browsers on a *secure context*:
`https://`, or `http://localhost`. A plain `http://<lan-ip>` origin never
gets `navigator.gpu` at all, in any browser, on any GPU. If you open the app
over plain HTTP, the viewer page will correctly report that WebGPU isn't
available — that's not a bug, it's the browser enforcing this rule. User
management and volume upload work fine over plain HTTP; only the in-browser
volume viewer needs the secure origin.

This repo ships an **nginx** reverse proxy (`nginx/nginx.conf`) already wired
into `docker-compose.yml` for this — it terminates TLS, redirects plain HTTP
to HTTPS, and forwards `X-Forwarded-Proto: https` so the backend's signed
data URLs come back as `https://` (the backend's `uvicorn` already runs with
`--proxy-headers` to trust that). It's also configured with no upload size
cap and long request timeouts, since OME-Zarr/TIFF archives can be large and
TIFF conversion runs synchronously within the upload request. The host ports
it listens on (`VG_HTTP_PORT`/`VG_HTTPS_PORT` in `.env`, default 8080/8443)
and where it looks for the certificate (`VG_CERT_DIR`, default
`./nginx/certs`) are both configurable — the defaults avoid 80/443
specifically because TrueNAS's own web UI commonly already occupies those.

**You still need a certificate** — nginx doesn't mint one for you the way
Caddy does. Two ways to get one:

**A. Self-signed, for LAN/internal use (the common case for a home/lab NAS).**
`./setup.sh <host>` (see "Running with Docker Compose" above) does this for
you as part of setup. To do just this step by hand instead:
```bash
./nginx/generate-self-signed-cert.sh 192.168.1.50   # your TrueNAS IP or hostname
docker compose up -d --build
```
This writes `fullchain.pem`/`privkey.pem` into `VG_CERT_DIR` (default
`nginx/certs/`), which nginx picks up automatically. If your certs already
live somewhere else — e.g. a dedicated TrueNAS certificate dataset — point
`VG_CERT_DIR` in `.env` at that directory instead of copying files into this
repo; `generate-self-signed-cert.sh <host> <dir>` also accepts the directory
as a second argument if you want to generate straight into it. Browsers will
show an untrusted-certificate warning for a self-signed cert — that's
expected; click through it (or import the cert into your OS/browser trust
store to avoid the warning). Either way this satisfies WebGPU's
secure-context check: that check is about the protocol (`https://`), not
certificate trust — those are two separate things browsers verify.

**B. A real certificate** (e.g. from Let's Encrypt, if you have a public
domain pointed at this box, or one issued some other way). Skip the script
and just place your own `fullchain.pem`/`privkey.pem` — same two filenames
nginx is already configured to look for — in `VG_CERT_DIR`.

If you'd rather use Caddy instead (it can mint Let's Encrypt certs
automatically, which is convenient if you do have a public domain), swap the
`nginx` service in `docker-compose.yml` for a Caddy one pointed at
`volume-gallery:8000`, with `tls internal` for the self-signed case:
```
volume-gallery.home.arpa {
    reverse_proxy volume-gallery:8000
    tls internal
}
```

**C. Quick LAN testing without setting up TLS at all.** Chrome and Edge let
you manually mark a specific insecure origin as trusted for local
development: visit `chrome://flags/#unsafely-treat-insecure-origin-as-secure`,
add `http://<truenas-ip>:8000`, and relaunch the browser. This only affects
that one browser profile and is meant for testing — use A or B for anything
other users will rely on. Note this requires temporarily adding back the
`volume-gallery` service's direct port mapping in `docker-compose.yml` (it's
commented out by default now that nginx fronts it).

Beyond WebGPU, HTTPS also matters here because JWTs and the signed file
tokens are passed as plain bearer tokens / URL query params, and you don't
want those on the wire unencrypted outside your LAN.

### Backups

Everything that matters lives under the dataset from step 1: `gallery.db`
(users, volumes, access grants) and `volumes/<slug>/` (the actual data).
Snapshot that dataset on your usual TrueNAS snapshot/replication schedule —
no separate backup step is needed inside the app.

### Updating

If you're pulling a published image (`VG_IMAGE` set in `.env`):
```bash
cd /mnt/tank/apps/volume-gallery/src
docker compose pull
docker compose up -d
```

If you're building from source instead:
```bash
cd /mnt/tank/apps/volume-gallery/src
git pull
docker compose up -d --build
```

`.env` and `nginx/certs/` are untouched by either path — no need to re-run
`setup.sh`. The SQLite schema migrates itself automatically on startup (see
`backend/app/database.py`), so no manual migration step is needed between
updates.
