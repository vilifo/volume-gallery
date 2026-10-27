from typing import List
from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from ..database import get_session
from ..models import User, Role
from ..schemas import UserCreate, UserRead, UserUpdate, PasswordChange, Token
from ..security import (
    hash_password, verify_password, validate_new_password, create_access_token, password_fingerprint,
)
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


@router.post("", response_model=UserRead)
def create_user(
    payload: UserCreate,
    session: Session = Depends(get_session),
    _admin: User = Depends(require_admin),
):
    existing = session.exec(select(User).where(User.username == payload.username)).first()
    if existing:
        raise HTTPException(status_code=409, detail="Username already exists")
    _check_password(payload.password)
    user = User(
        username=payload.username,
        password_hash=hash_password(payload.password),
        role=payload.role,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


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
    if payload.password is not None:
        # Admin password reset. The user's existing sessions stop working (see deps.get_current_user).
        _check_password(payload.password)
        user.password_hash = hash_password(payload.password)
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
