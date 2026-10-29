import json
import hashlib
import re
import shutil
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, UploadFile, File, Form, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from sqlmodel import Session, select

from ..database import get_session, engine
from ..models import User, Role, Volume, VolumeAccess, Mesh, AssetStatus
from ..schemas import VolumeRead, AssetStatusRead, AccessGrant, FileAccessUrl, UserRead
from ..deps import file_token_revoked, get_current_user, require_editor
from ..security import create_file_token, decode_token
from ..config import settings
from .. import workdir
from ..helpers.slices import SliceError, open_volume_slices, plane_response_parts
from ..helpers import volume_meta_path, process_zip, decompose_tiff_stack
from ..helpers import read_thumbnail, write_thumbnail, store_thumbnail, remove_thumbnail, thumbnail_response
from ..helpers import histogram_path
from ..utils import SLUG_RE, _now  # noqa: F401 - re-exported for the other asset routers
from .meshes import attach_mesh_to_volume, delete_volume_mesh, get_volume_mesh, volume_mesh_source, volume_mesh_file

router = APIRouter(prefix="/api/volumes", tags=["volumes"])

# In-memory caches to keep serve_sharded_file async and avoid threadpool/DB/JWT
# overhead on every 64^3 brick request.
_TOKEN_CACHE: Dict[str, Tuple[float, dict]] = {}
_VOLUME_LOC_CACHE: Dict[int, Tuple[float, str, str, Path]] = {}
_CACHE_MAX_SIZE = 4096
ZIP_NAME = "_upload.zip"  # the uploaded .zip, as saved in the volume's processing (scratch) folder


def _invalidate_volume_cache(volume_id: int) -> None:
    _VOLUME_LOC_CACHE.pop(volume_id, None)


def _validate_rel_path(path: str) -> str:
    """Validates and normalizes a relative path inside a sharded volume.
    Rejects empty paths, leading slashes, backslashes, null bytes, empty
    segments ('//'), and '.' or '..' traversal segments before any filesystem
    '%', '?' and '#' are interpreted again by nginx when the path is placed in an
    X-Accel-Redirect URI, so a literal one in a segment must never get that far.
    """
    if not path or any(c in path for c in ("\\", "\x00", "%", "?", "#")) or path.startswith("/"):
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
    ttl = max(1.0, float(settings.FILE_META_CACHE_TTL_SECONDS))
    exp_ts = min(token_exp, now + ttl) if token_exp > now else now
    if exp_ts > now:
        if len(_TOKEN_CACHE) >= _CACHE_MAX_SIZE:
            _TOKEN_CACHE.clear()
        _TOKEN_CACHE[token] = (exp_ts, payload)
    return payload


def _volume_level_count(volume: Volume) -> Optional[int]:
    """How many levels the volume really has, read from its volume.json. Volume.num_lod_levels is not
    that: it stores the number of the highest level (maxLod), one less than the count."""
    try:
        meta = json.loads(volume_meta_path(_volume_dir(volume.slug)).read_bytes())
        return len(meta["levels"]) or None
    except (OSError, ValueError, KeyError, TypeError):
        return None


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

def _slice_upload_ids(manifest: Optional[List[str]], legacy: Optional[List[str]]) -> List[str]:
    """The upload ids of a TIFF stack's slices, in stack order.

    `manifest` is how the browser sends them: a repeated tiff_upload_manifest field whose
    values are JSON arrays of ids (a few hundred each). One form field per slice, which is what
    `legacy` (tiff_upload_ids) still is, does not work for big stacks: Starlette refuses a
    multipart form with more than 1000 fields ("Too many fields"). A JSON chunk is a single
    field, and chunking keeps each one below Starlette's 1 MB limit on the size of a field."""
    if manifest and legacy:
        raise HTTPException(status_code=400, detail="Provide only one of tiff_upload_manifest or tiff_upload_ids")
    if not manifest:
        return list(legacy or [])
    ids: List[str] = []
    for chunk in manifest:
        try:
            part = json.loads(chunk)
        except ValueError:
            part = None
        if not isinstance(part, list) or not all(isinstance(i, str) for i in part):
            raise HTTPException(status_code=400, detail="tiff_upload_manifest must be JSON arrays of upload ids")
        ids.extend(part)
    return ids


