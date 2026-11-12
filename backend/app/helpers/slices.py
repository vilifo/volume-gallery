"""Slice views: plans of arbitrarily oriented planes and the blocks they are assembled from.

The browser asks for the plan of a plane (plan_plane), then for the blocks it lacks (stream_blocks); it
assembles the image itself. Whole axis-aligned planes can still be fetched with get_plane."""
from __future__ import annotations

import asyncio
import itertools
import json
import logging
import os
import queue
import struct
import threading
import time
import zlib
from collections import OrderedDict
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np

from ..config import settings

log = logging.getLogger(__name__)

# Use Intel ISA-L SIMD decompression if installed (4x-6x faster than stdlib zlib)
try:
    from isal import igzip as _fast_gzip
    from isal import isal_zlib as _fast_zlib
except ImportError:
    _fast_gzip = None
    _fast_zlib = zlib

AXIS_NORMAL = {"xy": "z", "xz": "y", "yz": "x"}
AXES = tuple(AXIS_NORMAL)

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

# Physical (66^3) sub-block bounds for the 17 + 16 + 16 + 17 = 66 decomposition
_TILED66_PHYS_BOUNDS: Tuple[Tuple[int, int], ...] = ((0, 17), (17, 33), (33, 49), (49, 66))
_TILED66_PHYS_SIZES: Tuple[int, ...] = (17, 16, 16, 17)
# Slice inside each physical sub-block that strips the 1-voxel outer brick border -> always 16 wide!
_TILED66_CORE_TRIM: Tuple[slice, ...] = (
    slice(1, 17),   # block 0: [0..17) -> [1..17) = 16 logical voxels (0..15)
    slice(0, 16),   # block 1: [17..33) -> [0..16) = 16 logical voxels (16..31)
    slice(0, 16),   # block 2: [33..49) -> [0..16) = 16 logical voxels (32..47)
    slice(0, 16),   # block 3: [49..66) -> [0..16) = 16 logical voxels (48..63)
)

_NUM_WORKERS = min(16, (os.cpu_count() or 4) * 2)
_IO_POOL = ThreadPoolExecutor(max_workers=_NUM_WORKERS)
_DEFLATE_EOF_BLOCK = b"\x03\x00"


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
        return self.max_bytes > 0 and nbytes <= self.max_bytes * 0.75

    def get_or_build(self, key: tuple, nbytes: int, build) -> np.ndarray:
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


# ----------------------------------------------------------------------- decompression
def _decompress_gzip(data: bytes | memoryview) -> bytes:
    if _fast_gzip is not None:
        return _fast_gzip.decompress(data)
    return _fast_zlib.decompress(data, 16 + zlib.MAX_WBITS)


def _decompress_raw_deflate(data: bytes | memoryview) -> bytes:
    try:
        # Works if the block already has BFINAL=1 (e.g., the last sub-block 63)
        return _fast_zlib.decompress(data, -zlib.MAX_WBITS)
    except Exception:
        # Z_FULL_FLUSH blocks have BFINAL=0 and end on a byte-aligned 00 00 ff ff sync marker;
        # appending _DEFLATE_EOF_BLOCK cleanly closes the stream for igzip_lib / isal_zlib.
        return _fast_zlib.decompress(bytes(data) + _DEFLATE_EOF_BLOCK, -zlib.MAX_WBITS)


def _decompress_raw_deflate_prefix(data: bytes | memoryview, max_length: int) -> bytes:
    dobj = _fast_zlib.decompressobj(-zlib.MAX_WBITS)
    return dobj.decompress(data, max_length)


# ----------------------------------------------------------------------- the store


