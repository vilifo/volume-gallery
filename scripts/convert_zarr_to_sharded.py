import datetime
import gzip
import json
import math
import os
from pathlib import Path
from typing import Tuple

import dask
import dask.array as da
import numpy as np
import zarr


def load_zarr_as_dask(
        input_path: Path,
        brick_size: int
) -> Tuple[da.Array, Tuple[int, int, int], np.dtype]:
    """
    Lazily load a 3D Zarr array or group (e.g., OME-Zarr) as a Dask array
    with shape (D, H, W).
    """
    z = zarr.open(input_path, mode="r")

    if isinstance(z, zarr.Group):
        z = z["s0"]

    vol = da.from_zarr(z)

    # Squeeze out singleton channel/time dimensions if present (e.g. (1, D, H, W) -> (D, H, W))
    if vol.ndim > 3:
        squeezed = vol.squeeze()
        if squeezed.ndim == 3:
            vol = squeezed
        else:
            raise ValueError(
                f"Expected a 3D volume (D, H, W), but Zarr array has shape {vol.shape}. "
                f"Use --zarr-path to point to a specific 3D array."
            )
    elif vol.ndim != 3:
        raise ValueError(f"Expected 3D Zarr array (D, H, W), got shape {vol.shape}")

    d, h, w = vol.shape
    dtype = vol.dtype

    # Align Dask chunks to multiples of brick_size if underlying Zarr chunks are unaligned or too small
    chunk_d = min(d, max(brick_size * 2, vol.chunksize[0]))
    chunk_h = min(h, max(brick_size * 4, vol.chunksize[1]))
    chunk_w = min(w, max(brick_size * 4, vol.chunksize[2]))

    if (chunk_d, chunk_h, chunk_w) != vol.chunksize:
        vol = vol.rechunk((chunk_d, chunk_h, chunk_w))

    # Return volume (D, H, W) and dimensions in (W, H, D) order[cite: 1]
    return vol, (w, h, d), dtype


def _compress_brick(slab, z_off, y0, x0, ps, bx, by, bz, level):
    """Stats (core) + gzip of one physical brick, cut out of an in-RAM slab."""
    block = np.ascontiguousarray(slab[z_off:z_off + ps, y0:y0 + ps, x0:x0 + ps])
    core = block[1:-1, 1:-1, 1:-1]
    min_val = int(core.min())
    max_val = int(core.max())
    avg_val = int(np.floor(float(core.mean()) + 0.5))
    compressed = gzip.compress(block.tobytes(), compresslevel=level)
    return bx, by, bz, compressed, min_val, max_val, avg_val


def _downsample2x_block(a):
    """2x2x2 mean (half-up rounding, edge-clamped on odd dims) of a numpy block."""
    d, h, w = a.shape
    if d % 2 or h % 2 or w % 2:
        a = np.pad(a, ((0, d % 2), (0, h % 2), (0, w % 2)), mode="edge")
    acc = a[0::2, 0::2, 0::2].astype(np.float32)
    for oz in (0, 1):
        for oy in (0, 1):
            for ox in (0, 1):
                if oz or oy or ox:
                    acc += a[oz::2, oy::2, ox::2]
    acc *= 0.125
    acc += 0.5
    np.floor(acc, out=acc)
    return acc.astype(a.dtype)


