from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from sqlmodel import Session, select

from .database import init_db, engine
from .models import User, Role, Volume, Mesh, PointCloud, AssetStatus
from .security import hash_password
from .config import settings
from . import workdir
from .utils import _now
from .routers import auth, users, volumes, meshes, pointclouds


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
    """Uploads are processed by background tasks inside this process, so a
    restart (routine under Docker: redeploys, `docker compose up --build`,
    host reboots) kills any job in flight. Nothing is processing at startup,
    so mark such assets failed — the gallery would otherwise show them as
    "processing" forever — and clear the scratch space they left behind."""
    keep = set()  # scratch folders still in use: assets waiting for their TIFF slices
    with Session(engine) as session:
        for model, kind, label in (
            (Volume, "volumes", "volume"), (Mesh, "meshes", "mesh"), (PointCloud, "pointclouds", "point cloud"),
        ):
            for asset in session.exec(select(model)).all():
                if asset.status == AssetStatus.processing:
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
    workdir.clear_stale(keep)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    _bootstrap_admin()
    _recover_interrupted_jobs()
    print(f"[volume-gallery] Processing uploads in {settings.PROCESSING_DIR}; results are stored in {settings.DATA_DIR}.")
    yield


app = FastAPI(title="Volume Gallery", lifespan=lifespan)

app.include_router(auth.router)
app.include_router(users.router)
app.include_router(volumes.router)
app.include_router(meshes.router)
app.include_router(pointclouds.router)

# Serve the frontend (single-page-ish static site) at the root.
app.mount("/", StaticFiles(directory=settings.FRONTEND_DIR, html=True), name="frontend")