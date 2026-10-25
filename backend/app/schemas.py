from typing import Optional, List
from pydantic import BaseModel
from .models import Role, AssetStatus


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: Role
    username: str


class UserCreate(BaseModel):
    username: str
    password: str
    role: Role = Role.reader


class UserRead(BaseModel):
    id: int
    username: str
    role: Role
    disabled: bool


class PasswordChange(BaseModel):
    current_password: str
    new_password: str


class UserUpdate(BaseModel):
    role: Optional[Role] = None
    disabled: Optional[bool] = None
    password: Optional[str] = None


class AssetRead(BaseModel):
    id: int
    slug: str
    title: str
    description: str
    created_at: str
    status: AssetStatus
    status_log: List[str] = []
    can_download: bool = False
    # True when a thumbnail image is stored: fetch it from <asset api>/{id}/thumbnail
    has_thumbnail: bool = False


class VolumeRead(AssetRead):
    has_mesh: bool
    # Processing state of the attached mesh (it goes through the regular mesh
    # pipeline); None when the volume has no mesh or only a legacy raw file.
    mesh_status: Optional[AssetStatus] = None
    mesh_status_log: List[str] = []
    num_lod_levels: Optional[int] = None


class AssetStatusRead(BaseModel):
    id: int
    status: AssetStatus
    status_log: List[str] = []


class MeshRead(AssetRead):
    pass


class PointCloudRead(AssetRead):
    pass


class AccessGrant(BaseModel):
    user_id: int
    can_download: bool = False


class GrantedUserRead(BaseModel):
    id: int
    username: str
    can_download: bool = False


class FileAccessUrl(BaseModel):
    url: str
    expires_in_minutes: int
    version: Optional[str] = None


class ShareConfigRead(BaseModel):
    min_length: int
    max_length: int
    suggested_code: str


class ShareLinkCreate(BaseModel):
    code: Optional[str] = None
    asset_type: str  # "volume" | "mesh" | "pointcloud"
    asset_id: int
    expires_in_minutes: int = 1440  # default 24 hours
    view_query: str = ""
    can_download: bool = False
    min_lod: Optional[int] = None


class ShareLinkRead(BaseModel):
    id: int
    code: str
    url: str
    asset_type: str
    asset_id: int
    view_query: str = ""
    can_download: bool = False
    min_lod: Optional[int] = None
    created_at: str
    expires_at: str
    revoked: bool = False
    expired: bool = False
    views_count: int = 0
