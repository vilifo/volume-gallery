import os
import tempfile
from pathlib import Path  # noqa: E402


class Settings:
    # --- Security ---
    # Generate a real secret with: python -c "import secrets; print(secrets.token_hex(32))"
    # No default: check_secret_key() refuses to start without a real one (see below).
    SECRET_KEY: str = os.environ.get("VG_SECRET_KEY", "")
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = int(os.environ.get("VG_ACCESS_TOKEN_MINUTES", "480"))
    # Short-lived token used to authorize a single volume-data / mesh download
    FILE_TOKEN_EXPIRE_MINUTES: int = int(os.environ.get("VG_FILE_TOKEN_MINUTES", "30"))
    # Shortest password accepted when a password is set or changed
    MIN_PASSWORD_LENGTH: int = int(os.environ.get("VG_MIN_PASSWORD_LENGTH", "8"))

    # --- Share links (/s/<code>) ---
    SHARE_CODE_MIN_LENGTH: int = max(4, int(os.environ.get("VG_SHARE_CODE_MIN_LENGTH", "8")))
    SHARE_CODE_MAX_LENGTH: int = max(8, int(os.environ.get("VG_SHARE_CODE_MAX_LENGTH", "24")))

    # --- Storage ---
    DATA_DIR: Path = Path(os.environ.get("VG_DATA_DIR", "/data"))
    VOLUMES_DIR: Path = DATA_DIR / "volumes"
    MESHES_DIR: Path = DATA_DIR / "meshes"
    POINTCLOUDS_DIR: Path = DATA_DIR / "pointclouds"
    DB_PATH: Path = DATA_DIR / "gallery.db"

    # Offload sharded binary delivery to nginx via X-Accel-Redirect.
    SHARD_ACCEL_REDIRECT: bool = os.environ.get("VG_SHARD_ACCEL_REDIRECT", "").lower() in (
        "1", "true", "yes", "on"
    )
    SHARD_ACCEL_PREFIX: str = os.environ.get("VG_SHARD_ACCEL_PREFIX", "/_internal_volumes")
    FILE_META_CACHE_TTL_SECONDS: int = int(os.environ.get("VG_FILE_META_CACHE_TTL_SECONDS", "60"))

    # Largest accepted thumbnail upload (png / jpeg / webp)
    THUMBNAIL_MAX_MB: int = int(os.environ.get("VG_THUMBNAIL_MAX_MB", "5"))

    # Histograms (transfer function backdrop): threads used for the computation, and whether
    # volumes that lack one get it computed in the background at start-up.
    HISTOGRAM_THREADS: int = int(os.environ.get("VG_HISTOGRAM_THREADS", str(min(4, os.cpu_count() or 2))))
    HISTOGRAM_BACKFILL: bool = os.environ.get("VG_HISTOGRAM_BACKFILL", "1").lower() not in ("0", "false", "no", "off")

    # Folder with branding.toml and the logo files (see branding/branding.toml). The default is
    # <repo>/branding, which is /branding inside the Docker image.
    BRANDING_DIR: Path = Path(os.environ.get("VG_BRANDING_DIR") or Path(__file__).resolve().parents[2] / "branding")

    PROCESSING_DIR: Path = Path(os.environ.get("VG_PROCESSING_DIR") or "/processing")  # "" (unset in compose) -> default

    # Uploads that nginx has already written to disk and handed over by path (see
    # nginx/nginx.conf.template and routers/uploads.py) wait in <processing>/.uploads (volumes, point
    # clouds) or <data>/.uploads (meshes: the original is kept in the data folder) until the create
    # request claims them. Unclaimed ones (abandoned or failed uploads) are deleted after this long.
    UPLOAD_STAGING_MAX_AGE_HOURS: float = float(os.environ.get("VG_UPLOAD_STAGING_MAX_AGE_HOURS", "24"))

    # --- Slice views (server-extracted planes, see helpers/slices.py) ---
    # RAM for decoded 64-plane slabs, shared by every viewer. A slab of a 2000^3
    # 16-bit volume is ~512 MB, so ~4 slabs fit the default; 0 disables caching
    # (every plane is then read straight from the chunks, ~10-50x slower).
    SLICE_CACHE_MB: int = int(os.environ.get("VG_SLICE_CACHE_MB", "2048"))
    # Slabs decoded in parallel from sharded binary bricks
    SLICE_BUILD_THREADS: int = int(os.environ.get("VG_SLICE_BUILD_THREADS", "2"))
    # zstd level for planes sent to browsers that accept it (1 = fastest)
    SLICE_ZSTD_LEVEL: int = int(os.environ.get("VG_SLICE_ZSTD_LEVEL", "1"))

    # --- External processing tools ---
    # These binaries are NOT bundled with this app — see README's "Meshes and
    # point clouds" section. Point these at wherever you've placed them
    # (e.g. mounted into /usr/local/bin, or an absolute path) if they're not
    # on PATH under their default names.
    # Longest a converter (nxsbuild, nxscompress, PotreeConverter) may run on an uploaded file before the
    # job is failed: one that hangs on a broken or hostile file would otherwise hold its worker for ever.
    CONVERTER_TIMEOUT_SECONDS: float = float(os.environ.get("VG_CONVERTER_TIMEOUT_HOURS", "24")) * 3600  # 0 = no limit
    NXSBUILD_BIN: str = os.environ.get("VG_NXSBUILD_BIN", "nxsbuild")
    NXSCOMPRESS_BIN: str = os.environ.get("VG_NXSCOMPRESS_BIN", "nxscompress")
    POTREE_CONVERTER_BIN: str = os.environ.get("VG_POTREE_CONVERTER_BIN", "PotreeConverter") # Must be the full path to the PotreeConverter binary
    if not os.path.exists(POTREE_CONVERTER_BIN):
        POTREE_CONVERTER_BIN = POTREE_CONVERTER_BIN.replace("\\", "/")

    # --- Bootstrap admin (only used on first run, if no users exist) ---
    BOOTSTRAP_ADMIN_USER: str = os.environ.get("VG_ADMIN_USER", "admin")
    BOOTSTRAP_ADMIN_PASSWORD: str = os.environ.get("VG_ADMIN_PASSWORD", "")  # no default password

    # --- Frontend static files ---
    # In the Docker image this is /frontend (see Dockerfile). For local dev
    # (`uvicorn app.main:app --reload` from backend/), fall back to ../frontend.
    _default_frontend = "/frontend" if Path("/frontend").exists() else str(
        Path(__file__).resolve().parent.parent.parent / "frontend"
    )
    FRONTEND_DIR: str = os.environ.get("VG_FRONTEND_DIR", _default_frontend)

