"""Disk usage of the folders that hold the assets (volumes, meshes, point clouds).

Sizes are what the files occupy on disk (allocated blocks where the file system reports them, else the
file size), next to their plain size. Symbolic links are not followed below the asset's own folder, and a
file with several hard links is counted once. A scan walks the folder, so results are cached for
FILE_META_CACHE_TTL_SECONDS (callers can ask for a fresh one).
"""
import os
import re
import shutil
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, Optional, Tuple

from ..config import settings

_LOD_BIN_RE = re.compile(r"^lod(\d+)\.bin$")
_LOD_INDEX_RE = re.compile(r"^lod\d+_(index|subindex|zindex)\.(npy|json)$")
_VOLUME_META = {"volume.json", "histogram.json", "suggested_window.json", "metadata.json"}

_DTYPE_BYTES = {
    "uint8": 1, "int8": 1, "uint16": 2, "int16": 2, "uint32": 4, "int32": 4, "float32": 4, "float64": 8,
}


@dataclass
class Bucket:
    label: str
    bytes: int = 0            # on disk (allocated)
    apparent: int = 0         # sum of file sizes
    files: int = 0


@dataclass
class Scan:
    buckets: Dict[str, Bucket] = field(default_factory=dict)

    @property
    def bytes(self) -> int:
        return sum(b.bytes for b in self.buckets.values())

    @property
    def apparent(self) -> int:
        return sum(b.apparent for b in self.buckets.values())

    @property
    def files(self) -> int:
        return sum(b.files for b in self.buckets.values())


Classifier = Callable[[str], Tuple[str, str]]  # relative path -> (key, label)


def _one_bucket(_rel: str) -> Tuple[str, str]:
    return "all", "All files"


def scan_dir(root: Path, classify: Classifier = _one_bucket) -> Scan:
    """Walks `root` (a missing folder is empty) and adds up the files per class."""
    scan = Scan()
    seen = set()  # (device, inode) of files with more than one link
    try:
        root = root.resolve()
    except OSError:
        return scan
    stack = [(root, "")]
    while stack:
        folder, prefix = stack.pop()
        try:
            it = os.scandir(folder)
        except OSError:
            continue
        with it:
            for entry in it:
                try:
                    if entry.is_symlink():
                        continue
                    rel = f"{prefix}{entry.name}"
                    if entry.is_dir(follow_symlinks=False):
                        stack.append((Path(entry.path), rel + "/"))
                        continue
                    st = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                if st.st_nlink > 1:
                    ident = (st.st_dev, st.st_ino)
                    if ident in seen:
                        continue
                    seen.add(ident)
                allocated = getattr(st, "st_blocks", None)
                allocated = allocated * 512 if allocated is not None else st.st_size
                key, label = classify(rel)
                b = scan.buckets.setdefault(key, Bucket(label))
                b.bytes += allocated
                b.apparent += st.st_size
                b.files += 1
    return scan


# ------------------------------------------------------------------------------ per asset kind

def kind_dir(asset_type: str) -> Path:
    return {"volume": settings.VOLUMES_DIR, "mesh": settings.MESHES_DIR, "pointcloud": settings.POINTCLOUDS_DIR}[asset_type]


def asset_root(asset_type: str, slug: str) -> Path:
    return kind_dir(asset_type) / slug


def classifier_for(asset_type: str, thumbnail_name: Optional[str] = None) -> Classifier:
    def common(rel: str) -> Optional[Tuple[str, str]]:
        if thumbnail_name and rel == thumbnail_name:
            return "thumbnail", "Thumbnail"
        return None

    if asset_type == "volume":
        def classify(rel: str):
            hit = common(rel)
            if hit:
                return hit
            m = _LOD_BIN_RE.match(rel)
            if m:
                return f"lod{int(m.group(1)):04d}", f"LOD {int(m.group(1))} bricks"
            if _LOD_INDEX_RE.match(rel):
                return "indexes", "Brick indexes"
            if rel in _VOLUME_META:
                return "metadata", "Metadata and histogram"
            return "other", "Other files"
        return classify
    if asset_type == "mesh":
        def classify(rel: str):
            hit = common(rel)
            if hit:
                return hit
            if rel == "mesh.nxz":
                return "nxz", "Compressed mesh (for viewing)"
            if rel.startswith("_upload."):
                return "original", "Original file (for download)"
            return "other", "Other files"
        return classify

    def classify(rel: str):
        hit = common(rel)
        if hit:
            return hit
        if rel in ("octree.bin", "hierarchy.bin"):
            return rel, "Octree data" if rel == "octree.bin" else "Octree hierarchy"
        if rel == "metadata.json":
            return "metadata", "Metadata"
        return "other", "Other files"
    return classify


# ----------------------------------------------------------------------------------------- cache
_CACHE: Dict[Tuple, Tuple[float, Scan]] = {}
_LOCK = threading.Lock()
_MAX_ENTRIES = 4096


def cached_scan(asset_type: str, slug: str, thumbnail_name: Optional[str] = None, refresh: bool = False) -> Scan:
    key = (asset_type, slug, thumbnail_name)
    now = time.monotonic()
    if not refresh:
        with _LOCK:
            hit = _CACHE.get(key)
        if hit and now < hit[0]:
            return hit[1]
    scan = scan_dir(asset_root(asset_type, slug), classifier_for(asset_type, thumbnail_name))
    with _LOCK:
        if len(_CACHE) >= _MAX_ENTRIES:
            _CACHE.clear()
        _CACHE[key] = (now + max(1.0, float(settings.FILE_META_CACHE_TTL_SECONDS)), scan)
    return scan


# ------------------------------------------------------------------------------------ the disk
def disk_usage(path: Path) -> Optional[dict]:
    try:
        u = shutil.disk_usage(path)
    except OSError:
        return None
    return {"total": u.total, "used": u.used, "free": u.free}


def raw_voxel_bytes(volume_json: dict) -> Optional[int]:
    """Size of the full-resolution voxel data without compression, from volume.json (None if unknown)."""
    dims = volume_json.get("originalDimensions")
    per = _DTYPE_BYTES.get(str(volume_json.get("format", "")).lower())
    if not dims or len(dims) != 3 or not per:
        return None
    try:
        return int(dims[0]) * int(dims[1]) * int(dims[2]) * per
    except (TypeError, ValueError):
        return None
