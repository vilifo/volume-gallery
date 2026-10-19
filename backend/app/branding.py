"""Branding / marketing settings, read from <BRANDING_DIR>/branding.toml.

The file is read on every request (it is tiny), so edits show up without a restart. Its
content ends up in web pages, so everything is validated here: unknown keys are ignored,
text is trimmed and length-limited, links must be http(s)/mailto, and logo files must sit
inside the branding folder.
"""
import logging
import re
import tomllib
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

from .config import settings

log = logging.getLogger("volume-gallery.branding")

CONFIG_NAME = "branding.toml"
LOGO_TYPES = {".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif"}
_EMAIL_RE = re.compile(r"^[^@\s<>\"']+@[^@\s<>\"']+\.[^@\s<>\"']+$")
_MAX_LINKS = 10


def _text(value: Any, limit: int = 200) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def _web_url(value: Any) -> str:
    url = _text(value, 500)
    return url if url.lower().startswith(("http://", "https://")) else ""


def _read_config() -> Dict[str, Any]:
    path = settings.BRANDING_DIR / CONFIG_NAME
    try:
        with open(path, "rb") as fh:
            data = tomllib.load(fh)
    except FileNotFoundError:
        return {}
    except (OSError, tomllib.TOMLDecodeError) as exc:
        log.warning("Cannot read %s (%s); using the built-in branding defaults", path, exc)
        return {}
    return data if isinstance(data, dict) else {}


def logo_path(key: str, data: Optional[Dict[str, Any]] = None) -> Optional[Path]:
    """File behind `logo` / `logo_dark`, or None. Never leaves the branding folder."""
    name = _text((_read_config() if data is None else data).get(key), 200)
    if not name:
        return None
    base = settings.BRANDING_DIR.resolve()
    path = (base / name).resolve()
    if base not in path.parents or path.suffix.lower() not in LOGO_TYPES or not path.is_file():
        return None
    return path


def _logo_url(data: Dict[str, Any], key: str, route: str) -> Optional[str]:
    path = logo_path(key, data)
    # the version changes when the file does, so browsers can cache the logo for long
    return f"/api/branding/{route}?v={path.stat().st_mtime_ns:x}" if path else None


def load_branding() -> Dict[str, Any]:
    data = _read_config()
    organization = _text(data.get("organization"))
    copyright_text = _text(data.get("copyright"), 300)
    if not copyright_text and organization:
        copyright_text = "\u00a9 {year} {organization}"
    copyright_text = copyright_text.replace("{year}", str(datetime.now().year)).replace("{organization}", organization)

    contact_in = data.get("contact") if isinstance(data.get("contact"), dict) else {}
    email = _text(contact_in.get("email"))
    contact = {
        "email": email if _EMAIL_RE.match(email) else "",
        "phone": _text(contact_in.get("phone"), 60),
        "website": _web_url(contact_in.get("website")),
        "address": _text(contact_in.get("address"), 300),
    }

    links = []
    for item in data.get("links") if isinstance(data.get("links"), list) else []:
        if not isinstance(item, dict):
            continue
        label, url = _text(item.get("label"), 80), _text(item.get("url"), 500)
        if label and url.lower().startswith(("http://", "https://", "mailto:")):
            links.append({"label": label, "url": url})
    return {
        "app_name": _text(data.get("app_name"), 80) or "Volume Gallery",
        "tagline": _text(data.get("tagline"), 300),
        "about": _text(data.get("about"), 2000),
        "organization": organization,
        "copyright": copyright_text.strip(),
        "logo_url": _logo_url(data, "logo", "logo"),
        "logo_dark_url": _logo_url(data, "logo_dark", "logo-dark"),
        "contact": contact,
        "links": links[:_MAX_LINKS],
    }
