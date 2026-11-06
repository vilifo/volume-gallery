import re
from datetime import datetime, timezone

# Shared by the asset routers (kept out of routers/volumes.py so that the
# volumes and meshes routers can import each other's helpers without a cycle).
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,62}$")


def get_utc_now() -> datetime:
    return datetime.now(timezone.utc)


# A share link that never expires is stored with this expiry (the column is not nullable, and an
# existing database cannot be changed in place). Anything at or after the threshold counts as "never".
NEVER_EXPIRES = datetime(9999, 12, 31, 23, 59, 59, tzinfo=timezone.utc)
NEVER_EXPIRES_THRESHOLD = datetime(9999, 1, 1, tzinfo=timezone.utc)


def _now() -> str:
    return datetime.now(timezone.utc).strftime('%H:%M:%S')
