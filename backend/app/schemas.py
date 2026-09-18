from typing import Optional, List
from pydantic import BaseModel, ConfigDict
from .models import Role, AssetStatus, AssetType


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
    model_config = ConfigDict(from_attributes=True)

    id: int
    slug: str
    title: str
    description: str
    created_at: str
    status: AssetStatus
    asset_type: AssetType
    status_log: List[str]
    mesh: Optional["AssetRead"] = None


AssetRead.model_rebuild()


class AssetStatusRead(BaseModel):
    id: int
    status: AssetStatus
    status_log: List[str] = []


class AssetAccessGrant(BaseModel):
    user_id: int


class FileAccessUrl(BaseModel):
    url: str
    expires_in_minutes: int
