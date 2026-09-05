import os
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
    DB_PATH: Path = DATA_DIR / "gallery.db"

    # --- Bootstrap admin (only used on first run, if no users exist) ---
    BOOTSTRAP_ADMIN_USER: str = os.environ.get("VG_ADMIN_USER", "admin")
    BOOTSTRAP_ADMIN_PASSWORD: str = os.environ.get("VG_ADMIN_PASSWORD", "")

    # --- Frontend static files ---
    # In the Docker image this is /frontend (see Dockerfile). For local dev
    # (`uvicorn app.main:app --reload` from backend/), fall back to ../frontend.
    _default_frontend = "/frontend" if Path("/frontend").exists() else str(
        Path(__file__).resolve().parent.parent.parent / "frontend"
    )
    FRONTEND_DIR: str = os.environ.get("VG_FRONTEND_DIR", _default_frontend)

settings = Settings()
settings.VOLUMES_DIR.mkdir(parents=True, exist_ok=True)
