"""Administration: every share link with its statistics and assets, and the disk usage of the assets.

/api/admin/*  administrators only
/api/storage/{type}/{id}  editors and administrators (the management page of an asset)
"""
import json
import os
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import case, func
from sqlmodel import Session, col, select

from ..config import settings
from ..database import get_session
from ..deps import require_admin, require_editor
from ..helpers.storage import (
    asset_root, cached_scan, disk_usage, kind_dir, raw_voxel_bytes, scan_dir, Scan,
)
from .. import audit
from ..models import (
    AnimationPath, AuditEvent, Mesh, PointCloud, ShareLink, ShareView, User, ViewBookmark, Volume,
)
from ..schemas import (
    AuditEventRead, AuditPage, AssetStorageRead, DiskRead, RelatedAssetRead, ShareAdminOverview, ShareAdminRead,
    ShareAdminSummary, ShareAssetRead, ShareStatsRead, StorageAssetRow, StorageEntryRead,
    StorageLeftover, StorageOverviewRead,
)
from ..utils import NEVER_EXPIRES_THRESHOLD, get_utc_now

router = APIRouter(tags=["admin"])

_MODELS = {"volume": Volume, "mesh": Mesh, "pointcloud": PointCloud}
SPARK_DAYS = 14


def _utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def _iso(value) -> Optional[str]:
    """ISO text of a timestamp; SQLite aggregates (min, max) come back as text, not datetimes."""
    if value is None:
        return None
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value)
        except ValueError:
            return None
    return _utc(value).isoformat()


def _base_url(request: Request) -> str:
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    return f"{proto}://{host}".rstrip("/")


# ------------------------------------------------------------------------------- share statistics

def _view_stats(session: Session, now: datetime) -> Dict[int, ShareStatsRead]:
    """Per share link: the totals from the view log, and views per day for the last SPARK_DAYS days."""
    t24, t7, t30 = now - timedelta(hours=24), now - timedelta(days=7), now - timedelta(days=30)
    rows = session.exec(
        select(
            ShareView.share_id,
            func.count(),
            func.min(ShareView.viewed_at),
            func.max(ShareView.viewed_at),
            func.sum(case((ShareView.viewed_at >= t24, 1), else_=0)),
            func.sum(case((ShareView.viewed_at >= t7, 1), else_=0)),
            func.sum(case((ShareView.viewed_at >= t30, 1), else_=0)),
        ).group_by(ShareView.share_id)
    ).all()
    today = now.date()
    first_day = today - timedelta(days=SPARK_DAYS - 1)
    daily: Dict[int, List[int]] = defaultdict(lambda: [0] * SPARK_DAYS)
    day_rows = session.exec(
        select(ShareView.share_id, func.strftime("%Y-%m-%d", ShareView.viewed_at), func.count())
        .where(ShareView.viewed_at >= datetime.combine(first_day, datetime.min.time(), tzinfo=timezone.utc))
        .group_by(ShareView.share_id, func.strftime("%Y-%m-%d", ShareView.viewed_at))
    ).all()
    for share_id, day, n in day_rows:
        try:
            idx = (datetime.strptime(day, "%Y-%m-%d").date() - first_day).days
        except (TypeError, ValueError):
            continue
        if 0 <= idx < SPARK_DAYS:
            daily[share_id][idx] += int(n)
    out = {}
    for share_id, total, first, last, n24, n7, n30 in rows:
        out[share_id] = ShareStatsRead(
            views_total=int(total), views_24h=int(n24 or 0), views_7d=int(n7 or 0), views_30d=int(n30 or 0),
            first_viewed_at=_iso(first), last_viewed_at=_iso(last), daily=daily[share_id],
        )
    return out


def _empty_stats() -> ShareStatsRead:
    return ShareStatsRead(views_total=0, views_24h=0, views_7d=0, views_30d=0, daily=[0] * SPARK_DAYS)


def _asset_bytes(asset_type: str, row) -> int:
    return cached_scan(asset_type, row.slug, row.thumbnail_path).bytes


