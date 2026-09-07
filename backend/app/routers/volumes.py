import json
import re
import shutil
import zipfile
from collections import deque
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query, Request
from fastapi.responses import FileResponse
from sqlmodel import Session, select

from ..database import get_session
from ..models import User, Role, Volume, VolumeAccess
from ..schemas import VolumeRead, VolumeAccessGrant, FileAccessUrl, UserRead
from ..deps import get_current_user, require_editor, require_admin
from ..security import create_file_token, decode_token
from ..config import settings
from ..tiff_convert import convert_tiff_stack_to_ome_zarr

router = APIRouter(prefix="/api/volumes", tags=["volumes"])

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,62}$")


def _volume_dir(slug: str) -> Path:
    return settings.VOLUMES_DIR / slug


def _has_multiscales(attrs: dict) -> bool:
    """Checks the two shapes OME-NGFF metadata can take: a flat
    `multiscales` key (v2, and plain v3/v0.4), or one namespaced under
    `ome` (v0.5's convention for zarr-v3 group attributes)."""
    if not isinstance(attrs, dict):
        return False
    if "multiscales" in attrs:
        return True
    ome = attrs.get("ome")
    return isinstance(ome, dict) and "multiscales" in ome


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


def _volume_read(v: Volume) -> VolumeRead:
    return VolumeRead(
        id=v.id,
        slug=v.slug,
        title=v.title,
        description=v.description,
        has_mesh=v.has_mesh,
        mesh_filename=v.mesh_filename,
        created_at=v.created_at.isoformat(),
    )


# ---------- Gallery ----------

@router.get("", response_model=List[VolumeRead])
def list_volumes(session: Session = Depends(get_session), user: User = Depends(get_current_user)):
    volumes = session.exec(select(Volume)).all()
    visible = [v for v in volumes if _can_see_volume(user, v, session)]
    return [_volume_read(v) for v in visible]


@router.get("/{volume_id}", response_model=VolumeRead)
def get_volume(
    volume_id: int, session: Session = Depends(get_session), user: User = Depends(get_current_user)
):
    volume = session.get(Volume, volume_id)
    if not volume or not _can_see_volume(user, volume, session):
        raise HTTPException(status_code=404, detail="Volume not found")
    return _volume_read(volume)


# ---------- Editor: create / upload / delete ----------

@router.post("", response_model=VolumeRead)
def create_volume(
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
    session: Session = Depends(get_session),
    editor: User = Depends(require_editor),
):
    if not SLUG_RE.match(slug):
        raise HTTPException(status_code=400, detail="Slug must be lowercase alphanumeric/-/_ (2-63 chars)")
    if zarr_zip is None and tiff_zip is None:
        raise HTTPException(status_code=400, detail="Provide either zarr_zip or tiff_zip")
    if zarr_zip is not None and tiff_zip is not None:
        raise HTTPException(status_code=400, detail="Provide only one of zarr_zip or tiff_zip, not both")
    if session.exec(select(Volume).where(Volume.slug == slug)).first():
        raise HTTPException(status_code=409, detail="A volume with this slug already exists")

    vol_dir = _volume_dir(slug)
    vol_dir.mkdir(parents=True, exist_ok=False)

    try:
        if zarr_zip is not None:
            zarr_root = _extract_zarr_zip(zarr_zip, vol_dir)
        else:
            zarr_root = _convert_tiff_zip(tiff_zip, vol_dir)
    except HTTPException:
        shutil.rmtree(vol_dir, ignore_errors=True)
        raise
    except Exception as exc:  # noqa: BLE001 - surface conversion errors to the caller
        shutil.rmtree(vol_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail=f"Could not process upload: {exc}")

    mesh_filename = None
    has_mesh = False
    if mesh_file is not None:
        mesh_filename = Path(mesh_file.filename).name
        with open(vol_dir / mesh_filename, "wb") as f:
            shutil.copyfileobj(mesh_file.file, f)
        has_mesh = True

    volume = Volume(
        slug=slug,
        title=title,
        description=description,
        zarr_path=str(zarr_root.relative_to(vol_dir)),
        has_mesh=has_mesh,
        mesh_filename=mesh_filename,
        created_by=editor.id,
    )
    session.add(volume)
    session.commit()
    session.refresh(volume)
    return _volume_read(volume)


def _extract_zarr_zip(zarr_zip: UploadFile, vol_dir: Path) -> Path:
    """Extracts an uploaded OME-Zarr .zip into vol_dir and locates its
    multiscale group root (see _find_ome_zarr_root for why presence of a
    zarr.json/.zattrs file alone isn't sufficient)."""
    zip_path = vol_dir / "_upload.zip"
    with open(zip_path, "wb") as f:
        shutil.copyfileobj(zarr_zip.file, f)
    try:
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(vol_dir)
    except zipfile.BadZipFile:
        raise HTTPException(status_code=400, detail="zarr_zip is not a valid zip file")
    finally:
        zip_path.unlink(missing_ok=True)

    zarr_root = _find_ome_zarr_root(vol_dir)
    if zarr_root is None:
        raise HTTPException(
            status_code=400,
            detail=(
                "No OME-NGFF multiscales metadata found anywhere in the archive. "
                "Every zarr.json/.zattrs found lacks a multiscales entry — check "
                "that the archive contains the multiscale *group* (not just an "
                "individual resolution-level array), and that it was written "
                "with OME-NGFF metadata (attributes.multiscales for v2/plain v3, "
                "or attributes.ome.multiscales for NGFF v0.5)."
            ),
        )
    return zarr_root


