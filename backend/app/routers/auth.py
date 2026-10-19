from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlmodel import Session, select

from ..database import get_session
from ..models import User
from ..security import verify_password, needs_rehash, hash_password, create_access_token, password_fingerprint, _DUMMY_HASH
from ..schemas import Token

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login", response_model=Token)
def login(form: OAuth2PasswordRequestForm = Depends(), session: Session = Depends(get_session)):
    user = session.exec(select(User).where(User.username == form.username)).first()

    # Always run password verification to prevent username/status enumeration via timing
    target_hash = user.password_hash if user else _DUMMY_HASH
    password_valid = verify_password(form.password, target_hash)

    if not user or user.disabled or not password_valid:
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

    token = create_access_token(
        subject=user.username,
        role=user.role.value,
        pwv=password_fingerprint(user.password_hash),
    )
    return Token(access_token=token, role=user.role, username=user.username)
