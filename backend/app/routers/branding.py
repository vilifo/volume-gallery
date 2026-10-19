from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from ..branding import load_branding, logo_path

# Public on purpose: the login page shows the branding before anyone has signed in.
router = APIRouter(prefix="/api/branding", tags=["branding"])

# An SVG opened directly (not through <img>) must not be able to run scripts.
_LOGO_HEADERS = {
    "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "public, max-age=86400",
}


@router.get("")
def get_branding():
    return load_branding()


def _logo(key: str) -> FileResponse:
    path = logo_path(key)
    if path is None:
        raise HTTPException(status_code=404, detail="No logo configured")
    return FileResponse(path, headers=_LOGO_HEADERS)


@router.get("/logo")
def get_logo():
    return _logo("logo")


@router.get("/logo-dark")
def get_logo_dark():
    return _logo("logo_dark")
