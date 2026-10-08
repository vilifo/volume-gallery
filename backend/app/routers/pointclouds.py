import shutil
import zipfile
from pathlib import Path
from typing import List

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, UploadFile, File, Form, Request
from fastapi.responses import FileResponse
from sqlmodel import Session, select

from ..database import get_session, engine
from ..models import User, Role, PointCloud, PointCloudAccess, AssetStatus
from ..schemas import PointCloudRead, AssetStatusRead, AccessGrant, GrantedUserRead, FileAccessUrl
from ..deps import get_current_user, require_editor
from ..security import create_file_token, decode_token
from ..config import settings
from .. import workdir
from ..helpers import convert_pointcloud
from .volumes import SLUG_RE, _now

router = APIRouter(prefix="/api/pointclouds", tags=["pointclouds"])

_POINTCLOUD_SOURCE_EXTS = (".las", ".laz", ".ply", ".xyz", ".ptx", ".pts", ".e57")


def _pointcloud_dir(slug: str) -> Path:
    return settings.POINTCLOUDS_DIR / slug


def _work_dir(slug: str) -> Path:
    """Where this point cloud's upload is staged and converted: its own data
    folder, or — if VG_PROCESSING_DIR is set — a scratch folder (see workdir.py)."""
    return workdir.work_dir_for("pointclouds", slug, _pointcloud_dir(slug))


def _can_see_pointcloud(user: User, pc: PointCloud, session: Session) -> bool:
    if user.role in (Role.admin, Role.editor):
        return True
    grant = session.exec(
        select(PointCloudAccess).where(PointCloudAccess.user_id == user.id, PointCloudAccess.pointcloud_id == pc.id)
    ).first()
    return grant is not None


def _pointcloud_read(pc: PointCloud) -> PointCloudRead:
    log_lines = [line for line in (pc.status_log or "").split("\n") if line]
    return PointCloudRead(
        id=pc.id, slug=pc.slug, title=pc.title, description=pc.description, created_at=pc.created_at.isoformat(),
        status=pc.status, status_log=log_lines
    )


# ---------- Gallery ----------

@router.get("", response_model=List[PointCloudRead])
def list_pointclouds(session: Session = Depends(get_session), user: User = Depends(get_current_user)):
    pcs = session.exec(select(PointCloud)).all()
    visible = [pc for pc in pcs if _can_see_pointcloud(user, pc, session)]
    return [_pointcloud_read(pc) for pc in visible]


@router.get("/{pc_id}", response_model=PointCloudRead)
def get_pointcloud(pc_id: int, session: Session = Depends(get_session), user: User = Depends(get_current_user)):
    pc = session.get(PointCloud, pc_id)
    if not pc or not _can_see_pointcloud(user, pc, session):
        raise HTTPException(status_code=404, detail="Point cloud not found")
    return _pointcloud_read(pc)


@router.get("/{pc_id}/status", response_model=AssetStatusRead)
def get_pointcloud_status(pc_id: int, session: Session = Depends(get_session), user: User = Depends(get_current_user)):
    pc = session.get(PointCloud, pc_id)
    if not pc or not _can_see_pointcloud(user, pc, session):
        raise HTTPException(status_code=404, detail="Point cloud not found")
    log_lines = [line for line in (pc.status_log or "").split("\n") if line]
    return AssetStatusRead(id=pc.id, status=pc.status, status_log=log_lines)


# ---------- Editor: upload / delete ----------

@router.post("", response_model=PointCloudRead)
def create_pointcloud(
    background_tasks: BackgroundTasks,
    slug: str = Form(...),
    title: str = Form(...),
    description: str = Form(""),
    pointcloud_file: UploadFile = File(..., description="las, laz, ply, xyz, ptx, pts, or e57"),
    session: Session = Depends(get_session),
    editor: User = Depends(require_editor),
):
    if not SLUG_RE.match(slug):
        raise HTTPException(status_code=400, detail="Slug must be lowercase alphanumeric/-/_ (2-63 chars)")
    if session.exec(select(PointCloud).where(PointCloud.slug == slug)).first():
        raise HTTPException(status_code=409, detail="A point cloud with this slug already exists")

    source_ext = Path(pointcloud_file.filename or "").suffix.lower()
    if source_ext not in _POINTCLOUD_SOURCE_EXTS:
        raise HTTPException(
            status_code=400,
            detail=f"Unrecognized point cloud format '{source_ext}' — expected one of {', '.join(_POINTCLOUD_SOURCE_EXTS)}",
        )

    pc_dir = _pointcloud_dir(slug)
    pc_dir.mkdir(parents=True, exist_ok=False)

    try:
        work_dir = workdir.prepare_work_dir("pointclouds", slug, pc_dir)
        upload_path = work_dir / f"_upload{source_ext}"
        with open(upload_path, "wb") as f:
            shutil.copyfileobj(pointcloud_file.file, f)
    except Exception as exc:  # noqa: BLE001
        shutil.rmtree(pc_dir, ignore_errors=True)
        workdir.discard_job("pointclouds", slug)
        raise HTTPException(status_code=400, detail=f"Could not save upload: {exc}")

    pc = PointCloud(
        slug=slug, title=title, description=description, created_by=editor.id,
        status=AssetStatus.processing,
        status_log=f"{_now()}  Upload received, queued for processing\n",
    )
    session.add(pc)
    session.commit()
    session.refresh(pc)

    background_tasks.add_task(_process_pointcloud_upload, pc.id, str(pc_dir), str(upload_path))

    return _pointcloud_read(pc)


