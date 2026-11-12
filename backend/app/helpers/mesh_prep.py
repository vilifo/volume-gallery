"""Reads an uploaded mesh with MeshLab and writes what nxsbuild wants: one PLY, and the texture images it refers to next to it.

Runs in a process of its own (python -m app.helpers.mesh_prep job.json): MeshLab is native code, and a file it cannot
digest can crash it outright, which must not take the web server down with it. The job file says what to do:

    {"input": ".../_upload.obj", "ply": ".../temp.ply", "work": ".../scratch",
     "images": [".../the textures the person uploaded with the mesh"], "missing": ["names of images that are not there"],
     "max_texture": 8192}

Progress goes to stdout as JSON lines: {"log": "text"}, and at the end {"result": {...}}.

What it does for the textures (a mesh can say where its texture is, in the file or in a .mtl, or not at all):
  * the texture the file refers to is used (kept at its own name, since a mesh may use several);
  * a mesh that has texture coordinates but whose texture could not be found (MeshLab puts a placeholder picture there,
    "missing" says which names are not there) gets the image that was uploaded with it (the first one when there are
    several), or loses its texture coordinates and its placeholder (a mesh with coordinates and no texture crashes the
    Nexus builder);
  * a single texture is written out at its own name (embedded ones have none: saving them by name would crash MeshLab)
    and scaled down when its longer side is over max_texture pixels.
"""
import json
import os
import re
import sys

PLY_TEXTURE_RE = re.compile(rb"comment\s+TextureFile\s+(.+?)\r?\n")


def _emit(kind, value):
    sys.stdout.write(json.dumps({kind: value}) + "\n")
    sys.stdout.flush()


def _scaled_copy(src, dst, max_side):
    """Writes the image at `src` as a PNG at `dst`, scaled down to at most `max_side` on its longer side.
    Returns (width, height, scaled)."""
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = 600_000_000  # a hostile "decompression bomb" is refused, a huge scan is not
    with Image.open(src) as im:
        im.load()
        w, h = im.size
        scaled = False
        if max_side and max(w, h) > max_side:
            f = max_side / max(w, h)
            im = im.resize((max(1, round(w * f)), max(1, round(h * f))), Image.LANCZOS)
            scaled = True
        if im.mode not in ("RGB", "RGBA", "L", "LA"):
            im = im.convert("RGBA" if "A" in im.getbands() or im.mode == "P" else "RGB")
        im.save(dst, "PNG")
        return im.size[0], im.size[1], scaled


def _untextured_copy(ms, layer, pymeshlab):
    """A copy of a layer's geometry (positions, faces, normals, colours) without texture coordinates or textures."""
    ms.set_current_mesh(layer)
    m = ms.current_mesh()
    kw = {"vertex_matrix": m.vertex_matrix(), "face_matrix": m.face_matrix()}
    normals = m.vertex_normal_matrix()
    if len(normals) == len(kw["vertex_matrix"]):  # (a mesh without normals gives an empty array)
        kw["v_normals_matrix"] = normals
    if m.has_vertex_color():
        kw["v_color_matrix"] = m.vertex_color_matrix()
    return pymeshlab.Mesh(**kw)


def prepare(job, log):
    import pymeshlab

    work = job["work"]
    os.makedirs(work, exist_ok=True)
    max_side = int(job.get("max_texture") or 0)
    images = list(job.get("images") or [])
    ms = pymeshlab.MeshSet()
    ms.load_new_mesh(job["input"])
    layers = ms.mesh_number()
    log(f"Loaded mesh: {layers} part{'s' if layers != 1 else ''}")
    notes = {"assigned": None, "stripped": False, "scaled": 0}
    missing = list(job.get("missing") or [])
    if missing:
        log(f"Not found next to the mesh: {', '.join(missing)}")
    strip = []  # layers that end up without a texture

    for i in range(layers):
        ms.set_current_mesh(i)
        c = ms.current_mesh()
        if c.has_vertex_tex_coord():
            ms.compute_texcoord_transfer_vertex_to_wedge()
            c = ms.current_mesh()
        has_uv = c.has_wedge_tex_coord() or c.has_vertex_tex_coord()
        n_tex = c.texture_number()
        if missing and n_tex == 1:
            n_tex = 0  # that one is the placeholder
        if n_tex == 1:
            png = os.path.join(work, f"texture_{i}.png")
            c.texture(0).save(png)
            w, h, scaled = _scaled_copy(png, png, max_side)
            notes["scaled"] += int(scaled)
            ms.set_texture_per_mesh(textname=png)
            log(f"Part {i}: texture {w} x {h}{' (scaled down)' if scaled else ''}")
        elif n_tex > 1:
            log(f"Part {i}: {n_tex} textures (they are packed into one)")
        elif has_uv and images:
            png = os.path.join(work, f"texture_{i}.png")
            w, h, scaled = _scaled_copy(images[0], png, max_side)
            notes["scaled"] += int(scaled)
            ms.set_texture_per_mesh(textname=png)
            notes["assigned"] = os.path.basename(images[0])
            log(f"Part {i}: no texture came with the mesh; using the uploaded image {notes['assigned']} ({w} x {h})"
                + (" (scaled down)" if scaled else "")
                + (" (more images were uploaded; the first is used: the file does not say which part uses which)" if len(images) > 1 else ""))
        elif has_uv or c.texture_number() > 0:
            strip.append(i)
            log(f"Part {i}: the mesh has texture coordinates but no texture image was found (an OBJ needs its .mtl and "
                "images next to it): shown without a texture. Upload the texture with the mesh to get it.")

    if strip:
        notes["stripped"] = True
        for i in strip:
            ms.add_mesh(_untextured_copy(ms, i, pymeshlab), mesh_name=f"untextured_{i}")
        for i in sorted(strip, reverse=True):  # (the copies were added at the end: the originals' numbers are unchanged)
            ms.set_current_mesh(i)
            ms.delete_current_mesh()
    if ms.mesh_number() > 1:
        ms.generate_by_merging_visible_meshes(mergevisible=True, deletelayer=True)
    c = ms.current_mesh()
    textured = c.texture_number() > 0
    ms.save_current_mesh(job["ply"], save_textures=True, save_vertex_normal=True, save_wedge_texcoord=textured)
    header = open(job["ply"], "rb").read(8192).split(b"end_header")[0]
    names = [m.decode("utf-8", "replace") for m in PLY_TEXTURE_RE.findall(header)]
    return {"faces": c.face_number(), "vertices": c.vertex_number(), "textures": names, **notes}


def main(argv):
    job = json.load(open(argv[1], encoding="utf-8"))
    _emit("result", prepare(job, lambda text: _emit("log", text)))


if __name__ == "__main__":
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    main(sys.argv)