@router.post("", response_model=VolumeRead)
def create_volume(
    background_tasks: BackgroundTasks,
    slug: str = Form(...),
    title: str = Form(...),
    description: str = Form(""),
    tiff_zip: Optional[UploadFile] = File(
        None, description="A flat .zip of single-slice .tif/.tiff files"
    ),
    tiff_files: Optional[list[UploadFile]] = File(
        None, description="Multiple individual .tif/.tiff files (one per Z position)"
    ),
    spacing: Annotated[list[str], Form()] = None,
    mesh_file: Optional[UploadFile] = File(None),
    thumbnail_file: Optional[UploadFile] = File(None, description="Optional PNG/JPEG/WebP thumbnail"),
    # Instead of the file fields above: ids returned by PUT /api/uploads/volume|mesh, for files
    # nginx has already written to disk (see routers/uploads.py). Order matters for tiff_upload_ids.
    tiff_upload_id: Optional[str] = Form(None),
    tiff_upload_ids: Annotated[list[str], Form()] = None,  # one field per slice: max ~900 slices, see _slice_upload_ids
    tiff_upload_manifest: Annotated[list[str], Form()] = None,  # JSON arrays of slice ids, any number of slices
    mesh_upload_id: Optional[str] = Form(None),
    session: Session = Depends(get_session),
    editor: User = Depends(require_editor),
):
    if not SLUG_RE.fullmatch(slug):  # fullmatch: a pattern ending in $ also matches before a trailing newline
        raise HTTPException(status_code=400, detail="Slug must be lowercase alphanumeric/-/_ (2-63 chars)")

    slice_ids = _slice_upload_ids(tiff_upload_manifest, tiff_upload_ids)
    has_zip = tiff_zip is not None or bool(tiff_upload_id)
    n_sources = int(has_zip) + int(bool(tiff_files)) + int(bool(slice_ids))

    if n_sources == 0:
        raise HTTPException(status_code=400, detail="Provide either tiff_zip or tiff_files")
    if n_sources > 1:
        raise HTTPException(status_code=400, detail="Provide only one of tiff_zip or tiff_files")
    if mesh_file is not None and mesh_upload_id:
        raise HTTPException(status_code=400, detail="Provide only one of mesh_file or mesh_upload_id")
    if session.exec(select(Volume).where(Volume.slug == slug)).first():
        raise HTTPException(status_code=409, detail="A volume with this slug already exists")
    thumbnail = read_thumbnail(thumbnail_file) if thumbnail_file is not None else None  # validate before creating anything
    if not isinstance(spacing, tuple | list) or len(spacing) != 3:  # was inverted: every upload got a 400
        raise HTTPException(status_code=400, detail="Spacing must be three numbers (x, y, z)")
    try:
        spacing = [float(s) for s in spacing]
    except ValueError:
        raise HTTPException(status_code=400, detail="Spacing must be three numbers (x, y, z)")
    # Uploads nginx already wrote to disk: checked now, moved into place below.
    staged_zip = workdir.claim_upload(tiff_upload_id, "volume", editor.id) if tiff_upload_id else None
    staged_files = [workdir.claim_upload(i, "volume", editor.id) for i in slice_ids]
    staged_mesh = workdir.claim_upload(mesh_upload_id, "mesh", editor.id) if mesh_upload_id else None

    vol_dir = _volume_dir(slug)
    try:
        vol_dir.mkdir(parents=True, exist_ok=False)
    except FileExistsError:  # a folder without a database row (left over, or a concurrent request for the same slug)
        raise HTTPException(status_code=409, detail="A volume with this slug already exists")

    source_kind = "tiff" if has_zip else "tiff-files"
    upload_fd = None
    upload_fds = []
    # Staged uploads (files nginx already wrote to the processing directory) as (staged path,
    # destination in the scratch folder). Nothing is renamed in this request: that is one
    # filesystem operation per slice, so the response would wait for it. _process_upload does
    # it, and the browser is released as soon as the last byte has arrived.
    moves = []
    try:
        work_dir = workdir.prepare_work_dir("volumes", slug, vol_dir)
        thumbnail_name = write_thumbnail(vol_dir, *thumbnail) if thumbnail else None
        # A multipart upload is copied into the scratch folder by the background task, so
        # the response isn't held up by it (see workdir.detach_upload).
        if has_zip:
            if staged_zip is not None:
                moves = [(staged_zip.path, work_dir / ZIP_NAME)]
            else:
                upload_fd = workdir.detach_upload(tiff_zip)
        elif staged_files:
            moves = [(staged.path, work_dir / f"flice_{i:05d}.tiff") for i, staged in enumerate(staged_files)]
        else:
            upload_fds = [workdir.detach_upload(f) for f in tiff_files]
        workdir.reserve_uploads([src for src, _dst in moves])
    except Exception as exc:  # noqa: BLE001 - surface save errors to the caller
        workdir.drop_staged(moves)
        if upload_fd is not None:
            workdir.close_detached(upload_fd)
        for fd in upload_fds:
            workdir.close_detached(fd)
        shutil.rmtree(vol_dir, ignore_errors=True)
        workdir.discard_job("volumes", slug)
        raise HTTPException(status_code=400, detail=f"Could not save upload: {exc}")

    volume = Volume(
        slug=slug,
        title=title,
        description=description,
        thumbnail_path=thumbnail_name,
        created_by=editor.id,
        status=AssetStatus.processing,
        status_log=f"{_now()}  Upload received, queued for processing\n",
    )
    session.add(volume)
    session.commit()
    session.refresh(volume)

    # An optional mesh uploaded together with the volume is processed like any
    # other mesh (see routers/meshes.py) but is owned by the volume.
    mesh = None
    if mesh_file is not None or staged_mesh is not None:
        try:
            mesh = attach_mesh_to_volume(session, volume, mesh_file, editor, background_tasks, staged_mesh)
        except Exception:
            workdir.drop_staged(moves)
            if upload_fd is not None:
                workdir.close_detached(upload_fd)
            for fd in upload_fds:
                workdir.close_detached(fd)
            shutil.rmtree(vol_dir, ignore_errors=True)
            workdir.discard_job("volumes", slug)
            session.delete(volume)
            session.commit()
            raise

    background_tasks.add_task(
        _process_upload,
        volume.id,
        str(vol_dir),
        source_kind,
        upload_fd if has_zip else upload_fds,
        spacing,
        moves,
    )

    return _volume_read(volume, mesh)


