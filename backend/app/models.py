import enum
from datetime import datetime
from typing import Optional

from sqlmodel import SQLModel, Field, Relationship


class Role(str, enum.Enum):
    admin = "admin"
    editor = "editor"
    reader = "reader"


class AssetStatus(str, enum.Enum):
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


class AssetBase(SQLModel):
    slug: str = Field(index=True, unique=True)
    title: str
    description: str = Field(default="")
    file_path: str
    thumbnail_path: Optional[str] = None
    created_by: Optional[int] = Field(default=None, foreign_key="user.id")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    status: AssetStatus = Field(default=AssetStatus.ready)
    status_log: str = Field(default="")


class Mesh(AssetBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    volume_id: Optional[int] = Field(default=None, foreign_key="volume.id")
    volume: Optional["Volume"] = Relationship(back_populates="mesh")


class PointCloud(AssetBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)


class Volume(AssetBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    mesh: Optional["Mesh"] = Relationship(back_populates="volume")


class AssetAccess(SQLModel, table=True):
    """Grants a reader visibility into a volume. Admins and editors bypass this table."""
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    asset_id: int = Field(foreign_key="volume.id", index=True)
    granted_by: Optional[int] = Field(default=None, foreign_key="user.id")
    granted_at: datetime = Field(default_factory=datetime.utcnow)