@router.get("/api/admin/shares", response_model=ShareAdminOverview)
def admin_shares(
    request: Request,
    session: Session = Depends(get_session),
    _admin: User = Depends(require_admin),
):
    """All share links, newest first, with views, state, who made them and the assets they open."""
    now = get_utc_now()
    links = session.exec(select(ShareLink).order_by(ShareLink.created_at.desc())).all()
    stats = _view_stats(session, now)
    base = _base_url(request)

    # assets the links point at, per type
    wanted: Dict[str, set] = defaultdict(set)
    for s in links:
        wanted[s.asset_type].add(s.asset_id)
    assets: Dict[Tuple[str, int], object] = {}
    for kind, ids in wanted.items():
        model = _MODELS.get(kind)
        if model and ids:
            for row in session.exec(select(model).where(model.id.in_(ids))).all():
                assets[(kind, row.id)] = row

    # related: a volume's meshes, a mesh's volume; and the saved paths / bookmarks of a volume
    volume_ids = {i for (k, i) in assets if k == "volume"}
    meshes_of: Dict[int, List[Mesh]] = defaultdict(list)
    if volume_ids:
        for m in session.exec(select(Mesh).where(Mesh.volume_id.in_(volume_ids))).all():
            meshes_of[m.volume_id].append(m)
    mesh_volume_ids = {a.volume_id for (k, _), a in assets.items() if k == "mesh" and a.volume_id}
    linked_volumes: Dict[int, Volume] = {}
    if mesh_volume_ids:
        for v in session.exec(select(Volume).where(Volume.id.in_(mesh_volume_ids))).all():
            linked_volumes[v.id] = v
    paths_n: Dict[int, int] = {}
    bookmarks_n: Dict[int, int] = {}
    if volume_ids:
        paths_n = dict(session.exec(select(AnimationPath.volume_id, func.count()).where(AnimationPath.volume_id.in_(volume_ids)).group_by(AnimationPath.volume_id)).all())
        bookmarks_n = dict(session.exec(select(ViewBookmark.volume_id, func.count()).where(ViewBookmark.volume_id.in_(volume_ids)).group_by(ViewBookmark.volume_id)).all())

    user_ids = {s.created_by for s in links if s.created_by} | {a.created_by for a in assets.values() if a.created_by}
    names = {u.id: u.username for u in session.exec(select(User).where(User.id.in_(user_ids))).all()} if user_ids else {}
    per_asset_links: Dict[Tuple[str, int], int] = defaultdict(int)
    for s in links:
        per_asset_links[(s.asset_type, s.asset_id)] += 1

    shares: List[ShareAdminRead] = []
    counts = dict(active=0, expired=0, revoked=0, never_expire=0, orphaned=0)
    size_cache: Dict[Tuple[str, int], int] = {}
    for s in links:
        exp = _utc(s.expires_at)
        never = exp >= NEVER_EXPIRES_THRESHOLD
        revoked = bool(s.revoked)
        state = "revoked" if revoked else "expired" if exp <= now else "active"
        counts[state] += 1
        counts["never_expire"] += int(never)
        key = (s.asset_type, s.asset_id)
        row = assets.get(key)
        if row is None:
            counts["orphaned"] += 1
            asset = ShareAssetRead(type=s.asset_type, id=s.asset_id, exists=False)
            related: List[RelatedAssetRead] = []
        else:
            if key not in size_cache:
                size_cache[key] = _asset_bytes(s.asset_type, row)
            asset = ShareAssetRead(
                type=s.asset_type, id=row.id, exists=True, title=row.title, slug=row.slug,
                status=row.status.value if hasattr(row.status, "value") else str(row.status),
                bytes=size_cache[key], created_by_name=names.get(row.created_by),
                has_thumbnail=bool(row.thumbnail_path),
            )
            related = []
            if s.asset_type == "volume":
                for m in meshes_of.get(row.id, []):
                    related.append(RelatedAssetRead(type="mesh", id=m.id, title=m.title, slug=m.slug, bytes=_asset_bytes("mesh", m)))
            elif s.asset_type == "mesh" and row.volume_id in linked_volumes:
                v = linked_volumes[row.volume_id]
                related.append(RelatedAssetRead(type="volume", id=v.id, title=v.title, slug=v.slug, bytes=_asset_bytes("volume", v)))
        st = stats.get(s.id) or _empty_stats()
        # the counter predates the view log: never show less than it counted
        st = st.model_copy(update={"views_total": max(st.views_total, int(s.views_count or 0))})
        shares.append(ShareAdminRead(
            id=s.id, code=s.code, url=f"{base}/s/{s.code}", state=state,
            created_at=_utc(s.created_at).isoformat(), expires_at=exp.isoformat(), never_expires=never,
            seconds_left=None if never or state != "active" else max(0, int((exp - now).total_seconds())),
            created_by_name=names.get(s.created_by), can_download=bool(s.can_download), min_lod=s.min_lod,
            view_query=s.view_query or "", asset=asset, stats=st, related=related,
            paths_count=int(paths_n.get(s.asset_id, 0)) if s.asset_type == "volume" else 0,
            bookmarks_count=int(bookmarks_n.get(s.asset_id, 0)) if s.asset_type == "volume" else 0,
            sibling_links=per_asset_links[key] - 1,
        ))

    summary = ShareAdminSummary(
        total=len(links), **counts,
        views_total=sum(x.stats.views_total for x in shares),
        views_24h=sum(x.stats.views_24h for x in shares),
        views_7d=sum(x.stats.views_7d for x in shares),
        views_30d=sum(x.stats.views_30d for x in shares),
        assets_shared=len(size_cache), bytes_shared=sum(size_cache.values()),
    )
    return ShareAdminOverview(summary=summary, shares=shares)


