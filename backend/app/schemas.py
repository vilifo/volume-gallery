from datetime import datetime
from typing import Optional, List
from pydantic import BaseModel, Field
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
    created_at: datetime
    status: AssetStatus
    status_log: List[str] = Field(default_factory=list)


class MeshRead(AssetRead):
    pass


class VolumeRead(AssetRead):
    mesh: Optional[MeshRead] = None


class PointCloudRead(AssetRead):
    pass


class AssetStatusRead(BaseModel):
    id: int
    status: AssetStatus
    status_log: List[str] = []


class AssetAccessGrant(BaseModel):
    user_id: int


class FileAccessUrl(BaseModel):
    url: str
    expires_in_minutes: int
