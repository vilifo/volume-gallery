import json
import shutil
import zipfile
from collections import deque
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, UploadFile, File, Form, Query, Request
from fastapi.responses import FileResponse, Response
from sqlmodel import Session, select

from ..database import get_session, engine
from ..models import User, Role, Volume, VolumeAccess, Mesh, AssetStatus
from ..schemas import VolumeRead, AssetStatusRead, AccessGrant, FileAccessUrl, UserRead
from ..deps import get_current_user, require_editor
from ..security import create_file_token, decode_token
from ..config import settings
from .. import workdir
from ..helpers.volume import convert_tiff_stack_to_ome_zarr
from ..utils import SLUG_RE, _now  # noqa: F401 - re-exported for the other asset routers
from .meshes import attach_mesh_to_volume, delete_volume_mesh, get_volume_mesh, volume_mesh_source, volume_mesh_file

router = APIRouter(prefix="/api/volumes", tags=["volumes"])

TIFF_IMPORT_DIR = "_tiff_import"  # scratch folder holding the slices until they are converted
TIFF_SUFFIXES = (".tif", ".tiff")
ZARR_DIRNAME = "data.ome.zarr"  # the converted/extracted store, as kept in the volume's data folder


def _volume_dir(slug: str) -> Path:
    return settings.VOLUMES_DIR / slug


def _work_dir(slug: str) -> Path:
    """Where this volume's upload is staged and processed: its own data folder,
    or — if VG_PROCESSING_DIR is set — a scratch folder (see workdir.py)."""
    return workdir.work_dir_for("volumes", slug, _volume_dir(slug))


def _get_multiscales(attrs: dict) -> Optional[list]:
    """Returns the `multiscales` array from a Zarr group's attributes,
    handling both shapes OME-NGFF metadata can take: a flat `multiscales`
    key (v2, and plain v3/v0.4), or one namespaced under `ome` (v0.5's
    convention for zarr-v3 group attributes). None if neither is present."""
    if not isinstance(attrs, dict):
        return None
    if "multiscales" in attrs:
        return attrs["multiscales"]
    ome = attrs.get("ome")
    if isinstance(ome, dict) and "multiscales" in ome:
        return ome["multiscales"]
    return None


def _has_multiscales(attrs: dict) -> bool:
    return _get_multiscales(attrs) is not None


def _count_multiscale_levels(zarr_root: Path) -> Optional[int]:
    """Number of resolution levels (index 0 = finest) in the multiscale
    pyramid at zarr_root, or None if it can't be determined. Used to compute
    the "max detail level" UI control's default (half of this)."""
    attrs = _read_group_attrs(zarr_root)
    if attrs is None:
        return None
    multiscales = _get_multiscales(attrs)
    if not multiscales or not isinstance(multiscales, list):
        return None
    datasets = multiscales[0].get("datasets") if isinstance(multiscales[0], dict) else None
    if not isinstance(datasets, list) or not datasets:
        return None
    return len(datasets)


def _read_group_attrs(directory: Path) -> Optional[dict]:
    """Reads a Zarr group's attributes regardless of v2 (.zattrs) or v3
    (zarr.json's "attributes" key) layout. Returns None if this directory
    isn't a Zarr group/array at all."""
    zattrs = directory / ".zattrs"
    if zattrs.exists():
        try:
            return json.loads(zattrs.read_text())
        except (json.JSONDecodeError, OSError):
            return None
    zarr_json = directory / "zarr.json"
    if zarr_json.exists():
        try:
            data = json.loads(zarr_json.read_text())
        except (json.JSONDecodeError, OSError):
            return None
        return data.get("attributes", {})
    return None


def _find_ome_zarr_root(vol_dir: Path) -> Optional[Path]:
    """Breadth-first search for the shallowest directory whose Zarr group
    attributes actually declare OME-NGFF multiscales metadata. BFS (rather
    than rglob, whose traversal order isn't guaranteed) guarantees we can
    never mistake a nested per-resolution array for the real multiscale
    group, since every array in a Zarr v3 store has its own zarr.json too."""
    queue = deque([vol_dir])
    while queue:
        current = queue.popleft()
        attrs = _read_group_attrs(current)
        if attrs is not None and _has_multiscales(attrs):
            return current
        try:
            children = sorted(p for p in current.iterdir() if p.is_dir())
        except OSError:
            children = []
        queue.extend(children)
    return None


