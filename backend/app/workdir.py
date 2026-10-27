"""Scratch ("processing") directory support.

Every asset gets a per-asset scratch folder under VG_PROCESSING_DIR —

    <VG_PROCESSING_DIR>/<kind>/<slug>/        kind: volumes | meshes | pointclouds

— and its final folder in VG_DATA_DIR (created up front, so it keeps claiming
the slug). In Docker the processing directory is typically a separate bind
mount (and the one nginx spools into), so multi-gigabyte archives, extracted
TIFF slices and tool temp files never touch the data volume.

What lives where, so that nothing is copied between the two after processing:

    volume      upload .zip   -> scratch       extracted / converted -> data
    mesh        upload        -> data          temp .ply/.nxs        -> scratch,
                                               compressed .nxz       -> data
    pointcloud  upload        -> scratch       octree export         -> data

Nothing is moved from scratch to data at the end: processing writes its result
straight into the data folder, and the scratch folder is simply discarded.

Uploads are not copied to their destination inside the request either. FastAPI
has already spooled the body to a temp file (in <VG_PROCESSING_DIR>/.tmp) by the
time the handler runs, and closes it right after the handler returns — before
background tasks start. So the handler only calls detach_upload(), which keeps
that temp file alive through a duplicated file descriptor, and the background
task copies it into place with save_detached(). The HTTP response therefore
goes out as soon as the last byte has arrived.

Behind nginx there is a path that copies nothing at all: the browser sends each
file as a raw request body to /api/uploads/<kind> (routers/uploads.py), nginx
writes that body to <VG_PROCESSING_DIR>/.uploads (meshes: <VG_DATA_DIR>/.uploads)
and tells the app only the file's name. The app renames it to an upload id, and
the create request later renames it again into its final place (accept_upload).
Both are renames within one filesystem, so each byte is written exactly once.
"""
import errno
import os
import re
import secrets
import shutil
import threading
import time
from pathlib import Path
from typing import NamedTuple

from fastapi import HTTPException

from .config import settings

KINDS = ("volumes", "meshes", "pointclouds")


def job_dir(kind: str, slug: str) -> Path:
    """The scratch folder of one asset. Only valid when enabled()."""
    return settings.PROCESSING_DIR / kind / slug


def work_dir_for(kind: str, slug: str, final_dir: Path) -> Path:
    """The asset's scratch folder (`final_dir` is only kept for call-site symmetry)."""
    return job_dir(kind, slug)


def prepare_work_dir(kind: str, slug: str, final_dir: Path) -> Path:
    """Like work_dir_for(), but also creates the scratch folder empty. Callers
    have already checked that the slug is free, so anything found at that path
    is left over from a job that no longer exists and is discarded."""
    work = work_dir_for(kind, slug, final_dir)
    if work != final_dir:
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir(parents=True)
    return work


def detach_upload(upload) -> int:
    """Returns a duplicate file descriptor of a Starlette UploadFile's spooled
    temp file. It stays valid after the request ends (when Starlette closes the
    upload); hand it to save_detached() — or close_detached() if the job is
    abandoned — exactly once."""
    upload.file.flush()
    return os.dup(upload.file.fileno())  # fileno() moves a small in-memory upload to disk first


def save_detached(fd, dst: Path) -> None:
    """Copies the whole file behind `fd` to `dst` and closes `fd`. Uses the
    kernel's copy_file_range where available (no data passes through Python),
    otherwise a plain read/write loop. A partial `dst` is removed on failure.
    `fd` None means the upload was already moved to `dst` (accept_upload)."""
    if fd is None:
        return
    try:
        size = os.fstat(fd).st_size
        done = 0
        use_kernel_copy = hasattr(os, "copy_file_range")
        with open(dst, "wb") as out:
            if not use_kernel_copy:
                os.lseek(fd, 0, os.SEEK_SET)
            while done < size:
                if use_kernel_copy:
                    try:
                        n = os.copy_file_range(fd, out.fileno(), size - done, done, done)
                    except OSError:  # e.g. cross-device on an old kernel, or unsupported fs
                        use_kernel_copy = False
                        os.lseek(fd, done, os.SEEK_SET)
                        continue
                else:
                    chunk = os.read(fd, 8 << 20)
                    out.write(chunk)
                    n = len(chunk)
                if n == 0:
                    raise OSError(f"upload ended after {done} of {size} bytes")
                done += n
    except BaseException:
        dst.unlink(missing_ok=True)
        raise
    finally:
        close_detached(fd)


