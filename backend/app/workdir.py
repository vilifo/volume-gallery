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
"""
import os
import shutil
from pathlib import Path

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


def save_detached(fd: int, dst: Path) -> None:
    """Copies the whole file behind `fd` to `dst` and closes `fd`. Uses the
    kernel's copy_file_range where available (no data passes through Python),
    otherwise a plain read/write loop. A partial `dst` is removed on failure."""
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


def close_detached(fd: int) -> None:
    """Releases a descriptor from detach_upload() that will not be saved."""
    try:
        os.close(fd)
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
