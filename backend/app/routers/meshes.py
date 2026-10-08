import shutil
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, UploadFile, File, Form, Request
from fastapi.responses import FileResponse
from sqlmodel import Session, select

from ..database import get_session, engine
from ..models import User, Role, Mesh, MeshAccess, AssetStatus
from ..schemas import MeshRead, AssetStatusRead, AccessGrant, GrantedUserRead, FileAccessUrl
from ..deps import get_current_user, require_editor
from ..security import create_file_token, decode_token
from ..config import settings
from .. import workdir
from ..helpers import convert_mesh_to_nxz
from ..utils import SLUG_RE, _now  # shared slug validation + timestamp helper

router = APIRouter(prefix="/api/meshes", tags=["meshes"])


def _mesh_dir(slug: str) -> Path:
    return settings.MESHES_DIR / slug


def _work_dir(slug: str) -> Path:
    """Where this mesh's upload is staged and converted: its own data folder,
    or — if VG_PROCESSING_DIR is set — a scratch folder (see workdir.py)."""
    return workdir.work_dir_for("meshes", slug, _mesh_dir(slug))


def _can_see_mesh(user: User, mesh: Mesh, session: Session) -> bool:
    if mesh.volume_id is not None:
        return False  # attached to a volume: only reachable through that volume
    if user.role in (Role.admin, Role.editor):
        return True
    grant = session.exec(
        select(MeshAccess).where(MeshAccess.user_id == user.id, MeshAccess.mesh_id == mesh.id)
    ).first()
    return grant is not None


def _can_download_mesh(user: User, mesh: Mesh, session: Session) -> bool:
    if mesh.volume_id is not None:
        return False
    if user.role in (Role.admin, Role.editor):
        return True
    grant = session.exec(
        select(MeshAccess).where(MeshAccess.user_id == user.id, MeshAccess.mesh_id == mesh.id)
    ).first()
    return grant is not None and grant.can_download


def _mesh_read(m: Mesh, can_download: bool = False) -> MeshRead:
    log_lines = [line for line in (m.status_log or "").split("\n") if line]
    return MeshRead(
        id=m.id, slug=m.slug, title=m.title, description=m.description, created_at=m.created_at.isoformat(),
        status=m.status, status_log=log_lines, can_download=can_download,
    )


def _require_standalone(mesh: Optional[Mesh], hint: str) -> None:
    """Meshes uploaded together with a volume are managed through that volume."""
    if mesh is not None and mesh.volume_id is not None:
        raise HTTPException(status_code=400, detail=f"This mesh belongs to a volume. {hint}.")


# ---------- Meshes attached to a volume ----------
# Used by the volumes router. The mesh is a normal Mesh row (converted by the
# same background job as any other mesh), tagged with volume_id so that it
# stays out of the mesh gallery and inherits the volume's permissions.

def _child_mesh_slug(session: Session, volume_slug: str) -> str:
    base = f"{volume_slug[:55]}-mesh"
    candidate, n = base, 2
    while session.exec(select(Mesh).where(Mesh.slug == candidate)).first() or _mesh_dir(candidate).exists():
        candidate = f"{base}-{n}"
        n += 1
    return candidate


def get_volume_mesh(session: Session, volume_id: int) -> Optional[Mesh]:
    return session.exec(select(Mesh).where(Mesh.volume_id == volume_id)).first()


def delete_volume_mesh(session: Session, volume) -> None:
    """Removes the volume's attached mesh (files + row). Caller commits."""
    for m in session.exec(select(Mesh).where(Mesh.volume_id == volume.id)).all():
        shutil.rmtree(_mesh_dir(m.slug), ignore_errors=True)
        workdir.discard_job("meshes", m.slug)
        session.delete(m)
    volume.has_mesh = False
    volume.mesh_filename = None
    session.add(volume)


