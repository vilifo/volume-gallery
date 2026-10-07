"""Scratch ("processing") directory support.

By default every upload is saved, unpacked and converted inside the asset's own
folder under VG_DATA_DIR. If VG_PROCESSING_DIR is set, that work happens in a
per-asset scratch folder under it instead —

    <VG_PROCESSING_DIR>/<kind>/<slug>/        kind: volumes | meshes | pointclouds

— and only the finished result is moved into the asset's folder in VG_DATA_DIR
(which is still created up front, so it keeps claiming the slug). In Docker the
processing directory is typically a separate bind mount, so multi-gigabyte
archives, extracted TIFF slices and half-written stores never touch the data
volume.

The routers call these helpers unconditionally: with no processing directory
configured, `work_dir_for()` simply returns the asset's data folder and every
other helper is a no-op, which is exactly the previous behaviour.
"""
import errno
import os
import shutil
from pathlib import Path

from .config import settings

KINDS = ("volumes", "meshes", "pointclouds")


def enabled() -> bool:
    return settings.PROCESSING_DIR is not None


def job_dir(kind: str, slug: str) -> Path:
    """The scratch folder of one asset. Only valid when enabled()."""
    return settings.PROCESSING_DIR / kind / slug


def work_dir_for(kind: str, slug: str, final_dir: Path) -> Path:
    """Where this asset's upload is staged and processed: its scratch folder if
    a processing directory is configured, otherwise `final_dir` itself."""
    return job_dir(kind, slug) if enabled() else final_dir


def prepare_work_dir(kind: str, slug: str, final_dir: Path) -> Path:
    """Like work_dir_for(), but also creates the scratch folder empty. Callers
    have already checked that the slug is free, so anything found at that path
    is left over from a job that no longer exists and is discarded."""
    work = work_dir_for(kind, slug, final_dir)
    if work != final_dir:
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir(parents=True)
    return work


def discard_job(kind: str, slug: str) -> None:
    """Deletes an asset's scratch folder, if there is one."""
    if enabled():
        shutil.rmtree(job_dir(kind, slug), ignore_errors=True)


def move_into_place(src: Path, dst: Path) -> Path:
    """Moves a file or directory from the scratch area to its final location.

    Scratch and data are normally different mounts, where a plain rename fails
    (EXDEV) and the data has to be copied. The copy goes to a sibling
    "<name>.partial" first and is renamed into place only once complete, so a
    half-copied store is never visible under its real name — if the copy fails,
    nothing is left behind at `dst`. The source is deleted after a successful
    move. `dst` must not already exist (for a directory).
    """
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.replace(src, dst)  # same filesystem: one atomic rename, no copying
        return dst
    except OSError as exc:
        if exc.errno != errno.EXDEV:
            raise

    partial = dst.with_name(dst.name + ".partial")
    _remove(partial)
    try:
        if src.is_dir():
            shutil.copytree(src, partial)
        else:
            shutil.copy2(src, partial)
        os.replace(partial, dst)
    except BaseException:
        _remove(partial)
        raise
    _remove(src)
    return dst


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
    if not enabled():
        return
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
