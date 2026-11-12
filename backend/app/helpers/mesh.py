import io
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import threading
from pathlib import Path
from typing import Callable, Dict, List, Optional

from ..config import settings
from ..workdir import safe_filename


MESH_EXTENSIONS = ["GLB", "GLTF", "STL", "PLY", "OBJ", "OFF", "3MF"] # Subset from https://trimesh.org/formats.html
TEMP_MESH_FILE = "temp.ply"
TEMP_NEXUS_FILE = "temp.nxs"
OUTPUT_FILE = "mesh.nxz"

# Files that may come with a mesh. Most formats hold their texture inside (GLB, 3MF) or have none (STL, OFF); these
# point at image files (and, for OBJ, a .mtl that names them; for glTF, .bin buffers) that sit next to the mesh.
EXTRA_DIR = "_extra"  # in the mesh's folder: the files uploaded with the mesh, kept with it
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".bmp", ".tga", ".tif", ".tiff", ".webp"}
EXTRA_SUFFIXES = {"obj": IMAGE_SUFFIXES | {".mtl"}, "ply": IMAGE_SUFFIXES, "gltf": IMAGE_SUFFIXES | {".bin"}}
MAX_EXTRA_FILES = 32


def mesh_path(mesh_dir: Path) -> Path:
    return mesh_dir / OUTPUT_FILE


def extra_suffixes(extension: str) -> set:
    """The suffixes of the files that can come with a mesh of this format (empty: none can)."""
    return EXTRA_SUFFIXES.get((extension or "").lower().lstrip("."), set())


def extra_name(filename: str, extension: str) -> Optional[str]:
    """The name to store an uploaded extra file under, or None if a mesh of this format has no use for it."""
    name = safe_filename(filename)
    return name if Path(name).suffix.lower() in extra_suffixes(extension) else None


def list_extras(mesh_dir: Path) -> List[Path]:
    d = mesh_dir / EXTRA_DIR
    return sorted(p for p in d.iterdir() if p.is_file()) if d.is_dir() else []


# ------------------------------------------------------------------------- names the files ask for

_MTL_MAP_RE = re.compile(r"^\s*(?:map_\w+|bump|disp|decal|refl)\s+(.+?)\s*$", re.IGNORECASE | re.MULTILINE)


def _read_head(path: Path, limit: int) -> str:
    with open(path, "rb") as f:
        return f.read(limit).decode("utf-8", "replace")


def referenced_names(path: Path) -> List[str]:
    """The files a mesh (OBJ, PLY, glTF) or a material library (.mtl) asks for by name."""
    suffix = path.suffix.lower()
    try:
        if suffix == ".obj":
            names = []
            for m in re.finditer(r"^\s*mtllib\s+(.+?)\s*$", _read_head(path, 1 << 20), re.IGNORECASE | re.MULTILINE):
                names += m.group(1).split()
            return names
        if suffix == ".mtl":
            return [m.group(1).split()[-1] for m in _MTL_MAP_RE.finditer(_read_head(path, 4 << 20))]
        if suffix == ".ply":
            head = _read_head(path, 8192).split("end_header")[0]
            return [m.group(1).strip() for m in re.finditer(r"comment\s+TextureFile\s+(.+)", head)]
        if suffix == ".gltf":
            doc = json.loads(path.read_text(encoding="utf-8"))
            uris = [x.get("uri") for x in doc.get("images", []) + doc.get("buffers", [])]
            return [u for u in uris if isinstance(u, str) and not u.startswith("data:")]
    except (OSError, ValueError):
        pass
    return []


def _put(src: Path, dst: Path) -> None:
    dst.unlink(missing_ok=True)
    try:
        os.symlink(src, dst)
    except OSError:
        shutil.copyfile(src, dst)


