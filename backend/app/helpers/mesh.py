import subprocess
import os
import trimesh
from pathlib import Path


MESH_EXTENSIONS = ["GLB", "GLTF", "STL", "PLY", "OBJ", "OFF", "3MF"] # Subset from https://trimesh.org/formats.html
TEMP_MESH_FILE = "temp.ply"
TEMP_NEXUS_FILE = "temp.nxs"
OUTPUT_FILE = "mesh.nxz"


def convert_mesh_to_nxz(mesh_dir: Path, log) -> Path:
    files = os.listdir(mesh_dir)
    mesh_files = [file for file in files if file[-3:].upper() in MESH_EXTENSIONS]
    print(files[0][-3:].upper())
    if not mesh_files:
        raise ValueError("mesh_dir must contain at least one valid mesh file")

    input_file = mesh_dir / mesh_files[0]
    temp_mesh_file = mesh_dir / TEMP_MESH_FILE
    temp_nexus_file = mesh_dir / TEMP_NEXUS_FILE
    output_file = mesh_dir / OUTPUT_FILE

    # nxsbuild favors PLY. For 3MF and STL, we route through trimesh first.
    mesh = trimesh.load(input_file, force='mesh')
    log(f"Normalizing geometry to temporary PLY: {temp_mesh_file}")
    mesh.export(temp_mesh_file)

    log(f"Generating multi-resolution Nexus file...")
    # nxsbuild handles the spatial indexing and compression for 3DHOP
    cmd = ['nxsbuild', temp_mesh_file, '-o', temp_nexus_file]

    try:
        subprocess.run(cmd, check=True)
        log(f"Successfully generated multi-resolution Nexus file: {temp_nexus_file}")
    except subprocess.CalledProcessError as e:
        raise ValueError(f"Error during Nexus compilation: {e}")
    finally:
        # Cleanup temp files to prevent container bloat
        if os.path.exists(temp_mesh_file):
            os.remove(temp_mesh_file)
        if os.path.exists(input_file):
            os.remove(input_file)

    log(f"Compressing Nexus file to {output_file}...")
    cmd = ['nxscompress', temp_nexus_file, '-o', output_file]
    try:
        subprocess.run(cmd, check=True)
        log(f"Successfully compressed Nexus file: {output_file}")
    except subprocess.CalledProcessError as e:
        raise ValueError(f"Error during Nexus compilation: {e}")
    finally:
        if os.path.exists(temp_nexus_file):
            os.remove(temp_nexus_file)

    return output_file
