import base64
import hashlib
from datetime import datetime, timedelta
from typing import Optional

import bcrypt
from jose import jwt, JWTError

from .config import settings

# bcrypt only uses the first 72 bytes of a password (and bcrypt 5 refuses longer ones), so
# new hashes are made from base64(sha256(password)) instead, which lifts that limit. Such
# hashes are stored as "$bcrypt-sha256$" + the bcrypt hash. Plain "$2b$..." hashes from
# earlier versions still verify (see verify_password) and are upgraded at the next login.
_SHA256_PREFIX = "$bcrypt-sha256$"
MAX_PASSWORD_LENGTH = 1024  # characters; just keeps absurd request bodies away from the hasher


def _prehash(password: str) -> bytes:
    return base64.b64encode(hashlib.sha256(password.encode("utf-8")).digest())  # 44 bytes, no NULs


def hash_password(password: str) -> str:
    return _SHA256_PREFIX + bcrypt.hashpw(_prehash(password), bcrypt.gensalt()).decode("ascii")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        if hashed.startswith(_SHA256_PREFIX):
            return bcrypt.checkpw(_prehash(plain), hashed[len(_SHA256_PREFIX):].encode("ascii"))
        # Legacy plain-bcrypt hash. Older versions silently truncated to 72 bytes when
        # hashing, so do the same here or such a user could no longer sign in.
        return bcrypt.checkpw(plain.encode("utf-8")[:72], hashed.encode("ascii"))
    except ValueError:  # malformed hash
        return False


def needs_rehash(hashed: str) -> bool:
    """True for hashes made by the old scheme (to be upgraded after a successful login)."""
    return not hashed.startswith(_SHA256_PREFIX)


def validate_new_password(password: str) -> None:
    """Raises ValueError (with a message fit for the user) if `password` is not acceptable."""
    if len(password) < settings.MIN_PASSWORD_LENGTH:
        raise ValueError(f"Password must be at least {settings.MIN_PASSWORD_LENGTH} characters long")
    if len(password) > MAX_PASSWORD_LENGTH:
        raise ValueError(f"Password is too long (at most {MAX_PASSWORD_LENGTH} characters)")


def password_fingerprint(password_hash: str) -> str:
    """Short, non-reversible tag of the current password hash. It is embedded in access
    tokens ("pwv" claim), so changing or resetting a password invalidates the tokens
    issued before it."""
    return hashlib.sha256(password_hash.encode("utf-8")).hexdigest()[:16]


def create_access_token(
    subject: str, role: str, expires_minutes: Optional[int] = None, pwv: Optional[str] = None
) -> str:
    expire = datetime.utcnow() + timedelta(
        minutes=expires_minutes or settings.ACCESS_TOKEN_EXPIRE_MINUTES
    )
    payload = {"sub": subject, "role": role, "exp": expire, "type": "access"}
    if pwv is not None:
        payload["pwv"] = pwv
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def create_file_token(subject: str, asset_id: int, kind: str, min_lod: Optional[int] = None) -> str:
    """kind is 'zarr' or 'mesh' or 'pointcloud' — scopes the token to a specific resource on a
    specific volume.
    - min_lod (zarr tokens only) caps which OME-NGFF
    multiscale levels get served — see routers/volumes.py's serve_zarr_file."""
    expire = datetime.utcnow() + timedelta(minutes=settings.FILE_TOKEN_EXPIRE_MINUTES)
    payload = {
        "sub": subject,
        "vol": asset_id,
        "kind": kind,
        "exp": expire,
        "type": "file",
    }
    if min_lod is not None:
        payload["min_lod"] = min_lod
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def decode_token(token: str) -> Optional[dict]:
    try:
        return jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
    except JWTError:
        return None