def _process_upload(volume_id: int, vol_dir_str: str, source_kind: str, upload_fd: int | List[int], spacing=(1,1,1),
                    staged_moves=()) -> None:
    """Runs after create_volume's response has already been sent. Opens its
    own DB session — the request-scoped one from create_volume is closed by
    the time this runs. `staged_moves`: the staged uploads still to be renamed into the
    scratch folder (workdir.move_staged)."""
    vol_dir = Path(vol_dir_str)
    with Session(engine) as session:
        volume = session.get(Volume, volume_id)
        if volume is None:
            workdir.close_detached(upload_fd)
            workdir.drop_staged(staged_moves)
            return

        def log(message: str) -> None:
            print(f"[Volume {volume.slug}] {message}")
            volume.status_log = (volume.status_log or "") + f"{_now()}  {message}\n"
            session.add(volume)
            session.commit()

        work_dir = _work_dir(volume.slug)
        try:
            log("Saving upload")
            workdir.move_staged(staged_moves)  # renames only: the bytes are already on this filesystem
            if source_kind == "tiff":
                zip_path = work_dir / ZIP_NAME
                workdir.save_detached(upload_fd, zip_path)
                max_lod = process_zip(zip_path, work_dir, vol_dir, spacing, log)
            else:
                for i in range(len(upload_fd)):
                    tiff_path = work_dir / f"flice_{i:05d}.tiff"
                    workdir.save_detached(upload_fd[i], tiff_path)
                tiff_source_dir = work_dir
                max_lod = decompose_tiff_stack(tiff_source_dir, vol_dir, log=log, spacing=spacing)
            volume.num_lod_levels = max_lod
            volume.status = AssetStatus.ready
            log("Ready")
        except Exception as exc:  # noqa: BLE001 - the failure message IS the point, shown to the user
            volume.status = AssetStatus.failed
            log(f"Failed: {exc}")
        finally:
            workdir.discard_job("volumes", volume.slug)  # success or failure: scratch is never kept
            workdir.drop_staged(staged_moves)  # whatever a failure left unmoved, and the reservation
        session.add(volume)
        session.commit()
        _invalidate_volume_cache(volume_id)


def backfill_missing_histograms() -> None:
    """Report missing histograms; sharded conversion writes them during ingestion.

    Reconstructing a histogram from the compressed brick store is intentionally not
    attempted at startup because it would require decompressing the full dataset.
    """
    with Session(engine) as session:
        ready = session.exec(select(Volume).where(Volume.status == AssetStatus.ready)).all()
        missing = [v.slug for v in ready if not histogram_path(_volume_dir(v.slug)).is_file()]
    if missing:
        print(f"[volume-gallery] {len(missing)} sharded volume(s) have no histogram: {', '.join(missing)}")


