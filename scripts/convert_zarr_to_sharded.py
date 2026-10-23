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


@dask.delayed
def process_and_compress_brick(
        brick_block: np.ndarray,
        bx: int,
        by: int,
        bz: int
) -> Tuple[int, int, int, bytes, int, int, int]:
    """
    Compute core statistics (64^3) and gzip-compress the physical brick (66^3).
    Executed in parallel threads by Dask workers (both NumPy and gzip release the GIL).
    """
    # Ensure contiguous C-order layout: (Z, Y, X) in C-order matches
    # lx + ly * physicalSize + lz * physicalSize^2 in linear byte memory
    brick_block = np.ascontiguousarray(brick_block)

    # Extract 64^3 logical core (excluding 1-voxel border on each side)
    core = brick_block[1:-1, 1:-1, 1:-1]
    min_val = int(core.min())
    max_val = int(core.max())
    avg_val = int(np.floor(float(core.mean()) + 0.5))

    compressed = gzip.compress(brick_block.tobytes(), compresslevel=6)
    return bx, by, bz, compressed, min_val, max_val, avg_val


def downsample_dask_volume(vol: da.Array) -> da.Array:
    """
    Lazily downsample a (D, H, W) Dask array by 2x using a 2x2x2 average.
    Pads odd dimensions by edge-clamping, matching the TypeScript behavior.
    """
    d, h, w = vol.shape
    pad_d = d % 2
    pad_h = h % 2
    pad_w = w % 2

    if pad_d or pad_h or pad_w:
        vol = da.pad(vol, ((0, pad_d), (0, pad_h), (0, pad_w)), mode='edge')

    nd, nh, nw = vol.shape[0] // 2, vol.shape[1] // 2, vol.shape[2] // 2

    # Reshape into 2x2x2 blocks and compute mean with standard half-up rounding
    reshaped = vol.reshape((nd, 2, nh, 2, nw, 2))
    summed = reshaped.astype(np.float32).sum(axis=(1, 3, 5))
    downsampled = da.floor((summed / 8.0) + 0.5).astype(vol.dtype)

    return downsampled


def decompose_zarr(zarr_path: Path,
                     output_dir: Path,
                     spacing=(1, 1, 1),
                     brick_size=64,
                     max_lod=-1,
                     workers=4,
                     batch_size=128,
                     log=None,
                     ):
    # Configure Dask to use a multithreaded pool for shared-memory parallelism
    dask.config.set(scheduler="threads", num_workers=workers)
    if log is None: log = print

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

    lod_levels_meta = []
    current_vol = vol

    for lod in range(max_lod + 1):
        cd, ch, cw = current_vol.shape
        nx = math.ceil(cw / brick_size)
        ny = math.ceil(ch / brick_size)
        nz = math.ceil(cd / brick_size)
        total_bricks = nx * ny * nz

        log(f"\nProcessing & Packing LOD {lod}: {cw}x{ch}x{cd} ({nx}x{ny}x{nz} = {total_bricks} bricks)")

        # Pad volume with edge-clamped borders so all bricks slice cleanly to 66x66x66
        pad_x_after = max(0, nx * brick_size - cw) + 1
        pad_y_after = max(0, ny * brick_size - ch) + 1
        pad_z_after = max(0, nz * brick_size - cd) + 1

        padded_vol = da.pad(
            current_vol,
            ((1, pad_z_after), (1, pad_y_after), (1, pad_x_after)),
            mode="edge",
        )

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

        # Build list of brick coordinates in Z -> Y -> X order
        coords = [(bx, by, bz) for bz in range(nz) for by in range(ny) for bx in range(nx)]

        offset = 0
        processed = 0

        with open(bin_path, "wb") as bf:
            for i in range(0, len(coords), batch_size):
                batch_coords = coords[i: i + batch_size]
                tasks = []

                for bx, by, bz in batch_coords:
                    z0 = bz * brick_size
                    y0 = by * brick_size
                    x0 = bx * brick_size
                    brick_slice = padded_vol[
                        z0: z0 + physical_size,
                        y0: y0 + physical_size,
                        x0: x0 + physical_size,
                    ]
                    tasks.append(process_and_compress_brick(brick_slice, bx, by, bz))

                # Compute the batch of bricks in parallel using Dask threads
                results = dask.compute(*tasks)

                # Write compressed bytes sequentially to lodN.bin
                for bx, by, bz, compressed_bytes, b_min, b_max, b_avg in results:
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

        # Setup lazy 2x downsample graph for the next LOD level
        if lod < max_lod:
            current_vol = downsample_dask_volume(current_vol)
            # Rechunk downsampled array so deeper LODs don't suffer from tiny fragmented chunks
            current_vol = current_vol.rechunk((
                min(current_vol.shape[0], brick_size * 2),
                min(current_vol.shape[1], brick_size * 4),
                min(current_vol.shape[2], brick_size * 4),
            ))

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