# ------------------------------------------------------------------------------------ disk usage

def _entries(scan: Scan, asset_type: str) -> List[StorageEntryRead]:
    items = [(k, b) for k, b in scan.buckets.items()]
    if asset_type == "volume":
        items.sort(key=lambda kb: (0 if kb[0].startswith("lod") else 1, kb[0]))
    else:
        items.sort(key=lambda kb: -kb[1].bytes)
    return [StorageEntryRead(key=k, label=b.label, bytes=b.bytes, apparent_bytes=b.apparent, files=b.files) for k, b in items]


@router.get("/api/storage/{asset_type}/{asset_id}", response_model=AssetStorageRead)
def asset_storage(
    asset_type: str,
    asset_id: int,
    refresh: bool = Query(False),
    session: Session = Depends(get_session),
    user: User = Depends(require_editor),
):
    """What one asset takes on disk, by kind of file (editors and administrators)."""
    model = _MODELS.get(asset_type)
    if model is None:
        raise HTTPException(status_code=404, detail="Unknown asset type")
    row = session.get(model, asset_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"{asset_type.capitalize()} not found")
    scan = cached_scan(asset_type, row.slug, row.thumbnail_path, refresh=refresh)
    out = AssetStorageRead(
        asset_type=asset_type, asset_id=row.id, slug=row.slug, bytes=scan.bytes,
        apparent_bytes=scan.apparent, files=scan.files, entries=_entries(scan, asset_type),
    )
    if asset_type == "volume":
        try:
            meta = json.loads((asset_root("volume", row.slug) / "volume.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            meta = {}
        raw = raw_voxel_bytes(meta)
        lod0 = scan.buckets.get("lod0000")
        if raw and lod0 and lod0.apparent:
            out.raw_bytes = raw
            out.ratio = round(raw / lod0.apparent, 2)
    if user.role.value == "admin":
        out.disk = DiskRead(**disk_usage(settings.DATA_DIR)) if disk_usage(settings.DATA_DIR) else None
        out.data_bytes = _kind_total(session, asset_type)
    return out


def _kind_total(session: Session, asset_type: str) -> int:
    model = _MODELS[asset_type]
    return sum(cached_scan(asset_type, r.slug, r.thumbnail_path).bytes for r in session.exec(select(model)).all())


def _same_device(a, b) -> bool:
    try:
        return os.stat(a).st_dev == os.stat(b).st_dev
    except OSError:
        return True


@router.get("/api/admin/storage", response_model=StorageOverviewRead)
def admin_storage(
    refresh: bool = Query(False),
    session: Session = Depends(get_session),
    _admin: User = Depends(require_admin),
):
    """Disk usage of every asset, the space nothing points at, and the free space (administrators)."""
    rows: List[StorageAssetRow] = []
    missing: List[StorageAssetRow] = []
    kind_bytes = {"volume": 0, "mesh": 0, "pointcloud": 0}
    known: Dict[str, set] = {k: set() for k in kind_bytes}
    for kind, model in _MODELS.items():
        for r in session.exec(select(model)).all():
            known[kind].add(r.slug)
            scan = cached_scan(kind, r.slug, r.thumbnail_path, refresh=refresh)
            status = r.status.value if hasattr(r.status, "value") else str(r.status)
            row = StorageAssetRow(type=kind, id=r.id, title=r.title, slug=r.slug, status=status, bytes=scan.bytes, files=scan.files)
            rows.append(row)
            kind_bytes[kind] += scan.bytes
            if status == "ready" and not asset_root(kind, r.slug).exists():
                missing.append(row)
    rows.sort(key=lambda x: -x.bytes)

    leftovers: List[StorageLeftover] = []
    for kind in kind_bytes:
        base = kind_dir(kind)
        try:
            names = [e.name for e in os.scandir(base) if e.is_dir(follow_symlinks=False)]
        except OSError:
            names = []
        for name in names:
            if name not in known[kind]:
                s = scan_dir(base / name)
                leftovers.append(StorageLeftover(type=kind, slug=name, bytes=s.bytes, files=s.files))
    leftovers.sort(key=lambda x: -x.bytes)

    db = 0
    for suffix in ("", "-wal", "-shm"):
        try:
            db += os.path.getsize(f"{settings.DB_PATH}{suffix}")
        except OSError:
            pass
    staging = scan_dir(settings.DATA_DIR / ".uploads").bytes + scan_dir(settings.PROCESSING_DIR / ".uploads").bytes
    processing = scan_dir(settings.PROCESSING_DIR).bytes
    data_disk = disk_usage(settings.DATA_DIR)
    proc_disk = None if _same_device(settings.DATA_DIR, settings.PROCESSING_DIR) else disk_usage(settings.PROCESSING_DIR)
    return StorageOverviewRead(
        disk=DiskRead(**data_disk) if data_disk else None,
        processing_disk=DiskRead(**proc_disk) if proc_disk else None,
        kind_bytes=kind_bytes, database_bytes=db, staging_bytes=staging, processing_bytes=processing,
        assets=rows, leftovers=leftovers, missing=missing, scanned_at=get_utc_now().isoformat(),
    )


# ----------------------------------------------------------------------------------------------- audit log

@router.get("/api/admin/audit", response_model=AuditPage)
def audit_log(
    limit: int = Query(100, ge=1, le=500),
    before: Optional[int] = Query(None, description="Only events older than this id (the previous page's next_before)"),
    action: str = Query("", description='An action ("user.create") or a group ending in a dot ("user.")'),
    actor: str = Query("", description="Part of the acting user's name"),
    target: str = Query("", description="Part of the name of what the action was done to (user name, slug, share code)"),
    ip: str = Query("", description="Part of the client address"),
    session: Session = Depends(get_session),
    _admin: User = Depends(require_admin),
):
    """The audit log (see audit.py), newest first, in pages."""
    query = select(AuditEvent)
    if before is not None:
        query = query.where(AuditEvent.id < before)
    action = action.strip()
    if action:
        query = query.where(col(AuditEvent.action).startswith(action, autoescape=True) if action.endswith(".") else AuditEvent.action == action)
    if actor.strip():
        query = query.where(col(AuditEvent.actor_name).contains(actor.strip(), autoescape=True))
    if target.strip():
        query = query.where(col(AuditEvent.target_name).contains(target.strip(), autoescape=True))
    if ip.strip():
        query = query.where(col(AuditEvent.ip).contains(ip.strip(), autoescape=True))
    rows = session.exec(query.order_by(col(AuditEvent.id).desc()).limit(limit + 1)).all()
    page = rows[:limit]
    return AuditPage(
        events=[
            AuditEventRead(
                id=e.id, at=_utc(e.at), actor_id=e.actor_id, actor_name=e.actor_name, action=e.action,
                target_type=e.target_type, target_id=e.target_id, target_name=e.target_name,
                detail=audit.parse_detail(e), ip=e.ip,
            )
            for e in page
        ],
        next_before=page[-1].id if len(rows) > limit and page else None,
    )
