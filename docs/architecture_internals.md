# Architecture & Internals

## Stack Overview
*   **Backend:** FastAPI app (SQLite for users/volumes/access, JWT auth).
*   **Frontend:** Static HTML/CSS/JS gallery UI + vendored `kiln-render` library.
*   **nginx:** Reverse proxy config + self-signed cert generator.
*   **Workers:** Redis & RQ based job queues for background processing.

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