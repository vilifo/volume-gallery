from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, VerificationError, InvalidHashError
import hashlib
from datetime import datetime, timedelta
from typing import Optional

import bcrypt
from jose import jwt, JWTError

from .config import settings

MAX_PASSWORD_LENGTH = 1024  # Protects against memory/CPU DoS on oversized payloads

# argon2-cffi defaults to RFC 9106 Low-Memory profile (Argon2id, m=65536 [64 MiB], t=3, p=4),
# which exceeds OWASP's minimum recommendations (m=19456 [19 MiB], t=2, p=1).
_ph = PasswordHasher()

# Pre-computed dummy hash to prevent user-enumeration timing attacks when a user is not found
_DUMMY_HASH = _ph.hash("dummy_password_for_timing_mitigation")


def hash_password(password: str) -> str:
    if len(password) > MAX_PASSWORD_LENGTH:
        raise ValueError(f"Password exceeds maximum length of {MAX_PASSWORD_LENGTH} characters.")
    return _ph.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    """
    Drop-in replacement for verifying both Argon2id and legacy bcrypt hashes.
    """
    if len(plain) > MAX_PASSWORD_LENGTH or not hashed:
        return False

    # 1. Modern Argon2id path
    if hashed.startswith("$argon2"):
        try:
            return _ph.verify(hashed, plain)
        except (VerifyMismatchError, VerificationError, InvalidHashError):
            return False

    # 2. Legacy bcrypt path ($2b$, $2a$, $2y$)
    if hashed.startswith(("$2b$", "$2a$", "$2y$")):
        try:
            # Truncate UTF-8 bytes at 72 to preserve exact compatibility with bcrypt < 5.0.0
            return bcrypt.checkpw(plain.encode("utf-8")[:72], hashed.encode("ascii"))
        except (ValueError, UnicodeEncodeError):
            return False

    return False


def needs_rehash(hashed: str) -> bool:
    """
    Returns True if the hash is a legacy bcrypt hash OR if it's an Argon2 hash
    created with older/weaker parameters than currently configured on `_ph`.
    """
    if not hashed.startswith("$argon2"):
        return True
    try:
        return _ph.check_needs_rehash(hashed)
    except InvalidHashError:
        return True


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


def create_share_session_token(
    share_id: int,
    code: str,
    asset_type: str,
    asset_id: int,
    expires_at: datetime,
    can_download: bool = False,
    min_lod: Optional[int] = None,
) -> str:
    """Creates a scoped bearer token for a guest visiting a /s/<code> share link."""
    payload = {
        "sub": f"share:{code}",
        "type": "share",
        "sid": share_id,
        "kind": asset_type,
        "aid": asset_id,
        "cd": bool(can_download),
        "exp": expires_at,
    }
    if min_lod is not None:
        payload["min_lod"] = int(min_lod)
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def create_file_token(subject: str, asset_id: int, kind: str, min_lod: Optional[int] = None) -> str:
    """kind is 'sharded', 'mesh' or 'pointcloud' — scopes the token to a specific resource on a
    specific volume.
    - min_lod (sharded-volume tokens only) caps the finest LOD served — see routers/volumes.py."""
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
