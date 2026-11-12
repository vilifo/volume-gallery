#!/usr/bin/env python3
"""
Migrate a volume directory produced by `volume_old.decompose_tiff_stack_old`
to the format produced by `volume.decompose_tiff_stack`.

Supports both out-of-place conversion (to a new directory) and atomic in-place
conversion (when input_dir == output_dir or output_dir is omitted).
"""

import argparse
import binascii
from concurrent.futures import ThreadPoolExecutor
import json
import mmap
import os
from pathlib import Path
import shutil
import struct
from typing import Dict, List, Optional, Tuple
import zlib

import numpy as np

try:
    from isal import igzip as fast_gzip
    from isal import isal_zlib as fast_zlib
except ImportError:
    fast_gzip = None
    fast_zlib = zlib

# Attempt to import project-specific definitions if run inside the package;
# fall back to identical standalone definitions otherwise.
try:
    from .slices import INDEX_DTYPE, percentile_window
except ImportError:
    INDEX_DTYPE = np.dtype([
        ("offset", "<u8"),
        ("size", "<u4"),
        ("min", "<f4"),
        ("max", "<f4"),
        ("avg", "<f4"),
    ])
    percentile_window = None

GZIP_HEADER = b"\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\xff"
TILED66_BOUNDS = ((0, 17), (17, 33), (33, 49), (49, 66))


def decompress_gzip(data: bytes | memoryview, expected_nbytes: int) -> bytes:
    if fast_gzip is not None:
        raw = fast_gzip.decompress(data)
    else:
        raw = fast_zlib.decompress(data, 16 + zlib.MAX_WBITS)
    if len(raw) != expected_nbytes:
        raise ValueError(
            f"Decompressed brick size mismatch: got {len(raw)} bytes, expected {expected_nbytes}"
        )
    return raw


def _compress_blocks_gzip(blocks: List[bytes], compresslevel: int) -> Tuple[bytes, np.ndarray]:
    """Compress a list of raw byte blocks into a single Gzip stream with Z_FULL_FLUSH boundaries."""
    cobj = fast_zlib.compressobj(compresslevel, zlib.DEFLATED, -zlib.MAX_WBITS)
    parts = [GZIP_HEADER]
    offsets = np.empty(len(blocks) + 1, dtype=np.uint32)
    cur_offset = len(GZIP_HEADER)

    crc = 0
    total_uncompressed = 0
    last_i = len(blocks) - 1

    for i, blk in enumerate(blocks):
        offsets[i] = cur_offset
        crc = binascii.crc32(blk, crc)
        total_uncompressed += len(blk)
        if i < last_i:
            comp = cobj.compress(blk) + cobj.flush(zlib.Z_FULL_FLUSH)
        else:
            comp = cobj.compress(blk) + cobj.flush(zlib.Z_FINISH)
        parts.append(comp)
        cur_offset += len(comp)

    offsets[len(blocks)] = cur_offset
    parts.append(struct.pack("<II", crc & 0xFFFFFFFF, total_uncompressed & 0xFFFFFFFF))
    return b"".join(parts), offsets