def _process_pointcloud_upload(pc_id: int, pc_dir_str: str, upload_path_str: str) -> None:
    pc_dir = Path(pc_dir_str)
    upload_path = Path(upload_path_str)
    with Session(engine) as session:
        pc = session.get(PointCloud, pc_id)
        if pc is None:
            return

        def log(message: str) -> None:
            print(f"[PointCloud {pc.slug}] {message}")
            pc.status_log = (pc.status_log or "") + f"{_now()}  {message}\n"
            session.add(pc)
            session.commit()

        output_dir = pc_dir / "pointcloud"
        try:
            convert_pointcloud(upload_path, output_dir, log=log)
            pc.pc_path = output_dir.name
            pc.status = AssetStatus.ready
            log("Ready")
        except Exception as exc:  # noqa: BLE001 - the failure message IS the point, shown to the user
            pc.status = AssetStatus.failed
            log(f"Failed: {exc}")
        finally:
            # Only the converted octree is kept — the original point cloud
            # upload is deleted either way (can be large: las/laz files).
            upload_path.unlink(missing_ok=True)
            workdir.discard_job("pointclouds", pc.slug)  # scratch is never kept
        session.add(pc)
        session.commit()


@router.delete("/{pc_id}")
def delete_pointcloud(pc_id: int, session: Session = Depends(get_session), _editor: User = Depends(require_editor)):
    pc = session.get(PointCloud, pc_id)
    if not pc:
        raise HTTPException(status_code=404, detail="Point cloud not found")
    shutil.rmtree(_pointcloud_dir(pc.slug), ignore_errors=True)
    workdir.discard_job("pointclouds", pc.slug)
    for grant in session.exec(select(PointCloudAccess).where(PointCloudAccess.pointcloud_id == pc_id)).all():
        session.delete(grant)
    session.delete(pc)
    session.commit()
    return {"ok": True}


# ---------- Editor: access control ----------

@router.get("/{pc_id}/access", response_model=List[GrantedUserRead])
def list_access(pc_id: int, session: Session = Depends(get_session), _editor: User = Depends(require_editor)):
    grants = session.exec(select(PointCloudAccess).where(PointCloudAccess.pointcloud_id == pc_id)).all()
    result = []
    for g in grants:
        u = session.get(User, g.user_id)
        if u:
            result.append(GrantedUserRead(id=u.id, username=u.username))
    return result


@router.post("/{pc_id}/access")
def grant_access(
    pc_id: int, payload: AccessGrant, session: Session = Depends(get_session), editor: User = Depends(require_editor)
):
    pc = session.get(PointCloud, pc_id)
    target = session.get(User, payload.user_id)
    if not pc or not target:
        raise HTTPException(status_code=404, detail="Point cloud or user not found")
    existing = session.exec(
        select(PointCloudAccess).where(PointCloudAccess.pointcloud_id == pc_id, PointCloudAccess.user_id == payload.user_id)
    ).first()
    if existing:
        session.add(existing)
        session.commit()
        return {"ok": True}
    session.add(PointCloudAccess(
        user_id=payload.user_id, pointcloud_id=pc_id, granted_by=editor.id
    ))
    session.commit()
    return {"ok": True}


@router.delete("/{pc_id}/access/{user_id}")
def revoke_access(
    pc_id: int, user_id: int, session: Session = Depends(get_session), _editor: User = Depends(require_editor)
):
    grant = session.exec(
        select(PointCloudAccess).where(PointCloudAccess.pointcloud_id == pc_id, PointCloudAccess.user_id == user_id)
    ).first()
    if grant:
        session.delete(grant)
        session.commit()
    return {"ok": True}


