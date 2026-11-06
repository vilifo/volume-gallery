"""Editing an asset's details (title, description, tags) and filing it in a folder.

Shared by the three asset routers (volumes, meshes, point clouds) and the folders router, so the
rules are the same for every kind of asset.
"""
from typing import Dict, List, Optional

from fastapi import HTTPException
from sqlmodel import Session, select

from .models import Folder
from .schemas import AssetUpdate

MAX_TITLE_LENGTH = 200
MAX_DESCRIPTION_LENGTH = 5000
MAX_TAGS = 20
MAX_TAG_LENGTH = 32
MAX_FOLDER_NAME_LENGTH = 80
MAX_FOLDER_DEPTH = 8  # nesting levels, the top level folders being level 1


# ---------- tags ----------

def clean_tags(tags: List[str]) -> List[str]:
    """Trims, drops empties and duplicates (case-insensitively; the first spelling wins). A comma
    separates tags, so "a, b" is two tags."""
    seen, out = set(), []
    for raw in tags:
        for part in str(raw).split(","):
            tag = " ".join(part.split())
            if not tag:
                continue
            if len(tag) > MAX_TAG_LENGTH:
                raise HTTPException(status_code=400, detail=f"A tag can have at most {MAX_TAG_LENGTH} characters")
            if tag.lower() in seen:
                continue
            seen.add(tag.lower())
            out.append(tag)
    if len(out) > MAX_TAGS:
        raise HTTPException(status_code=400, detail=f"An item can have at most {MAX_TAGS} tags")
    return out


def split_tags(stored: Optional[str]) -> List[str]:
    return [t for t in (stored or "").split(",") if t]


# ---------- folders ----------

def folder_map(session: Session) -> Dict[int, Folder]:
    return {f.id: f for f in session.exec(select(Folder)).all()}


def clean_folder_name(name: Optional[str]) -> str:
    cleaned = " ".join((name or "").split())
    if not cleaned:
        raise HTTPException(status_code=400, detail="A folder needs a name")
    if len(cleaned) > MAX_FOLDER_NAME_LENGTH:
        raise HTTPException(status_code=400, detail=f"A folder name can have at most {MAX_FOLDER_NAME_LENGTH} characters")
    if "/" in cleaned or "\\" in cleaned:
        raise HTTPException(status_code=400, detail="A folder name cannot contain / or \\")
    return cleaned


def folder_depth(folders: Dict[int, Folder], folder_id: Optional[int]) -> int:
    """Nesting level of a folder (1 = top level); 0 for "no folder"."""
    depth, seen = 0, set()
    while folder_id is not None and folder_id not in seen:
        seen.add(folder_id)
        folder = folders.get(folder_id)
        if folder is None:
            break
        depth += 1
        folder_id = folder.parent_id
    return depth


def folder_height(folders: Dict[int, Folder], folder_id: int) -> int:
    """Levels in the subtree under (and including) a folder."""
    children: Dict[Optional[int], List[int]] = {}
    for f in folders.values():
        children.setdefault(f.parent_id, []).append(f.id)

    def walk(fid: int, seen: frozenset) -> int:
        if fid in seen:
            return 0
        return 1 + max((walk(c, seen | {fid}) for c in children.get(fid, [])), default=0)

    return walk(folder_id, frozenset())


def is_inside(folders: Dict[int, Folder], folder_id: Optional[int], ancestor_id: int) -> bool:
    """True when folder_id is ancestor_id itself or lies somewhere below it."""
    seen = set()
    while folder_id is not None and folder_id not in seen:
        if folder_id == ancestor_id:
            return True
        seen.add(folder_id)
        folder = folders.get(folder_id)
        folder_id = folder.parent_id if folder else None
    return False


# ---------- assets ----------

def apply_asset_update(session: Session, asset, payload: AssetUpdate) -> None:
    """Applies the fields present in `payload` to a Volume / Mesh / PointCloud row. The caller commits."""
    sent = payload.model_fields_set
    if "title" in sent:
        title = (payload.title or "").strip()
        if not title:
            raise HTTPException(status_code=400, detail="The title cannot be empty")
        if len(title) > MAX_TITLE_LENGTH:
            raise HTTPException(status_code=400, detail=f"The title can have at most {MAX_TITLE_LENGTH} characters")
        asset.title = title
    if "description" in sent:
        description = (payload.description or "").strip()
        if len(description) > MAX_DESCRIPTION_LENGTH:
            raise HTTPException(status_code=400, detail=f"The description can have at most {MAX_DESCRIPTION_LENGTH} characters")
        asset.description = description
    if "tags" in sent:
        asset.tags = ",".join(clean_tags(payload.tags or []))
    if "folder_id" in sent:
        if payload.folder_id is not None and session.get(Folder, payload.folder_id) is None:
            raise HTTPException(status_code=404, detail="Folder not found")
        asset.folder_id = payload.folder_id
    session.add(asset)
