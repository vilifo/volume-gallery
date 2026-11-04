from typing import Literal, Optional, List
from pydantic import BaseModel, Field, field_validator
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
    folder_id: Optional[int] = None
    tags: List[str] = []


class VolumeRead(AssetRead):
    has_mesh: bool
    # Processing state of the attached mesh (it goes through the regular mesh
    # pipeline); None when the volume has no mesh or only a legacy raw file.
    mesh_status: Optional[AssetStatus] = None
    mesh_status_log: List[str] = []
    num_lod_levels: Optional[int] = None


class AssetUpdate(BaseModel):
    """Editable details of an asset. Only the fields that are sent are changed;
    `"folder_id": null` moves the asset to the top level."""
    title: Optional[str] = None
    description: Optional[str] = None
    tags: Optional[List[str]] = None
    folder_id: Optional[int] = None


class FolderRead(BaseModel):
    id: int
    name: str
    parent_id: Optional[int] = None


class FolderCreate(BaseModel):
    name: str
    parent_id: Optional[int] = None


class FolderUpdate(BaseModel):
    """Only the fields that are sent are changed; `"parent_id": null` moves the folder to the top level."""
    name: Optional[str] = None
    parent_id: Optional[int] = None


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
    expires_in_minutes: int = 1440  # default 24 hours; 0 = never expires
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
    never_expires: bool = False
    revoked: bool = False
    expired: bool = False
    views_count: int = 0


# ---------- saved ways of showing a volume (camera paths etc.) ----------

class PoseSpec(BaseModel):
    """A camera pose of the 3D view: eye = target + back * distance; `up` is the camera's up vector."""
    back: List[float] = Field(min_length=3, max_length=3)
    up: List[float] = Field(min_length=3, max_length=3)
    distance: float = Field(gt=0, lt=1e9)
    target: List[float] = Field(min_length=3, max_length=3)
    name: Optional[str] = Field(default=None, max_length=80)     # where it came from, e.g. a bookmark's name

    @field_validator("back", "up", "target")
    @classmethod
    def _finite(cls, v):
        if any(x != x or abs(x) > 1e9 for x in v):  # NaN or absurdly large
            raise ValueError("coordinates must be finite numbers")
        return v


class PlaybackSpec(BaseModel):
    """How to show a volume on screen: a 3D turntable, a 3D camera path or a sweep through the slices."""
    kind: Literal["turntable", "path", "slices"]
    duration: float = Field(default=20, ge=1, le=3600)          # seconds for one pass (3D)
    end: Literal["stop", "return", "pingpong"] = "return"       # what happens at the end of a pass
    ease: Literal["smooth", "linear"] = "smooth"
    angle: float = Field(default=360, ge=1, le=3600)             # turntable: degrees per pass
    direction: Literal[1, -1] = 1
    keys: List[PoseSpec] = Field(default_factory=list, max_length=200)
    start: Optional[PoseSpec] = None                             # turntable: begin from this view (else the current one)
    axis: Optional[Literal["xy", "xz", "yz"]] = None             # slice sweep
    from_index: int = Field(default=0, ge=0, le=1_000_000)
    to_index: int = Field(default=0, ge=0, le=1_000_000)
    step: int = Field(default=1, ge=1, le=100_000)
    speed: float = Field(default=10, gt=0, le=240)               # slices per second
    preload: bool = True
    pause_on_touch: bool = True


class PathWrite(BaseModel):
    name: str
    spec: PlaybackSpec


class PathRead(BaseModel):
    id: int
    name: str
    spec: PlaybackSpec
    created_at: str
    updated_at: str
    created_by_name: Optional[str] = None


# ---------- saved views (bookmarks) ----------

class TfPoint(BaseModel):
    x: float
    y: float


class BookmarkOptions(BaseModel):
    """The 3D render settings of a view, named as the viewer names them."""
    mode: Optional[Literal["dvr", "mip", "iso", "lod"]] = None
    windowCenter: Optional[float] = None
    windowWidth: Optional[float] = None
    densityScale: Optional[float] = None
    isoValue: Optional[float] = None
    tfPreset: Optional[str] = Field(default=None, max_length=40)
    tfPoints: Optional[List[TfPoint]] = Field(default=None, max_length=64)
    upAxis: Optional[Literal["x", "y", "z", "-x", "-y", "-z"]] = None
    cam: Optional[List[float]] = Field(default=None, max_length=12)   # 3, 6 or 12 numbers (a rolled view has 12)
    clipMin: Optional[List[float]] = Field(default=None, min_length=3, max_length=3)
    clipMax: Optional[List[float]] = Field(default=None, min_length=3, max_length=3)
    showWireframe: Optional[bool] = None
    showAxis: Optional[bool] = None

    @field_validator("cam")
    @classmethod
    def _cam_len(cls, v):
        if v is not None and len(v) not in (3, 6, 12):
            raise ValueError("cam has 3, 6 or 12 numbers")
        return v


class BookmarkSpec(BaseModel):
    options: BookmarkOptions
    pose: Optional[PoseSpec] = None                  # the camera as a pose: what a path uses as a keyframe
    min_level: Optional[int] = Field(default=None, ge=0, le=64)
    slices: Optional[dict[str, str]] = None          # the slice views' own parameters (layout, cursor, window, ...)
    thumb: Optional[str] = Field(default=None, max_length=60000)

    @field_validator("slices")
    @classmethod
    def _slices_small(cls, v):
        if v is not None and (len(v) > 12 or any(len(k) > 20 or len(x) > 4000 for k, x in v.items())):
            raise ValueError("slice parameters too large")
        return v

    @field_validator("thumb")
    @classmethod
    def _thumb_is_jpeg(cls, v):
        if v is not None and not v.startswith("data:image/jpeg;base64,"):
            raise ValueError("the thumbnail must be a JPEG data URL")
        return v


class BookmarkWrite(BaseModel):
    name: str
    spec: BookmarkSpec


class BookmarkRead(BaseModel):
    id: int
    name: str
    spec: BookmarkSpec
    created_at: str
    updated_at: str
    created_by_name: Optional[str] = None
