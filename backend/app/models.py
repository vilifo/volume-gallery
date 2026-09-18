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


class AssetType(str, enum.Enum):
    volume = "volume"
    mesh = "mesh"
    point_cloud = "point_cloud"


class User(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    username: str = Field(index=True, unique=True)
    password_hash: str
    role: Role = Field(default=Role.reader)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    disabled: bool = Field(default=False)


class Asset(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    asset_type: AssetType = Field(index=True, default=AssetType.volume)
    slug: str = Field(index=True, unique=True)
    title: str
    description: str = Field(default="")
    file_path: str
    thumbnail_path: Optional[str] = None
    created_by: Optional[int] = Field(default=None, foreign_key="user.id")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    status: AssetStatus = Field(default=AssetStatus.ready)
    status_log: str = Field(default="")
    # Mesh specific fields
    volume_id: Optional[int] = Field(default=None, foreign_key="asset.id")
    # Volume specific fields
    num_lod_levels: int = -1
    mesh: Optional["Asset"] = Relationship(
        sa_relationship_kwargs={"remote_side": "Asset.id"}
    )


Asset.model_rebuild()


class AssetAccess(SQLModel, table=True):
    """Grants a reader visibility into a volume. Admins and editors bypass this table."""
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    asset_id: int = Field(foreign_key="asset.id", index=True)
    granted_by: Optional[int] = Field(default=None, foreign_key="user.id")
    granted_at: datetime = Field(default_factory=datetime.utcnow)