def attach_mesh_to_volume(session: Session, volume, mesh_file: UploadFile, editor: User,
                          background_tasks: BackgroundTasks) -> Mesh:
    """Stores `mesh_file` as the volume's mesh (replacing any previous one) and
    queues the usual mesh conversion."""
    source_ext = Path(mesh_file.filename or "").suffix.lstrip(".").lower() or "bin"
    delete_volume_mesh(session, volume)
    slug = _child_mesh_slug(session, volume.slug)
    mesh_dir = _mesh_dir(slug)
    mesh_dir.mkdir(parents=True, exist_ok=False)
    try:
        work_dir = workdir.prepare_work_dir("meshes", slug, mesh_dir)  # == mesh_dir unless VG_PROCESSING_DIR is set
        with open(work_dir / f"_upload.{source_ext}", "wb") as f:
            shutil.copyfileobj(mesh_file.file, f)
    except Exception as exc:  # noqa: BLE001
        shutil.rmtree(mesh_dir, ignore_errors=True)
        workdir.discard_job("meshes", slug)
        raise HTTPException(status_code=400, detail=f"Could not save mesh upload: {exc}")

    mesh = Mesh(
        slug=slug, title=f"{volume.title} (mesh)", created_by=editor.id, volume_id=volume.id,
        status=AssetStatus.processing, file_extension=source_ext,
        status_log=f"{_now()}  Upload received, queued for processing\n",
    )
    session.add(mesh)
    volume.has_mesh = True
    volume.mesh_filename = Path(mesh_file.filename or "").name or f"mesh.{source_ext}"
    session.add(volume)
    session.commit()
    session.refresh(mesh)
    background_tasks.add_task(_process_mesh_upload, mesh.id, str(mesh_dir))
    return mesh


def volume_mesh_file(mesh: Mesh) -> Path:
    """The processed (.nxz) file of an attached mesh, as shown in the viewer."""
    return _mesh_dir(mesh.slug) / (mesh.mesh_filename or "mesh.nxz")


def volume_mesh_source(mesh: Mesh) -> Path:
    """The originally uploaded file of an attached mesh."""
    return _mesh_dir(mesh.slug) / f"_upload.{mesh.file_extension}"


# ---------- Gallery ----------

@router.get("", response_model=List[MeshRead])
def list_meshes(session: Session = Depends(get_session), user: User = Depends(get_current_user)):
    meshes = session.exec(select(Mesh).where(Mesh.volume_id == None)).all()  # noqa: E711 - SQL IS NULL
    visible = [m for m in meshes if _can_see_mesh(user, m, session)]
    return [_mesh_read(m, _can_download_mesh(user, m, session)) for m in visible]


@router.get("/{mesh_id}", response_model=MeshRead)
def get_mesh(mesh_id: int, session: Session = Depends(get_session), user: User = Depends(get_current_user)):
    mesh = session.get(Mesh, mesh_id)
    if not mesh or not _can_see_mesh(user, mesh, session):
        raise HTTPException(status_code=404, detail="Mesh not found")
    return _mesh_read(mesh, _can_download_mesh(user, mesh, session))


@router.get("/{mesh_id}/status", response_model=AssetStatusRead)
def get_mesh_status(mesh_id: int, session: Session = Depends(get_session), user: User = Depends(get_current_user)):
    mesh = session.get(Mesh, mesh_id)
    if not mesh or not _can_see_mesh(user, mesh, session):
        raise HTTPException(status_code=404, detail="Mesh not found")
    log_lines = [line for line in (mesh.status_log or "").split("\n") if line]
    return AssetStatusRead(id=mesh.id, status=mesh.status, status_log=log_lines)


# ---------- Editor: upload / delete ----------

@router.post("", response_model=MeshRead)
def create_mesh(
    background_tasks: BackgroundTasks,
    slug: str = Form(...),
    title: str = Form(...),
    description: str = Form(""),
    mesh_file: UploadFile = File(..., description="Any common mesh format: obj, stl, ply, off, dae, glb, gltf, 3mf, ..."),
    session: Session = Depends(get_session),
    editor: User = Depends(require_editor),
):
    if not SLUG_RE.match(slug):
        raise HTTPException(status_code=400, detail="Slug must be lowercase alphanumeric/-/_ (2-63 chars)")
    if session.exec(select(Mesh).where(Mesh.slug == slug)).first():
        raise HTTPException(status_code=409, detail="A mesh with this slug already exists")

    mesh_dir = _mesh_dir(slug)
    mesh_dir.mkdir(parents=True, exist_ok=False)

    source_ext = Path(mesh_file.filename or "").suffix.lstrip(".").lower() or "bin"
    try:
        work_dir = workdir.prepare_work_dir("meshes", slug, mesh_dir)  # == mesh_dir unless VG_PROCESSING_DIR is set
        upload_path = mesh_dir / f"_upload.{source_ext}"
        with open(upload_path, "wb") as f:
            shutil.copyfileobj(mesh_file.file, f)
    except Exception as exc:  # noqa: BLE001
        shutil.rmtree(mesh_dir, ignore_errors=True)
        workdir.discard_job("meshes", slug)
        raise HTTPException(status_code=400, detail=f"Could not save upload: {exc}")

    mesh = Mesh(
        slug=slug, title=title, description=description, created_by=editor.id,
        status=AssetStatus.processing, file_extension=source_ext,
        status_log=f"{_now()}  Upload received, queued for processing\n",
    )
    session.add(mesh)
    session.commit()
    session.refresh(mesh)

    background_tasks.add_task(_process_mesh_upload, mesh.id, str(mesh_dir))

    return _mesh_read(mesh, can_download=True)


