import hashlib
import json
import posixpath
import shutil
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, UploadFile, File, Form, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from sqlmodel import Session, select

from ..database import get_session, engine
from ..models import User, Role, Volume, VolumeAccess, Mesh, AssetStatus
from ..schemas import VolumeRead, AssetStatusRead, AccessGrant, FileAccessUrl, UserRead
from ..deps import get_current_user, require_editor
from ..security import create_file_token, decode_token
from ..config import settings
from .. import workdir
from ..helpers.slices import SliceError, open_volume_slices, plane_response_parts
from ..helpers import extract_zarr_zip_from_path, convert_tiff_zip_from_path, ZIP_NAME, count_multiscale_levels, get_multiscales
from ..helpers import read_thumbnail, write_thumbnail, store_thumbnail, remove_thumbnail, thumbnail_response
from ..utils import SLUG_RE, _now  # noqa: F401 - re-exported for the other asset routers
from .meshes import attach_mesh_to_volume, delete_volume_mesh, get_volume_mesh, volume_mesh_source, volume_mesh_file

router = APIRouter(prefix="/api/volumes", tags=["volumes"])

# In-memory caches to keep serve_zarr_file async and avoid threadpool/DB/JWT
# overhead on every 64^3 brick request.
_TOKEN_CACHE: Dict[str, Tuple[float, dict]] = {}
_VOLUME_LOC_CACHE: Dict[int, Tuple[float, str, str, Path]] = {}
_CACHE_MAX_SIZE = 4096


def _invalidate_volume_cache(volume_id: int) -> None:
    _VOLUME_LOC_CACHE.pop(volume_id, None)


def _validate_zarr_rel_path(path: str) -> str:
    """Validates and normalizes a relative path inside a Zarr store.
    Rejects empty paths, leading slashes, backslashes, null bytes, empty
    segments ('//'), and '.' or '..' traversal segments before any filesystem
    or X-Accel-Redirect path is constructed."""
    if not path or "\\" in path or "\x00" in path or path.startswith("/"):
        raise HTTPException(status_code=400, detail="Invalid path")
    segments = path.split("/")
    for seg in segments:
        if not seg or seg in (".", ".."):
            raise HTTPException(status_code=400, detail="Invalid path")
    return "/".join(segments)


def _check_file_token_cached(token: str, volume_id: int, kind: str) -> dict:
    now = time.time()
    cached = _TOKEN_CACHE.get(token)
    if cached is not None:
        exp_ts, payload = cached
        if now < exp_ts:
            if payload.get("vol") == volume_id and payload.get("kind") == kind:
                return payload
            raise HTTPException(status_code=403, detail="Invalid or expired link")
        _TOKEN_CACHE.pop(token, None)

    payload = _check_file_token(token, volume_id, kind)
    token_exp = float(payload.get("exp", 0))
    ttl = max(1.0, float(settings.ZARR_META_CACHE_TTL_SECONDS))
    exp_ts = min(token_exp, now + ttl) if token_exp > now else now
    if exp_ts > now:
        if len(_TOKEN_CACHE) >= _CACHE_MAX_SIZE:
            _TOKEN_CACHE.clear()
        _TOKEN_CACHE[token] = (exp_ts, payload)
    return payload


def _get_volume_zarr_loc(volume_id: int) -> Tuple[str, str, Path]:
    """Returns (slug, clean_zarr_rel_path, resolved_zarr_root) for volume_id,
    using a short-TTL in-memory cache so chunk requests do not open a SQLite
    session per chunk."""
    now = time.time()
    cached = _VOLUME_LOC_CACHE.get(volume_id)
    if cached is not None:
        exp_ts, slug, zarr_rel, zarr_root = cached
        if now < exp_ts:
            return slug, zarr_rel, zarr_root
        _VOLUME_LOC_CACHE.pop(volume_id, None)

    with Session(engine) as session:
        volume = session.get(Volume, volume_id)
        if not volume or not volume.zarr_path:
            raise HTTPException(status_code=404, detail="Volume not found")
        slug = volume.slug
        raw_zarr_path = volume.zarr_path.replace("\\", "/").strip("/")

    vol_dir = _volume_dir(slug).resolve()
    zarr_root = (vol_dir / raw_zarr_path).resolve()
    if not zarr_root.is_relative_to(vol_dir):
        raise HTTPException(status_code=400, detail="Invalid volume zarr_path")
    zarr_rel = posixpath.normpath(raw_zarr_path)
    if zarr_rel in ("", ".") or zarr_rel.startswith(".."):
        zarr_rel = ""

    ttl = max(1.0, float(settings.ZARR_META_CACHE_TTL_SECONDS))
    if len(_VOLUME_LOC_CACHE) >= _CACHE_MAX_SIZE:
        _VOLUME_LOC_CACHE.clear()
    _VOLUME_LOC_CACHE[volume_id] = (now + ttl, slug, zarr_rel, zarr_root)
    return slug, zarr_rel, zarr_root


