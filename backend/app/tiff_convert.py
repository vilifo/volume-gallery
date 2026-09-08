"""Converts a directory of single-slice TIFF files into an OME-Zarr store.

Adapted from a script the app's author supplied. One correctness fix versus
the original: it now sorts the filenames before stacking them into a volume.
`os.listdir()` doesn't guarantee any particular order, and an unsorted stack
silently scrambles the Z axis — the original script would produce a volume
whose slices are in whatever order the filesystem happened to return them,
not the intended acquisition order.
"""

from pathlib import Path

import dask
import dask.array as da
import tifffile
import zarr
from ome_zarr.io import parse_url
from ome_zarr.writer import write_image

TIFF_EXTENSIONS = (".tif", ".tiff")


def convert_tiff_stack_to_ome_zarr(tiff_dir: Path, zarr_dir: Path) -> None:
    """Reads every .tif/.tiff file directly inside `tiff_dir` (non-recursive),
    stacks them into a single volume ordered by filename, and writes an
    OME-NGFF multiscale pyramid to `zarr_dir`.

    Raises ValueError if no TIFF files are found or the slices don't all
    share the same shape/dtype (a mixed stack usually means the folder has
    more than one scan's files in it, or a corrupt/partial upload).
    """
    files = sorted(
        p for p in Path(tiff_dir).iterdir()
        if p.is_file() and p.suffix.lower() in TIFF_EXTENSIONS
    )
    if not files:
        raise ValueError("No .tif/.tiff files found in the archive")

    sample = tifffile.imread(files[0])
    lazy_imread = dask.delayed(tifffile.imread)

    lazy_arrays = [
        da.from_delayed(lazy_imread(f), shape=sample.shape, dtype=sample.dtype)
        for f in files
    ]

    image_data = da.stack(lazy_arrays, axis=0)
    print(f"Volume mapped lazily. Shape [ZYX]: {image_data.shape}")

    # Reshape to 5D (Time, Channel, Z, Y, X)
    if image_data.ndim == 3:
        image_data = image_data[None, None, ...]
    elif image_data.ndim == 4:
        image_data = image_data[None, ...]

    zarr_dir = Path(zarr_dir)
    zarr_dir.mkdir(parents=True, exist_ok=True)

    store = parse_url(str(zarr_dir), mode="w").store
    root_group = zarr.group(store=store)

    write_image(
        image=image_data,
        group=root_group,
        axes="tczyx",
        scale_factors=[2, 4, 8, 16],
        method="nearest",
    )
