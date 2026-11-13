from contextlib import asynccontextmanager
import re
import threading
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlmodel import Session, select

from .database import init_db, engine
from .models import User, Role, Volume, Mesh, PointCloud, AssetStatus
from .security import hash_password
from .config import settings, check_secret_key
from . import audit, workdir, jobs
from .utils import _now
from .routers import auth, users, volumes, meshes, pointclouds, branding, shares, uploads, folders, paths, bookmarks, admin


def _bootstrap_admin():
    with Session(engine) as session:
        has_any_user = session.exec(select(User)).first()
        if has_any_user:
            return
        password = settings.BOOTSTRAP_ADMIN_PASSWORD
        if not password:
            print(
                "[volume-gallery] WARNING: no users exist and VG_ADMIN_PASSWORD is not set. "
                "Set it in the environment and restart to create the first admin account."
            )
            return
        admin = User(
            username=settings.BOOTSTRAP_ADMIN_USER,
            password_hash=hash_password(password),
            role=Role.admin,
        )
        session.add(admin)
        session.commit()
        print(f"[volume-gallery] Created bootstrap admin user '{admin.username}'.")


def _recover_interrupted_jobs():
    """Without a job queue, uploads are processed by background tasks inside this process, so a
    restart (routine under Docker: redeploys, `docker compose up --build`,
    host reboots) kills any job in flight. Nothing is processing at startup,
    so mark such assets failed — the gallery would otherwise show them as
    "processing" forever — and clear the scratch space they left behind.

    With a queue (VG_REDIS_URL) the jobs live in the worker and survive a restart of this
    process, so this is the worker's job instead (app/worker.py), and only when it starts.
    `live` are (kind, slug) pairs whose job is still queued/running; they are left alone."""
    live = jobs.live_assets() if jobs.enabled() else set()
    keep = set(live)  # scratch folders still in use: assets waiting for their TIFF slices, or with a live job
    with Session(engine) as session:
        for model, kind, label in (
            (Volume, "volumes", "volume"), (Mesh, "meshes", "mesh"), (PointCloud, "pointclouds", "point cloud"),
        ):
            for asset in session.exec(select(model)).all():
                if asset.status == AssetStatus.processing and (kind, asset.slug) not in live:
                    asset.status = AssetStatus.failed
                    asset.status_log = (asset.status_log or "") + (
                        f"{_now()}  Failed: processing was interrupted by a server restart — "
                        "delete this entry and upload it again\n"
                    )
                    session.add(asset)
                    print(f"[volume-gallery] Marked interrupted {label} '{asset.slug}' as failed.")
                elif asset.status == AssetStatus.uploaded:
                    keep.add((kind, asset.slug))
        session.commit()
    workdir.clear_stale(keep, clear_tmp=not jobs.enabled())  # the web process spools uploads in .tmp
    workdir.sweep_staging()  # staged uploads (see routers/uploads.py) that nobody claimed


@asynccontextmanager
async def lifespan(app: FastAPI):
    check_secret_key()
    init_db()
    with Session(engine) as session:
        audit.prune(session)  # (VG_AUDIT_RETENTION_DAYS; the default keeps everything)
    _bootstrap_admin()
    if not jobs.enabled():  # with a queue the worker does this at its start (app/worker.py)
        _recover_interrupted_jobs()
    else:
        workdir.sweep_staging()
    if settings.HISTOGRAM_BACKFILL:  # not on the startup path: a big volume can take minutes
        threading.Thread(target=volumes.backfill_missing_histograms, name="histogram-backfill", daemon=True).start()
    print(f"[volume-gallery] Processing uploads in {settings.PROCESSING_DIR}; results are stored in {settings.DATA_DIR}.")
    yield


app = FastAPI(title="Volume Gallery", lifespan=lifespan)

app.include_router(branding.router)
app.include_router(auth.router)
app.include_router(users.router)
app.include_router(volumes.router)
app.include_router(meshes.router)
app.include_router(pointclouds.router)
app.include_router(shares.router)
app.include_router(uploads.router)
app.include_router(folders.router)
app.include_router(paths.router)
app.include_router(bookmarks.router)
app.include_router(admin.router)

class FrontendFiles(StaticFiles):
    """The bundled frontend (webpack, see frontend/webpack.config.js). A file whose name carries the hash of its
    content (js/volume.3fa9c0d1b2e4.js, css/style.9bd1e0c4a7f2.css) never changes under that name: browsers may
    keep it for good. The HTML pages are what names those files, so they are revalidated on every visit (an ETag
    makes that a 304 when nothing changed). Anything else (/vendor) keeps StaticFiles' defaults."""

    _HASHED = re.compile(r"\.[0-9a-f]{12}\.(?:js|css)(?:\.map)?$")

    def file_response(self, full_path, *args, **kwargs):
        response = super().file_response(full_path, *args, **kwargs)
        name = Path(full_path).name
        if self._HASHED.search(name):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        elif name.endswith((".html", ".css")):  # (.css: the plain css/style.css that the pages the server writes use)
            response.headers["Cache-Control"] = "no-cache"
        return response


# Serve the frontend (single-page-ish static site) at the root.
@app.get("/js/sw.js", include_in_schema=False)
def service_worker():
    """The brick-cache service worker lives in /js but is registered with scope "/" (it has to
    control the viewer page); browsers refuse that unless the script is served with this header."""
    return FileResponse(
        Path(settings.FRONTEND_DIR) / "js" / "sw.js",
        media_type="text/javascript",
        headers={"Service-Worker-Allowed": "/", "Cache-Control": "no-cache"},
    )


app.mount("/", FrontendFiles(directory=settings.FRONTEND_DIR, html=True), name="frontend")