class VolumeSlicesKiln:
    """
    Read access to the planes and blocks of one binary-sharded Kiln volume level.
    - On LOD 0 (`tiled66` with `lod0_subindex.npy`), uses 64 (17/16/16/17)^3
      independently-decompressible sub-blocks per brick.
    - On LOD > 0 (`z_sync` with `lod{N}_zindex.npy`), uses 66 Z-plane blocks.
    """

    def __init__(self, dataset_root: Path, level: int = 0, cache: Optional[SlabCache] = None):
        self.root = Path(dataset_root)
        self.level = level
        self._cache = cache
        self.dtype = np.uint16
        self._fd: Optional[int] = None

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
        self.brick_layout = lvl_meta.get("brickLayout") or vol_meta.get("brickLayout", "standard")

        w, h, d = lvl_meta["dimensions"]
        self.dims = {"x": int(w), "y": int(h), "z": int(d)}
        self.orig_shape = (self.dims["z"], self.dims["y"], self.dims["x"])
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
        # In (z, y, x) order to match BlockTiledVolume
        self.voxel_spacing = np.array(
            [self.spacing["z"], self.spacing["y"], self.spacing["x"]], dtype=np.float64
        )
        self.block_shape = (16, 16, 16)
        self.unit = vol_meta.get("unit", None)

        index_file = self.root / lvl_meta.get("indexFile", f"lod{level}_index.json")
        self.bin_file = self.root / lvl_meta.get("binFile", f"lod{level}.bin")
        npy_index_file = self.root / f"lod{level}_index.npy"
        npy_zindex_file = self.root / f"lod{level}_zindex.npy"
        npy_subindex_file = self.root / f"lod{level}_subindex.npy"

        if not self.bin_file.exists() or (not npy_index_file.exists() and not index_file.exists()):
            raise SliceError(f"Missing shard binary or index file for level {level}", 404)

        self._compressed = bool(vol_meta.get("compressed", True))
        self._idx = self._load_or_build_binary_index(index_file, npy_index_file)
        self._zidx = np.load(npy_zindex_file, mmap_mode="r") if npy_zindex_file.exists() else None
        self._subidx = np.load(npy_subindex_file, mmap_mode="r") if npy_subindex_file.exists() else None
        if self._subidx is not None:
            self.brick_layout = "tiled66"
        # blocks (see read_block): 16^3 sub-blocks on LOD 0, whole bricks on the coarser levels
        self.block_size = 16 if (self._subidx is not None and self._compressed) else self.brick_size
        self._blocks_per_brick = max(1, self.brick_size // self.block_size)
        self.block_grid = {a: -(-self.dims[a] // self.block_size) for a in "xyz"}

        # Persistent file descriptor (os.pread is thread-safe across _IO_POOL)
        self._fd = os.open(self.bin_file, os.O_RDONLY)

        self._omero_window = None
        self._window: Optional[dict] = vol_meta.get("suggestedWindow")
        if self._window is None and (self.root / "suggested_window.json").exists():
            try:
                self._window = json.loads((self.root / "suggested_window.json").read_text(encoding="utf-8"))
            except Exception:
                pass
        self._window_lock = threading.Lock()

        self.stamp = vol_json_path.stat().st_mtime_ns

    def __del__(self):
        if getattr(self, "_fd", None) is not None:
            try:
                os.close(self._fd)
            except OSError:
                pass
            self._fd = None

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
        if "brickLayout" in idx_meta:
            self.brick_layout = idx_meta["brickLayout"]
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
            "blockSize": self.block_size,
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

    # --------------------------------------------------- tiled66 (LOD 0) helpers

    def _decode_tiled66_subblock_core(
        self, raw_sub: bytes | memoryview, sz: int, sy: int, sx: int
    ) -> np.ndarray:
        """
        Reshape a decompressed (17/16/16/17)^3 physical sub-block and strip the
        1-voxel outer border on any face where sz/sy/sx == 0 or 3, returning a
        logical (16, 16, 16) view.
        """
        shape = (
            _TILED66_PHYS_SIZES[sz],
            _TILED66_PHYS_SIZES[sy],
            _TILED66_PHYS_SIZES[sx],
        )
        sub_phys = np.frombuffer(raw_sub, dtype=self._np_dtype).reshape(shape)
        return sub_phys[
            _TILED66_CORE_TRIM[sz],
            _TILED66_CORE_TRIM[sy],
            _TILED66_CORE_TRIM[sx],
        ]

    def _read_tiled66_subblocks(
        self, bx: int, by: int, bz: int, sub_indices: List[int]
    ) -> Dict[int, np.ndarray]:
        """
        Read and decode a subset of the 64 sub-blocks (0..63) of brick (bx, by, bz).
        Adjacent sub-blocks in `sub_indices` are automatically coalesced into a
        single `os.pread` call!
        Returns dict mapping `sub_idx -> (16, 16, 16) logical ndarray`.
        """
        entry = self._idx[bz, by, bx]
        size = int(entry["size"])
        if size == 0:
            return {}

        base_off = int(entry["offset"])
        s_offs = self._subidx[bz, by, bx]
        sorted_indices = sorted(sub_indices)
        result: Dict[int, np.ndarray] = {}

        # Coalesce contiguous runs of sub-block indices into single pread calls
        n = len(sorted_indices)
        i = 0
        while i < n:
            run_start = sorted_indices[i]
            j = i
            while j + 1 < n and sorted_indices[j + 1] == sorted_indices[j] + 1:
                j += 1
            run_end = sorted_indices[j]

            byte_start = int(s_offs[run_start])
            byte_end = int(s_offs[run_end + 1])
            if byte_end > byte_start:
                buf = os.pread(self._fd, byte_end - byte_start, base_off + byte_start)
                mv = memoryview(buf)
                for k in range(i, j + 1):
                    b_idx = sorted_indices[k]
                    c0 = int(s_offs[b_idx]) - byte_start
                    c1 = int(s_offs[b_idx + 1]) - byte_start
                    raw = _decompress_raw_deflate(mv[c0:c1])
                    sz = b_idx >> 4
                    sy = (b_idx >> 2) & 3
                    sx = b_idx & 3
                    result[b_idx] = self._decode_tiled66_subblock_core(raw, sz, sy, sx)
            i = j + 1

        return result

    def _read_tiled66_slab16(
        self, bx: int, by: int, bz: int, n: str, sub_blk: int
    ) -> Optional[np.ndarray]:
        """
        Read a 16-slice logical slab along normal axis `n` ('z', 'y', or 'x') at
        `sub_blk` (0..3) from a `tiled66` brick.
        Returns shape:
          - n == 'z': (16, 64, 64)
          - n == 'y': (64, 16, 64)
          - n == 'x': (64, 64, 16)
        """
        if n == "z":
            indices = [((sub_blk << 4) | (sy << 2) | sx) for sy in range(4) for sx in range(4)]
            blocks = self._read_tiled66_subblocks(bx, by, bz, indices)
            if not blocks:
                return None
            out = np.empty((16, 64, 64), dtype=self._np_dtype)
            for sy in range(4):
                for sx in range(4):
                    b_idx = (sub_blk << 4) | (sy << 2) | sx
                    out[:, sy*16:(sy+1)*16, sx*16:(sx+1)*16] = blocks[b_idx]
            return out

        if n == "y":
            indices = [((sz << 4) | (sub_blk << 2) | sx) for sz in range(4) for sx in range(4)]
            blocks = self._read_tiled66_subblocks(bx, by, bz, indices)
            if not blocks:
                return None
            out = np.empty((64, 16, 64), dtype=self._np_dtype)
            for sz in range(4):
                for sx in range(4):
                    b_idx = (sz << 4) | (sub_blk << 2) | sx
                    out[sz*16:(sz+1)*16, :, sx*16:(sx+1)*16] = blocks[b_idx]
            return out

        # n == "x"
        indices = [((sz << 4) | (sy << 2) | sub_blk) for sz in range(4) for sy in range(4)]
        blocks = self._read_tiled66_subblocks(bx, by, bz, indices)
        if not blocks:
            return None
        out = np.empty((64, 64, 16), dtype=self._np_dtype)
        for sz in range(4):
            for sy in range(4):
                b_idx = (sz << 4) | (sy << 2) | sub_blk
                out[sz*16:(sz+1)*16, sy*16:(sy+1)*16, :] = blocks[b_idx]
        return out

    def _read_tiled66_plane(
        self, bx: int, by: int, bz: int, axis: str, local: int
    ) -> Optional[np.ndarray]:
        """
        Read a single (64, 64) 2D logical plane at `local` (0..63) from a `tiled66` brick.
        For XY (`axis == 'xy'`), uses partial deflate decompression (`_decompress_raw_deflate_prefix`)
        to stop right after the target Z slice inside each of the 16 sub-blocks!
        """
        entry = self._idx[bz, by, bx]
        if int(entry["size"]) == 0:
            return None

        sub_blk = local >> 4
        sub_off = local & 15

        if axis == "xy":
            base_off = int(entry["offset"])
            s_offs = self._subidx[bz, by, bx]
            b0 = sub_blk << 4
            r_start = int(s_offs[b0])
            r_end = int(s_offs[b0 + 16])
            chunk = os.pread(self._fd, r_end - r_start, base_off + r_start)
            mv = memoryview(chunk)

            # In sub_blk == 0, physical z=0 is the border plane, so logical sub_off=0 is at phys_z=1
            phys_z_in_sub = sub_off + (1 if sub_blk == 0 else 0)
            phys_z_total = _TILED66_PHYS_SIZES[sub_blk]
            itemsize = self._np_dtype.itemsize
            tile = np.empty((64, 64), dtype=self._np_dtype)

            for idx_16 in range(16):
                sy = idx_16 >> 2
                sx = idx_16 & 3
                py = _TILED66_PHYS_SIZES[sy]
                px = _TILED66_PHYS_SIZES[sx]
                plane_elems = py * px
                plane_bytes = plane_elems * itemsize
                needed_bytes = (phys_z_in_sub + 1) * plane_bytes

                c0 = int(s_offs[b0 + idx_16]) - r_start
                c1 = int(s_offs[b0 + idx_16 + 1]) - r_start
                raw = (
                    _decompress_raw_deflate_prefix(mv[c0:c1], needed_bytes)
                    if phys_z_in_sub + 1 < phys_z_total
                    else _decompress_raw_deflate(mv[c0:c1])
                )
                plane_2d = np.frombuffer(
                    raw, dtype=self._np_dtype, count=plane_elems, offset=phys_z_in_sub * plane_bytes
                ).reshape((py, px))
                tile[sy*16:(sy+1)*16, sx*16:(sx+1)*16] = plane_2d[
                    _TILED66_CORE_TRIM[sy], _TILED66_CORE_TRIM[sx]
                ]
            return tile

        if axis == "xz":
            slab16 = self._read_tiled66_slab16(bx, by, bz, "y", sub_blk)
            return None if slab16 is None else slab16[:, sub_off, :]

        # axis == "yz"
        slab16 = self._read_tiled66_slab16(bx, by, bz, "x", sub_blk)
        return None if slab16 is None else slab16[:, :, sub_off]

    # ------------------------------------------------ full-brick & zindex reads

    def _decode_brick_core(self, raw_bytes: bytes | memoryview) -> np.ndarray:
        if self._compressed:
            raw_bytes = _decompress_gzip(raw_bytes)
        if self.brick_layout == "tiled66":
            out = np.empty((64, 64, 64), dtype=self._np_dtype)
            mv = memoryview(raw_bytes)
            itemsize = self._np_dtype.itemsize
            pos = 0
            for sz in range(4):
                pz = _TILED66_PHYS_SIZES[sz]
                for sy in range(4):
                    py = _TILED66_PHYS_SIZES[sy]
                    for sx in range(4):
                        px = _TILED66_PHYS_SIZES[sx]
                        nbytes = pz * py * px * itemsize
                        sub = np.frombuffer(mv[pos : pos + nbytes], dtype=self._np_dtype).reshape((pz, py, px))
                        pos += nbytes
                        out[sz*16:(sz+1)*16, sy*16:(sy+1)*16, sx*16:(sx+1)*16] = sub[
                            _TILED66_CORE_TRIM[sz],
                            _TILED66_CORE_TRIM[sy],
                            _TILED66_CORE_TRIM[sx],
                        ]
            return out

        p = self.physical_size
        brick = np.frombuffer(raw_bytes, dtype=self._np_dtype).reshape((p, p, p))
        return brick[1:-1, 1:-1, 1:-1]

    def _read_brick_core(self, bx: int, by: int, bz: int) -> Optional[np.ndarray]:
        entry = self._idx[bz, by, bx]
        size = int(entry["size"])
        if size == 0:
            return None
        raw_bytes = os.pread(self._fd, size, int(entry["offset"]))
        return self._decode_brick_core(raw_bytes)

    def _read_brick_xy_plane(self, bx: int, by: int, bz: int, local_z: int) -> Optional[np.ndarray]:
        """Fast-path for XY _read_direct across both tiled66 (LOD 0) and z_sync (LOD > 0)."""
        if self._subidx is not None and self._compressed:
            return self._read_tiled66_plane(bx, by, bz, "xy", local_z)

        entry = self._idx[bz, by, bx]
        size = int(entry["size"])
        if size == 0:
            return None

        if self._zidx is not None and self._compressed:
            z_offs = self._zidx[bz, by, bx]
            rel_start = int(z_offs[local_z + 1])
            rel_end = int(z_offs[local_z + 2])
            if rel_end > rel_start:
                comp_plane = os.pread(self._fd, rel_end - rel_start, int(entry["offset"]) + rel_start)
                raw_plane = _decompress_raw_deflate(comp_plane)
                p = self.physical_size
                plane = np.frombuffer(raw_plane, dtype=self._np_dtype).reshape((p, p))
                return plane[1:-1, 1:-1]

        core = self._read_brick_core(bx, by, bz)
        return None if core is None else core[local_z]

    def _read_slab(
        self, axis: str, k: int, channel: int, sub_start: int = 0, sub_thickness: Optional[int] = None
    ) -> np.ndarray:
        """
        Assemble a 3D slab in (z, y, x) order along normal axis `n` in parallel.
        Supports both full brick-thick slabs (64 slices) and 16-slice thin sub-slabs.
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

        s0 = sub_start
        s1 = sub_start + thickness
        use_tiled66_sub = (
            self._subidx is not None
            and self._compressed
            and (s0 & 15) == 0
            and thickness <= 16
        )
        sub_blk = s0 >> 4

        io_tasks = []
        for bz in bz_range:
            z0 = 0 if n == "z" else bz * bs
            dz = thickness if n == "z" else min(bs, self.dims["z"] - z0)
            for by in by_range:
                y0 = 0 if n == "y" else by * bs
                dy = thickness if n == "y" else min(bs, self.dims["y"] - y0)
                for bx in bx_range:
                    x0 = 0 if n == "x" else bx * bs
                    dx = thickness if n == "x" else min(bs, self.dims["x"] - x0)
                    entry = self._idx[bz, by, bx]
                    if int(entry["size"]) == 0:
                        continue
                    io_tasks.append((int(entry["offset"]), bx, by, bz, x0, dx, y0, dy, z0, dz))

        if io_tasks:
            io_tasks.sort(key=lambda t: t[0])

            def load_batch(batch):
                for _, bx, by, bz, x0, dx, y0, dy, z0, dz in batch:
                    if use_tiled66_sub:
                        sub_core = self._read_tiled66_slab16(bx, by, bz, n, sub_blk)
                        if sub_core is not None:
                            slab[z0:z0+dz, y0:y0+dy, x0:x0+dx] = sub_core[:dz, :dy, :dx]
                    elif n == "z" and self._zidx is not None and self._compressed and (s0 > 0 or s1 < bs):
                        z_offs = self._zidx[bz, by, bx]
                        r0, r1 = int(z_offs[s0 + 1]), int(z_offs[s1 + 1])
                        if r1 > r0:
                            base_off = int(self._idx[bz, by, bx]["offset"])
                            comp = os.pread(self._fd, r1 - r0, base_off + r0)
                            raw = _decompress_raw_deflate(comp)
                            p = self.physical_size
                            planes = np.frombuffer(raw, dtype=self._np_dtype).reshape((s1 - s0, p, p))
                            slab[z0:z0+dz, y0:y0+dy, x0:x0+dx] = planes[:dz, 1:1+dy, 1:1+dx]
                    else:
                        core = self._read_brick_core(bx, by, bz)
                        if core is None:
                            continue
                        if n == "z":
                            slab[z0:z0+dz, y0:y0+dy, x0:x0+dx] = core[s0:s1, :dy, :dx]
                        elif n == "y":
                            slab[z0:z0+dz, y0:y0+dy, x0:x0+dx] = core[:dz, s0:s1, :dx]
                        else:
                            slab[z0:z0+dz, y0:y0+dy, x0:x0+dx] = core[:dz, :dy, s0:s1]

            batch_size = max(1, (len(io_tasks) + _NUM_WORKERS - 1) // _NUM_WORKERS)
            batches = [io_tasks[i : i + batch_size] for i in range(0, len(io_tasks), batch_size)]
            list(_IO_POOL.map(load_batch, batches))

        if self.dtype != self.source_dtype:
            slab = slab.astype(self.dtype, copy=False)
        return slab

    def _read_direct(self, axis: str, index: int, channel: int) -> np.ndarray:
        """Read a single 2D plane in parallel across _IO_POOL."""
        bs = self.brick_size
        k = index // bs
        local = index - k * bs
        use_tiled66 = self._subidx is not None and self._compressed

        if axis == "xy":  # (y, x) at fixed z = index
            plane = np.zeros((self.dims["y"], self.dims["x"]), dtype=self._np_dtype)
            io_tasks = []
            for by in range(self.bricks["y"]):
                y0 = by * bs
                dy = min(bs, self.dims["y"] - y0)
                for bx in range(self.bricks["x"]):
                    x0 = bx * bs
                    dx = min(bs, self.dims["x"] - x0)
                    entry = self._idx[k, by, bx]
                    if int(entry["size"]) > 0:
                        io_tasks.append((int(entry["offset"]), bx, by, x0, dx, y0, dy))

            if io_tasks:
                io_tasks.sort(key=lambda t: t[0])

                def work_xy_batch(batch):
                    for _, bx, by, x0, dx, y0, dy in batch:
                        tile = self._read_brick_xy_plane(bx, by, k, local)
                        if tile is not None:
                            plane[y0:y0+dy, x0:x0+dx] = tile[:dy, :dx]

                batch_size = max(1, (len(io_tasks) + _NUM_WORKERS - 1) // _NUM_WORKERS)
                batches = [io_tasks[i : i + batch_size] for i in range(0, len(io_tasks), batch_size)]
                list(_IO_POOL.map(work_xy_batch, batches))

        elif axis == "xz":  # (z, x) at fixed y = index
            plane = np.zeros((self.dims["z"], self.dims["x"]), dtype=self._np_dtype)
            io_tasks = []
            for bz in range(self.bricks["z"]):
                z0 = bz * bs
                dz = min(bs, self.dims["z"] - z0)
                for bx in range(self.bricks["x"]):
                    x0 = bx * bs
                    dx = min(bs, self.dims["x"] - x0)
                    entry = self._idx[bz, k, bx]
                    if int(entry["size"]) > 0:
                        io_tasks.append((int(entry["offset"]), bx, bz, x0, dx, z0, dz))

            if io_tasks:
                io_tasks.sort(key=lambda t: t[0])

                def work_xz_batch(batch):
                    for _, bx, bz, x0, dx, z0, dz in batch:
                        if use_tiled66:
                            tile = self._read_tiled66_plane(bx, k, bz, "xz", local)
                            if tile is not None:
                                plane[z0:z0+dz, x0:x0+dx] = tile[:dz, :dx]
                        else:
                            core = self._read_brick_core(bx, k, bz)
                            if core is not None:
                                plane[z0:z0+dz, x0:x0+dx] = core[:dz, local, :dx]

                batch_size = max(1, (len(io_tasks) + _NUM_WORKERS - 1) // _NUM_WORKERS)
                batches = [io_tasks[i : i + batch_size] for i in range(0, len(io_tasks), batch_size)]
                list(_IO_POOL.map(work_xz_batch, batches))

        else:  # "yz" -> (z, y) at fixed x = index
            plane = np.zeros((self.dims["z"], self.dims["y"]), dtype=self._np_dtype)
            io_tasks = []
            for bz in range(self.bricks["z"]):
                z0 = bz * bs
                dz = min(bs, self.dims["z"] - z0)
                for by in range(self.bricks["y"]):
                    y0 = by * bs
                    dy = min(bs, self.dims["y"] - y0)
                    entry = self._idx[bz, by, k]
                    if int(entry["size"]) > 0:
                        io_tasks.append((int(entry["offset"]), by, bz, y0, dy, z0, dz))

            if io_tasks:
                io_tasks.sort(key=lambda t: t[0])

                def work_yz_batch(batch):
                    for _, by, bz, y0, dy, z0, dz in batch:
                        if use_tiled66:
                            tile = self._read_tiled66_plane(k, by, bz, "yz", local)
                            if tile is not None:
                                plane[z0:z0+dz, y0:y0+dy] = tile[:dz, :dy]
                        else:
                            core = self._read_brick_core(k, by, bz)
                            if core is not None:
                                plane[z0:z0+dz, y0:y0+dy] = core[:dz, :dy, local]

                batch_size = max(1, (len(io_tasks) + _NUM_WORKERS - 1) // _NUM_WORKERS)
                batches = [io_tasks[i : i + batch_size] for i in range(0, len(io_tasks), batch_size)]
                list(_IO_POOL.map(work_yz_batch, batches))

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

    def __getitem__(self, key: Tuple[str, int]) -> np.ndarray:
        """
        BlockTiledVolume-compatible orthogonal 2D slice indexing:
          - vol['z', idx] or vol['xy', idx] -> (y, x) plane at z = idx
          - vol['y', idx] or vol['xz', idx] -> (z, x) plane at y = idx
          - vol['x', idx] or vol['yz', idx] -> (z, y) plane at x = idx
        """
        axis, idx = key
        axis = str(axis).lower()
        axis_to_plane = {
            "z": "xy", "0": "xy", "xy": "xy",
            "y": "xz", "1": "xz", "xz": "xz",
            "x": "yz", "2": "yz", "yz": "yz",
        }
        if axis not in axis_to_plane:
            raise KeyError(f"Unsupported axis {axis!r}")
        plane_axis = axis_to_plane[axis]
        n = AXIS_NORMAL[plane_axis]
        if idx < 0:
            idx += self.dims[n]
        plane, _ = self.get_plane(plane_axis, idx, channel=0)
        return plane

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
        thickness = min(chunk_n, self.dims[n] - k * chunk_n)

        # On LOD 0 (`tiled66`), a 16-slice sub-slab reads ONLY 16 sub-blocks per brick (25% of brick)
        # with zero wasted voxels and 4x smaller cache footprint!
        if self._subidx is not None:
            sub_step = 16
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

        # 1. Try full 64-slice brick-layer slab
        slab_bytes = plane_bytes * thickness
        if cache.fits(slab_bytes):
            key = (str(self.root), self.stamp, self.level, channel, axis, k)
            slab = cache.get_or_build(key, slab_bytes, lambda: self._read_slab(axis, k, channel))
            return self._plane_from_slab(slab, axis, local), "slab"

        # 2. Try 16-slice thin sub-slab before dropping to 1-slice direct
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

    # ------------------------------------------------- blocks: the unit the browser is fed with
    #
    # A slice is no longer cut out here. The browser asks for a *plan* (which blocks a plane touches and how
    # many of its pixels read from each, see plan_plane) and then for the blocks themselves (read_block,
    # streamed by stream_blocks), and assembles the image from them. A block is a 16^3 sub-block on LOD 0
    # (`tiled66`) and a whole brick core (brick_size^3) on the coarser levels; blocks are addressed by their
    # block coordinates (gx, gy, gz) and hold their voxels in (z, y, x) order, as the transport dtype.

    def read_block(self, gx: int, gy: int, gz: int) -> Optional[np.ndarray]:
        """One block as a C-contiguous (bs, bs, bs) array in the transport dtype, or None when its brick is
        empty (all zero). Voxels past the end of the volume are whatever the store holds there."""
        per = self._blocks_per_brick
        bx, by, bz = gx // per, gy // per, gz // per
        if not (bx < self.bricks["x"] and by < self.bricks["y"] and bz < self.bricks["z"]):
            return None
        if int(self._idx[bz, by, bx]["size"]) == 0:
            return None
        if self.block_size != self.brick_size:  # tiled66: 4 x 4 x 4 sub-blocks per brick
            sub = ((gz & 3) << 4) | ((gy & 3) << 2) | (gx & 3)
            core = self._read_tiled66_subblocks(bx, by, bz, [sub]).get(sub)
        else:
            core = self._read_brick_core(bx, by, bz)
        if core is None:
            return None
        return np.ascontiguousarray(core, dtype=_NATIVE[self.dtype][0])

    def plan_plane(
        self,
        origin: Tuple[float, float, float],
        u: Tuple[float, float, float],
        v: Tuple[float, float, float],
        pixel: float,
        width: int,
        height: int,
    ) -> dict:
        """Plan of the image of a plane: pixel (col, row) has its centre at
        origin + (col + .5) * pixel * u + (row + .5) * pixel * v, all in physical (x, y, z) units, u and v
        unit vectors. Returns what the browser needs to assemble the image from blocks:

        - `p0`, `du`, `dv`: the position of pixel (0, 0) and the step to the next column / row, in voxel
          index space of this level (voxel i has its centre at i), x, y, z. The pixel (col, row) samples the
          volume (trilinearly) at p0 + row * dv + col * du, evaluated in that order, in float64.
        - `blocks`: flat [gx, gy, gz, weight] * n, the non-empty blocks the image reads from, most needed
          first. weight = the number of pixels that read from the block. Blocks that are not listed are
          empty (zero) or outside the volume.
        Pixels that fall outside the volume read from no block and stay zero."""
        t0 = time.perf_counter()
        sp = np.array([self.spacing["x"], self.spacing["y"], self.spacing["z"]], dtype=np.float64)
        u = np.asarray(u, dtype=np.float64)
        v = np.asarray(v, dtype=np.float64)
        p0 = (np.asarray(origin, dtype=np.float64) + 0.5 * pixel * (u + v)) / sp - 0.5
        du = pixel * u / sp
        dv = pixel * v / sp
        dims = (self.dims["x"], self.dims["y"], self.dims["z"])
        bs = self.block_size
        nbx, nby, nbz = (self.block_grid[a] for a in "xyz")

        cols = np.arange(width, dtype=np.float64)[None, :]
        rows_per_band = max(1, 1_000_000 // width)
        key_parts: List[np.ndarray] = []
        count_parts: List[np.ndarray] = []
        for r0 in range(0, height, rows_per_band):
            r = np.arange(r0, min(height, r0 + rows_per_band), dtype=np.float64)[:, None]
            pos = [(p0[k] + r * dv[k]) + cols * du[k] for k in range(3)]
            # a superset of what the browser treats as inside (it tests without the tolerance)
            inside = np.ones(pos[0].shape, dtype=bool)
            for k in range(3):
                inside &= (pos[k] >= -0.5 - 1e-6) & (pos[k] < dims[k] - 0.5 + 1e-6)
            if not inside.any():
                continue
            lo: List[np.ndarray] = []
            hi: List[np.ndarray] = []
            for k in range(3):
                p = pos[k][inside]
                # the voxels a trilinear sample reads are floor(p) and floor(p) + 1 (clamped to the volume);
                # the tolerance keeps float rounding at an exact integer from losing a block
                lo.append(np.clip(np.floor(p - 1e-4), 0, dims[k] - 1).astype(np.int64) // bs)
                hi.append(np.clip(np.floor(p + 1e-4) + 1, 0, dims[k] - 1).astype(np.int64) // bs)
            differs = [hi[k] != lo[k] for k in range(3)]
            keys = [(lo[2] * nby + lo[1]) * nbx + lo[0]]
            for i in (0, 1):
                for j in (0, 1):
                    for k in (0, 1):
                        if not (i or j or k):
                            continue
                        sel = np.ones(lo[0].shape, dtype=bool)
                        if i:
                            sel &= differs[0]
                        if j:
                            sel &= differs[1]
                        if k:
                            sel &= differs[2]
                        if not sel.any():
                            continue
                        bx = (hi if i else lo)[0][sel]
                        by = (hi if j else lo)[1][sel]
                        bz = (hi if k else lo)[2][sel]
                        keys.append((bz * nby + by) * nbx + bx)
            uk, cnt = np.unique(np.concatenate(keys), return_counts=True)
            key_parts.append(uk)
            count_parts.append(cnt)

        blocks: List[int] = []
        total = 0
        if key_parts:
            uk, inverse = np.unique(np.concatenate(key_parts), return_inverse=True)
            weight = np.bincount(inverse.ravel(), weights=np.concatenate(count_parts)).astype(np.int64)
            bx = uk % nbx
            by = (uk // nbx) % nby
            bz = uk // (nbx * nby)
            per = self._blocks_per_brick
            in_grid = (bx // per < self.bricks["x"]) & (by // per < self.bricks["y"]) & (bz // per < self.bricks["z"])
            bx, by, bz, weight = bx[in_grid], by[in_grid], bz[in_grid], weight[in_grid]
            sizes = np.asarray(self._idx["size"])[bz // per, by // per, bx // per] if len(bx) else np.zeros(0)
            keep = sizes > 0
            bx, by, bz, weight = bx[keep], by[keep], bz[keep], weight[keep]
            order = np.argsort(-weight, kind="stable")  # the blocks most pixels read from first
            flat = np.stack([bx[order], by[order], bz[order], weight[order]], axis=1)
            blocks = flat.ravel().tolist()
            total = int(weight.sum())
        return {
            "width": int(width),
            "height": int(height),
            "dtype": self.dtype,
            "level": self.level,
            "blockSize": bs,
            "dims": dict(self.dims),
            "p0": p0.tolist(),
            "du": du.tolist(),
            "dv": dv.tolist(),
            "blocks": blocks,
            "totalWeight": total,
            "planMs": round((time.perf_counter() - t0) * 1000, 1),
        }

    def check_blocks(self, flat: List[int]) -> List[Tuple[int, int, int, int]]:
        """[gx, gy, gz, weight] * n (as plan_plane lists them) -> [(gx, gy, gz, weight)], validated."""
        if len(flat) % 4:
            raise SliceError("blocks must be a flat list of [gx, gy, gz, weight] groups")
        out = []
        for i in range(0, len(flat), 4):
            gx, gy, gz, w = flat[i], flat[i + 1], flat[i + 2], flat[i + 3]
            if not (0 <= gx < self.block_grid["x"] and 0 <= gy < self.block_grid["y"] and 0 <= gz < self.block_grid["z"]):
                raise SliceError(f"block ({gx}, {gy}, {gz}) is outside the volume")
            out.append((gx, gy, gz, min(max(w, 0), 1 << 30)))
        return out


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

# ------------------------------------------------------------ block streaming (the slice delivery)

BLOCK_HEADER = struct.Struct("<4I")  # gx, gy, gz, payload bytes
BLOCK_EMPTY = 0                      # payload size of a block whose brick is empty: all zero, no payload
BLOCK_ERROR = 0xFFFFFFFE             # payload size of a block that could not be read
STREAM_END = 0xFFFFFFFF              # gx, gy, gz of the closing record; the 4th field is the number of blocks sent
MAX_BLOCKS_PER_REQUEST = 40_000


class PriorityPool:
    """Worker threads that always take the queued job with the best priority (lowest tuple) first, ties in
    submission order. Block reads of every viewer share one, so the blocks that most pixels read from are read
    before the rest, whichever request they belong to."""

    def __init__(self, workers: int, name: str = "blocks"):
        self._queue: "queue.PriorityQueue" = queue.PriorityQueue()
        self._seq = itertools.count()
        self._workers = max(1, workers)
        self._name = name
        self._started = False
        self._lock = threading.Lock()

    def _start(self) -> None:
        with self._lock:
            if self._started:
                return
            for i in range(self._workers):
                threading.Thread(target=self._run, name=f"{self._name}-{i}", daemon=True).start()
            self._started = True

    def _run(self) -> None:
        while True:
            _, _, fn, args = self._queue.get()
            try:
                fn(*args)
            except Exception:  # a job reports its own failures; never kill the worker
                log.exception("block job failed")

    def submit(self, priority: tuple, fn, *args) -> None:
        self._start()
        self._queue.put((priority, next(self._seq), fn, args))

    @property
    def queued(self) -> int:
        return self._queue.qsize()


_BLOCK_POOL = PriorityPool(_NUM_WORKERS)


def encode_block(gx: int, gy: int, gz: int, payload: Optional[bytes], failed: bool = False) -> bytes:
    if failed:
        return BLOCK_HEADER.pack(gx, gy, gz, BLOCK_ERROR)
    if not payload:
        return BLOCK_HEADER.pack(gx, gy, gz, BLOCK_EMPTY)
    return BLOCK_HEADER.pack(gx, gy, gz, len(payload)) + payload


async def stream_blocks(
    vs: VolumeSlicesKiln,
    blocks: List[Tuple[int, int, int, int]],
    prefetch: bool = False,
    window: Optional[int] = None,
):
    """Async generator of the wire form of `blocks` ([(gx, gy, gz, weight)]), each record as soon as its block
    has been read, not in request order: header (4 x uint32 LE: gx, gy, gz, payload bytes) + payload, the block's
    voxels (z, y, x) in the transport dtype; a closing record (STREAM_END x3, count) tells a complete stream from
    a cut one.

    Reads go through the shared priority pool, best first: foreground before prefetch, then by weight. Only
    `window` reads are outstanding at a time (a slow client does not make the server read ahead without
    bound), and the generator cancelling (client gone) drops the queued rest."""
    loop = asyncio.get_running_loop()
    done: "asyncio.Queue" = asyncio.Queue()
    cancelled = threading.Event()
    window = window or _NUM_WORKERS * 4
    cls = 1 if prefetch else 0
    # the plan lists blocks best first, but a request may be a subset in any order: sort again
    todo = sorted(blocks, key=lambda b: -b[3])
    cursor = 0
    inflight = 0

    def work(gx: int, gy: int, gz: int) -> None:
        if cancelled.is_set():
            return
        try:
            arr = vs.read_block(gx, gy, gz)
            item = (gx, gy, gz, arr.tobytes() if arr is not None else None, False)
        except Exception:
            log.exception("reading block (%s, %s, %s) failed", gx, gy, gz)
            item = (gx, gy, gz, None, True)
        try:
            loop.call_soon_threadsafe(done.put_nowait, item)
        except RuntimeError:  # the loop is gone
            pass

    def feed() -> None:
        nonlocal cursor, inflight
        while inflight < window and cursor < len(todo):
            gx, gy, gz, weight = todo[cursor]
            cursor += 1
            inflight += 1
            _BLOCK_POOL.submit((cls, -weight), work, gx, gy, gz)

    sent = 0
    try:
        feed()
        while inflight:
            batch = [await done.get()]
            while len(batch) < 64 and not done.empty():
                batch.append(done.get_nowait())
            inflight -= len(batch)
            feed()
            sent += len(batch)
            yield b"".join(encode_block(*item[:3], item[3], item[4]) for item in batch)
        yield BLOCK_HEADER.pack(STREAM_END, STREAM_END, STREAM_END, sent)
    finally:
        cancelled.set()
