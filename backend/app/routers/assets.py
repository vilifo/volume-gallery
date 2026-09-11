import re
import shutil
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, UploadFile, File, Form, Request
from fastapi.responses import FileResponse
from sqlmodel import Session, select

from ..database import get_session, engine
from ..models import User, Role, Volume, AssetAccess, AssetStatus, Mesh, PointCloud, AssetBase
from ..schemas import AssetRead, AssetStatusRead, AssetAccessGrant, FileAccessUrl, UserRead, VolumeRead, MeshRead, PointCloudRead
from ..deps import get_current_user, require_editor
from ..security import create_file_token, decode_token
from ..config import settings

from ..helpers import convert_mesh_to_nxz, extract_zarr_zip_from_path, convert_tiff_zip_from_path, convert_point_cloud


router = APIRouter(prefix="/api/assets", tags=["assets"])

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,62}$")


def _asset_dir(slug: str) -> Path:
    return settings.ASSETS_DIR / slug


def _can_see_asset(user: User, asset: AssetBase, session: Session) -> bool:
    if user.role in (Role.admin, Role.editor):
        return True
    grant = session.exec(
        select(AssetAccess).where(
            AssetAccess.user_id == user.id, AssetAccess.asset_id == asset.id
        )
    ).first()
    return grant is not None


def _asset_read(a: AssetBase) -> AssetRead:
    log_lines = [line for line in (a.status_log or "").split("\n") if line]
    if isinstance(a, Volume):
        read = VolumeRead
    elif isinstance(a, Mesh):
        read = MeshRead
    elif isinstance(a, PointCloud):
        read = PointCloudRead
    else:
        raise ValueError(f"Unknown asset type: {type(a)}")
    read = read(
        id=a.id,
        slug=a.slug,
        title=a.title,
        description=a.description,
        created_at=a.created_at,
        status=a.status,
        status_log=log_lines,
    )
    if isinstance(a, Volume) and a.mesh:
        read.mesh = MeshRead.from_orm(a.mesh)
    return read


# ---------- Gallery ----------

@router.get("", response_model=List[AssetRead])
def list_assets(session: Session = Depends(get_session), user: User = Depends(get_current_user)):
    visible = []
    for asset_type in (Volume, Mesh, PointCloud):
        assets = session.exec(select(asset_type)).all()
        visible.extend([a for a in assets if _can_see_asset(user, a, session)])
    return [_asset_read(v) for v in visible]


@router.get("/{asset_id}", response_model=AssetRead)
def get_asset(
    asset_id: int, session: Session = Depends(get_session), user: User = Depends(get_current_user)
):
    asset = _get_asset_by_id(session, asset_id)
    if not asset or not _can_see_asset(user, asset, session):
        raise HTTPException(status_code=404, detail="Asset not found")
    return _asset_read(asset)


def _get_asset_by_id(session, asset_id: int):
    for model in (Volume, Mesh, PointCloud):
        obj = session.get(model, asset_id)
        if obj:
            return obj
    return None


def _to_asset_read(asset):
    if isinstance(asset, Volume):
        return VolumeRead(
            id=asset.id,
            slug=asset.slug,
            title=asset.title,
            description=asset.description,
            created_at=asset.created_at,
            status=asset.status,
            status_log=asset.status_log.splitlines(),
            mesh=MeshRead.from_orm(asset.mesh) if asset.mesh else None,
        )

    if isinstance(asset, Mesh):
        return MeshRead.from_orm(asset)

    if isinstance(asset, PointCloud):
        return PointCloudRead.from_orm(asset)

    return None


@router.get("/{asset_id}/status", response_model=AssetStatusRead)
def get_asset_status(
    asset_id: int, session: Session = Depends(get_session), user: User = Depends(get_current_user)
):
    """Lightweight endpoint for the gallery page to poll while a asset is
    still processing — same payload shape as VolumeRead's status fields,
    without re-sending everything else."""
    asset = _get_asset_by_id(session, asset_id)
    if not asset or not _can_see_asset(user, asset, session):
        raise HTTPException(status_code=404, detail="Asset not found")
    log_lines = [line for line in (asset.status_log or "").split("\n") if line]
    return AssetStatusRead(id=asset.id, status=asset.status, status_log=log_lines)


# ---------- Editor: create / upload / delete ----------

