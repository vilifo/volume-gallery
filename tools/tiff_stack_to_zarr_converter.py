import os
import tifffile
import dask
import dask.array as da
import zarr
from ome_zarr.writer import write_image
from argparse import ArgumentParser


def tiff_to_ome_zarr(tiff_path, zarr_path):
    # Retrieve and sort files to ensure correct Z-order
    files = [f for f in os.listdir(tiff_path) if f.endswith(".tif")]
    files = [os.path.join(tiff_path, f) for f in files]

    if not files:
        raise ValueError(f"No .tif files found in {tiff_path}")

    # Read one sample to get the dimensions and data type
    sample = tifffile.imread(files[0])

    # Wrap the tifffile.imread function to make it lazy
    lazy_imread = dask.delayed(tifffile.imread)

    # Create a list of lazy dask arrays, one for each file
    lazy_arrays = [
        da.from_delayed(lazy_imread(f), shape=sample.shape, dtype=sample.dtype)
        for f in files
    ]

    # Stack the 2D lazy arrays into a 3D Dask array along the Z-axis
    image_data = da.stack(lazy_arrays, axis=0)
    print(f"Volume mapped lazily. Shape [ZYX]: {image_data.shape}")

    # Reshape to 5D (Time, Channel, Z, Y, X)
    if image_data.ndim == 3:
        image_data = image_data[None, None, ...]
    elif image_data.ndim == 4:
        image_data = image_data[None, ...]

    os.makedirs(zarr_path, exist_ok=True)

    # Create the output Zarr store
    root_group = zarr.open_group(zarr_path, mode="w")

    # write_image will trigger the execution, reading and writing chunk-by-chunk
    print("Writing Zarr pyramid...")
    write_image(
        image=image_data,
        group=root_group,
        axes=["t", "c", "z", "y", "x"],
        scale_factors=[2, 4, 8, 16],
        method="nearest"
    )
    print("Done.")


if __name__ == "__main__":
    arg_parser = ArgumentParser()
    arg_parser.add_argument("tiff_path", type=str)
    arg_parser.add_argument("zarr_path", type=str)
    args = arg_parser.parse_args()
    tiff_to_ome_zarr(args.tiff_path, args.zarr_path)