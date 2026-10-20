import hashlib
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlmodel import Session, select

from ..config import settings
from ..database import get_session
from ..deps import require_editor
from ..models import Mesh, PointCloud, ShareLink, User, Volume
from ..schemas import ShareConfigRead, ShareLinkCreate, ShareLinkRead
from ..security import create_share_session_token
from ..utils import get_utc_now

router = APIRouter(tags=["shares"])

_CODE_CHARS_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]*$")
_VALID_ASSET_TYPES = {"volume", "mesh", "pointcloud"}
_VIEWER_PATHS = {
    "volume": "/viewers/volume.html",
    "mesh": "/viewers/mesh.html",
    "pointcloud": "/viewers/pointcloud.html",
}


def _code_bounds() -> tuple[int, int]:
    min_len = max(1, settings.SHARE_CODE_MIN_LENGTH)
    max_len = max(min_len, settings.SHARE_CODE_MAX_LENGTH)
    return min_len, max_len


def _generate_cropped_hash(session: Session) -> str:
    """Generates a random SHA-256 hex digest cropped to SHARE_CODE_MAX_LENGTH."""
    _, max_len = _code_bounds()
    for _ in range(16):
        digest = hashlib.sha256(secrets.token_bytes(32)).hexdigest()
        candidate = digest[:max_len]
        if not session.exec(select(ShareLink).where(ShareLink.code == candidate)).first():
            return candidate
    raise HTTPException(status_code=500, detail="Could not generate a unique share code")


def _validate_custom_code(code: str) -> str:
    cleaned = code.strip()
    min_len, max_len = _code_bounds()
    if len(cleaned) < min_len or len(cleaned) > max_len:
        raise HTTPException(
            status_code=400,
            detail=f"Share code length must be between {min_len} and {max_len} characters",
        )
    if not _CODE_CHARS_RE.match(cleaned):
        raise HTTPException(
            status_code=400,
            detail="Share code may only contain letters, digits, '-' and '_', starting with a letter or digit",
        )
    return cleaned


def _ensure_asset_exists(session: Session, asset_type: str, asset_id: int) -> None:
    if asset_type not in _VALID_ASSET_TYPES:
        raise HTTPException(status_code=400, detail="Invalid asset_type")
    model = {"volume": Volume, "mesh": Mesh, "pointcloud": PointCloud}[asset_type]
    if not session.get(model, asset_id):
        raise HTTPException(status_code=404, detail=f"{asset_type.capitalize()} not found")


def _as_utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def _share_read(s: ShareLink, request: Request) -> ShareLinkRead:
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    base = f"{proto}://{host}".rstrip("/")
    now = get_utc_now()
    exp = _as_utc(s.expires_at)
    return ShareLinkRead(
        id=s.id,
        code=s.code,
        url=f"{base}/s/{s.code}",
        asset_type=s.asset_type,
        asset_id=s.asset_id,
        view_query=getattr(s, "view_query", "") or "",
        can_download=bool(getattr(s, "can_download", False)),
        min_lod=getattr(s, "min_lod", None),
        created_at=s.created_at.isoformat(),
        expires_at=exp.isoformat(),
        revoked=bool(getattr(s, "revoked", False)),
        expired=exp <= now,
        views_count=int(getattr(s, "views_count", 0) or 0),
    )


@router.get("/api/shares/suggest", response_model=ShareConfigRead)
def suggest_share_code(
    session: Session = Depends(get_session),
    _editor: User = Depends(require_editor),
):
    min_len, max_len = _code_bounds()
    return ShareConfigRead(
        min_length=min_len,
        max_length=max_len,
        suggested_code=_generate_cropped_hash(session),
    )