def _can_see_volume(user: User, volume: Volume, session: Session) -> bool:
    if user.role in (Role.admin, Role.editor):
        return True
    grant = session.exec(
        select(VolumeAccess).where(
            VolumeAccess.user_id == user.id, VolumeAccess.volume_id == volume.id
        )
    ).first()
    return grant is not None


def _volume_read(v: Volume, mesh: Optional[Mesh] = None) -> VolumeRead:
    log_lines = [line for line in (v.status_log or "").split("\n") if line]
    mesh_log = [line for line in ((mesh.status_log if mesh else "") or "").split("\n") if line]
    return VolumeRead(
        id=v.id,
        slug=v.slug,
        title=v.title,
        description=v.description,
        has_mesh=v.has_mesh,
        mesh_filename=v.mesh_filename,
        mesh_status=mesh.status if mesh else None,
        mesh_status_log=mesh_log,
        created_at=v.created_at.isoformat(),
        status=v.status,
        status_log=log_lines,
        num_lod_levels=v.num_lod_levels,
    )


# ---------- Gallery ----------

@router.get("", response_model=List[VolumeRead])
def list_volumes(session: Session = Depends(get_session), user: User = Depends(get_current_user)):
    volumes = session.exec(select(Volume)).all()
    visible = [v for v in volumes if _can_see_volume(user, v, session)]
    meshes = {m.volume_id: m for m in session.exec(select(Mesh).where(Mesh.volume_id != None)).all()}  # noqa: E711
    return [_volume_read(v, meshes.get(v.id)) for v in visible]


@router.get("/{volume_id}", response_model=VolumeRead)
def get_volume(
    volume_id: int, session: Session = Depends(get_session), user: User = Depends(get_current_user)
):
    volume = session.get(Volume, volume_id)
    if not volume or not _can_see_volume(user, volume, session):
        raise HTTPException(status_code=404, detail="Volume not found")
    return _volume_read(volume, get_volume_mesh(session, volume.id))


@router.get("/{volume_id}/status", response_model=AssetStatusRead)
def get_volume_status(
    volume_id: int, session: Session = Depends(get_session), user: User = Depends(get_current_user)
):
    """Lightweight endpoint for the gallery page to poll while a volume is
    still processing — same payload shape as VolumeRead's status fields,
    without re-sending everything else."""
    volume = session.get(Volume, volume_id)
    if not volume or not _can_see_volume(user, volume, session):
        raise HTTPException(status_code=404, detail="Volume not found")
    log_lines = [line for line in (volume.status_log or "").split("\n") if line]
    return AssetStatusRead(id=volume.id, status=volume.status, status_log=log_lines)


# ---------- Editor: create / upload / delete ----------

