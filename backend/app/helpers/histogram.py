"""Intensity histogram of a volume, shown behind the viewer's transfer function curve.

Stored as <volume dir>/histogram.json (next to the Zarr store, so it is deleted with the
volume):

    {"version": 1, "dtype": "uint16", "min": 0, "max": 40211, "bins": 1024, "counts": [...]}

`counts` is a histogram of the finest resolution level over [min, max] (the data's own
range). kiln-render draws its histogram over the transfer function's whole intensity axis
(for 16-bit data 0..65535), so the viewer resamples these counts onto that axis
(frontend/js/histogram.js); min and max are stored for exactly that.
"""
import json
import os
from pathlib import Path
from typing import Callable, Optional, Tuple

import dask
import dask.array as da
import numpy as np
import zarr

from ..config import settings
from .volume import _read_group_attrs, get_multiscales

HISTOGRAM_NAME = "histogram.json"
HISTOGRAM_BINS = 1024
_BLOCK_BYTES = 128 * 1024 * 1024  # uncompressed size of the pieces the volume is processed in


def histogram_path(vol_dir: Path) -> Path:
    return vol_dir / HISTOGRAM_NAME


def _finest_level(zarr_root: Path) -> zarr.Array:
    """The full-resolution array of an OME-Zarr multiscale pyramid (Zarr v2 or v3 layout)."""
    attrs = _read_group_attrs(zarr_root)
    multiscales = get_multiscales(attrs) if attrs is not None else None
    try:
        level_path = multiscales[0]["datasets"][0]["path"]
    except (TypeError, KeyError, IndexError):
        raise ValueError("no multiscale levels found in the Zarr store")
    return zarr.open_array(str(zarr_root / level_path), mode="r")


def _block_shape(arr: zarr.Array) -> Tuple[int, ...]:
    """Dask block shape: whole multiples of the storage chunks (64^3 here), grown towards
    _BLOCK_BYTES so a big volume gives thousands of tasks, not hundreds of thousands."""
    shape, block, itemsize = tuple(arr.shape), list(arr.chunks), arr.dtype.itemsize
    grew = True
    while grew:
        grew = False
        for axis in range(len(block) - 1, -1, -1):
            grown = min(block[axis] * 2, shape[axis])
            if grown == block[axis]:
                continue
            if int(np.prod(block)) // block[axis] * grown * itemsize > _BLOCK_BYTES:
                continue
            block[axis] = grown
            grew = True
    return tuple(block)


def compute_histogram(zarr_root: Path, hist_path: Path, bins: int = HISTOGRAM_BINS) -> dict:
    """Computes the histogram of the finest level and writes it to hist_path (atomically).
    Reads the volume twice (range, then counts). Returns what was written."""
    arr = _finest_level(zarr_root)
    darr = da.from_zarr(arr, chunks=_block_shape(arr))
    is_float = np.issubdtype(arr.dtype, np.floating)

    with dask.config.set(scheduler="threads", num_workers=max(1, settings.HISTOGRAM_THREADS)):
        if is_float:  # NaN / +-inf voxels are not data
            finite = da.isfinite(darr)
            lo, hi = da.min(da.where(finite, darr, np.inf)), da.max(da.where(finite, darr, -np.inf))
        else:
            lo, hi = da.min(darr), da.max(darr)
        vmin, vmax = dask.compute(lo, hi)
        if is_float and not (np.isfinite(vmin) and np.isfinite(vmax)):
            raise ValueError("the volume has no finite values")
        if vmin == vmax:  # constant volume: one spike, np.histogram would need a range
            counts = np.zeros(bins, dtype=np.int64)
            counts[0] = int(np.prod(arr.shape))
        else:
            counts = da.histogram(darr, bins=bins, range=(vmin, vmax))[0].compute()

    result = {
        "version": 1,
        "dtype": str(arr.dtype),
        "min": vmin.item(),
        "max": vmax.item(),
        "bins": bins,
        "counts": [int(c) for c in counts],
    }
    tmp = hist_path.with_name(hist_path.name + ".part")
    tmp.write_text(json.dumps(result, separators=(",", ":")))
    os.replace(tmp, hist_path)
    return result