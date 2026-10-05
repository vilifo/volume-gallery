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


class VolumeRead(AssetRead):
    has_mesh: bool
    mesh_filename: Optional[str] = None
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
    can_download: bool


class FileAccessUrl(BaseModel):
    url: str
    expires_in_minutes: int
