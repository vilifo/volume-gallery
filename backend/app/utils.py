import re
from datetime import datetime

# Shared by the asset routers (kept out of routers/volumes.py so that the
# volumes and meshes routers can import each other's helpers without a cycle).
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,62}$")


def _now() -> str:
    return datetime.utcnow().strftime("%H:%M:%S")
