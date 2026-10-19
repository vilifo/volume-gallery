from typing import Optional
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlmodel import Session, select

from .database import get_session
from .security import decode_token, password_fingerprint
from .models import User, Role

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)


def get_current_user(
    token: Optional[str] = Depends(oauth2_scheme),
    session: Session = Depends(get_session),
) -> User:
    credentials_exc = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Not authenticated",
        headers={"WWW-Authenticate": "Bearer"},
    )
    if not token:
        raise credentials_exc
    payload = decode_token(token)
    if not payload or payload.get("type") != "access":
        raise credentials_exc
    username = payload.get("sub")
    user = session.exec(select(User).where(User.username == username)).first()
    if not user or user.disabled:
        raise credentials_exc
    # Tokens carry a fingerprint of the password they were issued for: after a password
    # change/reset the old ones stop working. (Tokens issued before this claim existed
    # have none and stay valid until they expire.)
    pwv = payload.get("pwv")
    if pwv is not None and pwv != password_fingerprint(user.password_hash):
        raise credentials_exc
    return user


def require_roles(*roles: Role):
    def _checker(user: User = Depends(get_current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Requires one of roles: {[r.value for r in roles]}",
            )
        return user
    return _checker


require_admin = require_roles(Role.admin)
require_editor = require_roles(Role.admin, Role.editor)
any_authenticated = get_current_user
