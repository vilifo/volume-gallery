from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from sqlmodel import Session, select

from .database import init_db, engine
from .models import User, Role
from .security import hash_password
from .config import settings
from .routers import auth, users, volumes


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


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    _bootstrap_admin()
    yield


app = FastAPI(title="Volume Gallery", lifespan=lifespan)

app.include_router(auth.router)
app.include_router(users.router)
app.include_router(volumes.router)

# Serve the frontend (single-page-ish static site) at the root.
app.mount("/", StaticFiles(directory=settings.FRONTEND_DIR, html=True), name="frontend")