@router.get("/{volume_id}/histogram")
def get_histogram(
    volume_id: int, request: Request, session: Session = Depends(get_session), user: User = Depends(get_current_user)
):
    """The volume's intensity histogram (JSON, see helpers/histogram.py); 404 if there is none."""
    volume = session.get(Volume, volume_id)
    if not volume or not _can_see_volume(user, volume, session):
        raise HTTPException(status_code=404, detail="Volume not found")
    path = histogram_path(_volume_dir(volume.slug))
    if not path.is_file():
        raise HTTPException(status_code=404, detail="No histogram")
    st = path.stat()
    etag = f'"{st.st_mtime_ns:x}-{st.st_size:x}"'
    headers = {"ETag": etag, "Cache-Control": "private, no-cache"}
    if etag in {t.strip() for t in request.headers.get("if-none-match", "").split(",")}:
        return Response(status_code=304, headers=headers)
    return Response(content=path.read_bytes(), media_type="application/json", headers=headers)


@router.post("/{volume_id}/mesh", response_model=VolumeRead)
def upload_or_replace_mesh(
    volume_id: int,
    background_tasks: BackgroundTasks,
    mesh_file: Optional[UploadFile] = File(None),
    mesh_upload_id: Optional[str] = Form(None),  # instead of mesh_file: see routers/uploads.py
    session: Session = Depends(get_session),
    editor: User = Depends(require_editor),
):
    if (mesh_file is None) == (not mesh_upload_id):
        raise HTTPException(status_code=400, detail="Provide exactly one of mesh_file or mesh_upload_id")
    volume = session.get(Volume, volume_id)
    if not volume:
        raise HTTPException(status_code=404, detail="Volume not found")
    staged = workdir.claim_upload(mesh_upload_id, "mesh", editor.id) if mesh_upload_id else None
    mesh = attach_mesh_to_volume(session, volume, mesh_file, editor, background_tasks, staged)
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
# kiln-render fetches the sharded volume metadata by plain URL, so we hand it a
# short-lived signed URL instead of requiring an Authorization header.