@router.post("", response_model=VolumeRead)
def create_volume(
    background_tasks: BackgroundTasks,
    slug: str = Form(...),
    title: str = Form(...),
    description: str = Form(""),
    zarr_zip: Optional[UploadFile] = File(
        None, description="Zip archive containing the .ome.zarr directory"
    ),
    tiff_zip: Optional[UploadFile] = File(
        None, description="Zip archive of a flat .tif/.tiff slice stack, converted to OME-Zarr on upload"
    ),
    max_workers: int = Form(8, description="Parallel read threads for TIFF conversion"),
    mesh_file: Optional[UploadFile] = File(None),
    session: Session = Depends(get_session),
    editor: User = Depends(require_editor),
):
    if not SLUG_RE.match(slug):
        raise HTTPException(status_code=400, detail="Slug must be lowercase alphanumeric/-/_ (2-63 chars)")
    n_sources = sum([zarr_zip is not None, tiff_zip is not None])
    if n_sources == 0:
        raise HTTPException(status_code=400, detail="Provide one of zarr_zip, tiff_zip")
    if n_sources > 1:
        raise HTTPException(status_code=400, detail="Provide only one of zarr_zip, tiff_zip")
    if session.exec(select(Volume).where(Volume.slug == slug)).first():
        raise HTTPException(status_code=409, detail="A volume with this slug already exists")

    vol_dir = _volume_dir(slug)
    vol_dir.mkdir(parents=True, exist_ok=False)

    source_kind = "zarr" if zarr_zip is not None else "tiff" if tiff_zip is not None else "tiff-files"
    source_upload = zarr_zip if zarr_zip is not None else tiff_zip
    try:
        work_dir = workdir.prepare_work_dir("volumes", slug, vol_dir)
        if source_upload is not None:
            zip_path = work_dir / "_upload.zip"
            with open(zip_path, "wb") as f:
                shutil.copyfileobj(source_upload.file, f)
        else:
            (work_dir / TIFF_IMPORT_DIR).mkdir()  # slices arrive later, see upload_tiff_files()
    except Exception as exc:  # noqa: BLE001 - surface save errors to the caller
        shutil.rmtree(vol_dir, ignore_errors=True)
        workdir.discard_job("volumes", slug)
        raise HTTPException(status_code=400, detail=f"Could not save upload: {exc}")

    volume = Volume(
        slug=slug,
        title=title,
        description=description,
        zarr_path="",  # filled in by _process_upload once conversion/extraction finishes
        created_by=editor.id,
        status=AssetStatus.uploaded if source_kind == "tiff-files" else AssetStatus.processing,
        status_log=(
            f"{_now()}  Waiting for TIFF slices to be uploaded\n"
            if source_kind == "tiff-files"
            else f"{_now()}  Upload received, queued for processing\n"
        ),
    )
    session.add(volume)
    session.commit()
    session.refresh(volume)

    # An optional mesh uploaded together with the volume is processed like any
    # other mesh (see routers/meshes.py) but is owned by the volume.
    mesh = None
    if mesh_file is not None:
        try:
            mesh = attach_mesh_to_volume(session, volume, mesh_file, editor, background_tasks)
        except Exception:
            shutil.rmtree(vol_dir, ignore_errors=True)
            workdir.discard_job("volumes", slug)
            session.delete(volume)
            session.commit()
            raise

    if source_kind != "tiff-files":
        background_tasks.add_task(_process_upload, volume.id, str(vol_dir), source_kind, max_workers)

    return _volume_read(volume, mesh)


def _process_upload(volume_id: int, vol_dir_str: str, source_kind: str, max_workers: int) -> None:
    """Runs after create_volume's response has already been sent. Opens its
    own DB session — the request-scoped one from create_volume is closed by
    the time this runs."""
    vol_dir = Path(vol_dir_str)
    with Session(engine) as session:
        volume = session.get(Volume, volume_id)
        if volume is None:
            return

        def log(message: str) -> None:
            print(f"[Volume {volume.slug}] {message}")
            volume.status_log = (volume.status_log or "") + f"{_now()}  {message}\n"
            session.add(volume)
            session.commit()

        work_dir = _work_dir(volume.slug)
        staged = work_dir != vol_dir
        try:
            zip_path = work_dir / "_upload.zip"
            if source_kind == "zarr":
                log("Extracting OME-Zarr archive")
                zarr_root = _extract_zarr_zip_from_path(zip_path, work_dir)
            elif source_kind == "tiff-files":
                zarr_root = _convert_tiff_scratch_dir(work_dir / TIFF_IMPORT_DIR, work_dir, log)
            else:
                zarr_root = _convert_tiff_zip_from_path(zip_path, work_dir, max_workers, log)
            if staged:
                log("Moving the finished OME-Zarr store into the data directory")
                zarr_root = workdir.move_into_place(zarr_root, vol_dir / ZARR_DIRNAME)
            volume.zarr_path = str(zarr_root.relative_to(vol_dir))
            volume.num_lod_levels = _count_multiscale_levels(zarr_root)
            volume.status = AssetStatus.ready
            log("Ready")
        except Exception as exc:  # noqa: BLE001 - the failure message IS the point, shown to the user
            volume.status = AssetStatus.failed
            log(f"Failed: {exc}")
        finally:
            if staged:
                workdir.discard_job("volumes", volume.slug)  # success or failure: scratch is never kept
        session.add(volume)
        session.commit()