def _convert_tiff_zip(tiff_zip: UploadFile, vol_dir: Path) -> Path:
    """Extracts an uploaded TIFF-stack .zip into a scratch directory, converts
    it to OME-Zarr under vol_dir, then deletes the extracted TIFF files —
    only the converted OME-Zarr store is kept on disk afterward."""
    scratch_dir = vol_dir / "_tiff_import"
    scratch_dir.mkdir()
    zip_path = vol_dir / "_upload.zip"
    with open(zip_path, "wb") as f:
        shutil.copyfileobj(tiff_zip.file, f)
    try:
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(scratch_dir)
    except zipfile.BadZipFile:
        raise HTTPException(status_code=400, detail="tiff_zip is not a valid zip file")
    finally:
        zip_path.unlink(missing_ok=True)

    # Slices may be nested in a subfolder inside the zip rather than at its
    # top level (e.g. a zip of "scan/slice_0001.tif" instead of
    # "slice_0001.tif") — search shallowest-first for the folder that
    # actually contains the .tif files, same rationale as _find_ome_zarr_root.
    tiff_source_dir = _find_tiff_dir(scratch_dir)
    if tiff_source_dir is None:
        raise HTTPException(status_code=400, detail="No .tif/.tiff files found in tiff_zip")

    zarr_dir = vol_dir / "data.ome.zarr"
    try:
        convert_tiff_stack_to_ome_zarr(tiff_source_dir, zarr_dir)
    finally:
        # Only the converted OME-Zarr store is kept — the source TIFFs are
        # deleted whether conversion succeeded or failed.
        shutil.rmtree(scratch_dir, ignore_errors=True)

    zarr_root = _find_ome_zarr_root(vol_dir)
    if zarr_root is None:
        # Shouldn't happen — write_image() always emits multiscales metadata —
        # but don't silently accept a store our own viewer couldn't load.
        raise HTTPException(
            status_code=500,
            detail="TIFF conversion completed but produced no readable OME-NGFF metadata",
        )
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
    mesh_file: UploadFile = File(...),
    session: Session = Depends(get_session),
    editor: User = Depends(require_editor),
):
    volume = session.get(Volume, volume_id)
    if not volume:
        raise HTTPException(status_code=404, detail="Volume not found")
    vol_dir = _volume_dir(volume.slug)
    mesh_filename = Path(mesh_file.filename).name
    with open(vol_dir / mesh_filename, "wb") as f:
        shutil.copyfileobj(mesh_file.file, f)
    volume.mesh_filename = mesh_filename
    volume.has_mesh = True
    session.add(volume)
    session.commit()
    session.refresh(volume)
    return _volume_read(volume)


@router.delete("/{volume_id}")
def delete_volume(
    volume_id: int, session: Session = Depends(get_session), _editor: User = Depends(require_editor)
):
    volume = session.get(Volume, volume_id)
    if not volume:
        raise HTTPException(status_code=404, detail="Volume not found")
    shutil.rmtree(_volume_dir(volume.slug), ignore_errors=True)
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
    payload: VolumeAccessGrant,
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
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    volume = session.get(Volume, volume_id)
    if not volume or not _can_see_volume(user, volume, session):
        raise HTTPException(status_code=404, detail="Volume not found")
    token = create_file_token(subject=user.username, volume_id=volume_id, kind="zarr")
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
    volume = session.get(Volume, volume_id)
    if not volume or not _can_see_volume(user, volume, session):
        raise HTTPException(status_code=404, detail="Volume not found")
    if not volume.has_mesh:
        raise HTTPException(status_code=404, detail="This volume has no mesh")
    token = create_file_token(subject=user.username, volume_id=volume_id, kind="mesh")
    return FileAccessUrl(
        url=f"/api/volumes/{volume_id}/mesh-file/{token}",
        expires_in_minutes=settings.FILE_TOKEN_EXPIRE_MINUTES,
    )


def _check_file_token(token: str, volume_id: int, kind: str) -> str:
    payload = decode_token(token)
    if (
        not payload
        or payload.get("type") != "file"
        or payload.get("kind") != kind
        or payload.get("vol") != volume_id
    ):
        raise HTTPException(status_code=403, detail="Invalid or expired link")
    return payload["sub"]


@router.get("/{volume_id}/dataset.ome.zarr/{token}/{path:path}")
def serve_zarr_file(
    volume_id: int, token: str, path: str, session: Session = Depends(get_session)
):
    """Serves individual chunk/metadata files inside the OME-Zarr store.
    kiln-render performs many small ranged GETs against this — keep it fast and stateless.
    """
    _check_file_token(token, volume_id, "zarr")
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
    return FileResponse(target)


@router.get("/{volume_id}/mesh-file/{token}")
def serve_mesh_file(
    volume_id: int, token: str, session: Session = Depends(get_session)
):
    _check_file_token(token, volume_id, "mesh")
    volume = session.get(Volume, volume_id)
    if not volume or not volume.has_mesh:
        raise HTTPException(status_code=404, detail="Not found")
    mesh_path = _volume_dir(volume.slug) / volume.mesh_filename
    if not mesh_path.exists():
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(mesh_path, filename=volume.mesh_filename)