def _repack_brick(
    comp_bytes: bytes | memoryview,
    bx: int,
    by: int,
    bz: int,
    physical_size: int,
    dtype: np.dtype,
    use_tiled66: bool,
    compresslevel: int,
    extract_local_z: Optional[int] = None,
) -> Tuple[int, int, int, bytes, np.ndarray, float, float, float, Optional[np.ndarray]]:
    """
    Decompress an old contiguous 66^3 brick, compute exact float core stats,
    optionally extract a core XY slice (for LOD 0 suggestedWindow), and re-compress
    into either `tiled66` (LOD 0) or `z_sync` (LOD > 0).
    """
    expected_nbytes = (physical_size ** 3) * dtype.itemsize
    raw = decompress_gzip(comp_bytes, expected_nbytes)
    brick = np.frombuffer(raw, dtype=dtype).reshape((physical_size, physical_size, physical_size))

    core = brick[1:-1, 1:-1, 1:-1]
    b_min = float(core.min())
    b_max = float(core.max())
    b_avg = float(core.mean())

    mid_slice = None
    if extract_local_z is not None:
        # +1 accounts for the 1-voxel Z halo at index 0
        mid_slice = np.array(brick[1 + extract_local_z, 1:-1, 1:-1], copy=True)

    if use_tiled66:
        blocks = [
            np.ascontiguousarray(brick[za:zb, ya:yb, xa:xb]).tobytes()
            for za, zb in TILED66_BOUNDS
            for ya, yb in TILED66_BOUNDS
            for xa, xb in TILED66_BOUNDS
        ]
    else:
        blocks = [
            np.ascontiguousarray(brick[z]).tobytes()
            for z in range(physical_size)
        ]

    new_comp, block_offsets = _compress_blocks_gzip(blocks, compresslevel)
    return bx, by, bz, new_comp, block_offsets, b_min, b_max, b_avg, mid_slice


def _compute_suggested_window(mid_plane: np.ndarray) -> dict:
    if percentile_window is not None:
        try:
            return {**percentile_window(mid_plane), "source": "auto"}
        except Exception:
            pass
    lo, hi = np.percentile(mid_plane, [0.5, 99.5])
    return {
        "center": float((lo + hi) * 0.5),
        "width": float(max(hi - lo, 1e-3)),
        "source": "auto",
    }