def _extract_zarr_zip_from_path(zip_path: Path, vol_dir: Path) -> Path:
    """Extracts an OME-Zarr .zip already saved at zip_path into vol_dir and
    locates its multiscale group root (see _find_ome_zarr_root for why
    presence of a zarr.json/.zattrs file alone isn't sufficient)."""
    try:
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(vol_dir)
    except zipfile.BadZipFile:
        raise ValueError("zarr_zip is not a valid zip file")
    finally:
        zip_path.unlink(missing_ok=True)

    zarr_root = _find_ome_zarr_root(vol_dir)
    if zarr_root is None:
        raise ValueError(
            "No OME-NGFF multiscales metadata found anywhere in the archive. "
            "Every zarr.json/.zattrs found lacks a multiscales entry — check "
            "that the archive contains the multiscale group (not just an "
            "individual resolution-level array), and that it was written "
            "with OME-NGFF metadata (attributes.multiscales for v2/plain v3, "
            "or attributes.ome.multiscales for NGFF v0.5)."
        )
    return zarr_root


def _convert_tiff_zip_from_path(zip_path: Path, vol_dir: Path, max_workers: int, log) -> Path:
    """Extracts a TIFF-stack .zip already saved at zip_path into a scratch
    directory, converts it to OME-Zarr under vol_dir, then deletes the
    extracted TIFF files — only the converted OME-Zarr store is kept on disk
    afterward. `log` is called with progress messages as conversion runs."""
    log("Extracting TIFF archive")
    scratch_dir = vol_dir / TIFF_IMPORT_DIR
    scratch_dir.mkdir(exist_ok=True)
    try:
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(scratch_dir)
    except zipfile.BadZipFile:
        raise ValueError("tiff_zip is not a valid zip file")
    finally:
        zip_path.unlink(missing_ok=True)

    return _convert_tiff_scratch_dir(scratch_dir, vol_dir, log)


def _convert_tiff_scratch_dir(scratch_dir: Path, vol_dir: Path, log) -> Path:
    """Converts the TIFF slices under `scratch_dir` (extracted from a zip, or
    uploaded one by one) to OME-Zarr under vol_dir and deletes `scratch_dir`
    afterwards. Returns the OME-Zarr root."""
    # Slices may be nested in a subfolder inside the zip rather than at its
    # top level (e.g. a zip of "scan/slice_0001.tif" instead of
    # "slice_0001.tif") — search shallowest-first for the folder that
    # actually contains the .tif files, same rationale as _find_ome_zarr_root.
    tiff_source_dir = _find_tiff_dir(scratch_dir)
    if tiff_source_dir is None:
        shutil.rmtree(scratch_dir, ignore_errors=True)
        raise ValueError("No .tif/.tiff files found")

    n_files = sum(
        1 for p in tiff_source_dir.iterdir() if p.is_file() and p.suffix.lower() in (".tif", ".tiff")
    )
    log(f"Converting {n_files} TIFF slices to OME-Zarr (this can take a while for large stacks)")

    zarr_dir = vol_dir / ZARR_DIRNAME
    try:
        convert_tiff_stack_to_ome_zarr(tiff_source_dir, zarr_dir)
    finally:
        shutil.rmtree(scratch_dir, ignore_errors=True)

    log("Locating OME-Zarr metadata")
    zarr_root = _find_ome_zarr_root(vol_dir)
    if zarr_root is None:
        raise ValueError("TIFF conversion completed but produced no readable OME-NGFF metadata")
    return zarr_root


def _find_tiff_dir(scratch_dir: Path) -> Optional[Path]:
    """Breadth-first search for the shallowest directory containing at least
    one .tif/.tiff file."""
    queue = deque([scratch_dir])
    while queue:
        current = queue.popleft()
        try:
            entries = list(current.iterdir())
        except OSError:
            continue
        if any(p.is_file() and p.suffix.lower() in (".tif", ".tiff") for p in entries):
            return current
        queue.extend(sorted(p for p in entries if p.is_dir()))
    return None