def match_references(mesh_file: Path, extras: List[Path]) -> Dict[str, Path]:
    """Which uploaded extra file stands for each name the mesh (or one of its .mtl files) asks for. A person uploads
    "diffuse.jpg" for an .mtl that says "Material_0.png": names are matched by case and by their cleaned-up form."""
    from urllib.parse import unquote

    found: Dict[str, Path] = {}

    def want(ref: str) -> None:
        name = Path(unquote(ref.replace("\\", "/"))).name
        if not name or name.startswith(".") or name in found:
            return
        key = safe_filename(name).lower()
        for p in extras:
            if p.name.lower() == name.lower() or safe_filename(p.name).lower() == key:
                found[name] = p
                return

    for ref in referenced_names(mesh_file):
        want(ref)
    for mtl in [p for p in extras if p.suffix.lower() == ".mtl"] + [p for p in found.values() if p.suffix.lower() == ".mtl"]:
        for ref in referenced_names(mtl):
            want(ref)
    return found


def stage_sources(mesh_file: Path, extension: str, extras: List[Path], stage: Path, log: Callable[[str], None]) -> Path:
    """Lays the mesh and its extra files out in `stage` the way the mesh reader expects: next to each other, under
    the names the files ask for (a name nothing matches is left to the reader's fallback: the one uploaded image
    is used as the texture)."""
    stage.mkdir(parents=True, exist_ok=True)
    staged = stage / f"_upload.{extension}"
    _put(mesh_file, staged)
    for p in extras:
        _put(p, stage / p.name)
    for name, p in match_references(staged, extras).items():
        if name != p.name and not (stage / name).exists() and Path(name).name == name:
            _put(p, stage / name)
            log(f"Uploaded file {p.name} is used for the name the mesh asks for: {name}")
    return staged


def download_files(mesh_file: Path, arcname: str, extras: List[Path]) -> List[tuple]:
    """(name in the zip, path) for a download of the original upload together with the files that came with it:
    the extras under the names the mesh asks for, so that the unpacked folder opens in a 3D program."""
    named = {}
    for name, p in match_references(mesh_file, extras).items():
        if Path(name).name == name:
            named.setdefault(p, name)
    files = [(arcname, mesh_file)]
    used = {arcname}
    for p in extras:
        name = named.get(p, p.name)
        if name in used:
            name = p.name
        used.add(name)
        files.append((name, p))
    return files


def missing_images(staged: Path) -> List[str]:
    """Images the mesh (or its .mtl) names that are not next to it. The mesh reader puts a placeholder picture in
    their place, which must not end up on the mesh."""
    from urllib.parse import unquote

    names = list(referenced_names(staged))
    for mtl in sorted(staged.parent.glob("*.mtl")):
        names += referenced_names(mtl)
    out = []
    for ref in names:
        name = Path(unquote(ref.replace("\\", "/"))).name
        if Path(name).suffix.lower() in IMAGE_SUFFIXES and not (staged.parent / name).exists() and name not in out:
            out.append(name)
    return out


# ------------------------------------------------------------------------------------ Nexus files

def nxs_info(path: Path) -> dict:
    """What a Nexus (.nxs / .nxz) file holds: vertices, faces, whether it has texture coordinates, and its textures.
    `textures` lists (format, (width, height)) of each embedded image, "EMPTY" for one without bytes (the file
    names a texture but does not contain it: it would show untextured)."""
    b = Path(path).read_bytes()
    if len(b) < 88 or struct.unpack("<I", b[:4])[0] != 0x4E787320:
        raise ValueError("not a Nexus file")
    nverts, nfaces = struct.unpack("<QQ", b[8:24])
    vertex = [(b[24 + 2 * i], b[25 + 2 * i]) for i in range(8)]
    nodes, patches, ntex = struct.unpack("<III", b[60:72])
    off = 88 + nodes * 44 + patches * 12
    starts = [struct.unpack("<I", b[off + 68 * i: off + 68 * i + 4])[0] * 256 for i in range(ntex)]
    textures = []
    for i in range(max(0, ntex - 1)):  # the last entry is where the last texture ends
        data = b[starts[i]:starts[i + 1]]
        if not data:
            textures.append(("EMPTY", None))
            continue
        try:
            from PIL import Image
            with Image.open(io.BytesIO(data)) as im:
                textures.append((im.format, im.size))
        except Exception:
            textures.append(("UNREADABLE", None))
    return {"vertices": nverts, "faces": nfaces, "has_texcoords": vertex[3][1] > 0, "patches": patches, "textures": textures}


