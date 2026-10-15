"""Plane extraction for the slice views (XY / XZ / YZ planes).

A plane is named by the two physical axes it spans and indexed along the third:
"xy" at index z, "xz" at index y, "yz" at index x.

Why the server does this
------------------------
Volumes are stored as OME-Zarr with cubic 64^3 chunks. Showing ONE plane of a
chunked 3D array needs every chunk the plane crosses (for a 2000^3 volume:
32 x 32 = 1024 chunks), whichever axis is chosen. Done in the browser that is
1024 HTTP requests plus 1024 decodes per plane, and ~0.5 GB per 64-plane slab.
Done here the chunks are read from local disk, and only the finished plane
(a few MB, zstd-compressed) crosses the network.

How it stays fast while scrolling
---------------------------------
A "slab" is the chunk-thick layer of the volume that contains a plane: decoding
it once yields all 64 neighbouring planes. Decoded slabs are kept in a
byte-budgeted LRU cache (``VG_SLICE_CACHE_MB``), shared by every viewer of the
volume, so scrolling inside a slab costs a memory copy plus compression. Slab
builds are single-flight: concurrent requests for the same slab wait for one
decode. Planes too large for the budget are read directly (slower, but exact).
"""
from __future__ import annotations

import threading
import time
from collections import OrderedDict
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Dict, Optional, Tuple

import numpy as np
import zarr

from ..config import settings
from .volume import get_multiscales

AXIS_NORMAL = {"xy": "z", "xz": "y", "yz": "x"}
AXES = tuple(AXIS_NORMAL)

# dtype name -> (little-endian numpy dtype sent to the browser, display range)
_NATIVE = {
    "uint8": (np.dtype("u1"), (0.0, 255.0)),
    "int8": (np.dtype("i1"), (-128.0, 127.0)),
    "uint16": (np.dtype("<u2"), (0.0, 65535.0)),
    "int16": (np.dtype("<i2"), (-32768.0, 32767.0)),
    "float32": (np.dtype("<f4"), (0.0, 1.0)),
}


