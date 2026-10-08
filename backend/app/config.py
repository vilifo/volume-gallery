import os
import tempfile
from pathlib import Path  # noqa: E402


class Settings:
    # --- Security ---
    # Generate a real secret with: python -c "import secrets; print(secrets.token_hex(32))"
    SECRET_KEY: str = os.environ.get("VG_SECRET_KEY", "CHANGE_ME_INSECURE_DEFAULT")
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = int(os.environ.get("VG_ACCESS_TOKEN_MINUTES", "480"))
    # Short-lived token used to authorize a single volume-data / mesh download
    FILE_TOKEN_EXPIRE_MINUTES: int = int(os.environ.get("VG_FILE_TOKEN_MINUTES", "30"))

    # --- Storage ---
    DATA_DIR: Path = Path(os.environ.get("VG_DATA_DIR", "/data"))
    VOLUMES_DIR: Path = DATA_DIR / "volumes"
    MESHES_DIR: Path = DATA_DIR / "meshes"
    POINTCLOUDS_DIR: Path = DATA_DIR / "pointclouds"
    DB_PATH: Path = DATA_DIR / "gallery.db"

    PROCESSING_DIR: Path = Path(os.environ.get("VG_PROCESSING_DIR") or "/processing")  # "" (unset in compose) -> default

    # --- External processing tools ---
    # These binaries are NOT bundled with this app — see README's "Meshes and
    # point clouds" section. Point these at wherever you've placed them
    # (e.g. mounted into /usr/local/bin, or an absolute path) if they're not
    # on PATH under their default names.
    NXSBUILD_BIN: str = os.environ.get("VG_NXSBUILD_BIN", "nxsbuild")
    NXSCOMPRESS_BIN: str = os.environ.get("VG_NXSCOMPRESS_BIN", "nxscompress")
    POTREE_CONVERTER_BIN: str = os.environ.get("VG_POTREE_CONVERTER_BIN", "PotreeConverter") # Must be the full path to the PotreeConverter binary
    if not os.path.exists(POTREE_CONVERTER_BIN):
        POTREE_CONVERTER_BIN = POTREE_CONVERTER_BIN.replace("\\", "/")

    # --- Bootstrap admin (only used on first run, if no users exist) ---
    BOOTSTRAP_ADMIN_USER: str = os.environ.get("VG_ADMIN_USER", "admin")
    BOOTSTRAP_ADMIN_PASSWORD: str = os.environ.get("VG_ADMIN_PASSWORD", "changeme")

    # --- Frontend static files ---
    # In the Docker image this is /frontend (see Dockerfile). For local dev
    # (`uvicorn app.main:app --reload` from backend/), fall back to ../frontend.
    _default_frontend = "/frontend" if Path("/frontend").exists() else str(
        Path(__file__).resolve().parent.parent.parent / "frontend"
    )
    FRONTEND_DIR: str = os.environ.get("VG_FRONTEND_DIR", _default_frontend)

settings = Settings()
settings.VOLUMES_DIR.mkdir(parents=True, exist_ok=True)
settings.MESHES_DIR.mkdir(parents=True, exist_ok=True)
settings.POINTCLOUDS_DIR.mkdir(parents=True, exist_ok=True)

_tmp = settings.PROCESSING_DIR / ".tmp"
_tmp.mkdir(parents=True, exist_ok=True)
tempfile.tempdir = str(_tmp)
os.environ["TMPDIR"] = str(_tmp)