# ---------- File access (Potree viewer + download) ----------

@router.get("/{pc_id}/octree-access-url", response_model=FileAccessUrl)
def octree_access_url(
    pc_id: int, request: Request, session: Session = Depends(get_session), user: User = Depends(get_current_user)
):
    pc = session.get(PointCloud, pc_id)
    if not pc or not _can_see_pointcloud(user, pc, session):
        raise HTTPException(status_code=404, detail="Point cloud not found")
    if pc.status != AssetStatus.ready:
        raise HTTPException(
            status_code=409,
            detail="Point cloud is still processing" if pc.status == AssetStatus.processing else "Point cloud processing failed — see its status log",
        )
    token = create_file_token(subject=user.username, asset_id=pc_id, kind="pc-octree")
    base = str(request.base_url).rstrip("/")
    return FileAccessUrl(
        url=f"{base}/api/pointclouds/{pc_id}/octree/{token}/",
        expires_in_minutes=settings.FILE_TOKEN_EXPIRE_MINUTES,
    )


@router.get("/{pc_id}/download-access-url", response_model=FileAccessUrl)
def pointcloud_download_access_url(
    pc_id: int, request: Request, session: Session = Depends(get_session), user: User = Depends(get_current_user)
):
    pc = session.get(PointCloud, pc_id)
    if not pc or not _can_see_pointcloud(user, pc, session):
        raise HTTPException(status_code=404, detail="Point cloud not found")
    if pc.status != AssetStatus.ready:
        raise HTTPException(status_code=409, detail="Point cloud is still processing")
    token = create_file_token(subject=user.username, asset_id=pc_id, kind="pc-download")
    base = str(request.base_url).rstrip("/")
    return FileAccessUrl(
        url=f"{base}/api/pointclouds/{pc_id}/download-file/{token}",
        expires_in_minutes=settings.FILE_TOKEN_EXPIRE_MINUTES,
    )


def _zip_directory(src: Path, zip_path: Path) -> None:
    tmp = zip_path.with_suffix('.zip.part')
    with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zf:
        for f in sorted(src.rglob('*')):
            if f.is_file():
                zf.write(f, f.relative_to(src).as_posix())
    tmp.replace(zip_path)


def _check_pc_token(token: str, pc_id: int, kind: str) -> None:
    payload = decode_token(token)
    if (
        not payload
        or payload.get("type") != "file"
        or payload.get("kind") != kind
        or payload.get("vol") != pc_id
    ):
        raise HTTPException(status_code=403, detail="Invalid or expired link")


@router.get("/{pc_id}/octree/{token}/{path:path}")
def serve_octree_file(pc_id: int, token: str, path: str, session: Session = Depends(get_session)):
    """Serves individual files inside the Potree octree directory
    (metadata.json, octree.bin, hierarchy.bin, ...) — same pattern as the
    volume viewer's zarr chunk server: a generic signed-token passthrough,
    since Potree's own client-side code decides exactly what to fetch from
    whatever base URL it's given."""
    _check_pc_token(token, pc_id, "pc-octree")
    pc = session.get(PointCloud, pc_id)
    if not pc:
        raise HTTPException(status_code=404, detail="Point cloud not found")
    octree_root = (_pointcloud_dir(pc.slug) / pc.pc_path).resolve()
    target = (octree_root / path.lstrip("/")).resolve()
    if not str(target).startswith(str(octree_root)):
        raise HTTPException(status_code=400, detail="Invalid path")
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(
        target,
        headers={"Cache-Control": f"public, max-age={settings.FILE_TOKEN_EXPIRE_MINUTES * 60}, immutable"},
    )


@router.get("/{pc_id}/download-file/{token}")
def serve_pointcloud_download(pc_id: int, token: str, session: Session = Depends(get_session)):
    _check_pc_token(token, pc_id, "pc-download")
    pc = session.get(PointCloud, pc_id)
    if not pc:
        raise HTTPException(status_code=404, detail="Point cloud not found")
    octree_root = (_pointcloud_dir(pc.slug) / pc.pc_path).resolve()
    if not octree_root.exists():
        raise HTTPException(status_code=404, detail="Not found")
    zip_path = _pointcloud_dir(pc.slug) / "_download.zip"
    if not zip_path.exists():
        _zip_directory(octree_root, zip_path)
    return FileResponse(
        zip_path,
        filename=f"{pc.slug}.zip",
        headers={"Cache-Control": f"public, max-age={settings.FILE_TOKEN_EXPIRE_MINUTES * 60}, immutable"},
    )