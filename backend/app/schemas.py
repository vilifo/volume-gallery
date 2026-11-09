from typing import Literal, Optional, List
from pydantic import BaseModel, Field, field_validator, model_validator
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

class KeyTfPoint(BaseModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)


class KeyTfStop(BaseModel):
    pos: float = Field(ge=0, le=1)
    color: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")


class KeyTf(BaseModel):
    """The transfer function a view of a camera path carries: colour map (a built-in preset, or "custom" with
    colour stops), opacity curve, window and density. Between two views these blend."""
    preset: Literal["coolwarm", "grayscale", "grayscale-inverted", "hot", "cool", "viridis", "plasma", "seismic", "custom"]
    colorStops: Optional[List[KeyTfStop]] = Field(default=None, min_length=2, max_length=64)
    points: List[KeyTfPoint] = Field(min_length=2, max_length=64)
    windowCenter: Optional[float] = Field(default=None, ge=0, le=1)
    windowWidth: Optional[float] = Field(default=None, gt=0, le=1)
    densityScale: Optional[float] = Field(default=None, gt=0, le=100)

    @model_validator(mode="after")
    def _custom_needs_stops(self):
        if self.preset == "custom" and not self.colorStops:
            raise ValueError('the "custom" colour map needs colour stops')
        return self


class PoseSpec(BaseModel):
    """A camera pose of the 3D view: eye = target + back * distance; `up` is the camera's up vector."""
    back: List[float] = Field(min_length=3, max_length=3)
    up: List[float] = Field(min_length=3, max_length=3)
    distance: float = Field(gt=0, lt=1e9)
    target: List[float] = Field(min_length=3, max_length=3)
    name: Optional[str] = Field(default=None, max_length=80)     # where it came from, e.g. a bookmark's name
    # The clipping box of the 3D view at this pose, as fractions (0..1) of the volume along x, y, z. Both or
    # neither: a pose without a box leaves the clipping as it is.
    clipMin: Optional[List[float]] = Field(default=None, min_length=3, max_length=3)
    clipMax: Optional[List[float]] = Field(default=None, min_length=3, max_length=3)
    # The transfer function at this pose; a pose without one leaves it as it is.
    tf: Optional[KeyTf] = None
    # When this view is reached, as a fraction 0..1 of one pass of the path (all views have it, or none: then they
    # are spread evenly).
    at: Optional[float] = Field(default=None, ge=0, le=1)

    @field_validator("back", "up", "target")
    @classmethod
    def _finite(cls, v):
        if any(x != x or abs(x) > 1e9 for x in v):  # NaN or absurdly large
            raise ValueError("coordinates must be finite numbers")
        return v

    @field_validator("clipMin", "clipMax")
    @classmethod
    def _fractions(cls, v):
        if v is not None and any(not (0.0 <= x <= 1.0) for x in v):  # NaN fails this too
            raise ValueError("clipping bounds are fractions between 0 and 1")
        return v

    @model_validator(mode="after")
    def _clip_pair(self):
        if (self.clipMin is None) != (self.clipMax is None):
            raise ValueError("clipMin and clipMax go together")
        if self.clipMin is not None and any(lo > hi for lo, hi in zip(self.clipMin, self.clipMax)):
            raise ValueError("clipMin must not be above clipMax")
        return self


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
    preload: bool = True                                         # 3D: load the data of the whole path before playing (never used for slices)
    pause_on_touch: bool = True

    @model_validator(mode="after")
    def _key_times(self):
        timed = [k.at for k in self.keys if k.at is not None]
        if timed and len(timed) != len(self.keys):
            raise ValueError("either all views of a path have a time or none")
        if any(b < a for a, b in zip(timed, timed[1:])):
            raise ValueError("the views of a path must be in time order")
        return self


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


class TfColorStop(BaseModel):
    """One colour stop of a custom colour map (kiln-render patch 0007): position 0..1 and #rrggbb."""
    pos: float = Field(ge=0, le=1)
    color: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")


