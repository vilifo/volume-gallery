"""Raw-body uploads: the browser sends each big file as the body of

    PUT /api/uploads/<volume|mesh|pointcloud>?name=<file name>

and gets back an upload id, which the create request (POST /api/volumes, /api/meshes,
/api/pointclouds) then names instead of re-sending the file (tiff_upload_id,
tiff_upload_ids, mesh_upload_id, pointcloud_upload_id). The multipart form fields keep
working too, for curl and for a bare uvicorn without nginx.

Behind nginx (see nginx/nginx.conf.template) this is what makes an upload cost one disk
write: nginx authorizes the request first (GET /api/uploads/auth), writes the body to the
processing directory itself and passes only the file's path in X-Upload-File without
forwarding the body. All that is left to do here is to rename that file. Without nginx
the body arrives here and is streamed to the same place.
"""
import os
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.concurrency import run_in_threadpool

from ..deps import require_editor
from ..models import User
from .. import workdir

router = APIRouter(prefix="/api/uploads", tags=["uploads"])


@router.get("/auth", status_code=204, include_in_schema=False)
def check_upload_auth(_: User = Depends(require_editor)) -> Response:
    """nginx's auth_request target: an upload body is only accepted from someone who may
    create assets, and that is decided before nginx writes the first byte to disk."""
    return Response(status_code=204)


@router.put("/{kind}")
async def stage_upload(
    kind: Literal["volume", "mesh", "pointcloud"],
    request: Request,
    name: str = Query(..., min_length=1, max_length=255, description="Original file name"),
    editor: User = Depends(require_editor),
):
    await run_in_threadpool(workdir.sweep_staging)  # cheap, and keeps abandoned uploads from piling up
    handed = request.headers.get("x-upload-file")
    if handed:
        upload_id, size = await run_in_threadpool(workdir.stage_handed_file, kind, editor.id, name, handed)
        return {"upload_id": upload_id, "size": size}

    # No nginx in front (bare uvicorn): receive the body here, straight into the staging directory.
    staging = workdir.staging_dir(kind)
    staging.mkdir(parents=True, exist_ok=True)
    upload_id = workdir.new_upload_id(editor.id, name)
    partial = staging / f".incoming-{upload_id}"
    size = 0
    try:
        with open(partial, "wb") as out:
            async for chunk in request.stream():
                size += len(chunk)
                await run_in_threadpool(out.write, chunk)
        if size == 0:
            raise HTTPException(status_code=400, detail="The file is empty")
        os.replace(partial, staging / upload_id)
    except BaseException:
        partial.unlink(missing_ok=True)
        raise
    return {"upload_id": upload_id, "size": size}