def convert_volume_dir(
    input_dir: Path,
    output_dir: Optional[Path] = None,
    workers: int = 4,
    compresslevel: int = 3,
    batch_size: int = 256,
    log=print,
) -> Path:
    input_dir = Path(input_dir).resolve()
    in_place = (output_dir is None) or (Path(output_dir).resolve() == input_dir)
    target_dir = input_dir if in_place else Path(output_dir).resolve()
    target_dir.mkdir(parents=True, exist_ok=True)

    vol_json_path = input_dir / "volume.json"
    if not vol_json_path.is_file():
        raise FileNotFoundError(f"Missing volume.json in {input_dir}")

    vol_meta = json.loads(vol_json_path.read_text(encoding="utf-8"))
    brick_size = int(vol_meta.get("brickSize", 64))
    physical_size = int(vol_meta.get("physicalSize", brick_size + 2))
    if brick_size != 64 or physical_size != 66:
        raise ValueError(
            f"Expected brickSize=64 and physicalSize=66 for tiled66 layout, "
            f"got brickSize={brick_size}, physicalSize={physical_size}"
        )

    fmt = vol_meta.get("format", "uint8")
    dtype = np.dtype(fmt)
    w, h, d = vol_meta["originalDimensions"]
    max_lod = int(vol_meta["maxLod"])

    # Copy histogram.json if converting to a separate directory
    src_hist = input_dir / "histogram.json"
    if not in_place and src_hist.is_file():
        shutil.copy2(src_hist, target_dir / "histogram.json")

    suggested_window = vol_meta.get("suggestedWindow")
    new_levels_meta = []

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for lod in range(max_lod + 1):
            src_bin = input_dir / f"lod{lod}.bin"
            src_idx_path = input_dir / f"lod{lod}_index.json"
            if not src_bin.is_file() or not src_idx_path.is_file():
                raise FileNotFoundError(f"Missing LOD {lod} files in {input_dir}")

            old_idx = json.loads(src_idx_path.read_text(encoding="utf-8"))
            nx, ny, nz = old_idx["bricks"]
            total_bricks = int(old_idx["totalBricks"])
            old_entries: Dict[str, dict] = old_idx["entries"]

            # Find level dimensions from volume.json
            lvl_info = next((lvl for lvl in vol_meta.get("levels", []) if lvl["lod"] == lod), None)
            if lvl_info is not None:
                cw, ch, cd = lvl_info["dimensions"]
            else:
                cw = max(1, (w + (1 << lod) - 1) >> lod)
                ch = max(1, (h + (1 << lod) - 1) >> lod)
                cd = max(1, (d + (1 << lod) - 1) >> lod)

            use_tiled66 = (lod == 0)
            brick_layout = "tiled66" if use_tiled66 else "z_sync"
            n_offsets = 65 if use_tiled66 else (physical_size + 1)

            log(
                f"Converting LOD {lod} -> {brick_layout}: "
                f"{cw}x{ch}x{cd} ({nx}x{ny}x{nz} = {total_bricks} bricks)"
            )

            # Reconstruct mid_z plane on LOD 0 if suggestedWindow is not yet populated
            need_window = (lod == 0 and suggested_window is None)
            mid_z = cd // 2
            mid_bz = mid_z // brick_size
            mid_local_z = mid_z % brick_size
            mid_plane = np.empty((ny * brick_size, nx * brick_size), dtype=dtype) if need_window else None

            idx_array = np.zeros((nz, ny, nx), dtype=INDEX_DTYPE)
            subidx_array = np.zeros((nz, ny, nx, n_offsets), dtype=np.uint32)
            new_entries: Dict[str, dict] = {}

            tmp_prefix = f"._tmp_convert_lod{lod}.{os.getpid()}"
            tmp_bin_path = target_dir / f"{tmp_prefix}.bin"
            tmp_idx_json_path = target_dir / f"{tmp_prefix}_index.json"
            tmp_idx_npy_path = target_dir / f"{tmp_prefix}_index.npy"
            tmp_subidx_npy_path = target_dir / f"{tmp_prefix}_subindex.npy"

            coords = [
                (bx, by, bz)
                for bz in range(nz)
                for by in range(ny)
                for bx in range(nx)
            ]

            write_offset = 0
            processed = 0

            # Open in binary mode and memory-map so threads can slice without OS cursor/text-mode issues
            with open(src_bin, "rb") as f_in:
                with mmap.mmap(f_in.fileno(), 0, access=mmap.ACCESS_READ) as mm_in:
                    mv_in = memoryview(mm_in)
                    try:
                        with open(tmp_bin_path, "wb") as bf_out:
                            for batch_start in range(0, len(coords), batch_size):
                                batch = coords[batch_start : batch_start + batch_size]

                                def work(c, mv=mv_in):
                                    bx, by, bz = c
                                    key = f"{bx}/{by}/{bz}"
                                    entry = old_entries[key]
                                    off = int(entry["offset"])
                                    sz = int(entry["size"])
                                    comp = mv[off : off + sz]
                                    ext_z = mid_local_z if (need_window and bz == mid_bz) else None
                                    return _repack_brick(
                                        comp,
                                        bx,
                                        by,
                                        bz,
                                        physical_size,
                                        dtype,
                                        use_tiled66,
                                        compresslevel,
                                        extract_local_z=ext_z,
                                    )

                                for (
                                    bx,
                                    by,
                                    bz,
                                    new_comp,
                                    block_offsets,
                                    b_min,
                                    b_max,
                                    b_avg,
                                    mid_tile,
                                ) in pool.map(work, batch):
                                    comp_size = len(new_comp)
                                    brick_offset = write_offset
                                    bf_out.write(new_comp)
                                    write_offset += comp_size

                                    new_entries[f"{bx}/{by}/{bz}"] = {
                                        "offset": brick_offset,
                                        "size": comp_size,
                                        "min": b_min,
                                        "max": b_max,
                                        "avg": b_avg,
                                    }
                                    idx_array[bz, by, bx] = (brick_offset, comp_size, b_min, b_max, b_avg)
                                    subidx_array[bz, by, bx] = block_offsets

                                    if mid_tile is not None and mid_plane is not None:
                                        y0 = by * brick_size
                                        x0 = bx * brick_size
                                        mid_plane[y0 : y0 + brick_size, x0 : x0 + brick_size] = mid_tile

                                    processed += 1

                                log(f"  Repacked {processed}/{total_bricks} bricks")
                    finally:
                        # Release memoryview before closing mmap (required on Windows before os.replace)
                        mv_in.release()

            if need_window and mid_plane is not None:
                cropped_mid = mid_plane[:ch, :cw]
                suggested_window = _compute_suggested_window(cropped_mid)

            new_index_data = {
                "lod": lod,
                "brickSize": brick_size,
                "physicalSize": physical_size,
                "brickLayout": brick_layout,
                "bricks": [nx, ny, nz],
                "totalBricks": total_bricks,
                "totalBytes": write_offset,
                "compressed": True,
                "entries": new_entries,
            }

            tmp_idx_json_path.write_text(json.dumps(new_index_data, indent=2), encoding="utf-8")
            np.save(tmp_idx_npy_path, idx_array)
            np.save(tmp_subidx_npy_path, subidx_array)

            # Atomically move temporary files into their final filenames
            final_bin_path = target_dir / f"lod{lod}.bin"
            final_idx_json_path = target_dir / f"lod{lod}_index.json"
            final_idx_npy_path = target_dir / f"lod{lod}_index.npy"
            final_subidx_npy_path = (
                target_dir / f"lod{lod}_subindex.npy"
                if use_tiled66
                else target_dir / f"lod{lod}_zindex.npy"
            )

            os.replace(tmp_bin_path, final_bin_path)
            os.replace(tmp_idx_json_path, final_idx_json_path)
            os.replace(tmp_idx_npy_path, final_idx_npy_path)
            os.replace(tmp_subidx_npy_path, final_subidx_npy_path)

            # Clean up stale lod0_zindex.npy if upgrading from an intermediate version
            if use_tiled66:
                stale_zindex = target_dir / f"lod{lod}_zindex.npy"
                if stale_zindex.is_file():
                    stale_zindex.unlink()

            new_levels_meta.append({
                "lod": lod,
                "dimensions": [cw, ch, cd],
                "bricks": [nx, ny, nz],
                "brickCount": total_bricks,
                "brickLayout": brick_layout,
                "binFile": f"lod{lod}.bin",
                "indexFile": f"lod{lod}_index.json",
            })

    new_vol_meta = {
        "name": target_dir.name if not in_place else vol_meta.get("name", target_dir.name),
        "originalDimensions": [w, h, d],
        "voxelSpacing": vol_meta.get("voxelSpacing", [1, 1, 1]),
        "brickSize": brick_size,
        "physicalSize": physical_size,
        "maxLod": max_lod,
        "levels": new_levels_meta,
        "format": fmt,
        "packed": vol_meta.get("packed", True),
        "compressed": vol_meta.get("compressed", True),
        "suggestedWindow": suggested_window,
        "createdAt": vol_meta.get("createdAt"),
    }

    tmp_vol_json = target_dir / f"._tmp_volume.{os.getpid()}.json"
    tmp_vol_json.write_text(json.dumps(new_vol_meta, indent=2), encoding="utf-8")
    os.replace(tmp_vol_json, target_dir / "volume.json")

    log(f"\nMigration complete: {target_dir / 'volume.json'}")
    return target_dir


def main():
    parser = argparse.ArgumentParser(
        description="Convert volume_old.decompose_tiff_stack_old output to volume.decompose_tiff_stack format."
    )
    parser.add_argument("input_dir", type=Path, help="Path to the existing old-format volume directory")
    parser.add_argument(
        "output_dir",
        type=Path,
        nargs="?",
        default=None,
        help="Destination directory (omit or pass same path for atomic in-place upgrade)",
    )
    parser.add_argument("-w", "--workers", type=int, default=4, help="Number of worker threads (default: 4)")
    parser.add_argument(
        "-c", "--compresslevel", type=int, default=3, help="Gzip compression level (default: 3)"
    )
    parser.add_argument(
        "-b", "--batch-size", type=int, default=256, help="Bricks processed per batch (default: 256)"
    )
    args = parser.parse_args()

    convert_volume_dir(
        input_dir=args.input_dir,
        output_dir=args.output_dir,
        workers=args.workers,
        compresslevel=args.compresslevel,
        batch_size=args.batch_size,
    )


if __name__ == "__main__":
    main()