@router.get("/api/shares", response_model=List[ShareLinkRead])
def list_share_links(
    request: Request,
    asset_type: Optional[str] = Query(None),
    asset_id: Optional[int] = Query(None),
    session: Session = Depends(get_session),
    _editor: User = Depends(require_editor),
):
    stmt = select(ShareLink)
    if asset_type is not None:
        stmt = stmt.where(ShareLink.asset_type == asset_type)
    if asset_id is not None:
        stmt = stmt.where(ShareLink.asset_id == asset_id)
    stmt = stmt.order_by(ShareLink.created_at.desc())
    rows = session.exec(stmt).all()
    return [_share_read(r, request) for r in rows]


@router.post("/api/shares", response_model=ShareLinkRead)
def create_share_link(
    payload: ShareLinkCreate,
    request: Request,
    session: Session = Depends(get_session),
    editor: User = Depends(require_editor),
):
    _ensure_asset_exists(session, payload.asset_type, payload.asset_id)
    if payload.expires_in_minutes < 1 or payload.expires_in_minutes > 525600:
        raise HTTPException(status_code=400, detail="expires_in_minutes must be between 1 and 525600 (1 year)")

    if payload.code and payload.code.strip():
        code = _validate_custom_code(payload.code)
        existing = session.exec(select(ShareLink).where(ShareLink.code == code)).first()
        if existing:
            raise HTTPException(status_code=409, detail="This share code is already in use")
    else:
        code = _generate_cropped_hash(session)

    clean_query = (payload.view_query or "").lstrip("?&")
    now = get_utc_now()
    share = ShareLink(
        code=code,
        asset_type=payload.asset_type,
        asset_id=payload.asset_id,
        view_query=clean_query,
        can_download=bool(payload.can_download),
        min_lod=payload.min_lod,
        created_by=editor.id,
        created_at=now,
        expires_at=now + timedelta(minutes=payload.expires_in_minutes),
    )
    session.add(share)
    session.commit()
    session.refresh(share)
    return _share_read(share, request)


@router.delete("/api/shares/{share_id}")
def delete_or_revoke_share_link(
    share_id: int,
    session: Session = Depends(get_session),
    _editor: User = Depends(require_editor),
):
    share = session.get(ShareLink, share_id)
    if not share:
        raise HTTPException(status_code=404, detail="Share link not found")
    session.delete(share)
    session.commit()
    return {"ok": True}


@router.get("/s/{code}")
def resolve_short_share_link(code: str, session: Session = Depends(get_session)):
    """Validates a short share URL (/s/<code>), mints a scoped session token,
    and 302-redirects directly to the viewer with the token in the URL fragment."""
    share = session.exec(select(ShareLink).where(ShareLink.code == code)).first()
    now = get_utc_now()
    if not share or share.revoked or _as_utc(share.expires_at) <= now:
        return HTMLResponse(
            status_code=404,
            content=(
                "<!DOCTYPE html><html><head><meta charset='utf-8'><title>Link expired or invalid</title>"
                "<link rel='stylesheet' href='/css/style.css'></head>"
                "<body class='login-shell'><div class='login-box'>"
                "<h1>Link unavailable</h1>"
                "<p class='subtitle'>This shared link has expired, been revoked, or does not exist.</p>"
                "<a href='/login.html'><button class='primary' style='width:100%'>Sign in</button></a>"
                "</div></body></html>"
            ),
        )

    share.views_count = (share.views_count or 0) + 1
    session.add(share)
    session.commit()

    exp = _as_utc(share.expires_at)
    scoped_token = create_share_session_token(
        share_id=share.id,
        code=share.code,
        asset_type=share.asset_type,
        asset_id=share.asset_id,
        expires_at=exp,
        can_download=share.can_download,
        min_lod=share.min_lod,
    )
    viewer_base = _VIEWER_PATHS.get(share.asset_type, "/viewers/volume.html")
    extra = f"&{share.view_query}" if share.view_query else ""
    target_url = f"{viewer_base}?id={share.asset_id}{extra}#vg_st={scoped_token}&vg_sc={share.code}"
    return RedirectResponse(url=target_url, status_code=302)