class BookmarkOptions(BaseModel):
    """The 3D render settings of a view, named as the viewer names them."""
    mode: Optional[Literal["dvr", "mip", "iso", "lod"]] = None
    windowCenter: Optional[float] = None
    windowWidth: Optional[float] = None
    densityScale: Optional[float] = None
    isoValue: Optional[float] = None
    tfPreset: Optional[str] = Field(default=None, max_length=40)
    tfPoints: Optional[List[TfPoint]] = Field(default=None, max_length=64)
    tfColorStops: Optional[List[TfColorStop]] = Field(default=None, max_length=64)   # the colours when tfPreset is "custom"
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


# ---------- administration: share links with statistics, and disk usage ----------

class ShareStatsRead(BaseModel):
    views_total: int
    views_24h: int
    views_7d: int
    views_30d: int
    first_viewed_at: Optional[str] = None     # from the view log, which starts when this was introduced
    last_viewed_at: Optional[str] = None
    daily: List[int]                          # views per day over the last 14 days, oldest first, today last


class RelatedAssetRead(BaseModel):
    type: str
    id: int
    title: str
    slug: str
    bytes: Optional[int] = None               # on disk


class ShareAssetRead(BaseModel):
    type: str
    id: int
    exists: bool                              # False when the asset was deleted after the link was made
    title: Optional[str] = None
    slug: Optional[str] = None
    status: Optional[str] = None
    bytes: Optional[int] = None               # on disk
    created_by_name: Optional[str] = None
    has_thumbnail: bool = False


class ShareAdminRead(BaseModel):
    id: int
    code: str
    url: str
    state: Literal["active", "expired", "revoked"]
    created_at: str
    expires_at: str
    never_expires: bool
    seconds_left: Optional[int] = None        # None for a link that never expires or has ended
    created_by_name: Optional[str] = None
    can_download: bool
    min_lod: Optional[int] = None
    view_query: str = ""
    asset: ShareAssetRead
    stats: ShareStatsRead
    related: List[RelatedAssetRead] = Field(default_factory=list)   # a volume's meshes, or a mesh's volume
    paths_count: int = 0                      # saved paths / bookmarks of the volume (what a link may open)
    bookmarks_count: int = 0
    sibling_links: int = 0                    # other share links to the same asset


class ShareAdminSummary(BaseModel):
    total: int
    active: int
    expired: int
    revoked: int
    never_expire: int
    orphaned: int                             # links whose asset no longer exists
    views_total: int
    views_24h: int
    views_7d: int
    views_30d: int
    assets_shared: int
    bytes_shared: int                         # on disk, each shared asset counted once


class ShareAdminOverview(BaseModel):
    summary: ShareAdminSummary
    shares: List[ShareAdminRead]


class DiskRead(BaseModel):
    total: int
    used: int
    free: int


class StorageEntryRead(BaseModel):
    key: str
    label: str
    bytes: int                                # on disk
    apparent_bytes: int                       # sum of the file sizes
    files: int


class AssetStorageRead(BaseModel):
    asset_type: str
    asset_id: int
    slug: str
    bytes: int
    apparent_bytes: int
    files: int
    entries: List[StorageEntryRead]
    raw_bytes: Optional[int] = None           # volumes: the full-resolution voxels without compression
    ratio: Optional[float] = None             # raw_bytes / the LOD 0 bricks
    disk: Optional[DiskRead] = None           # administrators only
    data_bytes: Optional[int] = None          # administrators only: everything the assets of this kind take


class StorageAssetRow(BaseModel):
    type: str
    id: int
    title: str
    slug: str
    status: str
    bytes: int
    files: int


class StorageLeftover(BaseModel):
    type: str
    slug: str
    bytes: int
    files: int


class StorageOverviewRead(BaseModel):
    disk: Optional[DiskRead] = None
    processing_disk: Optional[DiskRead] = None   # None when the scratch folder is on the same disk
    kind_bytes: dict[str, int]                   # volume / mesh / pointcloud
    database_bytes: int
    staging_bytes: int                           # uploads waiting to be claimed
    processing_bytes: int                        # scratch space of running conversions
    assets: List[StorageAssetRow]
    leftovers: List[StorageLeftover]             # folders in the data directory that no asset points at
    missing: List[StorageAssetRow]               # ready assets whose folder is gone
    scanned_at: str