def decompose_zarr(zarr_path: Path,
                     output_dir: Path,
                     spacing=(1, 1, 1),
                     brick_size=64,
                     max_lod=-1,
                     workers=4,
                     slab_gb=8.0,
                     compresslevel=6,
                     log=None,
                     ):
    """
        Slab-streaming version: each LOD is processed in Z slabs of k brick layers
        (+2 halo slices) held in RAM as one numpy array. Every source voxel is read
        once per LOD, bricks are cut from the slab and compressed on a thread pool,
        and the next LOD is downsampled from the same slab into an on-disk temp
        array (no lazy dask chain that re-reads / recomputes everything per batch).
        slab_gb is the RAM budget for one slab; raise it to use more memory.
        """
    from concurrent.futures import ThreadPoolExecutor

    # Dask is only used to read LOD 0 from Zarr (parallel chunk decompression)


    dask.config.set(scheduler="threads", num_workers=workers)
    log = log if log else print
    if brick_size % 2:
        raise ValueError("brick_size must be even")

    physical_size = brick_size + 2
    os.makedirs(output_dir, exist_ok=True)

    vol, dimensions, dtype = load_zarr_as_dask(zarr_path, brick_size)

    w, h, d = dimensions

    if dtype == np.uint8:
        bit_depth = 8
    elif dtype == np.uint16:
        bit_depth = 16
    else:
        raise ValueError(f"Unsupported TIFF data type: {dtype}. Expected uint8 or uint16.")

    if max_lod < 0:
        min_dim = min(w, h, d)
        max_lod = max(0, min(10, int(math.floor(math.log2(max(1, min_dim / brick_size))))))

    output_format = "uint16" if bit_depth == 16 else "uint8"
    itemsize = np.dtype(dtype).itemsize

    lod_levels_meta = []
    current_vol = vol  # dask array for LOD 0, np.memmap afterwards
    tmp_path = None

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for lod in range(max_lod + 1):
            cd, ch, cw = current_vol.shape
            nx = math.ceil(cw / brick_size)
            ny = math.ceil(ch / brick_size)
            nz = math.ceil(cd / brick_size)
            total_bricks = nx * ny * nz

            log(f"\nProcessing & Packing LOD {lod}: {cw}x{ch}x{cd} ({nx}x{ny}x{nz} = {total_bricks} bricks)")

            # Padded in-plane size: 1 voxel edge-clamped border before, >=1 after
            ph = ny * brick_size + 2
            pw = nx * brick_size + 2
            plane_bytes = ph * pw * itemsize
            k = int((int(slab_gb * 2 ** 30) - 2 * plane_bytes) // (brick_size * plane_bytes))
            k = max(1, min(nz, k))

            bin_path = os.path.join(output_dir, f"lod{lod}.bin")
            index_path = os.path.join(output_dir, f"lod{lod}_index.json")

            index_data = {
                "lod": lod,
                "brickSize": brick_size,
                "physicalSize": physical_size,
                "bricks": [nx, ny, nz],
                "totalBricks": total_bricks,
                "totalBytes": 0,
                "compressed": True,
                "entries": {},
            }

            next_mm = None
            next_path = None
            if lod < max_lod:
                next_path = os.path.join(output_dir, f"_tmp_lod{lod + 1}.npy")
                next_mm = np.lib.format.open_memmap(
                    next_path, mode="w+", dtype=dtype,
                    shape=((cd + 1) // 2, (ch + 1) // 2, (cw + 1) // 2))

            offset = 0
            processed = 0

            with open(bin_path, "wb") as bf:
                for bz0 in range(0, nz, k):
                    kz = min(k, nz - bz0)
                    depth = kz * brick_size + 2
                    z_start = bz0 * brick_size - 1  # source z of slab row 0

                    # ---- load slab (single read of the source) ----
                    slab = np.empty((depth, ph, pw), dtype=dtype)
                    src0 = max(0, z_start)
                    src1 = min(cd, z_start + depth)
                    dst0 = src0 - z_start
                    dst1 = dst0 + (src1 - src0)
                    target = slab[dst0:dst1, 1:1 + ch, 1:1 + cw]
                    if isinstance(current_vol, da.Array):
                        da.store(current_vol[src0:src1], target, lock=False)
                    else:
                        target[...] = current_vol[src0:src1]

                    # ---- edge-clamp borders (equivalent to np.pad(mode="edge")) ----
                    if dst0 > 0:
                        slab[:dst0, 1:1 + ch, 1:1 + cw] = slab[dst0:dst0 + 1, 1:1 + ch, 1:1 + cw]
                    if dst1 < depth:
                        slab[dst1:, 1:1 + ch, 1:1 + cw] = slab[dst1 - 1:dst1, 1:1 + ch, 1:1 + cw]
                    slab[:, 0, 1:1 + cw] = slab[:, 1, 1:1 + cw]
                    slab[:, 1 + ch:, 1:1 + cw] = slab[:, ch:ch + 1, 1:1 + cw]
                    slab[:, :, 0] = slab[:, :, 1]
                    slab[:, :, 1 + cw:] = slab[:, :, cw:cw + 1]

                    # ---- compress bricks in parallel, write in order ----
                    coords = [(bx, by, bz) for bz in range(bz0, bz0 + kz)
                              for by in range(ny) for bx in range(nx)]

                    def work(c, slab=slab, bz0=bz0):
                        bx, by, bz = c
                        return _compress_brick(
                            slab, (bz - bz0) * brick_size, by * brick_size, bx * brick_size,
                            physical_size, bx, by, bz, compresslevel)

                    for bx, by, bz, compressed_bytes, b_min, b_max, b_avg in pool.map(work, coords):
                        comp_size = len(compressed_bytes)
                        bf.write(compressed_bytes)
                        index_data["entries"][f"{bx}/{by}/{bz}"] = {
                            "offset": offset,
                            "size": comp_size,
                            "min": b_min,
                            "max": b_max,
                            "avg": b_avg,
                        }
                        offset += comp_size
                        processed += 1

                    log(f"Packed {processed}/{total_bricks} bricks")

                    # ---- downsample this slab into the next LOD (while it is in RAM) ----
                    if next_mm is not None:
                        rz = min(cd, (bz0 + kz) * brick_size) - bz0 * brick_size
                        core = slab[1:1 + rz, 1:1 + ch, 1:1 + cw]
                        parts = [(s, min(s + brick_size, rz)) for s in range(0, rz, brick_size)]
                        for s, out in pool.map(lambda p: (p[0], _downsample2x_block(core[p[0]:p[1]])), parts):
                            zo = (bz0 * brick_size + s) // 2
                            next_mm[zo:zo + out.shape[0]] = out
                    del slab, target

            index_data["totalBytes"] = offset
            with open(index_path, "w", encoding="utf-8") as jf:
                json.dump(index_data, jf, indent=2)

            lod_levels_meta.append({
                "lod": lod,
                "dimensions": [cw, ch, cd],
                "bricks": [nx, ny, nz],
                "brickCount": total_bricks,
                "binFile": f"lod{lod}.bin",
                "indexFile": f"lod{lod}_index.json",
            })

            # Switch to the freshly written LOD and drop the previous temp file
            if next_mm is not None:
                next_mm.flush()
            old_path = tmp_path
            current_vol = next_mm
            tmp_path = next_path
            if old_path:
                try:
                    os.remove(old_path)
                except OSError:
                    pass

    del current_vol
    if tmp_path:
        import gc
        gc.collect()
        try:
            os.remove(tmp_path)
        except OSError:
            pass

    # Write final volume.json
    volume_json = {
        "name": os.path.basename(os.path.abspath(output_dir)),
        "originalDimensions": [w, h, d],
        "voxelSpacing": spacing,
        "brickSize": brick_size,
        "physicalSize": physical_size,
        "maxLod": max_lod,
        "levels": lod_levels_meta,
        "format": output_format,
        "packed": True,
        "compressed": True,
        "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
    }

    volume_json_path = os.path.join(output_dir, "volume.json")
    with open(volume_json_path, "w", encoding="utf-8") as vf:
        json.dump(volume_json, vf, indent=2)

    log(f"\nProcessing finished. Metadata written to {volume_json_path}")
    return output_dir, max_lod