@router.post("", response_model=AssetRead)
def create_asset(
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
    mesh_file: Optional[UploadFile] = File(
        None, description="Mesh file"),
    point_cloud_file: Optional[UploadFile] = File(
        None, description="Point cloud file"),
    session: Session = Depends(get_session),
    editor: User = Depends(require_editor),
):
    if not SLUG_RE.match(slug):
        raise HTTPException(status_code=400, detail="Slug must be lowercase alphanumeric/-/_ (2-63 chars)")
    uploads = 0
    for upload in (zarr_zip, tiff_zip, mesh_file, point_cloud_file):
        if upload is not None:
            uploads += 1
    if uploads != 1:
        raise HTTPException(status_code=400, detail="Provide exactly one of zarr_zip, tiff_zip, mesh_file, or point_cloud_file")
    if session.exec(select(Volume).where(Volume.slug == slug)).first():
        raise HTTPException(status_code=409, detail="A asset with this slug already exists")

    asset_dir = _asset_dir(slug)
    asset_dir.mkdir(parents=True, exist_ok=False)

    source_kind = "zarr" if zarr_zip is not None else "tiff" if tiff_zip is not None else "mesh" if mesh_file is not None else "pointcloud"
    source_upload = zarr_zip if zarr_zip is not None else tiff_zip if tiff_zip is not None else mesh_file if mesh_file is not None else point_cloud_file
    aux_mesh_upload = False
    try:
        upload_path = asset_dir / source_upload.filename
        with open(upload_path, "wb") as f:
            shutil.copyfileobj(source_upload.file, f)

        if source_kind in ("zarr", "tiff"):
            if mesh_file is not None:
                mesh_upload_path = asset_dir / mesh_file.filename
                with open(mesh_upload_path, "wb") as f:
                    shutil.copyfileobj(mesh_file.file, f)
                aux_mesh_upload = True
    except Exception as exc:  # noqa: BLE001 - surface save errors to the caller
        shutil.rmtree(asset_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail=f"Could not save upload: {exc}")

    asset = Volume if source_kind in ("zarr", "tiff") else Mesh if source_kind == "mesh" else PointCloud

    asset = asset(
        slug=slug,
        title=title,
        description=description,
        file_path="",  # filled in by _process_upload once conversion/extraction finishes
        created_by=editor.id,
        status=AssetStatus.processing,
        status_log=f"{_now()}  Upload received, queued for processing\n",
    )
    session.add(asset)
    session.commit()
    session.refresh(asset)

    background_tasks.add_task(_process_upload, asset.id, str(asset_dir), source_kind)
    if aux_mesh_upload:
        mesh = Mesh(
            slug=f"{slug}-mesh",
            title=f"{title} (mesh)",
            description=f"Mesh for {title}",
            file_path="",  # filled in by _process_aux_upload once conversion/extraction finishes
            created_by=editor.id,
            status=AssetStatus.processing,
            status_log=f"{_now()}  Mesh upload received, queued for processing\n",
            volume_id=asset.id,
            volume=asset
        )
        session.add(mesh)
        session.commit()
        session.refresh(mesh)
        background_tasks.add_task(_process_aux_upload, mesh.id, str(asset_dir), "mesh")

    return _asset_read(asset)


def _now() -> str:
    return datetime.utcnow().strftime("%H:%M:%S")


def _process_upload(asset_id: int, asset_dir_str: str, source_kind: str) -> None:
    """Runs after create_volume's response has already been sent. Opens its
    own DB session — the request-scoped one from create_volume is closed by
    the time this runs."""
    asset_dir = Path(asset_dir_str)
    asset_type = Volume if source_kind in ("zarr", "tiff") else Mesh if source_kind == "mesh" else PointCloud
    with Session(engine) as session:
        asset = session.get(asset_type, asset_id)
        if asset is None:
            return

        def log(message: str) -> None:
            asset.status_log = (asset.status_log or "") + f"{_now()}  {message}\n"
            session.add(asset)
            session.commit()

        try:
            if source_kind == "zarr":
                log("Extracting OME-Zarr archive")
                asset_path_root = extract_zarr_zip_from_path(asset_dir)
            elif source_kind == "tiff":
                asset_path_root = convert_tiff_zip_from_path(asset_dir, log)
            elif source_kind == "mesh":
                log("Processing mesh file")
                asset_path_root = convert_mesh_to_nxz(asset_dir, log)
            elif source_kind == "pointcloud":
                log("Processing point cloud file")
                asset_path_root = convert_point_cloud(asset_dir, log)  # For point clouds, we just keep the uploaded file as is
            else:
                raise ValueError(f"Unknown source_kind: {source_kind}")
            asset.file_path = str(asset_path_root.relative_to(asset_dir))
            asset.status = AssetStatus.ready
            log("Ready")
        except Exception as exc:  # noqa: BLE001 - the failure message IS the point, shown to the user
            asset.status = AssetStatus.failed
            log(f"Failed: {exc}")
        session.add(asset)
        session.commit()


