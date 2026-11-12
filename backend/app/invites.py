"""One-time links with which a user sets their own password: for a new account (an admin creates it without
a password) and for a reset (an admin generates a new link; the user picks the new password). Only a hash of the
token is stored, so a copy of the database does not hold usable links."""
import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from .config import settings
from .utils import get_utc_now

PURPOSE_SETUP = "setup"   # the account has no password yet
PURPOSE_RESET = "reset"   # the account has a password that the user replaces


def new_token() -> str:
    """256 random bits, URL-safe: nothing to guess, so no rate limit is needed on the link."""
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def link_expiry() -> datetime:
    return get_utc_now() + timedelta(hours=settings.PASSWORD_LINK_HOURS)


def aware(moment: datetime) -> datetime:
    """SQLite hands datetimes back without a time zone; they are UTC."""
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)
