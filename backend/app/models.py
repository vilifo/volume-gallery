import enum
from datetime import datetime
from typing import Optional

from sqlmodel import SQLModel, Field


class Role(str, enum.Enum):
    admin = "admin"
    editor = "editor"
    reader = "reader"


class VolumeStatus(str, enum.Enum):
    processing = "processing"
    ready = "ready"
    failed = "failed"


class User(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    username: str = Field(index=True, unique=True)
    password_hash: str
    role: Role = Field(default=Role.reader)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    disabled: bool = Field(default=False)


class Volume(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    slug: str = Field(index=True, unique=True)  # folder name on disk, also used in URLs
    title: str
    description: str = Field(default="")
    # Relative path (inside VOLUMES_DIR/<slug>/) to the OME-Zarr root, e.g. "data.ome.zarr"
    zarr_path: str = Field(default="data.ome.zarr")
    has_mesh: bool = Field(default=False)
    mesh_filename: Optional[str] = Field(default=None)
    thumbnail_path: Optional[str] = Field(default=None)
    created_by: Optional[int] = Field(default=None, foreign_key="user.id")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    # Extraction/conversion happens in a background task after the upload
    # request returns (see routers/volumes.py: _process_upload) — "ready"
    # for volumes created before this field existed (see database.py's
    # startup migration for how the column gets backfilled).
    status: VolumeStatus = Field(default=VolumeStatus.ready)
    # Newline-joined, timestamp-prefixed progress messages, appended to as
    # background processing runs. Kept as plain text rather than a separate
    # table — this app has no need to query into it, only display it whole.
    status_log: str = Field(default="")


class VolumeAccess(SQLModel, table=True):
    """Grants a reader visibility into a volume. Admins and editors bypass this table."""
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    volume_id: int = Field(foreign_key="volume.id", index=True)
    granted_by: Optional[int] = Field(default=None, foreign_key="user.id")
    granted_at: datetime = Field(default_factory=datetime.utcnow)