def texture_summary(info: dict) -> str:
    good = [t for t in info["textures"] if t[0] not in ("EMPTY", "UNREADABLE")]
    if not good:
        return "no texture"
    return ", ".join(f"{fmt} {size[0]} x {size[1]}" for fmt, size in good)


# --------------------------------------------------------------------------------- the conversion

def _run_prepare(job: dict, work_dir: Path, log: Callable[[str], None]) -> dict:
    """Runs mesh_prep in a process of its own and returns its result. A crash of MeshLab (it happens on files it
    cannot digest) or a timeout fails this one mesh, not the server."""
    job_file = work_dir / "prepare.json"
    job_file.write_text(json.dumps(job), encoding="utf-8")
    module = __name__.rsplit(".", 1)[0] + ".mesh_prep"
    backend_dir = Path(__file__).resolve().parents[2]
    # (the reader starts in the folder with the mesh: a texture it cannot find must not be picked up from somewhere else)
    env = {**os.environ, "QT_QPA_PLATFORM": "offscreen", "PYTHONPATH": os.pathsep.join(filter(None, [str(backend_dir), os.environ.get("PYTHONPATH")]))}
    proc = subprocess.Popen([sys.executable, "-m", module, str(job_file)], cwd=Path(job["input"]).parent, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")
    timeout = settings.CONVERTER_TIMEOUT_SECONDS or None
    timed_out = threading.Event()
    timer = None
    if timeout:
        def _kill():
            timed_out.set()
            proc.kill()
        timer = threading.Timer(timeout, _kill)
        timer.start()
    stderr_lines: List[str] = []
    reader = threading.Thread(target=lambda: stderr_lines.extend(proc.stderr.read().splitlines()), daemon=True)
    reader.start()
    result = None
    try:
        for line in proc.stdout:
            try:
                msg = json.loads(line)
            except ValueError:
                continue  # something MeshLab printed
            if "log" in msg:
                log(msg["log"])
            elif "result" in msg:
                result = msg["result"]
        proc.wait()
        reader.join(5)
    finally:
        if timer:
            timer.cancel()
    if timed_out.is_set():
        raise ValueError(f"Reading the mesh timed out after {settings.CONVERTER_TIMEOUT_SECONDS / 3600:g} hours (VG_CONVERTER_TIMEOUT_HOURS)")
    if proc.returncode != 0 or result is None:
        tail = next((l.strip() for l in reversed(stderr_lines) if l.strip() and not l.startswith("  ")), "")
        if proc.returncode is not None and proc.returncode < 0:
            raise ValueError(f"The mesh reader crashed (signal {-proc.returncode}); the file may be damaged or use something it cannot read")
        raise ValueError(f"The mesh could not be read: {tail or 'exit code ' + str(proc.returncode)}")
    return result


def convert_mesh_to_nxz(work_dir: Path, mesh_dir: Path, log) -> Path:
    """Reads mesh_dir/_upload.* (data folder) and the extra files in mesh_dir/_extra (textures, materials), keeps the
    intermediate .ply/.nxs in work_dir (scratch folder) and compresses the result directly to mesh_dir/mesh.nxz
    (data folder).

    MeshLab (in its own process) reads the mesh, merges its parts and writes a PLY with its textures; nxsbuild turns
    that into a Nexus file, EMBEDDING the textures (MeshLab's own Nexus writer leaves them out: the viewer would show
    the mesh grey); nxscompress compresses it."""
    file = next((f for f in os.listdir(mesh_dir) if Path(f).stem == "_upload"), None)
    if file is None:
        raise ValueError(f"The _upload file not found in {mesh_dir}.")
    input_file = mesh_dir / file
    extension = input_file.suffix.lstrip(".").lower()
    temp_mesh_file = work_dir / TEMP_MESH_FILE
    temp_nexus_file = work_dir / TEMP_NEXUS_FILE
    output_file = mesh_dir / OUTPUT_FILE

    extras = list_extras(mesh_dir)
    if extras:
        log(f"Files that came with the mesh: {', '.join(p.name for p in extras)}")
    staged = stage_sources(input_file, extension, extras, work_dir / "src", log)
    log("Reading the mesh and normalizing it to a temporary PLY")
    prepared = _run_prepare({
        "input": str(staged), "ply": str(temp_mesh_file), "work": str(work_dir / "textures"),
        "images": [str(p) for p in extras if p.suffix.lower() in IMAGE_SUFFIXES],
        "missing": missing_images(staged),
        "max_texture": settings.MESH_MAX_TEXTURE_SIZE,
    }, work_dir, log)
    log(f"Mesh: {prepared['vertices']:,} vertices, {prepared['faces']:,} faces")

    log("Generating multi-resolution Nexus file...")
    # nxsbuild handles the spatial indexing and compression for 3DHOP
    cmd = [settings.NXSBUILD_BIN, str(temp_mesh_file), '-o', str(temp_nexus_file)]
    try:
        subprocess.run(cmd, check=True, timeout=settings.CONVERTER_TIMEOUT_SECONDS or None,
                       env={**os.environ, "QT_QPA_PLATFORM": "offscreen"}, capture_output=True)
        log(f"Successfully generated multi-resolution Nexus file: {temp_nexus_file}")
    except FileNotFoundError:
        raise ValueError(f"{settings.NXSBUILD_BIN} was not found: it builds the viewable mesh (VG_NXSBUILD_BIN)")
    except subprocess.TimeoutExpired:
        raise ValueError(f"Nexus compilation timed out after {settings.CONVERTER_TIMEOUT_SECONDS / 3600:g} hours (VG_CONVERTER_TIMEOUT_HOURS)")
    except subprocess.CalledProcessError as e:
        detail = (e.stderr or b"").decode("utf-8", "replace").strip().splitlines()
        raise ValueError(f"Error during Nexus compilation: {detail[-1] if detail else e}")
    finally:
        # Cleanup temp files to prevent container bloat
        for p in [temp_mesh_file, *work_dir.glob("textures/*")]:
            p.unlink(missing_ok=True)

    log(f"Compressing Nexus file to {output_file}...")
    cmd = [settings.NXSCOMPRESS_BIN, str(temp_nexus_file), '-o', str(output_file)]
    try:
        subprocess.run(cmd, check=True, timeout=settings.CONVERTER_TIMEOUT_SECONDS or None,
                       env={**os.environ, "QT_QPA_PLATFORM": "offscreen"}, capture_output=True)
    except FileNotFoundError:
        raise ValueError(f"{settings.NXSCOMPRESS_BIN} was not found: it compresses the viewable mesh (VG_NXSCOMPRESS_BIN)")
    except subprocess.TimeoutExpired:
        output_file.unlink(missing_ok=True)
        raise ValueError(f"Nexus compression timed out after {settings.CONVERTER_TIMEOUT_SECONDS / 3600:g} hours (VG_CONVERTER_TIMEOUT_HOURS)")
    except subprocess.CalledProcessError as e:
        output_file.unlink(missing_ok=True)  # written straight into the data folder: drop the partial file
        detail = (e.stderr or b"").decode("utf-8", "replace").strip().splitlines()
        raise ValueError(f"Error during Nexus compression: {detail[-1] if detail else e}")
    finally:
        if os.path.exists(temp_nexus_file):
            os.remove(temp_nexus_file)

    # The textures must be in the file: a Nexus file that names a texture without containing it shows the mesh grey.
    try:
        info = nxs_info(output_file)
        if prepared["textures"] and not any(t[0] not in ("EMPTY", "UNREADABLE") for t in info["textures"]):
            log("Warning: the mesh has a texture but it is not in the converted file; it will be shown without it")
        else:
            log(f"Texture: {texture_summary(info)}")
    except (OSError, ValueError) as err:
        log(f"Could not check the converted file: {err}")
    return output_file