def _volume_dir(slug: str) -> Path:
    return settings.VOLUMES_DIR / slug


def _work_dir(slug: str) -> Path:
    """The volume's scratch folder under VG_PROCESSING_DIR: holds the uploaded
    .zip (and extracted TIFF slices); the result is written straight into the
    volume's data folder (see workdir.py)."""
    return workdir.work_dir_for("volumes", slug, _volume_dir(slug))


def _can_see_volume(user: User, volume: Volume, session: Session) -> bool:
    if user.role in (Role.admin, Role.editor):
        return True
    scope = getattr(user, "_share_scope", None)
    if scope is not None:
        return scope["asset_type"] == "volume" and scope["asset_id"] == volume.id
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
        has_thumbnail=bool(v.thumbnail_path),
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
    mesh_file: Optional[UploadFile] = File(None),
    thumbnail_file: Optional[UploadFile] = File(None, description="Optional PNG/JPEG/WebP thumbnail"),
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
    thumbnail = read_thumbnail(thumbnail_file) if thumbnail_file is not None else None  # validate before creating anything

    vol_dir = _volume_dir(slug)
    vol_dir.mkdir(parents=True, exist_ok=False)

    source_kind = "zarr" if zarr_zip is not None else "tiff" if tiff_zip is not None else "tiff-files"
    source_upload = zarr_zip if zarr_zip is not None else tiff_zip
    try:
        workdir.prepare_work_dir("volumes", slug, vol_dir)
        thumbnail_name = write_thumbnail(vol_dir, *thumbnail) if thumbnail else None
        # The upload is copied into the scratch folder by the background task, so
        # the response isn't held up by it (see workdir.detach_upload).
        upload_fd = workdir.detach_upload(source_upload)
    except Exception as exc:  # noqa: BLE001 - surface save errors to the caller
        shutil.rmtree(vol_dir, ignore_errors=True)
        workdir.discard_job("volumes", slug)
        raise HTTPException(status_code=400, detail=f"Could not save upload: {exc}")

    volume = Volume(
        slug=slug,
        title=title,
        description=description,
        thumbnail_path=thumbnail_name,
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
            workdir.close_detached(upload_fd)
            shutil.rmtree(vol_dir, ignore_errors=True)
            workdir.discard_job("volumes", slug)
            session.delete(volume)
            session.commit()
            raise

    if source_kind != "tiff-files":
        background_tasks.add_task(_process_upload, volume.id, str(vol_dir), source_kind, upload_fd)
    else:
        workdir.close_detached(upload_fd)

    return _volume_read(volume, mesh)


def _process_upload(volume_id: int, vol_dir_str: str, source_kind: str, upload_fd: int) -> None:
    """Runs after create_volume's response has already been sent. Opens its
    own DB session — the request-scoped one from create_volume is closed by
    the time this runs."""
    vol_dir = Path(vol_dir_str)
    with Session(engine) as session:
        volume = session.get(Volume, volume_id)
        if volume is None:
            workdir.close_detached(upload_fd)
            return

        def log(message: str) -> None:
            print(f"[Volume {volume.slug}] {message}")
            volume.status_log = (volume.status_log or "") + f"{_now()}  {message}\n"
            session.add(volume)
            session.commit()

        work_dir = _work_dir(volume.slug)
        try:
            zip_path = work_dir / ZIP_NAME
            log("Saving upload")
            workdir.save_detached(upload_fd, zip_path)
            if source_kind == "zarr":
                log("Extracting OME-Zarr archive")
                zarr_root = extract_zarr_zip_from_path(zip_path, vol_dir)
            else:
                zarr_root = convert_tiff_zip_from_path(zip_path, work_dir, vol_dir, log)
            volume.zarr_path = str(zarr_root.relative_to(vol_dir))
            volume.num_lod_levels = count_multiscale_levels(zarr_root)
            volume.status = AssetStatus.ready
            log("Ready")
        except Exception as exc:  # noqa: BLE001 - the failure message IS the point, shown to the user
            volume.status = AssetStatus.failed
            log(f"Failed: {exc}")
        finally:
            workdir.discard_job("volumes", volume.slug)  # success or failure: scratch is never kept
        session.add(volume)
        session.commit()
        _invalidate_volume_cache(volume_id)


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


@router.get("/{volume_id}/thumbnail")
def get_thumbnail(
    volume_id: int, request: Request, session: Session = Depends(get_session), user: User = Depends(get_current_user)
):
    volume = session.get(Volume, volume_id)
    if not volume or not _can_see_volume(user, volume, session):
        raise HTTPException(status_code=404, detail="Volume not found")
    return thumbnail_response(_volume_dir(volume.slug), volume.thumbnail_path, request)


@router.post("/{volume_id}/thumbnail", response_model=VolumeRead)
def upload_or_replace_thumbnail(
    volume_id: int,
    thumbnail_file: UploadFile = File(...),
    session: Session = Depends(get_session),
    _editor: User = Depends(require_editor),
):
    volume = session.get(Volume, volume_id)
    if not volume:
        raise HTTPException(status_code=404, detail="Volume not found")
    volume.thumbnail_path = store_thumbnail(thumbnail_file, _volume_dir(volume.slug))
    session.add(volume)
    session.commit()
    session.refresh(volume)
    return _volume_read(volume, get_volume_mesh(session, volume.id))


@router.delete("/{volume_id}/thumbnail", response_model=VolumeRead)
def delete_thumbnail(
    volume_id: int, session: Session = Depends(get_session), _editor: User = Depends(require_editor)
):
    volume = session.get(Volume, volume_id)
    if not volume:
        raise HTTPException(status_code=404, detail="Volume not found")
    remove_thumbnail(_volume_dir(volume.slug))
    volume.thumbnail_path = None
    session.add(volume)
    session.commit()
    session.refresh(volume)
    return _volume_read(volume, get_volume_mesh(session, volume.id))


@router.delete("/{volume_id}")
def delete_volume(
    volume_id: int, session: Session = Depends(get_session), _editor: User = Depends(require_editor)
):
    volume = session.get(Volume, volume_id)
    if not volume:
        raise HTTPException(status_code=404, detail="Volume not found")
    _invalidate_volume_cache(volume_id)
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
    ver_input = f"{volume.id}:{volume.created_at.isoformat()}:{volume.zarr_path}"
    version = hashlib.sha256(ver_input.encode("utf-8")).hexdigest()[:16]
    return FileAccessUrl(
        url=f"{base}/api/volumes/{volume_id}/dataset.ome.zarr/{token}/",
        expires_in_minutes=settings.FILE_TOKEN_EXPIRE_MINUTES,
        version=version,
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


# ---------- Slice views: planes extracted server-side ----------
# The browser asks for one finished plane at a time instead of streaming zarr
# chunks (a plane needs a whole column of chunks: ~1000 requests for a 2000^3
# volume). See helpers/slices.py for the cache that keeps scrolling fast.

@router.get("/{volume_id}/slice-access-url", response_model=FileAccessUrl)
def slice_access_url(
    volume_id: int,
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
    token = create_file_token(subject=user.username, asset_id=volume_id, kind="slice")
    return FileAccessUrl(
        url=f"/api/volumes/{volume_id}/slices/{token}/",
        expires_in_minutes=settings.FILE_TOKEN_EXPIRE_MINUTES,
    )


def _slice_store(volume_id: int, token: str, level: int, session: Session):
    _check_file_token(token, volume_id, "slice")
    volume = session.get(Volume, volume_id)
    if not volume:
        raise HTTPException(status_code=404, detail="Volume not found")
    zarr_root = (_volume_dir(volume.slug) / volume.zarr_path).resolve()
    # Plane reads can take a while: give the DB connection back first so a
    # burst of slice requests cannot exhaust the connection pool.
    session.close()
    try:
        return open_volume_slices(zarr_root, level)
    except SliceError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc))


@router.get("/{volume_id}/slices/{token}/info")
def slice_info(
    volume_id: int,
    token: str,
    level: int = Query(0, ge=0, description="Resolution level (0 = finest, the default)"),
    session: Session = Depends(get_session),
):
    """Dimensions, voxel spacing, data type and a suggested window for the slice views."""
    vs = _slice_store(volume_id, token, level, session)
    return JSONResponse(vs.info(), headers={"Cache-Control": "private, max-age=60"})


@router.get("/{volume_id}/slices/{token}/{axis}/{index}")
def slice_plane(
    volume_id: int,
    token: str,
    axis: str,
    index: int,
    channel: int = Query(0, ge=0),
    stride: int = Query(1, description="1 (full detail), or 2/4/8 for a subsampled preview"),
    enc: str = Query("identity", description="identity (raw, the default) or zstd (Content-Encoding: zstd)"),
    level: int = Query(0, ge=0),
    session: Session = Depends(get_session),
):
    """One plane as raw little-endian samples (zstd Content-Encoding when accepted).

    `axis` is the plane: xy (index = z), xz (index = y) or yz (index = x). Rows run
    along the plane's vertical axis: xy (y, x), xz (z, x), yz (z, y).
    Width/height/dtype are in the X-Plane-* response headers. The body is raw unless
    `enc=zstd` is requested explicitly (the Accept-Encoding header is not consulted).
    """
    vs = _slice_store(volume_id, token, level, session)
    try:
        body, headers = plane_response_parts(vs, axis, index, channel, stride, enc)
    except SliceError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc))
    # Same reasoning as serve_zarr_file: the bytes are fixed by the token's claims.
    headers["Cache-Control"] = f"public, max-age={settings.FILE_TOKEN_EXPIRE_MINUTES * 60}, immutable"
    return Response(content=body, media_type="application/octet-stream", headers=headers)


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
async def serve_zarr_file(volume_id: int, token: str, path: str):
    """Serves individual chunk/metadata files inside the OME-Zarr store.
    kiln-render performs many small ranged GETs against this — keep it fast and stateless.
    """
    clean_path = _validate_zarr_rel_path(path)
    payload = _check_file_token_cached(token, volume_id, "zarr")
    slug, zarr_rel, zarr_root = _get_volume_zarr_loc(volume_id)

    min_lod = payload.get("min_lod")
    is_root_meta = "/" not in clean_path and clean_path in (".zattrs", "zarr.json")

    # Every file this endpoint can serve is immutable for the lifetime of
    # the signed token that grants access to it (a volume's data never
    # changes after processing finishes, and this URL's content is fully
    # determined by the token's own claims — same token always means same
    # bytes). Cache-Control here lets the browser skip re-fetching chunks it
    # already has on a page reload, or when kiln-render re-requests
    # something already in cache — capped to the token's own validity
    # window since the URL 403s once it expires anyway.
    cache_headers = {"Cache-Control": f"public, max-age={settings.FILE_TOKEN_EXPIRE_MINUTES * 60}, immutable"}

    if settings.ZARR_ACCEL_REDIRECT and not is_root_meta:
        prefix = settings.ZARR_ACCEL_PREFIX.rstrip("/")
        rel_parts = [p for p in (slug, zarr_rel, clean_path) if p]
        accel_uri = f"{prefix}/{'/'.join(rel_parts)}"
        headers = {
            ** cache_headers,
            "X-Accel-Redirect": accel_uri,
            "Content-Type": "application/json" if clean_path.endswith("zarr.json") or clean_path.endswith(
        ".zarray") or clean_path.endswith(".zattrs") else "application/octet-stream",
        }
        return Response(status_code=200, headers=headers)

    target = (zarr_root / clean_path).resolve()

    if not target.is_relative_to(zarr_root):
        raise HTTPException(status_code=400, detail="Invalid path")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Not found")

    # Only the store's own root metadata file (no "/" in path — a per-level
    # array's metadata is at e.g. "5/zarr.json", which has one) ever lists
    # the multiscale pyramid; everything else (chunk data, per-level array
    # metadata) is served completely unmodified regardless of min_lod, since
    # capping only means "which levels are listed as available", not
    # anything about the bytes of the levels that remain.
    if min_lod and is_root_meta:
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
    multiscales = get_multiscales(attrs)
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
