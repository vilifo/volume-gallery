"""Plane extraction for the slice views (XY / XZ / YZ planes).

A plane is named by the two physical axes it spans and indexed along the third:
"xy" at index z, "xz" at index y, "yz" at index x.

Why the server does this
------------------------
Volumes are stored as kiln sharded binary with cubic 64^3 bricks. Showing ONE plane of a
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
import gzip
import json
import os
import numpy as np
import zlib

from ..config import settings

# Use Intel ISA-L SIMD decompression if installed (4x-6x faster than stdlib zlib)
try:
    from isal import igzip as _fast_gzip
    from isal import isal_zlib as _fast_zlib
except ImportError:
    _fast_gzip = None
    _fast_zlib = zlib

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
INDEX_DTYPE = np.dtype([
    ("offset", "<u8"),
    ("size", "<u4"),
    ("min", "<f4"),
    ("max", "<f4"),
    ("avg", "<f4"),
])
# Shared thread pool for GIL-releasing pread + decompression
_IO_POOL = ThreadPoolExecutor(max_workers=min(16, (os.cpu_count() or 4) * 2))


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
def _decompress_gzip(data: bytes | memoryview) -> bytes:
    if _fast_gzip is not None:
        return _fast_gzip.decompress(data)
    return zlib.decompress(data, 16 + zlib.MAX_WBITS)


def _decompress_raw_deflate(data: bytes | memoryview) -> bytes:
    return _fast_zlib.decompress(data, -zlib.MAX_WBITS)


class VolumeSlicesKiln_old:
    """Read access to the planes of one binary-sharded volume (one resolution level)."""

    def __init__(self, dataset_root: Path, level: int = 0, cache: Optional[SlabCache] = None):
        self.root = Path(dataset_root).resolve()
        self.level = level
        self._cache = cache
        self.dtype = np.uint16

        vol_json_path = self.root / "volume.json"
        if not vol_json_path.exists():
            raise SliceError(f"Cannot open volume metadata: {vol_json_path} not found", 404)

        try:
            with open(vol_json_path, "r", encoding="utf-8") as f:
                vol_meta = json.load(f)
        except Exception as exc:
            raise SliceError(f"Cannot read volume.json: {exc}", 404) from exc

        levels = vol_meta.get("levels") or []
        if not 0 <= level < len(levels):
            raise SliceError(f"Level {level} does not exist (volume has {len(levels)} levels)")
        self.level_count = len(levels)

        lvl_meta = next((l for l in levels if l.get("lod") == level), levels[level])

        self.brick_size = int(vol_meta.get("brickSize", 64))
        self.physical_size = int(vol_meta.get("physicalSize", self.brick_size + 2))

        # Dimensions in volume.json are [W, H, D] -> [x, y, z]
        w, h, d = lvl_meta["dimensions"]
        self.dims = {"x": int(w), "y": int(h), "z": int(d)}
        self.chunk = {a: int(min(self.brick_size, self.dims[a])) for a in "xyz"}

        bx, by, bz = lvl_meta["bricks"]
        self.bricks = {"x": int(bx), "y": int(by), "z": int(bz)}
        self.channels = 1  # Sharded format is single-channel scalar volume

        fmt = vol_meta.get("format", "uint8")
        src = np.dtype(fmt)
        if src.name in _NATIVE:
            self.dtype = src.name
        elif src.kind in "iuf":
            self.dtype = "float32"
        else:
            raise SliceError(f"Unsupported data type {src}")
        self.source_dtype = src.name
        self._np_dtype = src

        # Scale base voxelSpacing [sx, sy, sz] by 2^level for downsampled LODs
        base_spacing = vol_meta.get("voxelSpacing") or [1.0, 1.0, 1.0]
        scale_factor = float(1 << level)
        self.spacing = {
            "x": float(base_spacing[0] or 1.0) * scale_factor,
            "y": float(base_spacing[1] or 1.0) * scale_factor,
            "z": float(base_spacing[2] or 1.0) * scale_factor,
        }
        self.unit = vol_meta.get("unit", None)
        levels = vol_meta.get("levels") or []
        if level < 0 or level >= len(levels):
            raise SliceError(f"Invalid level {level}", 404)

        # Load brick index (lodN_index.json) and verify shard binary (lodN.bin)
        index_name = lvl_meta.get("indexFile", f"lod{level}_index.json")
        # index_file = self.root / lvl_meta.get("indexFile", f"lod{level}_index.json")
        bin_name = lvl_meta.get("binFile", f"lod{level}.bin")
        index_file = (self.root / index_name).resolve()
        self.bin_file = (self.root / bin_name).resolve()
        if self.root not in index_file.parents or self.root not in self.bin_file.parents:
            raise SliceError("Invalid shard file path", 404)
        try:
            index_file.relative_to(self.root)
            self.bin_file.relative_to(self.root)
        except ValueError:
            raise SliceError(f"Invalid shard paths for level {level}", 404)

        if not index_file.exists() or not self.bin_file.exists():
            raise SliceError(f"Missing shard binary or index file for level {level}", 404)

        try:
            with open(index_file, "r", encoding="utf-8") as f:
                idx_meta = json.load(f)
        except Exception as exc:
            raise SliceError(f"Cannot read {index_file.name}: {exc}", 404) from exc

        self._compressed = bool(idx_meta.get("compressed", vol_meta.get("compressed", True)))
        self._entries: dict = idx_meta.get("entries") or {}

        self._omero_window = None
        self._window: Optional[dict] = None
        self._window_lock = threading.Lock()

        self.stamp = vol_json_path.stat().st_mtime_ns

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
        """Robust percentiles of the middle xy plane."""
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

    def _read_brick_core(self, fd: int, bx: int, by: int, bz: int) -> Optional[np.ndarray]:
        """Read a single physical brick (66^3) from lodN.bin and return its logical core (64^3) in (z, y, x) order."""
        entry = self._entries.get(f"{bx}/{by}/{bz}")
        if not entry:
            return None

        raw_bytes = os.pread(fd, int(entry["size"]), int(entry["offset"]))
        if self._compressed:
            raw_bytes = gzip.decompress(raw_bytes)

        p = self.physical_size
        # Bricks are stored in x-fastest, y-middle, z-slowest order -> shape (z, y, x) in C order
        brick = np.frombuffer(raw_bytes, dtype=self._np_dtype).reshape((p, p, p))
        # Strip the 1-voxel border on all sides to get the logical 64^3 core
        return brick[1:-1, 1:-1, 1:-1]

    def _read_slab(self, axis: str, k: int, channel: int) -> np.ndarray:
        """Assemble a full brick-thick 3D slab in (z, y, x) order along normal axis `n`."""
        n = AXIS_NORMAL[axis]
        bs = self.brick_size
        start_n = k * bs
        end_n = min((k + 1) * bs, self.dims[n])
        thickness = end_n - start_n

        slab_shape = {
            "z": thickness if n == "z" else self.dims["z"],
            "y": thickness if n == "y" else self.dims["y"],
            "x": thickness if n == "x" else self.dims["x"],
        }
        slab = np.zeros((slab_shape["z"], slab_shape["y"], slab_shape["x"]), dtype=self._np_dtype)

        bz_range = [k] if n == "z" else range(self.bricks["z"])
        by_range = [k] if n == "y" else range(self.bricks["y"])
        bx_range = [k] if n == "x" else range(self.bricks["x"])

        fd = os.open(self.bin_file, os.O_RDONLY)
        try:
            for bz in bz_range:
                z0 = 0 if n == "z" else bz * bs
                dz = thickness if n == "z" else min(bs, self.dims["z"] - z0)
                for by in by_range:
                    y0 = 0 if n == "y" else by * bs
                    dy = thickness if n == "y" else min(bs, self.dims["y"] - y0)
                    for bx in bx_range:
                        x0 = 0 if n == "x" else bx * bs
                        dx = thickness if n == "x" else min(bs, self.dims["x"] - x0)

                        core = self._read_brick_core(fd, bx, by, bz)
                        if core is not None:
                            slab[z0: z0 + dz, y0: y0 + dy, x0: x0 + dx] = core[:dz, :dy, :dx]
        finally:
            os.close(fd)

        if self.dtype != self.source_dtype:
            slab = slab.astype(self.dtype, copy=False)
        return slab

    def _read_direct(self, axis: str, index: int, channel: int) -> np.ndarray:
        """Read a single 2D plane directly without allocating the full 64-slice slab in RAM."""
        n = AXIS_NORMAL[axis]
        bs = self.brick_size
        k = index // bs
        local = index - k * bs

        if axis == "xy":  # (y, x) at fixed z = index
            plane = np.zeros((self.dims["y"], self.dims["x"]), dtype=self._np_dtype)
            fd = os.open(self.bin_file, os.O_RDONLY)
            try:
                for by in range(self.bricks["y"]):
                    y0 = by * bs
                    dy = min(bs, self.dims["y"] - y0)
                    for bx in range(self.bricks["x"]):
                        x0 = bx * bs
                        dx = min(bs, self.dims["x"] - x0)
                        core = self._read_brick_core(fd, bx, by, k)
                        if core is not None:
                            plane[y0: y0 + dy, x0: x0 + dx] = core[local, :dy, :dx]
            finally:
                os.close(fd)

        elif axis == "xz":  # (z, x) at fixed y = index
            plane = np.zeros((self.dims["z"], self.dims["x"]), dtype=self._np_dtype)
            fd = os.open(self.bin_file, os.O_RDONLY)
            try:
                for bz in range(self.bricks["z"]):
                    z0 = bz * bs
                    dz = min(bs, self.dims["z"] - z0)
                    for bx in range(self.bricks["x"]):
                        x0 = bx * bs
                        dx = min(bs, self.dims["x"] - x0)
                        core = self._read_brick_core(fd, bx, k, bz)
                        if core is not None:
                            plane[z0: z0 + dz, x0: x0 + dx] = core[:dz, local, :dx]
            finally:
                os.close(fd)

        else:  # "yz" -> (z, y) at fixed x = index
            plane = np.zeros((self.dims["z"], self.dims["y"]), dtype=self._np_dtype)
            fd = os.open(self.bin_file, os.O_RDONLY)
            try:
                for bz in range(self.bricks["z"]):
                    z0 = bz * bs
                    dz = min(bs, self.dims["z"] - z0)
                    for by in range(self.bricks["y"]):
                        y0 = by * bs
                        dy = min(bs, self.dims["y"] - y0)
                        core = self._read_brick_core(fd, k, by, bz)
                        if core is not None:
                            plane[z0: z0 + dz, y0: y0 + dy] = core[:dz, :dy, local]
            finally:
                os.close(fd)

        if self.dtype != self.source_dtype:
            plane = plane.astype(self.dtype, copy=False)
        return plane

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
                self.dims["x"]
                * self.dims["y"]
                * self.dims["z"]
                // self.dims[n]
                * thickness
                * self._np_dtype.itemsize
        )
        if cache.fits(slab_bytes):
            key = (str(self.root), self.stamp, self.level, channel, axis, k)
            slab = cache.get_or_build(key, slab_bytes, lambda: self._read_slab(axis, k, channel))
            return self._plane_from_slab(slab, axis, index - k * self.chunk[n]), "slab"
        return self._read_direct(axis, index, channel), "direct"


class VolumeSlicesKiln:
    """Read access to the planes of one binary-sharded volume (one resolution level)."""

    def __init__(self, dataset_root: Path, level: int = 0, cache: Optional[SlabCache] = None):
        self.root = Path(dataset_root)
        self.level = level
        self._cache = cache
        self.dtype = np.uint16

        vol_json_path = self.root / "volume.json"
        if not vol_json_path.exists():
            raise SliceError(f"Cannot open volume metadata: {vol_json_path} not found", 404)

        try:
            with open(vol_json_path, "r", encoding="utf-8") as f:
                vol_meta = json.load(f)
        except Exception as exc:
            raise SliceError(f"Cannot read volume.json: {exc}", 404) from exc

        levels = vol_meta.get("levels") or []
        if not 0 <= level < len(levels):
            raise SliceError(f"Level {level} does not exist (volume has {len(levels)} levels)")
        self.level_count = len(levels)

        lvl_meta = next((l for l in levels if l.get("lod") == level), levels[level])

        self.brick_size = int(vol_meta.get("brickSize", 64))
        self.physical_size = int(vol_meta.get("physicalSize", self.brick_size + 2))

        w, h, d = lvl_meta["dimensions"]
        self.dims = {"x": int(w), "y": int(h), "z": int(d)}
        self.chunk = {a: int(min(self.brick_size, self.dims[a])) for a in "xyz"}

        bx, by, bz = lvl_meta["bricks"]
        self.bricks = {"x": int(bx), "y": int(by), "z": int(bz)}
        self.channels = 1

        fmt = vol_meta.get("format", "uint8")
        src = np.dtype(fmt)
        if src.name in _NATIVE:
            self.dtype = src.name
        elif src.kind in "iuf":
            self.dtype = "float32"
        else:
            raise SliceError(f"Unsupported data type {src}")
        self.source_dtype = src.name
        self._np_dtype = src

        base_spacing = vol_meta.get("voxelSpacing") or [1.0, 1.0, 1.0]
        scale_factor = float(1 << level)
        self.spacing = {
            "x": float(base_spacing[0] or 1.0) * scale_factor,
            "y": float(base_spacing[1] or 1.0) * scale_factor,
            "z": float(base_spacing[2] or 1.0) * scale_factor,
        }
        self.unit = vol_meta.get("unit", None)

        index_file = self.root / lvl_meta.get("indexFile", f"lod{level}_index.json")
        self.bin_file = self.root / lvl_meta.get("binFile", f"lod{level}.bin")
        npy_index_file = self.root / f"lod{level}_index.npy"
        npy_zindex_file = self.root / f"lod{level}_zindex.npy"

        if not self.bin_file.exists() or (not npy_index_file.exists() and not index_file.exists()):
            raise SliceError(f"Missing shard binary or index file for level {level}", 404)

        self._compressed = bool(vol_meta.get("compressed", True))
        self._idx = self._load_or_build_binary_index(index_file, npy_index_file)
        self._zidx = np.load(npy_zindex_file, mmap_mode="r") if npy_zindex_file.exists() else None

        self._omero_window = None
        self._window: Optional[dict] = vol_meta.get("suggestedWindow")
        if self._window is None and (self.root / "suggested_window.json").exists():
            try:
                self._window = json.loads((self.root / "suggested_window.json").read_text(encoding="utf-8"))
            except Exception:
                pass
        self._window_lock = threading.Lock()

        self.stamp = vol_json_path.stat().st_mtime_ns

    def _load_or_build_binary_index(self, json_path: Path, npy_path: Path) -> np.ndarray:
        """Load mmap binary index (.npy), or auto-build it once from legacy lodN_index.json."""
        if npy_path.exists():
            return np.load(npy_path, mmap_mode="r")

        try:
            with open(json_path, "r", encoding="utf-8") as f:
                idx_meta = json.load(f)
        except Exception as exc:
            raise SliceError(f"Cannot read {json_path.name}: {exc}", 404) from exc

        self._compressed = bool(idx_meta.get("compressed", self._compressed))
        entries = idx_meta.get("entries") or {}
        nx, ny, nz = self.bricks["x"], self.bricks["y"], self.bricks["z"]
        arr = np.zeros((nz, ny, nx), dtype=INDEX_DTYPE)

        for key, e in entries.items():
            s_bx, s_by, s_bz = key.split("/")
            arr[int(s_bz), int(s_by), int(s_bx)] = (
                int(e["offset"]),
                int(e["size"]),
                float(e.get("min", 0.0)),
                float(e.get("max", 0.0)),
                float(e.get("avg", 0.0)),
            )

        try:
            tmp_npy = npy_path.with_suffix(".tmp.npy")
            np.save(tmp_npy, arr)
            os.replace(tmp_npy, npy_path)
            return np.load(npy_path, mmap_mode="r")
        except OSError:
            return arr

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
        """Robust percentiles of the middle xy plane."""
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

    def _decode_brick_core(self, raw_bytes: bytes | memoryview) -> np.ndarray:
        if self._compressed:
            raw_bytes = _decompress_gzip(raw_bytes)
        p = self.physical_size
        brick = np.frombuffer(raw_bytes, dtype=self._np_dtype).reshape((p, p, p))
        return brick[1:-1, 1:-1, 1:-1]

    def _read_brick_core(self, fd: int, bx: int, by: int, bz: int) -> Tuple[Optional[np.ndarray], float]:
        """
        Returns (core_array, const_val).
        When a brick is uniform (min == max), returns (None, min) with ZERO disk I/O.
        """
        entry = self._idx[bz, by, bx]
        size = int(entry["size"])
        b_min = float(entry["min"])
        b_max = float(entry["max"])

        if size == 0 or b_min == b_max:
            return None, b_min

        raw_bytes = os.pread(fd, size, int(entry["offset"]))
        return self._decode_brick_core(raw_bytes), 0.0

    def _read_brick_xy_plane(
            self, fd: int, bx: int, by: int, bz: int, local_z: int
    ) -> Tuple[Optional[np.ndarray], float]:
        """
        Fast-path for XY _read_direct:
        If lodN_zindex.npy exists, reads and decompresses ONLY the single Z-plane (66x less data).
        Otherwise falls back to full brick decode.
        """
        entry = self._idx[bz, by, bx]
        size = int(entry["size"])
        b_min = float(entry["min"])
        b_max = float(entry["max"])

        if size == 0 or b_min == b_max:
            return None, b_min

        if self._zidx is not None and self._compressed:
            z_offs = self._zidx[bz, by, bx]
            rel_start = int(z_offs[local_z + 1])
            rel_end = int(z_offs[local_z + 2])
            if rel_end > rel_start:
                comp_plane = os.pread(fd, rel_end - rel_start, int(entry["offset"]) + rel_start)
                raw_plane = _decompress_raw_deflate(comp_plane)
                p = self.physical_size
                plane = np.frombuffer(raw_plane, dtype=self._np_dtype).reshape((p, p))
                return plane[1:-1, 1:-1], 0.0

        core, const_val = self._read_brick_core(fd, bx, by, bz)
        if core is None:
            return None, const_val
        return core[local_z], 0.0

    def _read_slab(
            self, axis: str, k: int, channel: int, sub_start: int = 0, sub_thickness: Optional[int] = None
    ) -> np.ndarray:
        """
        Assemble a 3D slab in (z, y, x) order along normal axis `n` in parallel.
        Supports both full brick-thick slabs (64 slices) and thin sub-slabs (e.g., 16 slices).
        """
        n = AXIS_NORMAL[axis]
        bs = self.brick_size
        start_n = k * bs + sub_start
        max_end_n = min((k + 1) * bs, self.dims[n])
        end_n = max_end_n if sub_thickness is None else min(start_n + sub_thickness, max_end_n)
        thickness = end_n - start_n

        slab_shape = {
            "z": thickness if n == "z" else self.dims["z"],
            "y": thickness if n == "y" else self.dims["y"],
            "x": thickness if n == "x" else self.dims["x"],
        }
        slab = np.zeros((slab_shape["z"], slab_shape["y"], slab_shape["x"]), dtype=self._np_dtype)

        bz_range = [k] if n == "z" else range(self.bricks["z"])
        by_range = [k] if n == "y" else range(self.bricks["y"])
        bx_range = [k] if n == "x" else range(self.bricks["x"])

        coords = [(bx, by, bz) for bz in bz_range for by in by_range for bx in bx_range]
        s0 = sub_start
        s1 = sub_start + thickness

        fd = os.open(self.bin_file, os.O_RDONLY)
        try:
            def load_one(c):
                bx, by, bz = c
                core, const_val = self._read_brick_core(fd, bx, by, bz)
                if core is None and const_val == 0.0:
                    return  # Destination is already zero-initialized

                z0 = 0 if n == "z" else bz * bs
                dz = thickness if n == "z" else min(bs, self.dims["z"] - z0)
                y0 = 0 if n == "y" else by * bs
                dy = thickness if n == "y" else min(bs, self.dims["y"] - y0)
                x0 = 0 if n == "x" else bx * bs
                dx = thickness if n == "x" else min(bs, self.dims["x"] - x0)

                if core is None:
                    slab[z0: z0 + dz, y0: y0 + dy, x0: x0 + dx] = const_val
                elif n == "z":
                    slab[z0: z0 + dz, y0: y0 + dy, x0: x0 + dx] = core[s0:s1, :dy, :dx]
                elif n == "y":
                    slab[z0: z0 + dz, y0: y0 + dy, x0: x0 + dx] = core[:dz, s0:s1, :dx]
                else:
                    slab[z0: z0 + dz, y0: y0 + dy, x0: x0 + dx] = core[:dz, :dy, s0:s1]

            list(_IO_POOL.map(load_one, coords))
        finally:
            os.close(fd)

        if self.dtype != self.source_dtype:
            slab = slab.astype(self.dtype, copy=False)
        return slab

    def _read_direct(self, axis: str, index: int, channel: int) -> np.ndarray:
        """Read a single 2D plane in parallel across _IO_POOL."""
        bs = self.brick_size
        k = index // bs
        local = index - k * bs

        fd = os.open(self.bin_file, os.O_RDONLY)
        try:
            if axis == "xy":  # (y, x) at fixed z = index
                plane = np.zeros((self.dims["y"], self.dims["x"]), dtype=self._np_dtype)
                coords = [(bx, by) for by in range(self.bricks["y"]) for bx in range(self.bricks["x"])]

                def work_xy(c):
                    bx, by = c
                    tile, const_val = self._read_brick_xy_plane(fd, bx, by, k, local)
                    if tile is None and const_val == 0.0:
                        return
                    y0 = by * bs
                    dy = min(bs, self.dims["y"] - y0)
                    x0 = bx * bs
                    dx = min(bs, self.dims["x"] - x0)
                    plane[y0: y0 + dy, x0: x0 + dx] = const_val if tile is None else tile[:dy, :dx]

                list(_IO_POOL.map(work_xy, coords))

            elif axis == "xz":  # (z, x) at fixed y = index
                plane = np.zeros((self.dims["z"], self.dims["x"]), dtype=self._np_dtype)
                coords = [(bx, bz) for bz in range(self.bricks["z"]) for bx in range(self.bricks["x"])]

                def work_xz(c):
                    bx, bz = c
                    core, const_val = self._read_brick_core(fd, bx, k, bz)
                    if core is None and const_val == 0.0:
                        return
                    z0 = bz * bs
                    dz = min(bs, self.dims["z"] - z0)
                    x0 = bx * bs
                    dx = min(bs, self.dims["x"] - x0)
                    plane[z0: z0 + dz, x0: x0 + dx] = const_val if core is None else core[:dz, local, :dx]

                list(_IO_POOL.map(work_xz, coords))

            else:  # "yz" -> (z, y) at fixed x = index
                plane = np.zeros((self.dims["z"], self.dims["y"]), dtype=self._np_dtype)
                coords = [(by, bz) for bz in range(self.bricks["z"]) for by in range(self.bricks["y"])]

                def work_yz(c):
                    by, bz = c
                    core, const_val = self._read_brick_core(fd, k, by, bz)
                    if core is None and const_val == 0.0:
                        return
                    z0 = bz * bs
                    dz = min(bs, self.dims["z"] - z0)
                    y0 = by * bs
                    dy = min(bs, self.dims["y"] - y0)
                    plane[z0: z0 + dz, y0: y0 + dy] = const_val if core is None else core[:dz, :dy, local]

                list(_IO_POOL.map(work_yz, coords))
        finally:
            os.close(fd)

        if self.dtype != self.source_dtype:
            plane = plane.astype(self.dtype, copy=False)
        return plane

    @staticmethod
    def _plane_from_slab(slab: np.ndarray, axis: str, local: int) -> np.ndarray:
        if axis == "xy":
            return slab[local]
        if axis == "xz":
            return slab[:, local, :]
        return slab[:, :, local]

    def get_plane(self, axis: str, index: int, channel: int = 0) -> Tuple[np.ndarray, str]:
        """The plane as a 2D array (rows = v, columns = u) and where it came from."""
        if axis not in AXIS_NORMAL:
            raise SliceError(f"axis must be one of {', '.join(AXES)}")
        n = AXIS_NORMAL[axis]
        if not 0 <= index < self.dims[n]:
            raise SliceError(f"{axis} index must be in 0..{self.dims[n] - 1}")
        if not 0 <= channel < self.channels:
            raise SliceError(f"channel must be in 0..{self.channels - 1}")

        cache = self._cache if self._cache is not None else slab_cache()
        chunk_n = self.chunk[n]
        k = index // chunk_n
        local = index - k * chunk_n
        plane_bytes = (
                (self.dims["x"] * self.dims["y"] * self.dims["z"] // self.dims[n])
                * self._np_dtype.itemsize
        )

        # 1. Try full 64-slice brick-layer slab
        thickness = min(chunk_n, self.dims[n] - k * chunk_n)
        slab_bytes = plane_bytes * thickness
        if cache.fits(slab_bytes):
            key = (str(self.root), self.stamp, self.level, channel, axis, k)
            slab = cache.get_or_build(key, slab_bytes, lambda: self._read_slab(axis, k, channel))
            return self._plane_from_slab(slab, axis, local), "slab"

        # 2. For XZ / YZ (or XY without zindex), try a 16-slice thin sub-slab before dropping to 1-slice direct
        sub_step = 16
        if axis != "xy" or self._zidx is None:
            sub_idx = local // sub_step
            sub_start = sub_idx * sub_step
            sub_thick = min(sub_step, thickness - sub_start)
            sub_bytes = plane_bytes * sub_thick
            if sub_thick > 1 and cache.fits(sub_bytes):
                key = (str(self.root), self.stamp, self.level, channel, axis, k, sub_idx)
                slab = cache.get_or_build(
                    key, sub_bytes, lambda: self._read_slab(axis, k, channel, sub_start, sub_thick)
                )
                return self._plane_from_slab(slab, axis, local - sub_start), "slab"

        return self._read_direct(axis, index, channel), "direct"


def percentile_window(plane: np.ndarray, lo: float = 1.0, hi: float = 99.0) -> dict:
    sample = np.asarray(plane).ravel()
    if sample.size > 400_000:
        sample = sample[:: sample.size // 400_000 + 1]
    a, b = np.percentile(sample.astype(np.float64), [lo, hi])
    width = max(float(b - a), 1e-6)
    return {"center": float(a) + width / 2, "width": width}


# ------------------------------------------------------------------- the registry

_registry: "OrderedDict[tuple, VolumeSlicesKiln]" = OrderedDict()
_registry_lock = threading.Lock()
_REGISTRY_SIZE = 16


def open_volume_slices(dataset_root: Path, level: int = 0) -> VolumeSlicesKiln:
    """Cached VolumeSlices for a store (a replaced store gets a new entry via its mtime)."""
    root = Path(dataset_root)
    meta = root / "volume.json"
    if not meta.is_file():
        raise SliceError(f"Cannot open volume metadata: {meta} not found", 404)
    stamp = meta.stat().st_mtime_ns if meta is not None else 0
    key = (str(root), stamp, level)
    with _registry_lock:
        vs = _registry.get(key)
        if vs is not None:
            _registry.move_to_end(key)
            return vs
    vs = VolumeSlicesKiln(root, level)  # may raise; built outside the lock
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


ENCODINGS = ("identity", "zstd")


def encode_plane(plane: np.ndarray, encoding: str = "identity", zstd_level: int = 1) -> Tuple[bytes, Optional[str]]:
    """Plane bytes for the wire.

    The client chooses (``?enc=``) instead of the Accept-Encoding header deciding: a body that
    is sent as ``Content-Encoding: zstd`` but arrives undecoded (older embedded Chromium, a
    proxy that strips the header, ...) is unusable, so the page first proves with a tiny probe
    that its fetch() really decodes zstd and only then asks for it. Raw is always safe.
    """
    if encoding == "zstd":
        import zstandard

        return zstandard.ZstdCompressor(level=zstd_level).compress(plane), "zstd"
    return plane.tobytes(), None


def plane_response_parts(
        vs: VolumeSlicesKiln,
        axis: str,
        index: int,
        channel: int = 0,
        stride: int = 1,
        encoding: str = "identity",
) -> Tuple[bytes, dict]:
    """Everything the HTTP layer needs: (body, headers). Kept free of FastAPI for testing."""
    if stride not in (1, 2, 4, 8):
        raise SliceError("stride must be 1, 2, 4 or 8")
    if encoding not in ENCODINGS:
        raise SliceError(f"enc must be one of {', '.join(ENCODINGS)}")
    t0 = time.perf_counter()
    plane, source = vs.get_plane(axis, index, channel)
    out = to_transport(plane, vs.dtype, stride)
    body, content_encoding = encode_plane(out, encoding, settings.SLICE_ZSTD_LEVEL)
    headers = {
        "X-Plane-Width": str(out.shape[1]),
        "X-Plane-Height": str(out.shape[0]),
        "X-Plane-Dtype": vs.dtype,
        "X-Plane-Stride": str(stride),
        "X-Plane-Source": source,
        "X-Plane-Raw-Bytes": str(out.nbytes),
        "X-Plane-Server-Ms": f"{(time.perf_counter() - t0) * 1000:.1f}",
        "X-Plane-Encoding": encoding,
        "Vary": "Accept-Encoding",
    }
    if content_encoding:
        headers["Content-Encoding"] = content_encoding
    return body, headers
