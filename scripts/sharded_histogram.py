\
#!/usr/bin/env python3
"""Compute the finest-LOD voxel histogram from a kiln sharded volume.

Input is a volume directory containing volume.json, lod0.bin and
lod0_index.json (or the path to volume.json). Each LOD0 brick is gzip
compressed and contains a one-voxel halo on every side; only the core voxels
are included in the histogram.
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
from pathlib import Path

try:
    import numpy as np
except ImportError:
    print("error: NumPy is required. Install it with: python -m pip install numpy", file=sys.stderr)
    raise SystemExit(2)

DEFAULT_BINS = 1024
HISTOGRAM_NAME = "histogram.json"


def load_metadata(input_path: Path) -> tuple[Path, dict]:
    if input_path.is_file():
        if input_path.name == "volume.json":
            volume_dir = input_path.parent
        else:
            raise ValueError("input file must be volume.json; otherwise pass the volume directory")
    elif input_path.is_dir():
        volume_dir = input_path
    else:
        raise FileNotFoundError(f"input path does not exist: {input_path}")

    meta_path = volume_dir / "volume.json"
    if not meta_path.is_file():
        raise FileNotFoundError(f"missing metadata file: {meta_path}")
    with meta_path.open("r", encoding="utf-8") as f:
        meta = json.load(f)

    if not meta.get("levels"):
        raise ValueError(f"{meta_path} has no LOD levels")
    level0 = next((level for level in meta["levels"] if int(level.get("lod", -1)) == 0), None)
    if level0 is None:
        raise ValueError("volume.json does not describe LOD 0")
    return volume_dir, level0


def iter_core_bricks(volume_dir: Path, level: dict, dtype: np.dtype):
    bin_path = volume_dir / level.get("binFile", "lod0.bin")
    index_path = volume_dir / level.get("indexFile", "lod0_index.json")
    if not bin_path.is_file():
        raise FileNotFoundError(f"missing sharded binary: {bin_path}")
    if not index_path.is_file():
        raise FileNotFoundError(f"missing brick index: {index_path}")

    with index_path.open("r", encoding="utf-8") as f:
        index = json.load(f)

    brick_size = int(index["brickSize"])
    physical_size = int(index.get("physicalSize", brick_size + 2))
    if physical_size != brick_size + 2:
        raise ValueError(
            f"unexpected physicalSize={physical_size}; expected brickSize + 2 ({brick_size + 2})"
        )
    expected_bytes = physical_size ** 3 * dtype.itemsize

    with bin_path.open("rb") as bf:
        for key, entry in index["entries"].items():
            offset, size = int(entry["offset"]), int(entry["size"])
            bf.seek(offset)
            compressed = bf.read(size)
            if len(compressed) != size:
                raise ValueError(f"truncated brick {key}: expected {size} compressed bytes")
            raw = gzip.decompress(compressed)
            if len(raw) != expected_bytes:
                raise ValueError(
                    f"brick {key} decoded to {len(raw)} bytes; expected {expected_bytes}"
                )
            physical = np.frombuffer(raw, dtype=dtype).reshape(
                (physical_size, physical_size, physical_size)
            )
            # Exclude the one-voxel halo: halos duplicate adjacent voxels.
            core = physical[1:-1, 1:-1, 1:-1]
            # Edge bricks can extend past the true volume dimensions. Clip them.
            yield key, core


def compute_histogram(input_path: Path, output_dir: Path, bins: int = DEFAULT_BINS) -> dict:
    if bins < 1:
        raise ValueError("--bins must be at least 1")

    volume_dir, level0 = load_metadata(input_path)
    meta_path = volume_dir / "volume.json"
    with meta_path.open("r", encoding="utf-8") as f:
        meta = json.load(f)

    fmt = str(meta.get("format", "")).lower()
    if fmt not in ("uint8", "uint16"):
        raise ValueError(f"unsupported volume format {fmt!r}; expected uint8 or uint16")
    dtype = np.dtype(fmt)

    dimensions = level0.get("dimensions")
    if not dimensions or len(dimensions) != 3:
        raise ValueError("LOD 0 metadata must contain dimensions [width, height, depth]")
    width, height, depth = map(int, dimensions)
    index_path = volume_dir / level0.get("indexFile", "lod0_index.json")
    with index_path.open("r", encoding="utf-8") as f:
        index = json.load(f)
    brick_size = int(index["brickSize"])

    # Use index brick coordinates and actual dimensions to clip boundary bricks.
    grid = index.get("bricks")
    if not grid or len(grid) != 3:
        raise ValueError("brick index must contain bricks [nx, ny, nz]")

    vmin, vmax = None, None
    counts = np.zeros(bins, dtype=np.int64)
    # Integer values allow us to derive exact bounds from brick metadata, but
    # decoding the cores below also validates the binary and counts only real voxels.
    brick_entries = index.get("entries", {})
    if not brick_entries:
        raise ValueError("brick index contains no entries")

    # First pass: exact value range, using per-brick core min/max written by the converter.
    for key, entry in brick_entries.items():
        if "min" not in entry or "max" not in entry:
            raise ValueError(f"brick {key} has no min/max statistics")
        lo, hi = int(entry["min"]), int(entry["max"])
        vmin = lo if vmin is None else min(vmin, lo)
        vmax = hi if vmax is None else max(vmax, hi)
    if vmin is None or vmax is None:
        raise ValueError("could not determine volume value range")

    # Match the backend's histogram semantics: constant volumes have one spike
    # in bin zero; otherwise bins span [min, max], with max included in the last bin.
    total_voxels = 0
    bin_width = None if vmin == vmax else (vmax - vmin) / bins
    bin_path = volume_dir / level0.get("binFile", "lod0.bin")
    with bin_path.open("rb") as bf:
        for key, entry in brick_entries.items():
            bx, by, bz = map(int, key.split("/"))
            x0, y0, z0 = bx * brick_size, by * brick_size, bz * brick_size
            cw = max(0, min(brick_size, width - x0))
            ch = max(0, min(brick_size, height - y0))
            cd = max(0, min(brick_size, depth - z0))
            if not (cw and ch and cd):
                continue
            offset, size = int(entry["offset"]), int(entry["size"])
            bf.seek(offset)
            compressed = bf.read(size)
            if len(compressed) != size:
                raise ValueError(f"truncated brick {key}: expected {size} compressed bytes")
            raw = gzip.decompress(compressed)
            physical_size = int(index.get("physicalSize", brick_size + 2))
            expected_bytes = physical_size ** 3 * dtype.itemsize
            if len(raw) != expected_bytes:
                raise ValueError(
                    f"brick {key} decoded to {len(raw)} bytes; expected {expected_bytes}"
                )
            physical = np.frombuffer(raw, dtype=dtype).reshape(
                (physical_size, physical_size, physical_size)
            )
            values = physical[1:1 + cd, 1:1 + ch, 1:1 + cw].reshape(-1)
            total_voxels += int(values.size)
            if vmin == vmax:
                counts[0] += values.size
            else:
                # Equivalent to a fixed-range histogram over [vmin, vmax].
                idx = ((values.astype(np.float64) - vmin) * (bins / (vmax - vmin))).astype(np.int64)
                idx = np.clip(idx, 0, bins - 1)
                counts += np.bincount(idx, minlength=bins)

    expected_voxels = width * height * depth
    if total_voxels != expected_voxels:
        raise ValueError(
            f"voxel count mismatch: read {total_voxels}, expected {expected_voxels}; "
            "check the LOD0 brick index and dimensions"
        )

    result = {
        "version": 1,
        "dtype": str(dtype),
        "min": int(vmin),
        "max": int(vmax),
        "bins": bins,
        "counts": [int(c) for c in counts],
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    target = output_dir / HISTOGRAM_NAME
    tmp = target.with_name(target.name + ".part")
    tmp.write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, target)
    print(f"Histogram saved to: {target}")
    print(f"Dimensions: {width}x{height}x{depth}; dtype: {dtype}; range: {vmin}..{vmax}")
    print(f"Voxels: {total_voxels:,}; bins: {bins}")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Compute a histogram from a kiln sharded volume's finest LOD (LOD 0)."
    )
    parser.add_argument("input", type=Path, help="volume directory or its volume.json file")
    parser.add_argument("output_dir", type=Path, help="directory in which histogram.json is written")
    parser.add_argument("--bins", type=int, default=DEFAULT_BINS, help=f"number of bins (default: {DEFAULT_BINS})")
    args = parser.parse_args()
    try:
        compute_histogram(args.input, args.output_dir, args.bins)
    except (OSError, ValueError, KeyError, json.JSONDecodeError, gzip.BadGzipFile) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
