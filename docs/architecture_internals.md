# Architecture & Internals

## Stack Overview
*   **Backend:** FastAPI app (SQLite for users/volumes/access, JWT auth).
*   **Frontend:** HTML/CSS/JS gallery UI bundled with webpack (see below) + the `kiln-render` library.
*   **nginx:** Reverse proxy config + self-signed cert generator.
*   **Workers:** Redis & RQ based job queues for background processing.

## Frontend build

`frontend/` is built with webpack (`frontend/webpack.config.js`; `npm run build` makes `frontend/dist`, which is what the
backend serves; the Dockerfile does it in its `frontend` stage).

*   Each page (`*.html`, `viewers/*.html`) is a template whose script is `pages/<name>.js` (an entry); the template puts
    in the stylesheet and the small `theme-init` script. Modules import each other with relative paths.
*   Every output file carries a hash of its content (`js/volume.3fa9c0d1b2e4.js`), so there is **no `?v=` cache busting**
    to maintain: a changed file has a new name, an unchanged one keeps its name and stays in the browser's cache. The
    server sends hashed files with `Cache-Control: immutable` and the HTML pages with `no-cache`
    (`FrontendFiles` in `backend/app/main.py`).
*   `kiln-render` is bundled into the volume page. The lazy chunks it loads (Zarr codecs) become files of their own.
*   Not hashed: `js/sw.js` (the service worker keeps its URL), `favicon.ico` and `css/style.css` (asked for by their plain
    names: by the browser on its own, and by the page the server writes for a dead share link; `STATIC_FILES` in the
    webpack config lists such files), and `/vendor` (the prebuilt Potree and 3DHOP libraries the viewer pages load as
    classic scripts; the Docker image adds them).
*   The slice workers (`js/slice/slice-worker.js`) are found by webpack through `new Worker(new URL(...))` in
    `worker-plane-client.js` and built as scripts of their own.
*   Tests: `npm test` (Node's test runner, no browser) in `frontend/`.

## Background Processing & Processing Directory

Uploads are received, unpacked, and converted in a scratch directory (`/processing` in the containers), and only the finished result is written to `/data`.

**Every upload byte is written to disk once.** Nginx authenticates the request before reading the body, writes it directly to the scratch folder, and passes just the filename to the app.

| Asset | Upload | Temp Files / Extraction | Result |
| :--- | :--- | :--- | :--- |
| **Volume** | scratch (`.uploads` → slug) | scratch | written to `/data` |
| **Mesh** | `/data` (`.uploads` → slug) | scratch (`.ply`, `.nxs`) | compressed into `/data` |
| **Point Cloud** | scratch | — | octree exported to `/data` |

*Note: Clean-up happens automatically. Incomplete uploads expire after 24 hours (`VG_UPLOAD_STAGING_MAX_AGE_HOURS`).*

## Job Queue

Conversions (volumes, meshes, point clouds) run in a separate worker container (`volume-gallery-worker`) fed through Redis.
*   Restarting the web app no longer kills a running conversion. 
*   Scale workers with: `docker compose up -d --scale volume-gallery-worker=2`.

## Fast Chunk Delivery

In the Docker Compose setup, `VG_SHARD_ACCEL_REDIRECT=true` is set. The Python backend validates signed URLs and returns an `X-Accel-Redirect` header. NGINX intercepts this and serves the binary chunk files directly using `sendfile` for maximum performance.

## Running as a Non-Root User

The app container runs as root by default. To run as another user (e.g., TrueNAS SCALE `apps` user 568:568), set `VG_UID` and `VG_GID` in `.env`.
*   The app and NGINX worker processes will run as this user.
*   The init container automatically `chown`s your data directories to match these IDs.

*For data formats, see the [Kiln Volume Format Specification](kiln_volume_format.md).*