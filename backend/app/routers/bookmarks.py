import json
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from ..database import get_session
from ..deps import get_current_user, require_editor
from ..models import ViewBookmark, User, Volume
from ..schemas import BookmarkRead, BookmarkWrite, BookmarkSpec
from ..utils import get_utc_now
from .volumes import _can_see_volume

router = APIRouter(prefix="/api/volumes/{volume_id}/bookmarks", tags=["bookmarks"])

MAX_NAME_LENGTH = 80
MAX_BOOKMARKS_PER_VOLUME = 100


def _volume_for(session: Session, user: User, volume_id: int) -> Volume:
    volume = session.get(Volume, volume_id)
    if not volume or not _can_see_volume(user, volume, session):
        raise HTTPException(status_code=404, detail="Volume not found")
    return volume


def _clean_name(name: str) -> str:
    cleaned = " ".join((name or "").split())
    if not cleaned:
        raise HTTPException(status_code=400, detail="A bookmark needs a name")
    if len(cleaned) > MAX_NAME_LENGTH:
        raise HTTPException(status_code=400, detail=f"The name can have at most {MAX_NAME_LENGTH} characters")
    return cleaned


def _read(session: Session, row: ViewBookmark) -> BookmarkRead:
    author = session.get(User, row.created_by) if row.created_by else None
    return BookmarkRead(
        id=row.id, name=row.name, spec=BookmarkSpec(**json.loads(row.spec)),
        created_at=row.created_at.isoformat(), updated_at=row.updated_at.isoformat(),
        created_by_name=author.username if author else None,
    )


def _owned(session: Session, volume_id: int, bookmark_id: int) -> ViewBookmark:
    row = session.get(ViewBookmark, bookmark_id)
    if not row or row.volume_id != volume_id:
        raise HTTPException(status_code=404, detail="Bookmark not found")
    return row


@router.get("", response_model=List[BookmarkRead])
def list_bookmarks(volume_id: int, session: Session = Depends(get_session), user: User = Depends(get_current_user)):
    """The bookmarks of a volume, for everybody who may see the volume (editors write them)."""
    _volume_for(session, user, volume_id)
    rows = session.exec(select(ViewBookmark).where(ViewBookmark.volume_id == volume_id)).all()
    return [_read(session, r) for r in sorted(rows, key=lambda r: (r.name.lower(), r.id))]


@router.get("/{bookmark_id}", response_model=BookmarkRead)
def get_bookmark(volume_id: int, bookmark_id: int, session: Session = Depends(get_session), user: User = Depends(get_current_user)):
    _volume_for(session, user, volume_id)
    return _read(session, _owned(session, volume_id, bookmark_id))


@router.post("", response_model=BookmarkRead)
def create_bookmark(
    volume_id: int, payload: BookmarkWrite,
    session: Session = Depends(get_session), editor: User = Depends(require_editor),
):
    if not session.get(Volume, volume_id):
        raise HTTPException(status_code=404, detail="Volume not found")
    existing = session.exec(select(ViewBookmark).where(ViewBookmark.volume_id == volume_id)).all()
    if len(existing) >= MAX_BOOKMARKS_PER_VOLUME:
        raise HTTPException(status_code=400, detail=f"A volume can have at most {MAX_BOOKMARKS_PER_VOLUME} bookmarks")
    row = ViewBookmark(
        volume_id=volume_id, name=_clean_name(payload.name), spec=payload.spec.model_dump_json(), created_by=editor.id,
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return _read(session, row)


@router.put("/{bookmark_id}", response_model=BookmarkRead)
def update_bookmark(
    volume_id: int, bookmark_id: int, payload: BookmarkWrite,
    session: Session = Depends(get_session), _editor: User = Depends(require_editor),
):
    row = _owned(session, volume_id, bookmark_id)
    row.name = _clean_name(payload.name)
    row.spec = payload.spec.model_dump_json()
    row.updated_at = get_utc_now()
    session.add(row)
    session.commit()
    session.refresh(row)
    return _read(session, row)


@router.delete("/{bookmark_id}")
def delete_bookmark(
    volume_id: int, bookmark_id: int,
    session: Session = Depends(get_session), _editor: User = Depends(require_editor),
):
    session.delete(_owned(session, volume_id, bookmark_id))
    session.commit()
    return {"ok": True}
