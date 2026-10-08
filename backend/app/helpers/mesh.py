import subprocess
import os
import trimesh
from pathlib import Path

from ..config import settings


MESH_EXTENSIONS = ["GLB", "GLTF", "STL", "PLY", "OBJ", "OFF", "3MF"] # Subset from https://trimesh.org/formats.html
TEMP_MESH_FILE = "temp.ply"
TEMP_NEXUS_FILE = "temp.nxs"
OUTPUT_FILE = "mesh.nxz"


def convert_mesh_to_nxz(work_dir: Path, mesh_dir: Path, log) -> Path:
    files = os.listdir(mesh_dir)
    file = None
    for f in files:
        if Path(f).stem == "_upload":
            file = f
            break
    if file is None:
        raise ValueError(f"The _upload file not found in {mesh_dir}.")
    input_file = mesh_dir / file
    temp_mesh_file = work_dir / TEMP_MESH_FILE
    temp_nexus_file = work_dir / TEMP_NEXUS_FILE
    output_file = mesh_dir / OUTPUT_FILE

    # nxsbuild favors PLY. For 3MF and STL, we route through trimesh first.
    mesh = trimesh.load(input_file, force='mesh')
    log(f"Normalizing geometry to temporary PLY: {temp_mesh_file}")
    mesh.export(temp_mesh_file)

    log(f"Generating multi-resolution Nexus file...")
    # nxsbuild handles the spatial indexing and compression for 3DHOP
    cmd = [settings.NXSBUILD_BIN, str(temp_mesh_file), '-o', str(temp_nexus_file)]

    try:
        subprocess.run(cmd, check=True)
        log(f"Successfully generated multi-resolution Nexus file: {temp_nexus_file}")
    except subprocess.CalledProcessError as e:
        raise ValueError(f"Error during Nexus compilation: {e}")
    finally:
        # Cleanup temp files to prevent container bloat
        if os.path.exists(temp_mesh_file):
            os.remove(temp_mesh_file)

    log(f"Compressing Nexus file to {output_file}...")
    cmd = [settings.NXSCOMPRESS_BIN, str(temp_nexus_file), '-o', str(output_file)]
    try:
        subprocess.run(cmd, check=True)
        log(f"Successfully compressed Nexus file: {output_file}")
    except subprocess.CalledProcessError as e:
        raise ValueError(f"Error during Nexus compilation: {e}")
    finally:
        if os.path.exists(temp_nexus_file):
            os.remove(temp_nexus_file)

    return output_file