@router.post("/{volume_id}/mesh", response_model=VolumeRead)
def upload_or_replace_mesh(
    volume_id: int,
    background_tasks: BackgroundTasks,
    mesh_file: UploadFile = File(...),
    session: Session = Depends(get_session),
    editor: User = Depends(require_editor),
):
    volume = session.get(Volume, volume_id)
    if not volume:
        raise HTTPException(status_code=404, detail="Volume not found")
    mesh = attach_mesh_to_volume(session, volume, mesh_file, editor, background_tasks)
    session.refresh(volume)
    return _volume_read(volume, mesh)


@router.delete("/{volume_id}")
def delete_volume(
    volume_id: int, session: Session = Depends(get_session), _editor: User = Depends(require_editor)
):
    volume = session.get(Volume, volume_id)
    if not volume:
        raise HTTPException(status_code=404, detail="Volume not found")
    shutil.rmtree(_volume_dir(volume.slug), ignore_errors=True)
    workdir.discard_job("volumes", volume.slug)
    delete_volume_mesh(session, volume)
    for grant in session.exec(select(VolumeAccess).where(VolumeAccess.volume_id == volume_id)).all():
        session.delete(grant)
    session.delete(volume)
    session.commit()
    return {"ok": True}


# ---------- Editor: access control ----------

@router.get("/{volume_id}/access", response_model=List[UserRead])
def list_access(
    volume_id: int, session: Session = Depends(get_session), _editor: User = Depends(require_editor)
):
    grants = session.exec(select(VolumeAccess).where(VolumeAccess.volume_id == volume_id)).all()
    users = [session.get(User, g.user_id) for g in grants]
    return [u for u in users if u]


@router.post("/{volume_id}/access")
def grant_access(
    volume_id: int,
    payload: AccessGrant,
    session: Session = Depends(get_session),
    editor: User = Depends(require_editor),
):
    volume = session.get(Volume, volume_id)
    target = session.get(User, payload.user_id)
    if not volume or not target:
        raise HTTPException(status_code=404, detail="Volume or user not found")
    existing = session.exec(
        select(VolumeAccess).where(
            VolumeAccess.volume_id == volume_id, VolumeAccess.user_id == payload.user_id
        )
    ).first()
    if existing:
        return {"ok": True}
    session.add(VolumeAccess(user_id=payload.user_id, volume_id=volume_id, granted_by=editor.id))
    session.commit()
    return {"ok": True}


@router.delete("/{volume_id}/access/{user_id}")
def revoke_access(
    volume_id: int,
    user_id: int,
    session: Session = Depends(get_session),
    _editor: User = Depends(require_editor),
):
    grant = session.exec(
        select(VolumeAccess).where(
            VolumeAccess.volume_id == volume_id, VolumeAccess.user_id == user_id
        )
    ).first()
    if grant:
        session.delete(grant)
        session.commit()
    return {"ok": True}


# ---------- File access (kiln-render + mesh download) ----------
# kiln-render's KilnViewer fetches the zarr root by plain URL, so we hand it a
# short-lived signed URL instead of requiring an Authorization header.

