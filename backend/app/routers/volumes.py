import re
import shutil
import zipfile
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query
from fastapi.responses import FileResponse
from sqlmodel import Session, select

from ..database import get_session
from ..models import User, Role, Volume, VolumeAccess
from ..schemas import VolumeRead, VolumeAccessGrant, FileAccessUrl, UserRead
from ..deps import get_current_user, require_editor, require_admin
from ..security import create_file_token, decode_token
from ..config import settings

router = APIRouter(prefix="/api/volumes", tags=["volumes"])

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-_]{1,62}$")


def _volume_dir(slug: str) -> Path:
    return settings.VOLUMES_DIR / slug


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
    zarr_zip: UploadFile = File(..., description="Zip archive containing the .ome.zarr directory"),
    mesh_file: Optional[UploadFile] = File(None),
    session: Session = Depends(get_session),
    editor: User = Depends(require_editor),
):
    if not SLUG_RE.match(slug):
        raise HTTPException(status_code=400, detail="Slug must be lowercase alphanumeric/-/_ (2-63 chars)")
    if session.exec(select(Volume).where(Volume.slug == slug)).first():
        raise HTTPException(status_code=409, detail="A volume with this slug already exists")

    vol_dir = _volume_dir(slug)
    vol_dir.mkdir(parents=True, exist_ok=False)

    # Extract the OME-Zarr archive
    zip_path = vol_dir / "_upload.zip"
    with open(zip_path, "wb") as f:
        shutil.copyfileobj(zarr_zip.file, f)
    try:
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(vol_dir)
    except zipfile.BadZipFile:
        shutil.rmtree(vol_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail="zarr_zip is not a valid zip file")
    finally:
        zip_path.unlink(missing_ok=True)

    # Find the extracted .zarr / .ome.zarr root (top-level dir containing .zattrs / zarr.json)
    zarr_root = None
    for candidate in vol_dir.rglob("*"):
        if candidate.is_dir() and (
            (candidate / ".zattrs").exists() or (candidate / "zarr.json").exists()
        ):
            zarr_root = candidate
            break
    if zarr_root is None:
        shutil.rmtree(vol_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail="No OME-Zarr root found in archive")

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
    volume_id: int, session: Session = Depends(get_session), user: User = Depends(get_current_user)
):
    volume = session.get(Volume, volume_id)
    if not volume or not _can_see_volume(user, volume, session):
        raise HTTPException(status_code=404, detail="Volume not found")
    token = create_file_token(subject=user.username, volume_id=volume_id, kind="zarr")
    return FileAccessUrl(
        url=f"/api/volumes/{volume_id}/zarr/{token}/",
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


@router.get("/{volume_id}/zarr/{token}/{path:path}")
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
    zarr_root = _volume_dir(volume.slug) / volume.zarr_path
    target = (zarr_root / path).resolve()
    if not str(target).startswith(str(zarr_root.resolve())):
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