def _process_mesh_upload(mesh_id: int, mesh_dir_str: str) -> None:
    mesh_dir = Path(mesh_dir_str)
    with Session(engine) as session:
        mesh = session.get(Mesh, mesh_id)
        if mesh is None:
            return

        def log(message: str) -> None:
            print(f"[Mesh {mesh.slug}] {message}")
            mesh.status_log = (mesh.status_log or "") + f"{_now()}  {message}\n"
            session.add(mesh)
            session.commit()

        # Conversion runs in work_dir: mesh_dir itself, or a scratch folder when
        # VG_PROCESSING_DIR is set — then the original upload (kept for downloads)
        # and the converted .nxz are moved into mesh_dir when done.
        work_dir = _work_dir(mesh.slug)
        try:
            nxz_path = convert_mesh_to_nxz(work_dir, mesh_dir, log)
            mesh.mesh_filename = nxz_path.name
            mesh.status = AssetStatus.ready
            log("Ready")
        except Exception as exc:  # noqa: BLE001 - the failure message IS the point, shown to the user
            mesh.status = AssetStatus.failed
            log(f"Failed: {exc}")
        finally:
            workdir.discard_job("meshes", mesh.slug)  # success or failure: scratch is never kept
        session.add(mesh)
        session.commit()


@router.delete("/{mesh_id}")
def delete_mesh(mesh_id: int, session: Session = Depends(get_session), _editor: User = Depends(require_editor)):
    mesh = session.get(Mesh, mesh_id)
    if not mesh:
        raise HTTPException(status_code=404, detail="Mesh not found")
    _require_standalone(mesh, "Delete the volume (or replace its mesh) instead")
    shutil.rmtree(_mesh_dir(mesh.slug), ignore_errors=True)
    workdir.discard_job("meshes", mesh.slug)
    for grant in session.exec(select(MeshAccess).where(MeshAccess.mesh_id == mesh_id)).all():
        session.delete(grant)
    session.delete(mesh)
    session.commit()
    return {"ok": True}


# ---------- Editor: access control ----------

@router.get("/{mesh_id}/access", response_model=List[GrantedUserRead])
def list_access(mesh_id: int, session: Session = Depends(get_session), _editor: User = Depends(require_editor)):
    _require_standalone(session.get(Mesh, mesh_id), "Access follows the volume it belongs to")
    grants = session.exec(select(MeshAccess).where(MeshAccess.mesh_id == mesh_id)).all()
    result = []
    for g in grants:
        u = session.get(User, g.user_id)
        if u:
            result.append(GrantedUserRead(id=u.id, username=u.username, can_download=g.can_download))
    return result


@router.post("/{mesh_id}/access")
def grant_access(
    mesh_id: int, payload: AccessGrant, session: Session = Depends(get_session), editor: User = Depends(require_editor)
):
    mesh = session.get(Mesh, mesh_id)
    target = session.get(User, payload.user_id)
    if not mesh or not target:
        raise HTTPException(status_code=404, detail="Mesh or user not found")
    _require_standalone(mesh, "Access follows the volume it belongs to")
    existing = session.exec(
        select(MeshAccess).where(MeshAccess.mesh_id == mesh_id, MeshAccess.user_id == payload.user_id)
    ).first()
    if existing:
        existing.can_download = payload.can_download
        session.add(existing)
        session.commit()
        return {"ok": True}
    session.add(MeshAccess(
        user_id=payload.user_id, mesh_id=mesh_id, granted_by=editor.id, can_download=payload.can_download
    ))
    session.commit()
    return {"ok": True}