@router.get("/{volume_id}/zarr-access-url", response_model=FileAccessUrl)
def zarr_access_url(
    volume_id: int,
    request: Request,
    min_level: Optional[int] = Query(
        None, ge=0,
        description="Finest OME-NGFF multiscale level index to load (0 = full resolution; "
                     "higher = coarser). Levels below this are never streamed. Omit for no cap.",
    ),
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    volume = session.get(Volume, volume_id)
    if not volume or not _can_see_volume(user, volume, session):
        raise HTTPException(status_code=404, detail="Volume not found")
    if volume.status != AssetStatus.ready:
        raise HTTPException(
            status_code=409,
            detail=(
                "Volume is still processing"
                if volume.status == AssetStatus.processing
                else "Volume processing failed — see its status log"
            ),
        )
    if min_level is not None and volume.num_lod_levels and min_level >= volume.num_lod_levels:
        raise HTTPException(
            status_code=400,
            detail=f"min_level must be less than this volume's {volume.num_lod_levels} levels",
        )
    token = create_file_token(subject=user.username, asset_id=volume_id, kind="zarr", min_lod=min_level)
    # kiln-render's KilnViewer.create() picks its data provider with a plain
    # `url.includes(".zarr")` check — the path segment below must contain that
    # literal substring or it silently falls back to its other (incompatible)
    # provider and fails trying to fetch a manifest file that doesn't exist.
    # kiln-render's KilnViewer.create() does `new URL(dataset)` internally —
    # it requires a fully-qualified absolute URL, not a path, so we build one
    # from the incoming request rather than returning a relative path.
    base = str(request.base_url).rstrip("/")
    return FileAccessUrl(
        url=f"{base}/api/volumes/{volume_id}/dataset.ome.zarr/{token}/",
        expires_in_minutes=settings.FILE_TOKEN_EXPIRE_MINUTES,
    )


@router.get("/{volume_id}/mesh-access-url", response_model=FileAccessUrl)
def mesh_access_url(
    volume_id: int, session: Session = Depends(get_session), user: User = Depends(get_current_user)
):
    """Download link for the volume's attached mesh (the original upload).
    Permission is the volume's: anyone who can see the volume can download it."""
    volume = session.get(Volume, volume_id)
    if not volume or not _can_see_volume(user, volume, session):
        raise HTTPException(status_code=404, detail="Volume not found")
    if not volume.has_mesh:
        raise HTTPException(status_code=404, detail="This volume has no mesh")
    token = create_file_token(subject=user.username, asset_id=volume_id, kind="volume-mesh-download")
    return FileAccessUrl(
        url=f"/api/volumes/{volume_id}/mesh-file/{token}",
        expires_in_minutes=settings.FILE_TOKEN_EXPIRE_MINUTES,
    )


@router.get("/{volume_id}/mesh-view-url", response_model=FileAccessUrl)
def mesh_view_url(
    volume_id: int, request: Request, session: Session = Depends(get_session), user: User = Depends(get_current_user)
):
    """URL of the processed (.nxz) attached mesh for the 3DHOP viewer. Like the
    download link, it is authorised by the volume, not by a mesh permission."""
    volume = session.get(Volume, volume_id)
    if not volume or not _can_see_volume(user, volume, session):
        raise HTTPException(status_code=404, detail="Volume not found")
    mesh = get_volume_mesh(session, volume_id)
    if mesh is None:
        raise HTTPException(status_code=404, detail="This volume has no viewable mesh")
    if mesh.status != AssetStatus.ready:
        raise HTTPException(
            status_code=409,
            detail="Mesh is still processing" if mesh.status == AssetStatus.processing else "Mesh processing failed — see the volume's mesh status",
        )
    token = create_file_token(subject=user.username, asset_id=volume_id, kind="volume-mesh-view")
    base = str(request.base_url).rstrip("/")
    return FileAccessUrl(
        url=f"{base}/api/volumes/{volume_id}/mesh-view-file/{token}",
        expires_in_minutes=settings.FILE_TOKEN_EXPIRE_MINUTES,
    )


def _check_file_token(token: str, volume_id: int, kind: str) -> dict:
    payload = decode_token(token)
    if (
        not payload
        or payload.get("type") != "file"
        or payload.get("kind") != kind
        or payload.get("vol") != volume_id
    ):
        raise HTTPException(status_code=403, detail="Invalid or expired link")
    return payload


@router.get("/{volume_id}/dataset.ome.zarr/{token}/{path:path}")
def serve_zarr_file(
    volume_id: int, token: str, path: str, session: Session = Depends(get_session)
):
    """Serves individual chunk/metadata files inside the OME-Zarr store.
    kiln-render performs many small ranged GETs against this — keep it fast and stateless.
    """
    payload = _check_file_token(token, volume_id, "zarr")
    volume = session.get(Volume, volume_id)
    if not volume:
        raise HTTPException(status_code=404, detail="Volume not found")
    zarr_root = (_volume_dir(volume.slug) / volume.zarr_path).resolve()
    # Strip any leading slash first: pathlib treats "root / '/x'" as the
    # absolute path "/x" (discarding root entirely) rather than joining them,
    # which would otherwise defeat the containment check below.
    target = (zarr_root / path.lstrip("/")).resolve()
    if not str(target).startswith(str(zarr_root)):
        raise HTTPException(status_code=400, detail="Invalid path")
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="Not found")

    min_lod = payload.get("min_lod")
    # Every file this endpoint can serve is immutable for the lifetime of
    # the signed token that grants access to it (a volume's data never
    # changes after processing finishes, and this URL's content is fully
    # determined by the token's own claims — same token always means same
    # bytes). Cache-Control here lets the browser skip re-fetching chunks it
    # already has on a page reload, or when kiln-render re-requests
    # something already in cache — capped to the token's own validity
    # window since the URL 403s once it expires anyway.
    cache_headers = {"Cache-Control": f"public, max-age={settings.FILE_TOKEN_EXPIRE_MINUTES * 60}, immutable"}

    # Only the store's own root metadata file (no "/" in path — a per-level
    # array's metadata is at e.g. "5/zarr.json", which has one) ever lists
    # the multiscale pyramid; everything else (chunk data, per-level array
    # metadata) is served completely unmodified regardless of min_lod, since
    # capping only means "which levels are listed as available", not
    # anything about the bytes of the levels that remain.
    if min_lod and "/" not in path and path in (".zattrs", "zarr.json"):
        rewritten = _truncate_multiscales_json(target.read_bytes(), min_lod)
        if rewritten is not None:
            media_type = "application/json"
            return Response(content=rewritten, media_type=media_type, headers=cache_headers)
    return FileResponse(target, headers=cache_headers)