def close_detached(fd) -> None:
    """Releases a descriptor from detach_upload() that will not be saved."""
    if fd is None:
        return
    try:
        os.close(fd)
    except OSError:
        pass


# ---------- Uploads handed over by nginx ----------

STAGING_NAME = ".uploads"
_UPLOAD_ID_RE = re.compile(r"^u(?P<uid>\d+)_(?P<token>[0-9a-f]{32})__(?P<name>[A-Za-z0-9][A-Za-z0-9._-]{0,119})$")
_NGINX_TEMP_RE = re.compile(r"^\d{10}$")  # name of a client_body temp file, no levels


class StagedUpload(NamedTuple):
    path: Path
    filename: str  # sanitized original file name


def staging_dir(kind: str) -> Path:
    """Where uploads of this kind wait for their create request: next to where they end
    up, so claiming one is a rename. kind: "volume" | "pointcloud" | "mesh"."""
    return (settings.DATA_DIR if kind == "mesh" else settings.PROCESSING_DIR) / STAGING_NAME


def safe_filename(name: str) -> str:
    name = Path((name or "").replace("\\", "/")).name
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", name)[-120:].lstrip("._-")
    return name or "upload"


def move_file(src: Path, dst: Path) -> None:
    """Renames src to dst; copies instead if they are on different filesystems."""
    try:
        os.replace(src, dst)
    except OSError as exc:
        if exc.errno != errno.EXDEV:
            raise
        print(f"[volume-gallery] {src} and {dst} are on different filesystems: copying instead of renaming")
        save_detached(os.open(src, os.O_RDONLY), dst)
        Path(src).unlink(missing_ok=True)


def new_upload_id(user_id: int, filename: str) -> str:
    return f"u{user_id}_{secrets.token_hex(16)}__{safe_filename(filename)}"


def stage_handed_file(kind: str, user_id: int, filename: str, nginx_file: str) -> tuple:
    """Takes over the temp file nginx wrote for an upload (`nginx_file` is the value of the
    X-Upload-File header; only its name is used, so the two containers need not agree on
    the mount path) and renames it to a fresh upload id. Returns (upload_id, size)."""
    src = staging_dir(kind) / Path(nginx_file).name
    if not _NGINX_TEMP_RE.fullmatch(src.name) or not src.is_file():
        # Most likely cause in practice: nginx and the app do not share the directory, or nginx
        # writes it as another user than the app runs as (files are 0600, the directory 0700).
        print(f"[volume-gallery] cannot see the upload file nginx announced ({nginx_file!r} -> {src}). "
              "Check that nginx and the app mount the same processing directory and run as the same uid (VG_UID/VG_GID).")
        raise HTTPException(status_code=400, detail="Upload hand-over failed: the app cannot see the file nginx wrote "
                                                    "(nginx and the app need the same processing directory and the same uid; see VG_UID)")
    size = src.stat().st_size  # before the rename: some bind mounts (Docker Desktop on Windows) show a just-renamed file late
    upload_id = new_upload_id(user_id, filename)
    move_file(src, staging_dir(kind) / upload_id)
    return upload_id, size


def claim_upload(upload_id: str, kind: str, user_id: int) -> StagedUpload:
    """The staged file behind an upload id returned by PUT /api/uploads/<kind>."""
    m = _UPLOAD_ID_RE.fullmatch(upload_id or "")
    path = staging_dir(kind) / upload_id if m else None
    if not m or int(m["uid"]) != user_id or not path.is_file():
        raise HTTPException(status_code=400, detail="Unknown or expired upload — please upload the file again")
    return StagedUpload(path, m["name"])


