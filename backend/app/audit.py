"""The audit log: one row (models.AuditEvent) for every security-relevant action, written in the same transaction as
the action itself, so there is never a change without its line, or a line for a change that was rolled back.

Recorded: sign-ins and failed sign-ins, setting a password (link or own), accounts (create, password link, role or
status change, delete), uploads and deletions of volumes / meshes / point clouds, access grants and revocations,
and share links (create, delete). Reading and viewing are not logged (share links count their own views).

The client address is read from X-Real-IP, which nginx sets (see nginx.conf.template); without nginx in front of the
app, anyone can send that header, so treat addresses as informational then. A failed sign-in for a name that is not
an account is logged without the name: people paste passwords into the username box."""
import json
from datetime import timedelta
from typing import Any, Optional

from fastapi import Request
from sqlmodel import Session, delete

from .config import settings
from .models import AuditEvent, User
from .utils import get_utc_now

_MAX_TEXT = 200


def client_ip(request: Optional[Request]) -> str:
    if request is None:
        return ""
    real = request.headers.get("x-real-ip", "").strip()
    if real:
        return real[:64]
    return (request.client.host if request.client else "")[:64]


def _clip(value: Any) -> Any:
    return value[:_MAX_TEXT] if isinstance(value, str) else value


def record(
    session: Session,
    request: Optional[Request],
    actor: Optional[User],
    action: str,
    target_type: str = "",
    target_id: Optional[int] = None,
    target_name: str = "",
    **detail: Any,
) -> AuditEvent:
    """Adds a line to the session; it is saved with the caller's next commit (the action's own)."""
    event = AuditEvent(
        actor_id=actor.id if actor else None,
        actor_name=actor.username if actor else "",
        action=action,
        target_type=target_type,
        target_id=target_id,
        target_name=_clip(target_name or ""),
        detail=json.dumps({k: _clip(v) for k, v in detail.items() if v is not None}, default=str) if detail else "",
        ip=client_ip(request),
    )
    session.add(event)
    return event


def record_now(session: Session, *args: Any, **kwargs: Any) -> AuditEvent:
    """record() and commit: for events with no other change to ride on (a failed sign-in)."""
    event = record(session, *args, **kwargs)
    session.commit()
    return event


def parse_detail(event: AuditEvent) -> dict:
    try:
        value = json.loads(event.detail) if event.detail else {}
        return value if isinstance(value, dict) else {}
    except ValueError:
        return {}


def prune(session: Session, days: Optional[int] = None) -> int:
    """Deletes lines older than the retention (VG_AUDIT_RETENTION_DAYS; 0 = keep for ever). Returns how many."""
    days = settings.AUDIT_RETENTION_DAYS if days is None else days
    if days <= 0:
        return 0
    result = session.exec(delete(AuditEvent).where(AuditEvent.at < get_utc_now() - timedelta(days=days)))
    session.commit()
    return result.rowcount or 0
