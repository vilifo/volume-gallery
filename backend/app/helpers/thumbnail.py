"""Thumbnails of assets (volumes, meshes, point clouds).

A thumbnail is one small image stored next to the asset's data as
<asset dir>/_thumbnail.<png|jpg|webp>; the file name is kept in the asset's
`thumbnail_path` column. The type is decided by the file's magic bytes, never by the
name the client sent. SVG is deliberately not accepted.
"""
from pathlib import Path
from typing import Optional, Tuple

from fastapi import HTTPException, Request, UploadFile
from fastapi.responses import Response

from ..config import settings

THUMBNAIL_STEM = "_thumbnail"
_MEDIA_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp"}


def _sniff_extension(head: bytes) -> Optional[str]:
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if head.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return ".webp"
    return None


def read_thumbnail(upload: UploadFile) -> Tuple[str, bytes]:
    """Validates an uploaded thumbnail and returns (extension, bytes). Has no side
    effects, so create endpoints call it before they create anything."""
    limit = settings.THUMBNAIL_MAX_MB * 1024 * 1024
    upload.file.seek(0)
    data = upload.file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(status_code=413, detail=f"Thumbnail is larger than {settings.THUMBNAIL_MAX_MB} MB")
    ext = _sniff_extension(data[:16])
    if ext is None:
        raise HTTPException(status_code=400, detail="Thumbnail must be a PNG, JPEG or WebP image")
    return ext, data


def remove_thumbnail(asset_dir: Path) -> None:
    """Deletes the asset's thumbnail file(s), whatever their type."""
    for ext in _MEDIA_TYPES:
        (asset_dir / f"{THUMBNAIL_STEM}{ext}").unlink(missing_ok=True)


def write_thumbnail(asset_dir: Path, ext: str, data: bytes) -> str:
    """Stores the thumbnail (replacing a previous one) and returns its file name."""
    asset_dir.mkdir(parents=True, exist_ok=True)
    name = f"{THUMBNAIL_STEM}{ext}"
    part = asset_dir / f"{name}.part"
    part.write_bytes(data)
    remove_thumbnail(asset_dir)  # the old one may have had another extension
    part.replace(asset_dir / name)
    return name


def store_thumbnail(upload: UploadFile, asset_dir: Path) -> str:
    ext, data = read_thumbnail(upload)
    return write_thumbnail(asset_dir, ext, data)


def thumbnail_response(asset_dir: Path, filename: Optional[str], request: Request) -> Response:
    """The image, with an ETag: browsers revalidate on every gallery load and get a
    cheap 304 unless the thumbnail was replaced."""
    path = asset_dir / Path(filename).name if filename else None
    if path is None or not path.is_file():
        raise HTTPException(status_code=404, detail="No thumbnail")
    st = path.stat()
    etag = f'"{st.st_mtime_ns:x}-{st.st_size:x}"'
    headers = {"ETag": etag, "Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff"}
    sent = {t.strip().removeprefix("W/") for t in request.headers.get("if-none-match", "").split(",")}
    if etag in sent:
        return Response(status_code=304, headers=headers)
    return Response(
        content=path.read_bytes(),
        media_type=_MEDIA_TYPES.get(path.suffix, "application/octet-stream"),
        headers=headers,
    )
