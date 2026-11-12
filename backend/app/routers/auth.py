from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlmodel import Session, col, delete, select, update

from ..database import get_session
from ..models import User, UserToken
from ..security import (
    verify_password, needs_rehash, hash_password, validate_new_password, create_access_token, password_fingerprint,
    _DUMMY_HASH,
)
from ..schemas import Token, SetPassword, SetPasswordCheck, SetPasswordInfo
from .. import audit
from ..invites import aware, hash_token
from ..utils import get_utc_now

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login", response_model=Token)
def login(request: Request, form: OAuth2PasswordRequestForm = Depends(), session: Session = Depends(get_session)):
    user = session.exec(select(User).where(User.username == form.username)).first()

    # Always run password verification to prevent username/status enumeration via timing
    # (an account that has no password yet is checked against the dummy too: no timing difference)
    target_hash = user.password_hash if user and user.password_hash else _DUMMY_HASH
    password_valid = verify_password(form.password, target_hash)

    if not user or user.disabled or not password_valid:
        reason = "unknown user" if not user else "disabled" if user.disabled else "bad password"
        audit.record_now(session, request, None, "auth.login_failed", "user", user.id if user else None, user.username if user else "", reason=reason)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if needs_rehash(user.password_hash):
        user.password_hash = hash_password(form.password)
        session.add(user)
        session.commit()
        session.refresh(user)

    audit.record_now(session, request, user, "auth.login", "user", user.id, user.username)
    token = create_access_token(
        subject=user.username,
        role=user.role.value,
        pwv=password_fingerprint(user.password_hash),
    )
    return Token(access_token=token, role=user.role, username=user.username)


# ----------------------------------------------------------------------------- setting a password from a link
# An admin creates an account without a password, or asks for a password reset; either gives them a one-time
# link (see routers/users.py) to hand to the user, who opens it and picks the password. The token is in the
# POST body (not in the URL) so that it does not end up in access logs.

def _link_user(session: Session, token: str):
    """The (link, user) the token belongs to, or an HTTP error that tells the user what to do."""
    row = session.exec(select(UserToken).where(UserToken.token_hash == hash_token(token.strip()))).first()
    user = session.get(User, row.user_id) if row else None
    if not row or not user:
        raise HTTPException(status_code=404, detail="This link is not valid. Ask an administrator for a new one.")
    if row.used_at is not None:
        raise HTTPException(status_code=410, detail="This link has already been used. Ask an administrator for a new one if you need it.")
    if aware(row.expires_at) <= get_utc_now():
        raise HTTPException(status_code=410, detail="This link has expired. Ask an administrator for a new one.")
    if user.disabled:
        raise HTTPException(status_code=403, detail="This account is disabled.")
    return row, user


@router.post("/set-password/check", response_model=SetPasswordInfo)
def check_password_link(payload: SetPasswordCheck, session: Session = Depends(get_session)):
    """Whose password the link sets (the page shows it above the form), without using up the link."""
    row, user = _link_user(session, payload.token)
    return SetPasswordInfo(username=user.username, purpose=row.purpose, expires_at=aware(row.expires_at))


@router.post("/set-password", response_model=Token)
def set_password_from_link(payload: SetPassword, request: Request, session: Session = Depends(get_session)):
    """Sets the password with a one-time link, uses the link up and signs the user in. Sessions that were
    open before (a reset) stop working: the tokens carry a fingerprint of the old password."""
    row, user = _link_user(session, payload.token)
    try:
        validate_new_password(payload.password)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    # The link is used up first, by a conditional update: of two requests with the same link only one succeeds.
    claimed = session.exec(
        update(UserToken).where(UserToken.id == row.id, col(UserToken.used_at).is_(None)).values(used_at=get_utc_now())
    )
    if claimed.rowcount != 1:
        session.rollback()
        raise HTTPException(status_code=410, detail="This link has already been used. Ask an administrator for a new one if you need it.")
    user.password_hash = hash_password(payload.password)
    session.add(user)
    session.exec(delete(UserToken).where(UserToken.user_id == user.id, UserToken.id != row.id))  # any other link of the user
    audit.record(session, request, user, "user.password_set", "user", user.id, user.username, via="link", purpose=row.purpose)
    session.commit()
    session.refresh(user)
    token = create_access_token(subject=user.username, role=user.role.value, pwv=password_fingerprint(user.password_hash))
    return Token(access_token=token, role=user.role, username=user.username)
