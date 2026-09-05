import enum
from datetime import datetime
from typing import Optional, List

from sqlmodel import SQLModel, Field, Relationship


class Role(str, enum.Enum):
    admin = "admin"
    editor = "editor"
    reader = "reader"


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


class VolumeAccess(SQLModel, table=True):
    """Grants a reader visibility into a volume. Admins and editors bypass this table."""
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    volume_id: int = Field(foreign_key="volume.id", index=True)
    granted_by: Optional[int] = Field(default=None, foreign_key="user.id")
    granted_at: datetime = Field(default_factory=datetime.utcnow)