class SliceError(Exception):
    """Bad request or unsupported store (the router maps this to HTTP 400/404)."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


# --------------------------------------------------------------------------- cache


class SlabCache:
    """Byte-budgeted LRU of decoded slabs with single-flight background builds."""

    def __init__(self, max_bytes: int, workers: int = 2):
        self.max_bytes = max_bytes
        self._lock = threading.Lock()
        self._slabs: "OrderedDict[tuple, np.ndarray]" = OrderedDict()
        self._building: Dict[tuple, Future] = {}
        self._bytes = 0
        self._reserved = 0
        self._pool = ThreadPoolExecutor(max_workers=max(1, workers), thread_name_prefix="slab")
        self.hits = 0
        self.misses = 0
        self.evictions = 0

    @property
    def used_bytes(self) -> int:
        return self._bytes

    def get(self, key: tuple) -> Optional[np.ndarray]:
        with self._lock:
            slab = self._slabs.get(key)
            if slab is not None:
                self._slabs.move_to_end(key)
                self.hits += 1
            return slab

    def fits(self, nbytes: int) -> bool:
        """Whether a slab of this size may be cached at all (never evict everything for one slab)."""
        return self.max_bytes > 0 and nbytes <= self.max_bytes * 0.75

    def get_or_build(self, key: tuple, nbytes: int, build) -> np.ndarray:
        """Returns the slab, building it (once, even under concurrency) if needed."""
        with self._lock:
            slab = self._slabs.get(key)
            if slab is not None:
                self._slabs.move_to_end(key)
                self.hits += 1
                return slab
            fut = self._building.get(key)
            if fut is None:
                self.misses += 1
                self._make_room(nbytes)
                self._reserved += nbytes
                fut = self._pool.submit(self._run, key, nbytes, build)
                self._building[key] = fut
        return fut.result()

    def _run(self, key: tuple, nbytes: int, build) -> np.ndarray:
        try:
            slab = build()
            with self._lock:
                self._slabs[key] = slab
                self._bytes += slab.nbytes
            return slab
        finally:
            with self._lock:
                self._reserved -= nbytes
                self._building.pop(key, None)

    def _make_room(self, nbytes: int) -> None:
        # caller holds the lock
        while self._slabs and self._bytes + self._reserved + nbytes > self.max_bytes:
            _, old = self._slabs.popitem(last=False)
            self._bytes -= old.nbytes
            self.evictions += 1

    def stats(self) -> dict:
        with self._lock:
            return {
                "slabs": len(self._slabs),
                "usedMB": round(self._bytes / 1e6, 1),
                "budgetMB": round(self.max_bytes / 1e6, 1),
                "hits": self.hits,
                "misses": self.misses,
                "evictions": self.evictions,
            }


_cache: Optional[SlabCache] = None
_cache_lock = threading.Lock()


def slab_cache() -> SlabCache:
    global _cache
    with _cache_lock:
        if _cache is None:
            _cache = SlabCache(settings.SLICE_CACHE_MB * 1_000_000, settings.SLICE_BUILD_THREADS)
        return _cache


# ----------------------------------------------------------------------- the store


class VolumeSlices:
    """Read access to the planes of one OME-Zarr volume (one resolution level)."""

    def __init__(self, zarr_root: Path, level: int = 0, cache: Optional[SlabCache] = None):
        self.root = Path(zarr_root)
        self.level = level
        self._cache = cache
        try:
            group = zarr.open_group(str(self.root), mode="r")
        except Exception as exc:  # missing / unreadable store
            raise SliceError(f"Cannot open the volume's zarr store: {exc}", 404) from exc
        attrs = dict(group.attrs)
        multiscales = get_multiscales(attrs)
        if not multiscales:
            raise SliceError("No OME-NGFF multiscales metadata found")
        ms = multiscales[0]
        datasets = ms.get("datasets") or []
        if not 0 <= level < len(datasets):
            raise SliceError(f"Level {level} does not exist (volume has {len(datasets)} levels)")
        self.level_count = len(datasets)
        ds = datasets[level]
        self.arr = group[ds["path"]]

        names = [(a["name"] if isinstance(a, dict) else str(a)).lower() for a in ms.get("axes", [])]
        if not names:
            names = ["t", "c", "z", "y", "x"][-self.arr.ndim:]
        for needed in ("z", "y", "x"):
            if needed not in names:
                raise SliceError(f"Array has no '{needed}' axis")
        self.names = names
        self._idx = {n: names.index(n) for n in names}

        shape = self.arr.shape
        self.dims = {a: int(shape[self._idx[a]]) for a in "xyz"}
        self.chunk = {a: int(min(self.arr.chunks[self._idx[a]], self.dims[a])) for a in "xyz"}
        self.channels = int(shape[self._idx["c"]]) if "c" in self._idx else 1

        src = np.dtype(self.arr.dtype)
        if src.name in _NATIVE:
            self.dtype = src.name
        elif src.kind in "iuf":
            self.dtype = "float32"  # wider types are sent as float32
        else:
            raise SliceError(f"Unsupported data type {src}")
        self.source_dtype = src.name

        self.spacing = {"x": 1.0, "y": 1.0, "z": 1.0}
        for t in ds.get("coordinateTransformations", []):
            if t.get("type") == "scale" and len(t.get("scale", [])) == len(names):
                for a in "xyz":
                    self.spacing[a] = float(t["scale"][self._idx[a]] or 1.0)
        unit = next((a.get("unit") for a in ms.get("axes", []) if isinstance(a, dict) and a.get("name", "").lower() == "x"), None)
        self.unit = unit

        ome = attrs.get("ome") if isinstance(attrs.get("ome"), dict) else attrs
        omero = ome.get("omero") or attrs.get("omero") or {}
        win = (omero.get("channels") or [{}])[0].get("window") or {}
        start, end = win.get("start"), win.get("end")
        self._omero_window = (float(start), float(end)) if start is not None and end is not None and end > start else None
        self._window: Optional[dict] = None
        self._window_lock = threading.Lock()

        meta_file = self.root / ("zarr.json" if (self.root / "zarr.json").exists() else ".zattrs")
        self.stamp = meta_file.stat().st_mtime_ns if meta_file.exists() else 0

    # ------------------------------------------------------------------ metadata

    def info(self) -> dict:
        lo, hi = _NATIVE.get(self.dtype, (None, (0.0, 1.0)))[1]
        return {
            "level": self.level,
            "levelCount": self.level_count,
            "dims": self.dims,
            "chunk": self.chunk,
            "spacing": self.spacing,
            "unit": self.unit,
            "dtype": self.dtype,
            "sourceDtype": self.source_dtype,
            "channels": self.channels,
            "range": [lo, hi],
            "window": self.suggested_window(),
        }

    def suggested_window(self) -> dict:
        """OME `omero` window if present, else robust percentiles of the middle xy plane."""
        with self._window_lock:
            if self._window is None:
                if self._omero_window:
                    start, end = self._omero_window
                    self._window = {"center": (start + end) / 2, "width": end - start, "source": "omero"}
                else:
                    plane = self._read_direct("xy", self.dims["z"] // 2, 0)
                    self._window = {**percentile_window(plane), "source": "auto"}
            return self._window

    # --------------------------------------------------------------------- reads

    def _selector(self, sel: dict, channel: int) -> tuple:
        out = []
        for n in self.names:
            if n in sel:
                out.append(sel[n])
            elif n == "c":
                out.append(channel)
            else:
                out.append(0)
        return tuple(out)

    def _read_direct(self, axis: str, index: int, channel: int) -> np.ndarray:
        sel = {"z": slice(None), "y": slice(None), "x": slice(None)}
        sel[AXIS_NORMAL[axis]] = index
        return np.asarray(self.arr[self._selector(sel, channel)])

    def _read_slab(self, axis: str, k: int, channel: int) -> np.ndarray:
        n = AXIS_NORMAL[axis]
        sel = {"z": slice(None), "y": slice(None), "x": slice(None)}
        sel[n] = slice(k * self.chunk[n], min((k + 1) * self.chunk[n], self.dims[n]))
        return np.asarray(self.arr[self._selector(sel, channel)])  # (z, y, x) order, thin along n

    @staticmethod
    def _plane_from_slab(slab: np.ndarray, axis: str, local: int) -> np.ndarray:
        if axis == "xy":
            return slab[local]
        if axis == "xz":
            return slab[:, local, :]
        return slab[:, :, local]

    def get_plane(self, axis: str, index: int, channel: int = 0) -> Tuple[np.ndarray, str]:
        """The plane as a 2D array (rows = v, columns = u) and where it came from.

        xy: (y, x); xz: (z, x); yz: (z, y).
        """
        if axis not in AXIS_NORMAL:
            raise SliceError(f"axis must be one of {', '.join(AXES)}")
        n = AXIS_NORMAL[axis]
        if not 0 <= index < self.dims[n]:
            raise SliceError(f"{axis} index must be in 0..{self.dims[n] - 1}")
        if not 0 <= channel < self.channels:
            raise SliceError(f"channel must be in 0..{self.channels - 1}")

        cache = self._cache if self._cache is not None else slab_cache()
        k = index // self.chunk[n]
        thickness = min(self.chunk[n], self.dims[n] - k * self.chunk[n])
        slab_bytes = (
            self.dims["x"] * self.dims["y"] * self.dims["z"] // self.dims[n] * thickness * self.arr.dtype.itemsize
        )
        if cache.fits(slab_bytes):
            key = (str(self.root), self.stamp, self.level, channel, axis, k)
            slab = cache.get_or_build(key, slab_bytes, lambda: self._read_slab(axis, k, channel))
            return self._plane_from_slab(slab, axis, index - k * self.chunk[n]), "slab"
        return self._read_direct(axis, index, channel), "direct"


def percentile_window(plane: np.ndarray, lo: float = 1.0, hi: float = 99.0) -> dict:
    sample = np.asarray(plane).ravel()
    if sample.size > 400_000:
        sample = sample[:: sample.size // 400_000 + 1]
    a, b = np.percentile(sample.astype(np.float64), [lo, hi])
    width = max(float(b - a), 1e-6)
    return {"center": float(a) + width / 2, "width": width}


# ------------------------------------------------------------------- the registry

_registry: "OrderedDict[tuple, VolumeSlices]" = OrderedDict()
_registry_lock = threading.Lock()
_REGISTRY_SIZE = 16


def open_volume_slices(zarr_root: Path, level: int = 0) -> VolumeSlices:
    """Cached VolumeSlices for a store (a replaced store gets a new entry via its mtime)."""
    root = Path(zarr_root)
    meta = root / ("zarr.json" if (root / "zarr.json").exists() else ".zattrs")
    stamp = meta.stat().st_mtime_ns if meta.exists() else 0
    key = (str(root), stamp, level)
    with _registry_lock:
        vs = _registry.get(key)
        if vs is not None:
            _registry.move_to_end(key)
            return vs
    vs = VolumeSlices(root, level)  # may raise; built outside the lock
    with _registry_lock:
        _registry[key] = vs
        while len(_registry) > _REGISTRY_SIZE:
            _registry.popitem(last=False)
    return vs


# ------------------------------------------------------------------- transport


def to_transport(plane: np.ndarray, dtype: str, stride: int = 1) -> np.ndarray:
    """C-contiguous little-endian plane in the dtype announced by /info."""
    if stride > 1:
        plane = plane[::stride, ::stride]
    return np.ascontiguousarray(plane, dtype=_NATIVE.get(dtype, (np.dtype("<f4"),))[0])


def encode_plane(plane: np.ndarray, accept_encoding: str = "", zstd_level: int = 1) -> Tuple[bytes, Optional[str]]:
    """Plane bytes for the wire. Uses zstd when the client accepts it (every current
    Chromium / Firefox decodes it transparently inside fetch), otherwise raw."""
    if "zstd" in (accept_encoding or "").lower():
        import zstandard

        return zstandard.ZstdCompressor(level=zstd_level).compress(plane), "zstd"
    return plane.tobytes(), None


def plane_response_parts(
    vs: VolumeSlices,
    axis: str,
    index: int,
    channel: int = 0,
    stride: int = 1,
    accept_encoding: str = "",
) -> Tuple[bytes, dict]:
    """Everything the HTTP layer needs: (body, headers). Kept free of FastAPI for testing."""
    if stride not in (1, 2, 4, 8):
        raise SliceError("stride must be 1, 2, 4 or 8")
    t0 = time.perf_counter()
    plane, source = vs.get_plane(axis, index, channel)
    out = to_transport(plane, vs.dtype, stride)
    body, encoding = encode_plane(out, accept_encoding, settings.SLICE_ZSTD_LEVEL)
    headers = {
        "X-Plane-Width": str(out.shape[1]),
        "X-Plane-Height": str(out.shape[0]),
        "X-Plane-Dtype": vs.dtype,
        "X-Plane-Stride": str(stride),
        "X-Plane-Source": source,
        "X-Plane-Raw-Bytes": str(out.nbytes),
        "X-Plane-Server-Ms": f"{(time.perf_counter() - t0) * 1000:.1f}",
        "Vary": "Accept-Encoding",
    }
    if encoding:
        headers["Content-Encoding"] = encoding
    return body, headers
