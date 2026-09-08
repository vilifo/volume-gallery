from typing import Optional, List
from pydantic import BaseModel
from .models import Role, VolumeStatus


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


class VolumeCreate(BaseModel):
    slug: str
    title: str
    description: str = ""


class VolumeRead(BaseModel):
    id: int
    slug: str
    title: str
    description: str
    has_mesh: bool
    mesh_filename: Optional[str] = None
    created_at: str
    status: VolumeStatus
    status_log: List[str] = []


class VolumeStatusRead(BaseModel):
    id: int
    status: VolumeStatus
    status_log: List[str] = []


class VolumeAccessGrant(BaseModel):
    user_id: int


class FileAccessUrl(BaseModel):
    url: str
    expires_in_minutes: int