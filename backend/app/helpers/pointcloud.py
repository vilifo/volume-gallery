"""Converts an uploaded point cloud into a Potree-compatible octree, for
streaming display with the Potree.js viewer.

PotreeConverter is NOT bundled with this app — see the README's "Meshes and
point clouds" section. This module assumes it's on PATH (or at whatever path
VG_POTREE_CONVERTER_BIN points at) and raises a clear, actionable error
(surfaced via the point cloud's status log, same as any other processing
failure) if it isn't found.
"""
import shutil
import os
from pathlib import Path
import subprocess

from ..config import settings


def convert_pointcloud(source_path: Path, output_dir: Path, log=None) -> None:
    """source_path: the uploaded point cloud file (las/laz/ply/xyz/ptx —
    whatever the PotreeConverter build on your system supports).
    output_dir: where PotreeConverter writes its octree + metadata.json — the
    point cloud's folder in the data directory, so nothing is copied afterwards.
    The source file (in the scratch folder) is deleted when done; a partial
    octree is removed if the conversion fails."""
    def _log(msg: str) -> None:
        if log:
            log(msg)

    output_dir.mkdir(parents=True, exist_ok=True)
    _log("Building Potree octree from point cloud...")
    cmd = settings.POTREE_CONVERTER_BIN, str(source_path.resolve()), "-o", str(output_dir.resolve())
    try:
        subprocess.run(cmd, check=True)
        _log(f"Successfully generated potree folder: {output_dir}")
    except subprocess.CalledProcessError as e:
        shutil.rmtree(output_dir, ignore_errors=True)
        raise ValueError(f"Error during Potree conversion: {e}")
    finally:
        source_path.unlink(missing_ok=True)  # was rmtree(), a silent no-op on a file

    metadata_path = output_dir / "metadata.json"
    if not metadata_path.exists():
        raise RuntimeError(
            "PotreeConverter reported success but produced no metadata.json "
            f"in {output_dir} — check its actual output directory layout "
            "matches what this app expects (see pointcloud_convert.py)."
        )