def _truncate_multiscales_json(raw: bytes, min_lod: int) -> Optional[bytes]:
    """Drops multiscale dataset entries finer than min_lod (i.e. keeps
    datasets[min_lod:]) from a root metadata file's content, in whichever of
    the two OME-NGFF attribute shapes it uses. The chunk data those dropped
    entries pointed at is simply never requested by the client afterward —
    nothing on disk is touched. Returns None (meaning: serve the original
    file unchanged) if the content isn't parseable or has no multiscales."""
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None

    # v2 (.zattrs): multiscales sits at the top level of the file itself.
    # v3 (zarr.json): it's nested under "attributes" (and possibly "ome").
    is_v3 = "attributes" in data and isinstance(data.get("attributes"), dict)
    attrs = data["attributes"] if is_v3 else data
    multiscales = _get_multiscales(attrs)
    if not multiscales or not isinstance(multiscales, list):
        return None

    changed = False
    for entry in multiscales:
        if not isinstance(entry, dict):
            continue
        datasets = entry.get("datasets")
        if isinstance(datasets, list) and 0 < min_lod < len(datasets):
            entry["datasets"] = datasets[min_lod:]
            changed = True
    if not changed:
        return None
    return json.dumps(data).encode("utf-8")


@router.get("/{volume_id}/mesh-file/{token}")
def serve_mesh_file(
    volume_id: int, token: str, session: Session = Depends(get_session)
):
    _check_file_token(token, volume_id, "volume-mesh-download")
    volume = session.get(Volume, volume_id)
    if not volume or not volume.has_mesh:
        raise HTTPException(status_code=404, detail="Not found")
    mesh = get_volume_mesh(session, volume_id)
    mesh_path = volume_mesh_source(mesh)
    filename = volume.mesh_filename or f"{volume.slug}.{mesh.file_extension}"
    if mesh_path is None or not mesh_path.exists():
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(
        mesh_path,
        filename=filename,
        headers={"Cache-Control": f"public, max-age={settings.FILE_TOKEN_EXPIRE_MINUTES * 60}, immutable"},
    )


@router.get("/{volume_id}/mesh-view-file/{token}")
def serve_mesh_view_file(
    volume_id: int, token: str, session: Session = Depends(get_session)
):
    _check_file_token(token, volume_id, "volume-mesh-view")
    mesh = get_volume_mesh(session, volume_id)
    if mesh is None or not mesh.mesh_filename:
        raise HTTPException(status_code=404, detail="Not found")
    nxz_path = volume_mesh_file(mesh)
    if not nxz_path.exists():
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(
        nxz_path,
        headers={"Cache-Control": f"public, max-age={settings.FILE_TOKEN_EXPIRE_MINUTES * 60}, immutable"},
    )
