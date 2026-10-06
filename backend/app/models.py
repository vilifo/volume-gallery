import enum
from datetime import datetime
from typing import Optional

from sqlmodel import SQLModel, Field


class Role(str, enum.Enum):
    admin = "admin"
    editor = "editor"
    reader = "reader"


class AssetStatus(str, enum.Enum):
    uploaded = "uploaded"
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
    slug: str = Field(index=True, unique=True)  # folder name on disk, also used in URLs
    title: str
    description: str = Field(default="")
    thumbnail_path: Optional[str] = Field(default=None)
    created_by: Optional[int] = Field(default=None, foreign_key="user.id")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    status: AssetStatus = Field(default=AssetStatus.ready)
    status_log: str = Field(default="")


class AssetAccessBase(SQLModel):
    """Shared fields for asset access control."""
    user_id: int = Field(foreign_key="user.id", index=True)
    granted_by: Optional[int] = Field(default=None, foreign_key="user.id")
    granted_at: datetime = Field(default_factory=datetime.utcnow)


class Volume(AssetBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    zarr_path: str = Field(default="data.ome.zarr")
    has_mesh: bool = Field(default=False)
    mesh_filename: Optional[str] = Field(default=None)
    num_lod_levels: Optional[int] = Field(default=None)


class VolumeAccess(AssetAccessBase, table=True):
    """Grants a reader visibility into a volume."""
    id: Optional[int] = Field(default=None, primary_key=True)
    volume_id: int = Field(foreign_key="volume.id", index=True)


class Mesh(AssetBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    mesh_filename: Optional[str] = Field(default=None)
    file_extension: Optional[str] = Field(default="stl")  # file extension, e.g. "stl" or "ply"
    volume_id: Optional[int] = Field(default=None, foreign_key="volume.id", index=True)


class MeshAccess(AssetAccessBase, table=True):
    """Grants a reader visibility into a mesh."""
    id: Optional[int] = Field(default=None, primary_key=True)
    mesh_id: int = Field(foreign_key="mesh.id", index=True)
    can_download: bool = Field(default=False)


class PointCloud(AssetBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    pc_path: str = Field(default="potree")
    has_mesh: bool = Field(default=False)
    mesh_filename: Optional[str] = Field(default=None)


class PointCloudAccess(AssetAccessBase, table=True):
    """Grants a reader visibility into a point cloud."""
    id: Optional[int] = Field(default=None, primary_key=True)
    pointcloud_id: int = Field(foreign_key="pointcloud.id", index=True)