def _process_aux_upload(mesh_id: int, asset_dir_str: str) -> None:
    mesh_dir = Path(asset_dir_str)
    with Session(engine) as session:
        mesh = session.get(Mesh, mesh_id)
        if mesh is None:
            return
        volume = session.get(Volume, mesh.volume_id)
        if volume is None:
            return
        volume.mesh = mesh # associate the mesh with the volume
        session.add(volume)
        session.commit()

        def log(message: str) -> None:
            mesh.status_log = (mesh.status_log or "") + f"{_now()}  {message}\n"
            session.add(mesh)
            session.commit()

        try:
            zip_path = mesh_dir / "_mesh.file"
            log("Processing mesh file")
            mesh_root = convert_mesh_to_nxz(zip_path, log) # TODO
            mesh.file_path = str(mesh_root.relative_to(mesh_dir))
            mesh.status = AssetStatus.ready
            log("Ready")
        except Exception as exc:  # noqa: BLE001 - the failure message IS the point, shown to the user
            mesh.status = AssetStatus.failed
            log(f"Failed: {exc}")
        session.add(mesh)
        session.commit()


@router.post("/{asset_id}/mesh", response_model=AssetRead) # TODO: should this be MeshRead instead of AssetRead? The response is a Mesh, not a Volume
def upload_or_replace_mesh(
    volume_id: int,
    mesh_file: UploadFile = File(...),
    session: Session = Depends(get_session),
    editor: User = Depends(require_editor),
):
    volume = session.get(Volume, volume_id)
    if not volume:
        raise HTTPException(status_code=404, detail="Volume not found")
    vol_dir = _asset_dir(volume.slug)
    mesh_filename = Path(mesh_file.filename).name
    with open(vol_dir / mesh_filename, "wb") as f:
        shutil.copyfileobj(mesh_file.file, f)
    mesh = Mesh(volume_id=volume.id, file_path=mesh_filename, volume=volume) # create a new Mesh record associated with the volume
    volume.mesh = mesh
    session.add(mesh)
    session.commit()
    session.add(volume)
    session.commit()
    session.refresh(volume)
    return _asset_read(volume)


@router.delete("/{asset_id}")
def delete_volume(
    asset_id: int, session: Session = Depends(get_session), _editor: User = Depends(require_editor)
):
    asset = None
    for model in (Volume, Mesh, PointCloud):
        obj = session.get(model, asset_id)
        if obj:
            asset = obj
            break
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    shutil.rmtree(_asset_dir(asset.slug), ignore_errors=True)
    for grant in session.exec(select(AssetAccess).where(AssetAccess.asset_id == asset_id)).all():
        session.delete(grant)
    session.delete(asset)
    session.commit()
    return {"ok": True}


# ---------- Editor: access control ----------

@router.get("/{volume_id}/access", response_model=List[UserRead])
def list_access(
    volume_id: int, session: Session = Depends(get_session), _editor: User = Depends(require_editor)
):
    grants = session.exec(select(AssetAccess).where(AssetAccess.asset_id == volume_id)).all()
    users = [session.get(User, g.user_id) for g in grants]
    return [u for u in users if u]


@router.post("/{volume_id}/access")
def grant_access(
    volume_id: int,
    payload: AssetAccessGrant,
    session: Session = Depends(get_session),
    editor: User = Depends(require_editor),
):
    volume = session.get(Volume, volume_id)
    target = session.get(User, payload.user_id)
    if not volume or not target:
        raise HTTPException(status_code=404, detail="Volume or user not found")
    existing = session.exec(
        select(AssetAccess).where(
            AssetAccess.asset_id == volume_id, AssetAccess.user_id == payload.user_id
        )
    ).first()
    if existing:
        return {"ok": True}
    session.add(AssetAccess(user_id=payload.user_id, volume_id=volume_id, granted_by=editor.id))
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
        select(AssetAccess).where(
            AssetAccess.asset_id == volume_id, AssetAccess.user_id == user_id
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
    if not volume or not _can_see_asset(user, volume, session):
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
        url=f"{base}/api/assets/{volume_id}/dataset.ome.zarr/{token}/",
        expires_in_minutes=settings.FILE_TOKEN_EXPIRE_MINUTES,
    )


@router.get("/{volume_id}/mesh-access-url", response_model=FileAccessUrl)
def mesh_access_url(
    volume_id: int, session: Session = Depends(get_session), user: User = Depends(get_current_user)
):
    volume = session.get(Volume, volume_id)
    if not volume or not _can_see_asset(user, volume, session):
        raise HTTPException(status_code=404, detail="Volume not found")
    if not volume.mesh:
        raise HTTPException(status_code=404, detail="This volume has no mesh")
    token = create_file_token(subject=user.username, volume_id=volume_id, kind="mesh")
    return FileAccessUrl(
        url=f"/api/assets/{volume_id}/mesh-file/{token}",
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
    zarr_root = (_asset_dir(volume.slug) / volume.file_path).resolve()
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
    if not volume or not volume.mesh:
        raise HTTPException(status_code=404, detail="Not found")
    mesh_path = _asset_dir(volume.slug) / volume.mesh.file_path
    if not mesh_path.exists():
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(mesh_path, filename=volume.mesh.file_path)