@router.get("/{volume_id}/volume-data-access-url", response_model=FileAccessUrl)
def volume_data_access_url(
    volume_id: int,
    request: Request,
    min_level: Optional[int] = Query(
        None, ge=0,
        description="Finest sharded LOD index to load (0 = full resolution; "
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
    # A share link's resolution cap is enforced here, not left to the viewer: whatever min_level
    # the caller sends (or leaves out), the token never lets through a finer level than the share.
    scope = getattr(user, "_share_scope", None)
    if scope is not None and scope.get("min_lod"):
        min_level = max(min_level or 0, scope["min_lod"])
        levels = _volume_level_count(volume)
        if levels:  # a cap past the coarsest level means the coarsest level
            min_level = min(min_level, levels - 1)
    base = str(request.base_url).rstrip("/")
    ver_input = f"{volume.id}:{volume.created_at.isoformat()}:{volume.slug}"
    version = hashlib.sha256(ver_input.encode("utf-8")).hexdigest()[:16]

    vol_dir = _volume_dir(volume.slug).resolve()
    if volume_meta_path(vol_dir).is_file():
        token = create_file_token(subject=user.username, user=user, asset_id=volume_id, kind="sharded", min_lod=min_level, ver=version)
        return FileAccessUrl(
            url=f"{base}/api/volumes/{volume_id}/dataset/{token}",
            expires_in_minutes=settings.FILE_TOKEN_EXPIRE_MINUTES,
            version=version,
        )
    else:
        raise HTTPException(status_code=404, detail="Volume not found")


def _require_download(user: User) -> None:
    """A share link without can_download may look at an asset but not take the original files."""
    scope = getattr(user, "_share_scope", None)
    if scope is not None and not scope.get("can_download"):
        raise HTTPException(status_code=403, detail="This share link does not allow downloads")


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
    _require_download(user)
    token = create_file_token(subject=user.username, user=user, asset_id=volume_id, kind="volume-mesh-download")
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
    token = create_file_token(subject=user.username, user=user, asset_id=volume_id, kind="volume-mesh-view")
    base = str(request.base_url).rstrip("/")
    return FileAccessUrl(
        url=f"{base}/api/volumes/{volume_id}/mesh-view-file/{token}",
        expires_in_minutes=settings.FILE_TOKEN_EXPIRE_MINUTES,
    )


# ---------- Slice views: planes extracted server-side ----------
# The browser asks for one finished plane at a time, read directly from sharded bricks. See helpers/slices.py for the cache that keeps scrolling fast.

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
    # Same cap as volume-data-access-url: the share's min_lod is carried by the token and
    # applied in _slice_store (a guest asking for level 0 gets the share's coarsest allowed level).
    scope = getattr(user, "_share_scope", None)
    slice_min_lod = scope["min_lod"] if scope is not None and scope.get("min_lod") else None
    levels = _volume_level_count(volume) if slice_min_lod is not None else None
    if levels:
        slice_min_lod = min(slice_min_lod, levels - 1)
    token = create_file_token(subject=user.username, user=user, asset_id=volume_id, kind="slice", min_lod=slice_min_lod)
    return FileAccessUrl(
        url=f"/api/volumes/{volume_id}/slices/{token}/",
        expires_in_minutes=settings.FILE_TOKEN_EXPIRE_MINUTES,
    )


def _slice_store(volume_id: int, token: str, level: int, session: Session):
    payload = _check_file_token(token, volume_id, "slice")
    level = max(level, int(payload.get("min_lod") or 0))  # a share link's resolution cap
    volume = session.get(Volume, volume_id)
    if not volume:
        raise HTTPException(status_code=404, detail="Volume not found")
    # Kiln files live directly in the volume slug directory. Do not append the
    shard_root = _volume_dir(volume.slug).resolve()
    # Plane reads can take a while: give the DB connection back first so a
    # burst of slice requests cannot exhaust the connection pool.
    session.close()
    try:
        return open_volume_slices(shard_root, level)
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
    # The bytes are fixed by the token's claims.
    headers["Cache-Control"] = f"public, max-age={settings.FILE_TOKEN_EXPIRE_MINUTES * 60}, immutable"
    return Response(content=body, media_type="application/octet-stream", headers=headers)


def _get_volume_shard_loc(volume_id: int):
    """Resolve the canonical sharded dataset location for a ready volume."""
    with Session(engine) as session:
        volume = session.get(Volume, volume_id)
        if volume is None:
            raise HTTPException(status_code=404, detail="Volume not found")
        slug = volume.slug
    # The canonical dataset layout is flat: all kiln files are directly under
    # /data/volumes/<slug>/. Ignore data_path, which is retained only for DB
    # compatibility with older versions of the application.
    data_rel = ""
    root = _volume_dir(slug).resolve()
    if not (root / "volume.json").is_file():
        raise HTTPException(status_code=404, detail="Volume data not found")
    return slug, data_rel, root


def _check_file_token(token: str, volume_id: int, kind: str) -> dict:
    payload = decode_token(token)
    if (
        not payload
        or payload.get("type") != "file"
        or payload.get("kind") != kind
        or payload.get("vol") != volume_id
        or file_token_revoked(payload)
    ):
        raise HTTPException(status_code=403, detail="Invalid or expired link")
    return payload

_SHARDED_FILE_RE = re.compile(r"^(?:volume\.json|lod(\d+)\.bin|lod(\d+)_index\.json)$")


@router.get("/{volume_id}/dataset/{token}/{path:path}")
async def serve_sharded_file(volume_id: int, token: str, path: str):
    """Serves volume.json, lodN_index.json and ranged reads of lodN.bin for a volume stored in
    kiln-render's sharded-binary format. kiln-render fetches every brick with a Range request
    into lodN.bin — nginx (X-Accel-Redirect) or FileResponse answers those with 206.
    """
    clean_path = _validate_rel_path(path)
    payload = _check_file_token_cached(token, volume_id, "sharded")
    match = _SHARDED_FILE_RE.fullmatch(clean_path)
    if not match:
        raise HTTPException(status_code=404, detail="Not found")
    slug, data_rel, data_root = _get_volume_shard_loc(volume_id)

    min_lod = payload.get("min_lod")
    lod = match.group(1) or match.group(2)
    # Unlike metadata-only level capping, a level's
    # files are named after it, so the cap can be enforced outright: kiln never asks for the
    # finer levels once volume.json no longer lists them.
    if min_lod and lod is not None and int(lod) < min_lod:
        raise HTTPException(status_code=403, detail="This link does not include that level of detail")

    # volume.json is the only file that lists the levels, so it is the only one rewritten.
    rewrite_meta = bool(min_lod) and clean_path == "volume.json"

    # The bytes are fixed by the token's claims.
    cache_headers = {"Cache-Control": f"public, max-age={settings.FILE_TOKEN_EXPIRE_MINUTES * 60}, immutable"}
    is_json = clean_path.endswith(".json")

    if settings.SHARD_ACCEL_REDIRECT and not rewrite_meta:
        prefix = settings.SHARD_ACCEL_PREFIX.rstrip("/")
        rel_parts = [p for p in (slug, data_rel, clean_path) if p]
        headers = {
            **cache_headers,
            "X-Accel-Redirect": f"{prefix}/{'/'.join(rel_parts)}",
            "Content-Type": "application/json" if is_json else "application/octet-stream",
        }
        return Response(status_code=200, headers=headers)

    target = (data_root / clean_path).resolve()
    if not target.is_relative_to(data_root):
        raise HTTPException(status_code=400, detail="Invalid path")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Not found")

    if rewrite_meta:
        rewritten = truncate_sharded_volume_json(target.read_bytes(), min_lod)
        if rewritten is not None:
            return Response(content=rewritten, media_type="application/json", headers=cache_headers)
    return FileResponse(
        target,
        media_type="application/json" if is_json else "application/octet-stream",
        headers=cache_headers,
    )

def truncate_sharded_volume_json(raw: bytes, min_lod: int) -> Optional[bytes]:
    """Sharded-binary counterpart of truncate_multiscales_json: drops the levels
    finer than min_lod (keeps levels[min_lod:]) from a volume.json, so kiln-render
    never sees, and never requests, the finer bricks. Nothing on disk is touched.

    kiln-render derives everything from volume.json, looks levels up by their
    `lod` field and fetches each level's `binFile` / `indexFile` by the names
    listed there, so the kept levels are renumbered to start at 0 while still
    pointing at their real files (lod2.bin etc.). The per-level lodN_index.json
    files can be served as-is: kiln does not check the `lod` stored inside them.

    Because the new level 0 is coarser, the geometry that kiln reads from the
    top level has to follow, or the volume would render too small:
      - originalDimensions -> the dimensions of the new level 0
      - voxelSpacing       -> scaled by the downsampling between the old and
                              new level 0 (per axis, factor 2 per step in which
                              that axis shrank), so the physical size is unchanged
      - maxLod             -> number of kept levels - 1
    Returns None (meaning: serve the original file unchanged) if the content
    isn't parseable, isn't in the expected shape, or min_lod doesn't leave
    at least one level."""
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None

    levels = data.get("levels")
    if not isinstance(levels, list) or not 0 < min_lod < len(levels):
        return None
    if not all(isinstance(l, dict) and isinstance(l.get("lod"), int) for l in levels):
        return None
    levels = sorted(levels, key=lambda l: l["lod"])

    def _vec3(v) -> Optional[list]:
        ok = isinstance(v, (list, tuple)) and len(v) == 3 and all(
            isinstance(x, (int, float)) and not isinstance(x, bool) for x in v
        )
        return list(v) if ok else None

    spacing = _vec3(data.get("voxelSpacing"))
    dims = [_vec3(l.get("dimensions")) for l in levels]
    if spacing is None or any(d is None for d in dims):
        return None

    # Per axis: one factor-2 step for every level transition up to the new level 0
    # in which that axis got smaller (the same rule kiln's pyramid builder applies).
    for axis in range(3):
        steps = sum(1 for i in range(1, min_lod + 1) if dims[i][axis] != dims[i - 1][axis])
        spacing[axis] = spacing[axis] * (2 ** steps)

    kept = []
    for new_lod, level in enumerate(levels[min_lod:]):
        level = dict(level)
        level["lod"] = new_lod
        kept.append(level)

    data["levels"] = kept
    data["originalDimensions"] = list(dims[min_lod])
    data["voxelSpacing"] = spacing
    data["maxLod"] = len(kept) - 1
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
    filename = f"{volume.slug}.{mesh.file_extension}"
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
    if mesh is None:
        raise HTTPException(status_code=404, detail="Not found")
    nxz_path = volume_mesh_file(mesh)
    if not nxz_path.exists():
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(
        nxz_path,
        headers={"Cache-Control": f"public, max-age={settings.FILE_TOKEN_EXPIRE_MINUTES * 60}, immutable"},
    )
