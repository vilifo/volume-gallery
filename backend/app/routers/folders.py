from typing import List, Optional, Set

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from ..database import get_session
from ..deps import get_current_user, require_editor
from ..models import Folder, Mesh, PointCloud, Role, User, Volume
from ..organize import (
    MAX_FOLDER_DEPTH, clean_folder_name, folder_depth, folder_height, folder_map, is_inside,
)
from ..schemas import FolderCreate, FolderRead, FolderUpdate
from .meshes import _can_see_mesh
from .pointclouds import _can_see_pointcloud
from .volumes import _can_see_volume

router = APIRouter(prefix="/api/folders", tags=["folders"])


def _read(f: Folder) -> FolderRead:
    return FolderRead(id=f.id, name=f.name, parent_id=f.parent_id)


def _visible_folder_ids(session: Session, user: User, folders) -> Set[int]:
    """Editors see every folder. Others see only the folders that hold something they may view,
    together with the folders above those, so a folder name never reaches someone who has nothing in it."""
    if user.role in (Role.admin, Role.editor):
        return set(folders)
    if getattr(user, "_share_scope", None) is not None:
        return set()
    used: Set[int] = set()
    for model, can_see in ((Volume, _can_see_volume), (Mesh, _can_see_mesh), (PointCloud, _can_see_pointcloud)):
        for asset in session.exec(select(model).where(model.folder_id != None)).all():  # noqa: E711
            if can_see(user, asset, session):
                used.add(asset.folder_id)
    visible: Set[int] = set()
    for fid in used:
        while fid is not None and fid in folders and fid not in visible:
            visible.add(fid)
            fid = folders[fid].parent_id
    return visible


def _check_sibling_name(folders, name: str, parent_id: Optional[int], ignore_id: Optional[int] = None) -> None:
    for f in folders.values():
        if f.id != ignore_id and f.parent_id == parent_id and f.name.lower() == name.lower():
            raise HTTPException(status_code=409, detail="A folder with this name already exists here")


@router.get("", response_model=List[FolderRead])
def list_folders(session: Session = Depends(get_session), user: User = Depends(get_current_user)):
    folders = folder_map(session)
    visible = _visible_folder_ids(session, user, folders)
    rows = sorted((f for f in folders.values() if f.id in visible), key=lambda f: (f.name.lower(), f.id))
    return [_read(f) for f in rows]


@router.post("", response_model=FolderRead)
def create_folder(
    payload: FolderCreate, session: Session = Depends(get_session), editor: User = Depends(require_editor)
):
    name = clean_folder_name(payload.name)
    folders = folder_map(session)
    if payload.parent_id is not None and payload.parent_id not in folders:
        raise HTTPException(status_code=404, detail="Parent folder not found")
    if folder_depth(folders, payload.parent_id) + 1 > MAX_FOLDER_DEPTH:
        raise HTTPException(status_code=400, detail=f"Folders can be nested at most {MAX_FOLDER_DEPTH} levels deep")
    _check_sibling_name(folders, name, payload.parent_id)
    folder = Folder(name=name, parent_id=payload.parent_id, created_by=editor.id)
    session.add(folder)
    session.commit()
    session.refresh(folder)
    return _read(folder)


@router.patch("/{folder_id}", response_model=FolderRead)
def update_folder(
    folder_id: int, payload: FolderUpdate,
    session: Session = Depends(get_session), _editor: User = Depends(require_editor),
):
    folders = folder_map(session)
    folder = folders.get(folder_id)
    if folder is None:
        raise HTTPException(status_code=404, detail="Folder not found")
    sent = payload.model_fields_set
    name = clean_folder_name(payload.name) if "name" in sent else folder.name
    parent_id = payload.parent_id if "parent_id" in sent else folder.parent_id
    if parent_id is not None:
        if parent_id not in folders:
            raise HTTPException(status_code=404, detail="Parent folder not found")
        if is_inside(folders, parent_id, folder_id):
            raise HTTPException(status_code=400, detail="A folder cannot be moved into itself or one of its subfolders")
    if folder_depth(folders, parent_id) + folder_height(folders, folder_id) > MAX_FOLDER_DEPTH:
        raise HTTPException(status_code=400, detail=f"Folders can be nested at most {MAX_FOLDER_DEPTH} levels deep")
    _check_sibling_name(folders, name, parent_id, ignore_id=folder_id)
    folder.name, folder.parent_id = name, parent_id
    session.add(folder)
    session.commit()
    session.refresh(folder)
    return _read(folder)


@router.delete("/{folder_id}")
def delete_folder(
    folder_id: int, session: Session = Depends(get_session), _editor: User = Depends(require_editor)
):
    """Deletes the folder only: what it held (items and subfolders) moves up into its parent folder."""
    folder = session.get(Folder, folder_id)
    if folder is None:
        raise HTTPException(status_code=404, detail="Folder not found")
    for child in session.exec(select(Folder).where(Folder.parent_id == folder_id)).all():
        child.parent_id = folder.parent_id
        session.add(child)
    for model in (Volume, Mesh, PointCloud):
        for asset in session.exec(select(model).where(model.folder_id == folder_id)).all():
            asset.folder_id = folder.parent_id
            session.add(asset)
    session.delete(folder)
    session.commit()
    return {"ok": True}