settings = Settings()

_MIN_SECRET_KEY_LENGTH = 32
_PLACEHOLDER_SECRETS = {"change_me_insecure_default", "your-secret-key", "dev-secret-change-me", "changeme", "secret"}


def check_secret_key() -> None:
    """Refuses to start with a missing, short or placeholder VG_SECRET_KEY. Every login and
    download token is signed with it: an empty or well-known key lets anyone forge an admin token
    (docker-compose turns an unset variable into an empty string, which the JWT library accepts)."""
    key = settings.SECRET_KEY
    if len(key) < _MIN_SECRET_KEY_LENGTH or key.strip().lower() in _PLACEHOLDER_SECRETS:
        raise RuntimeError(
            f"VG_SECRET_KEY is missing, too short (< {_MIN_SECRET_KEY_LENGTH} characters) or a placeholder. "
            'Generate one with: python -c "import secrets; print(secrets.token_hex(32))" '
            "(changing it signs everyone out)."
        )
settings.VOLUMES_DIR.mkdir(parents=True, exist_ok=True)
settings.MESHES_DIR.mkdir(parents=True, exist_ok=True)
settings.POINTCLOUDS_DIR.mkdir(parents=True, exist_ok=True)

_tmp = settings.PROCESSING_DIR / ".tmp"
_tmp.mkdir(parents=True, exist_ok=True)
(settings.PROCESSING_DIR / ".uploads").mkdir(parents=True, exist_ok=True)
(settings.DATA_DIR / ".uploads").mkdir(parents=True, exist_ok=True)
tempfile.tempdir = str(_tmp)
os.environ["TMPDIR"] = str(_tmp)