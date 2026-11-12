#!/usr/bin/env python3
"""
Reconstruct a 2D TIFF slice stack (or a single 3D multipage TIFF) from a kiln
sharded binary volume directory (volume.json + lodN.bin + lodN_index.json).

Supports both `tiled66` (17/16/16/17 sub-blocks) and `z_sync` / `standard` (66^3)
brick layouts, processing one Z-brick layer at a time to keep RAM usage low.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import mmap
from pathlib import Path
from typing import Dict, Tuple
import zlib

import numpy as np
import tifffile

try:
    from isal import igzip as fast_gzip
    from isal import isal_zlib as fast_zlib
except ImportError:
    fast_gzip = None
    fast_zlib = zlib

TILED66_BOUNDS = ((0, 17), (17, 33), (33, 49), (49, 66))


def decompress_gzip(data: bytes | memoryview) -> bytes:
    if fast_gzip is not None:
        return fast_gzip.decompress(data)
    return fast_zlib.decompress(data, 16 + zlib.MAX_WBITS)


def decode_brick_core(
    comp_bytes: bytes | memoryview,
    dtype: np.dtype,
    brick_size: int,
    physical_size: int,
    is_tiled66: bool,
) -> np.ndarray:
    """
    Decompress a brick and return its unpadded core of shape
    (brick_size, brick_size, brick_size).
    """
    raw = decompress_gzip(comp_bytes)
    expected_nbytes = (physical_size ** 3) * dtype.itemsize
    if len(raw) != expected_nbytes:
        raise ValueError(
            f"Decompressed brick size mismatch: got {len(raw)} bytes, expected {expected_nbytes}"
        )

    if is_tiled66:
        if physical_size != 66:
            raise ValueError(f"tiled66 requires physical_size=66, got {physical_size}")
        brick = np.empty((66, 66, 66), dtype=dtype)
        mv = memoryview(raw)
        itemsize = dtype.itemsize
        pos = 0
        for z0, z1 in TILED66_BOUNDS:
            pz = z1 - z0
            for y0, y1 in TILED66_BOUNDS:
                py = y1 - y0
                for x0, x1 in TILED66_BOUNDS:
                    px = x1 - x0
                    nbytes = pz * py * px * itemsize
                    sub = np.frombuffer(mv[pos : pos + nbytes], dtype=dtype).reshape((pz, py, px))
                    brick[z0:z1, y0:y1, x0:x1] = sub
                    pos += nbytes
        return brick[1:-1, 1:-1, 1:-1]
    else:
        brick = np.frombuffer(raw, dtype=dtype).reshape(
            (physical_size, physical_size, physical_size)
        )
        # Return a contiguous copy of the 64^3 core (stripping the 1-voxel halo)
        return np.array(brick[1 : 1 + brick_size, 1 : 1 + brick_size, 1 : 1 + brick_size], copy=True)


def detect_is_tiled66(vol_dir: Path, vol_meta: dict, idx_meta: dict, lod: int) -> bool:
    if idx_meta.get("brickLayout") == "tiled66":
        return True
    if idx_meta.get("brickLayout") in ("z_sync", "standard"):
        return False
    for lvl in vol_meta.get("levels") or []:
        if lvl.get("lod") == lod:
            layout = lvl.get("brickLayout")
            if layout == "tiled66":
                return True
            if layout in ("z_sync", "standard"):
                return False
    return (vol_dir / f"lod{lod}_subindex.npy").is_file()


def export_volume_to_tiff(
    vol_dir: Path,
    output_path: Path,
    lod: int = 0,
    workers: int = 4,
    single_3d_tiff: bool = False,
    prefix: str = "slice_",
    compression: str | None = None,
    log=print,
) -> Path:
    vol_dir = Path(vol_dir).resolve()
    output_path = Path(output_path).resolve()

    vol_json_path = vol_dir / "volume.json"
    if not vol_json_path.is_file():
        raise FileNotFoundError(f"Missing volume.json in {vol_dir}")

    vol_meta = json.loads(vol_json_path.read_text(encoding="utf-8"))
    brick_size = int(vol_meta.get("brickSize", 64))
    physical_size = int(vol_meta.get("physicalSize", brick_size + 2))
    dtype = np.dtype(vol_meta.get("format", "uint8"))

    bin_path = vol_dir / f"lod{lod}.bin"
    idx_path = vol_dir / f"lod{lod}_index.json"
    if not bin_path.is_file() or not idx_path.is_file():
        raise FileNotFoundError(f"Missing lod{lod}.bin or lod{lod}_index.json in {vol_dir}")

    idx_meta = json.loads(idx_path.read_text(encoding="utf-8"))
    nx, ny, nz = idx_meta["bricks"]
    entries: Dict[str, dict] = idx_meta["entries"]

    # Determine exact cropped dimensions (W, H, D) for the requested LOD
    lvl_info = next((lvl for lvl in vol_meta.get("levels", []) if lvl["lod"] == lod), None)
    if lvl_info is not None:
        cw, ch, cd = lvl_info["dimensions"]
    else:
        w, h, d = vol_meta["originalDimensions"]
        cw = max(1, (w + (1 << lod) - 1) >> lod)
        ch = max(1, (h + (1 << lod) - 1) >> lod)
        cd = max(1, (d + (1 << lod) - 1) >> lod)

    is_tiled66 = detect_is_tiled66(vol_dir, vol_meta, idx_meta, lod)
    layout_str = "tiled66" if is_tiled66 else "z_sync/standard"
    log(
        f"Exporting LOD {lod} ({layout_str}): {cw}x{ch}x{cd} ({ dtype }) "
        f"from {nx}x{ny}x{nz} bricks..."
    )

    if single_3d_tiff:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        out_3d = np.empty((cd, ch, cw), dtype=dtype)
    else:
        output_path.mkdir(parents=True, exist_ok=True)
        out_3d = None

    num_digits = max(4, len(str(cd - 1)))

    with open(bin_path, "rb") as f_in:
        with mmap.mmap(f_in.fileno(), 0, access=mmap.ACCESS_READ) as mm_in:
            mv_in = memoryview(mm_in)
            try:
                with ThreadPoolExecutor(max_workers=workers) as pool:
                    for bz in range(nz):
                        z0 = bz * brick_size
                        z1 = min(cd, z0 + brick_size)
                        valid_dz = z1 - z0

                        # Allocate one Z-slab of core voxels in RAM: (valid_dz, ch, cw)
                        slab = np.empty((valid_dz, ch, cw), dtype=dtype)

                        xy_coords = [(bx, by) for by in range(ny) for bx in range(nx)]

                        def decode_xy(
                            coord: Tuple[int, int],
                            bz: int = bz,
                            mv: memoryview = mv_in,
                        ):
                            bx, by = coord
                            entry = entries[f"{bx}/{by}/{bz}"]
                            off = int(entry["offset"])
                            sz = int(entry["size"])
                            core = decode_brick_core(
                                mv[off : off + sz],
                                dtype=dtype,
                                brick_size=brick_size,
                                physical_size=physical_size,
                                is_tiled66=is_tiled66,
                            )
                            return bx, by, core

                        for bx, by, core in pool.map(decode_xy, xy_coords):
                            y0 = by * brick_size
                            y1 = min(ch, y0 + brick_size)
                            x0 = bx * brick_size
                            x1 = min(cw, x0 + brick_size)

                            slab[:, y0:y1, x0:x1] = core[:valid_dz, : (y1 - y0), : (x1 - x0)]

                        if single_3d_tiff and out_3d is not None:
                            out_3d[z0:z1] = slab
                        else:
                            def write_slice(local_z: int, z0: int = z0, slab: np.ndarray = slab):
                                z_idx = z0 + local_z
                                slice_path = output_path / f"{prefix}{z_idx:0{num_digits}d}.tif"
                                tifffile.imwrite(
                                    slice_path,
                                    slab[local_z],
                                    compression=compression,
                                )

                            list(pool.map(write_slice, range(valid_dz)))

                        log(f"  Exported Z slices {z0}..{z1 - 1} / {cd - 1}")
            finally:
                mv_in.release()

    if single_3d_tiff and out_3d is not None:
        log(f"Writing 3D TIFF to {output_path}...")
        tifffile.imwrite(
            output_path,
            out_3d,
            compression=compression,
            bigtiff=(out_3d.nbytes >= 2 * 1024 ** 3),
        )

    log(f"Export complete: {output_path}")
    return output_path


def main():
    parser = argparse.ArgumentParser(
        description="Convert a kiln sharded volume directory back to a 2D TIFF stack (or 3D TIFF)."
    )
    parser.add_argument("vol_dir", type=Path, help="Path to the volume directory containing volume.json")
    parser.add_argument(
        "output_path",
        type=Path,
        help="Destination folder for 2D TIFF slices (or .tif file path if --single-3d is set)",
    )
    parser.add_argument("--lod", type=int, default=0, help="LOD level to export (default: 0)")
    parser.add_argument("-w", "--workers", type=int, default=4, help="Worker threads (default: 4)")
    parser.add_argument(
        "--single-3d",
        action="store_true",
        help="Write a single multi-page 3D TIFF file instead of a directory of 2D slices",
    )
    parser.add_argument(
        "--prefix",
        type=str,
        default="slice_",
        help="Filename prefix for 2D slices (default: 'slice_')",
    )
    parser.add_argument(
        "--compression",
        type=str,
        default=None,
        help="Optional TIFF compression, e.g., 'zlib', 'lzw', or 'deflate' (default: uncompressed)",
    )
    args = parser.parse_args()

    export_volume_to_tiff(
        vol_dir=args.vol_dir,
        output_path=args.output_path,
        lod=args.lod,
        workers=args.workers,
        single_3d_tiff=args.single_3d,
        prefix=args.prefix,
        compression=args.compression,
    )


if __name__ == "__main__":
    main()