@router.delete("/{mesh_id}/access/{user_id}")
def revoke_access(
    mesh_id: int, user_id: int, session: Session = Depends(get_session), _editor: User = Depends(require_editor)
):
    _require_standalone(session.get(Mesh, mesh_id), "Access follows the volume it belongs to")
    grant = session.exec(
        select(MeshAccess).where(MeshAccess.mesh_id == mesh_id, MeshAccess.user_id == user_id)
    ).first()
    if grant:
        session.delete(grant)
        session.commit()
    return {"ok": True}


# ---------- File access (3DHOP viewer + download) ----------

@router.get("/{mesh_id}/mesh-access-url", response_model=FileAccessUrl)
def mesh_access_url(
    mesh_id: int, request: Request, session: Session = Depends(get_session), user: User = Depends(get_current_user)
):
    mesh = session.get(Mesh, mesh_id)
    if not mesh or not _can_see_mesh(user, mesh, session):
        raise HTTPException(status_code=404, detail="Mesh not found")
    if mesh.status != AssetStatus.ready:
        raise HTTPException(
            status_code=409,
            detail="Mesh is still processing" if mesh.status == AssetStatus.processing else "Mesh processing failed — see its status log",
        )
    token = create_file_token(subject=user.username, asset_id=mesh_id, kind="mesh")
    base = str(request.base_url).rstrip("/")
    return FileAccessUrl(
        url=f"{base}/api/meshes/{mesh_id}/mesh-access-file/{token}",
        expires_in_minutes=settings.FILE_TOKEN_EXPIRE_MINUTES,
    )


@router.get("/{mesh_id}/download-access-url", response_model=FileAccessUrl)
def mesh_download_access_url(
    mesh_id: int, request: Request, session: Session = Depends(get_session), user: User = Depends(get_current_user)
):
    mesh = session.get(Mesh, mesh_id)
    if not mesh or not _can_see_mesh(user, mesh, session):
        raise HTTPException(status_code=404, detail="Mesh not found")
    if not _can_download_mesh(user, mesh, session):
        raise HTTPException(status_code=403, detail="You don't have permission to download this mesh")
    if mesh.status != AssetStatus.ready:
        raise HTTPException(status_code=409, detail="Mesh is still processing")
    token = create_file_token(subject=user.username, asset_id=mesh_id, kind="mesh-download")
    base = str(request.base_url).rstrip("/")
    return FileAccessUrl(
        url=f"{base}/api/meshes/{mesh_id}/mesh-access-file/{token}",
        expires_in_minutes=settings.FILE_TOKEN_EXPIRE_MINUTES,
    )


def _check_mesh_token(token: str, mesh_id: int) -> str:
    """Accepts either a viewing token (kind="mesh") or a download token
    (kind="mesh-download") — both ultimately serve the same .nxz file, the
    distinction is only in which permission was checked to mint the token."""
    payload = decode_token(token)
    if (
        not payload
        or payload.get("type") != "file"
        or payload.get("kind") not in ("mesh", "mesh-download")
        or payload.get("vol") != mesh_id
    ):
        raise HTTPException(status_code=403, detail="Invalid or expired link")
    return payload["kind"]


@router.get("/{mesh_id}/mesh-access-file/{token}")
def serve_mesh_file(mesh_id: int, token: str, session: Session = Depends(get_session)):
    kind = _check_mesh_token(token, mesh_id)
    mesh = session.get(Mesh, mesh_id)
    if not mesh or not mesh.mesh_filename or mesh.volume_id is not None:
        raise HTTPException(status_code=404, detail=f"Mesh with id {mesh_id} not found or not ready")
    nxz_path = _mesh_dir(mesh.slug) / mesh.mesh_filename
    if not nxz_path.exists():
        raise HTTPException(status_code=404, detail=f"Mesh not ready: {nxz_path} does not exist")
    cache_headers = {"Cache-Control": f"public, max-age={settings.FILE_TOKEN_EXPIRE_MINUTES * 60}, immutable"}
    if kind == "mesh-download":
        upload_path = _mesh_dir(mesh.slug) / f"_upload.{mesh.file_extension}"
        return FileResponse(upload_path, filename=f"{mesh.slug}.{mesh.file_extension}", headers=cache_headers)
    return FileResponse(nxz_path, headers=cache_headers)