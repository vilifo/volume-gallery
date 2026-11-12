from typing import List
from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, delete, select, update

from ..database import get_session
from ..models import (
    User, UserToken, Role, Volume, VolumeAccess, Mesh, MeshAccess, PointCloud, PointCloudAccess, ShareLink,
)
from ..schemas import UserCreate, UserRead, UserUpdate, UserLink, PasswordChange, Token
from ..security import (
    hash_password, verify_password, validate_new_password, create_access_token, password_fingerprint,
)
from ..invites import PURPOSE_RESET, PURPOSE_SETUP, aware, hash_token, link_expiry, new_token
from ..deps import require_admin, get_current_user

router = APIRouter(prefix="/api/users", tags=["users"])


def _check_password(password: str) -> None:
    try:
        validate_new_password(password)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("", response_model=List[UserRead])
def list_users(session: Session = Depends(get_session), _admin: User = Depends(require_admin)):
    return session.exec(select(User)).all()


def _issue_link(session: Session, user: User, admin: User) -> UserLink:
    """Makes a new one-time link for `user` (the ones issued before stop working) and commits it. The token is
    in the result only: the database keeps its hash."""
    session.exec(delete(UserToken).where(UserToken.user_id == user.id))
    token = new_token()
    purpose = PURPOSE_SETUP if user.pending else PURPOSE_RESET
    row = UserToken(
        user_id=user.id, purpose=purpose, token_hash=hash_token(token), created_by=admin.id, expires_at=link_expiry(),
    )
    session.add(row)
    session.commit()
    session.refresh(user)
    return UserLink(user=UserRead.model_validate(user), token=token, purpose=purpose, expires_at=aware(row.expires_at))


@router.post("", response_model=UserLink)
def create_user(
    payload: UserCreate,
    session: Session = Depends(get_session),
    admin: User = Depends(require_admin),
):
    """Creates an account without a password and returns the one-time link with which its user sets one."""
    existing = session.exec(select(User).where(User.username == payload.username)).first()
    if existing:
        raise HTTPException(status_code=409, detail="Username already exists")
    user = User(username=payload.username, password_hash="", role=payload.role)
    session.add(user)
    session.flush()  # (the id; committed together with the link)
    return _issue_link(session, user, admin)


@router.post("/{user_id}/password-link", response_model=UserLink)
def create_password_link(
    user_id: int,
    session: Session = Depends(get_session),
    admin: User = Depends(require_admin),
):
    """A new link for a user: to set the password of an account that has none yet (the earlier link may have
    expired or got lost) or to reset a forgotten one. The user's current password and sessions stay valid until
    the link is used; any link issued before this one stops working."""
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.id == admin.id:
        raise HTTPException(status_code=400, detail="Change your own password on the Account page")
    if user.disabled:
        raise HTTPException(status_code=400, detail="Enable the account first")
    return _issue_link(session, user, admin)


@router.patch("/{user_id}", response_model=UserRead)
def update_user(
    user_id: int,
    payload: UserUpdate,
    session: Session = Depends(get_session),
    admin: User = Depends(require_admin),
):
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.id == admin.id and payload.role and payload.role != Role.admin:
        raise HTTPException(status_code=400, detail="Admins cannot demote themselves")
    if user.id == admin.id and payload.disabled:
        raise HTTPException(status_code=400, detail="Admins cannot disable themselves")
    if payload.role is not None:
        user.role = payload.role
    if payload.disabled is not None:
        user.disabled = payload.disabled
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


@router.delete("/{user_id}")
def delete_user(
    user_id: int,
    session: Session = Depends(get_session),
    admin: User = Depends(require_admin),
):
    if user_id == admin.id:
        raise HTTPException(status_code=400, detail="Admins cannot delete themselves")
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    # SQLite does not enforce the foreign keys, so rows that point at the user would stay behind:
    # the user's own grants go; for the rest (who granted, who created) the pointer is cleared and
    # the grant, asset or share link stays.
    for access in (VolumeAccess, MeshAccess, PointCloudAccess):
        session.exec(delete(access).where(access.user_id == user_id))
        session.exec(update(access).where(access.granted_by == user_id).values(granted_by=None))
    for asset in (Volume, Mesh, PointCloud):
        session.exec(update(asset).where(asset.created_by == user_id).values(created_by=None))
    session.exec(update(ShareLink).where(ShareLink.created_by == user_id).values(created_by=None))
    session.exec(delete(UserToken).where(UserToken.user_id == user_id))
    session.exec(update(UserToken).where(UserToken.created_by == user_id).values(created_by=None))
    session.delete(user)
    session.commit()
    return {"ok": True}


@router.get("/me", response_model=UserRead)
def me(user: User = Depends(get_current_user)):
    return user


@router.post("/me/password", response_model=Token)
def change_own_password(
    payload: PasswordChange,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    """Lets any signed-in user change their own password. All other sessions of the user are
    signed out; the response carries a fresh token so that this one stays signed in."""
    if not verify_password(payload.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    if payload.new_password == payload.current_password:
        raise HTTPException(status_code=400, detail="The new password must differ from the current one")
    _check_password(payload.new_password)
    user.password_hash = hash_password(payload.new_password)
    session.add(user)
    session.commit()
    session.refresh(user)
    token = create_access_token(
        subject=user.username, role=user.role.value, pwv=password_fingerprint(user.password_hash)
    )
    return Token(access_token=token, role=user.role, username=user.username)
