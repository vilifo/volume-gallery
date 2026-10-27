#!/usr/bin/env python3
"""
build_kiln_index.py

Generates sidecar binary index files (`lod{N}_index.npy`) and optional
precomputed window metadata (`suggested_window.json`) from existing
Kiln sharded volume datasets WITHOUT modifying `lod{N}.bin`,
`lod{N}_index.json`, or `volume.json`.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import sys
import time
from typing import Dict, List, Tuple
import zlib

import numpy as np

try:
    from isal import igzip as _fast_gzip
except ImportError:
    _fast_gzip = None

INDEX_DTYPE = np.dtype([
    ("offset", "<u8"),  # 8-byte unsigned byte offset in lodN.bin
    ("size",   "<u4"),  # 4-byte unsigned compressed size (0 = missing/empty)
    ("min",    "<f4"),  # 4-byte float minimum intensity
    ("max",    "<f4"),  # 4-byte float maximum intensity
    ("avg",    "<f4"),  # 4-byte float average intensity
])


def _decompress_gzip(data: bytes) -> bytes:
    if _fast_gzip is not None:
        return _fast_gzip.decompress(data)
    return zlib.decompress(data, 16 + zlib.MAX_WBITS)


def build_level_index(
    dataset_root: Path,
    lvl_meta: dict,
    default_compressed: bool = True,
    overwrite: bool = False,
    verify: bool = False,
) -> Tuple[int, Path, int, int, float]:
    """
    Build `lod{lod}_index.npy` from `lod{lod}_index.json` without modifying
    any existing files.

    Returns:
        (lod, npy_path, total_bricks, uniform_bricks, elapsed_seconds)
    """
    t0 = time.perf_counter()
    lod = int(lvl_meta["lod"])
    index_json_name = lvl_meta.get("indexFile", f"lod{lod}_index.json")
    bin_name = lvl_meta.get("binFile", f"lod{lod}.bin")

    json_path = dataset_root / index_json_name
    bin_path = dataset_root / bin_name
    npy_path = dataset_root / f"lod{lod}_index.npy"

    if not json_path.exists():
        raise FileNotFoundError(f"Missing index JSON: {json_path}")

    if npy_path.exists() and not overwrite:
        arr = np.load(npy_path, mmap_mode="r")
        total = int(arr.size)
        uniform = int(np.sum((arr["size"] == 0) | (arr["min"] == arr["max"])))
        return lod, npy_path, total, uniform, time.perf_counter() - t0

    with open(json_path, "r", encoding="utf-8") as f:
        idx_meta = json.load(f)

    bricks = idx_meta.get("bricks") or lvl_meta.get("bricks")
    if not bricks or len(bricks) != 3:
        raise ValueError(f"Invalid 'bricks' dimensions in {json_path}")

    nx, ny, nz = int(bricks[0]), int(bricks[1]), int(bricks[2])
    entries: Dict[str, dict] = idx_meta.get("entries") or {}

    arr = np.zeros((nz, ny, nx), dtype=INDEX_DTYPE)
    bin_size = bin_path.stat().st_size if (verify and bin_path.exists()) else None

    for key, entry in entries.items():
        s_bx, s_by, s_bz = key.split("/")
        bx, by, bz = int(s_bx), int(s_by), int(s_bz)

        offset = int(entry["offset"])
        size = int(entry["size"])
        b_min = float(entry.get("min", 0.0))
        b_max = float(entry.get("max", 0.0))
        b_avg = float(entry.get("avg", 0.0))

        if bin_size is not None and offset + size > bin_size:
            raise ValueError(
                f"LOD {lod} brick {key} (offset={offset}, size={size}) "
                f"exceeds {bin_path.name} size ({bin_size} bytes)"
            )

        arr[bz, by, bx] = (offset, size, b_min, b_max, b_avg)

    # Atomic write via temporary file so active readers never see a partial file
    tmp_path = npy_path.with_name(f"._tmp_lod{lod}_index.{os.getpid()}.npy")
    try:
        np.save(tmp_path, arr)
        os.replace(tmp_path, npy_path)
    finally:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass

    total_bricks = nx * ny * nz
    uniform_bricks = int(np.sum((arr["size"] == 0) | (arr["min"] == arr["max"])))
    elapsed = time.perf_counter() - t0
    return lod, npy_path, total_bricks, uniform_bricks, elapsed


def compute_middle_xy_window(
    dataset_root: Path,
    vol_meta: dict,
    lvl0_meta: dict,
    workers: int = 8,
) -> dict:
    """
    Extract the middle XY slice of LOD 0 using the newly built `lod0_index.npy`
    and compute robust [p0.5, p99.5] display window parameters.
    """
    w, h, d = (int(x) for x in lvl0_meta["dimensions"])
    nx, ny, nz = (int(x) for x in lvl0_meta["bricks"])
    brick_size = int(vol_meta.get("brickSize", 64))
    physical_size = int(vol_meta.get("physicalSize", brick_size + 2))
    compressed = bool(vol_meta.get("compressed", True))
    dtype = np.dtype(vol_meta.get("format", "uint8"))

    bin_path = dataset_root / lvl0_meta.get("binFile", "lod0.bin")
    npy_path = dataset_root / "lod0_index.npy"
    idx = np.load(npy_path, mmap_mode="r")

    mid_z = d // 2
    bz = mid_z // brick_size
    local_z = mid_z - bz * brick_size

    plane = np.zeros((h, w), dtype=dtype)
    coords = [(bx, by) for by in range(ny) for bx in range(nx)]

    fd = os.open(bin_path, os.O_RDONLY)
    try:
        def read_tile(coord: Tuple[int, int]):
            bx, by = coord
            entry = idx[bz, by, bx]
            size = int(entry["size"])
            b_min = float(entry["min"])
            b_max = float(entry["max"])

            if size == 0 or b_min == b_max:
                if b_min != 0.0:
                    y0 = by * brick_size
                    dy = min(brick_size, h - y0)
                    x0 = bx * brick_size
                    dx = min(brick_size, w - x0)
                    plane[y0 : y0 + dy, x0 : x0 + dx] = b_min
                return

            raw = os.pread(fd, size, int(entry["offset"]))
            if compressed:
                raw = _decompress_gzip(raw)
            brick = np.frombuffer(raw, dtype=dtype).reshape(
                (physical_size, physical_size, physical_size)
            )
            tile = brick[local_z + 1, 1:-1, 1:-1]
            y0 = by * brick_size
            dy = min(brick_size, h - y0)
            x0 = bx * brick_size
            dx = min(brick_size, w - x0)
            plane[y0 : y0 + dy, x0 : x0 + dx] = tile[:dy, :dx]

        with ThreadPoolExecutor(max_workers=workers) as pool:
            list(pool.map(read_tile, coords))
    finally:
        os.close(fd)

    lo, hi = np.percentile(plane, [0.5, 99.5])
    return {
        "center": float((lo + hi) * 0.5),
        "width": float(max(hi - lo, 1e-3)),
        "source": "auto",
    }


def process_dataset(
    dataset_root: Path,
    overwrite: bool = False,
    verify: bool = False,
    compute_window: bool = False,
    workers: int = 8,
) -> None:
    vol_json_path = dataset_root / "volume.json"
    if not vol_json_path.exists():
        raise FileNotFoundError(f"No volume.json found in {dataset_root}")

    with open(vol_json_path, "r", encoding="utf-8") as f:
        vol_meta = json.load(f)

    levels: List[dict] = vol_meta.get("levels") or []
    default_compressed = bool(vol_meta.get("compressed", True))

    print(f"=== Dataset: {dataset_root} ({len(levels)} LOD levels) ===")

    with ThreadPoolExecutor(max_workers=min(len(levels) or 1, workers)) as pool:
        futures = [
            pool.submit(
                build_level_index,
                dataset_root,
                lvl,
                default_compressed,
                overwrite,
                verify,
            )
            for lvl in levels
        ]
        for fut in futures:
            lod, npy_path, total, uniform, elapsed = fut.result()
            pct_uniform = (uniform / total * 100.0) if total > 0 else 0.0
            npy_kb = npy_path.stat().st_size / 1024.0
            print(
                f"  [LOD {lod}] -> {npy_path.name} ({npy_kb:.1f} KB) | "
                f"{total} bricks ({uniform} uniform/empty = {pct_uniform:.1f}% skippable) | "
                f"{elapsed * 1000:.1f} ms"
            )

    if compute_window and levels:
        win_path = dataset_root / "suggested_window.json"
        if not win_path.exists() or overwrite:
            t_win = time.perf_counter()
            lvl0 = next((l for l in levels if l.get("lod") == 0), levels[0])
            window_data = compute_middle_xy_window(dataset_root, vol_meta, lvl0, workers=workers)
            tmp_win = win_path.with_name(f"._tmp_window.{os.getpid()}.json")
            with open(tmp_win, "w", encoding="utf-8") as wf:
                json.dump(window_data, wf, indent=2)
            os.replace(tmp_win, win_path)
            print(
                f"  [Window] -> {win_path.name} (center={window_data['center']:.1f}, "
                f"width={window_data['width']:.1f}) | {(time.perf_counter() - t_win) * 1000:.1f} ms"
            )


def find_datasets(paths: List[Path], recursive: bool) -> List[Path]:
    found: List[Path] = []
    for p in paths:
        p = p.resolve()
        if (p / "volume.json").exists():
            found.append(p)
        elif recursive and p.is_dir():
            for vj in sorted(p.rglob("volume.json")):
                found.append(vj.parent)
        else:
            print(f"Warning: {p} does not contain volume.json (use -r to search recursively)", file=sys.stderr)
    return found


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build binary .npy brick indices for existing Kiln datasets without modifying existing files."
    )
    parser.add_argument(
        "paths",
        nargs="+",
        type=Path,
        help="Path(s) to dataset root directory (or parent directory when using --recursive).",
    )
    parser.add_argument(
        "-r", "--recursive",
        action="store_true",
        help="Recursively search for volume.json under the given path(s).",
    )
    parser.add_argument(
        "-f", "--overwrite",
        action="store_true",
        help="Overwrite existing lodN_index.npy files.",
    )
    parser.add_argument(
        "--verify",
        action="store_true",
        help="Verify that every brick's (offset + size) fits within lodN.bin.",
    )
    parser.add_argument(
        "--compute-window",
        action="store_true",
        help="Precompute middle-plane window into a sidecar suggested_window.json (leaves volume.json untouched).",
    )
    parser.add_argument(
        "-w", "--workers",
        type=int,
        default=min(16, (os.cpu_count() or 4) * 2),
        help="Worker threads for parallel index building / window calculation.",
    )

    args = parser.parse_args()
    datasets = find_datasets(args.paths, args.recursive)
    if not datasets:
        print("No datasets found.", file=sys.stderr)
        return 1

    for ds in datasets:
        process_dataset(
            ds,
            overwrite=args.overwrite,
            verify=args.verify,
            compute_window=args.compute_window,
            workers=args.workers,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())