def accept_upload(upload, staged, dst: Path):
    """Puts an upload where it belongs. `staged` (a claimed upload id) is renamed to `dst`
    right away and None is returned; otherwise `upload` is a multipart UploadFile and its
    detached descriptor is returned, to be copied to `dst` later by save_detached()."""
    if staged is not None:
        move_file(staged.path, dst)
        return None
    return detach_upload(upload)


# Staged uploads a create request has claimed but whose move into the scratch folder has not
# happened yet (the move runs in the background task, see move_staged). Without this a second
# create request naming the same ids would still find the files and claim them as well.
_reserved: set = set()
_reserved_lock = threading.Lock()


def reserve_uploads(paths) -> None:
    """Marks claimed staged files as taken until drop_staged() releases them. Raises the
    same 400 as claim_upload() when another request already took one of them (or when the
    list names a file twice)."""
    paths = list(paths)
    with _reserved_lock:
        if len(set(paths)) != len(paths) or any(p in _reserved for p in paths):
            raise HTTPException(status_code=400, detail="Unknown or expired upload — please upload the file again")
        _reserved.update(paths)


def move_staged(moves) -> None:
    """Renames each reserved staged upload to its destination: `moves` is a list of
    (staged path, destination). A create request hands this to its background task, so
    the HTTP response does not wait for one rename per file (thousands for a TIFF stack,
    and slow on a bind mount such as Docker Desktop's)."""
    for src, dst in moves:
        move_file(src, dst)


def drop_staged(moves) -> None:
    """Always the last step of a create request's staged uploads, whether or not move_staged()
    ran or got through: deletes the ones that are still where they were staged and releases
    the reservation. Safe to call more than once."""
    for src, _dst in moves:
        Path(src).unlink(missing_ok=True)
    with _reserved_lock:
        _reserved.difference_update(src for src, _dst in moves)


_last_sweep = 0.0


def sweep_staging(force: bool = True) -> None:
    """Deletes staged uploads nobody claimed (the browser gave up, the create request
    failed, ...) once they are older than VG_UPLOAD_STAGING_MAX_AGE_HOURS. Without `force`
    it runs at most every 10 minutes (it is called from the upload requests).
    Files nginx is still receiving (names like 0000000001) are left alone: nginx deletes
    them itself when a request is aborted."""
    global _last_sweep
    now = time.time()
    if not force and now - _last_sweep < 600:
        return
    _last_sweep = now
    max_age = 3600 * settings.UPLOAD_STAGING_MAX_AGE_HOURS
    for kind in ("volume", "mesh"):
        base = staging_dir(kind)
        if not base.is_dir():
            continue
        for child in base.iterdir():
            try:
                if _NGINX_TEMP_RE.fullmatch(child.name) or not child.is_file():
                    continue
                if now - child.stat().st_mtime > max_age:
                    child.unlink()
            except OSError:
                pass


def discard_job(kind: str, slug: str) -> None:
    """Deletes an asset's scratch folder, if there is one."""
    shutil.rmtree(job_dir(kind, slug), ignore_errors=True)


def _remove(path: Path) -> None:
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path, ignore_errors=True)
    else:
        path.unlink(missing_ok=True)


def clear_stale(keep: set) -> None:
    """Startup housekeeping. Deletes every scratch folder except those in
    `keep` ((kind, slug) pairs — assets still waiting for their TIFF slices),
    plus the temp files of any previous run. Nothing is processing at startup,
    so everything else is left over from a crash or restart."""
    for kind in KINDS:
        base = settings.PROCESSING_DIR / kind
        if not base.is_dir():
            continue
        for child in base.iterdir():
            if (kind, child.name) not in keep:
                _remove(child)
    tmp = settings.PROCESSING_DIR / ".tmp"
    if tmp.is_dir():
        for child in tmp.iterdir():
            _remove(child)
