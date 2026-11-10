"""Job queue for the heavy conversions (volume TIFF->sharded binary, mesh, point cloud).

With VG_REDIS_URL set, create requests put the conversion on an RQ queue and a separate worker
process (`python -m app.worker`, see docker-compose.yml) runs it. Without it, jobs run as
FastAPI background tasks inside the web process, exactly as before.

The web process and the worker must share /data and /processing, and the SQLite file.
"""
from typing import Set, Tuple

from fastapi import HTTPException
from sqlmodel import Session

from .config import settings
from .models import AssetStatus
from .utils import _now

_queue = None


def enabled() -> bool:
    return bool(settings.REDIS_URL)


def get_queue():
    global _queue
    if _queue is None:
        from redis import Redis
        from rq import Queue
        _queue = Queue(settings.QUEUE_NAME, connection=Redis.from_url(settings.REDIS_URL))
    return _queue


def job_id(kind: str, asset_id: int) -> str:
    return f"{kind}-{asset_id}"


def dispatch(background_tasks, session: Session, kind: str, asset, func, *args) -> None:
    """Runs `func(*args)` after the response (no queue) or on the worker (queue). `kind`:
    "volume" | "mesh" | "pointcloud". `func` must be importable by the worker and its
    arguments picklable; upload descriptors cannot be passed to a worker, so callers hand
    over None (see workdir.accept_upload(save_now=...))."""
    if not enabled():
        background_tasks.add_task(func, *args)
        return
    try:
        get_queue().enqueue(
            func, *args,
            job_id=job_id(kind, asset.id),
            job_timeout=settings.JOB_TIMEOUT_SECONDS or -1,
            result_ttl=0,
            failure_ttl=3600,
        )
    except Exception as exc:  # noqa: BLE001 - Redis down: don't leave the asset "processing" forever
        asset.status = AssetStatus.failed
        asset.status_log = (asset.status_log or "") + f"{_now()}  Failed: could not queue the job ({exc})\n"
        session.add(asset)
        session.commit()
        raise HTTPException(status_code=503, detail="The job queue is unavailable — try again shortly")


def live_assets() -> Set[Tuple[str, str]]:
    """(scratch kind, slug) of every asset with a queued or running job. Called by the worker at
    start-up to tell assets that are still being handled from ones whose job died."""
    from redis import Redis
    from rq.job import Job, JobStatus
    from sqlmodel import select
    from .database import engine
    from .models import Volume, Mesh, PointCloud

    queue = get_queue()
    queue.started_job_registry.cleanup()  # jobs of dead workers move to the failed registry
    conn = Redis.from_url(settings.REDIS_URL)
    live = set()
    with Session(engine) as session:
        for model, kind, scratch in ((Volume, "volume", "volumes"), (Mesh, "mesh", "meshes"),
                                     (PointCloud, "pointcloud", "pointclouds")):
            for asset in session.exec(select(model).where(model.status == AssetStatus.processing)).all():
                job = Job.fetch(job_id(kind, asset.id), connection=conn) if conn.exists(
                    Job.key_for(job_id(kind, asset.id))) else None
                if job is not None and job.get_status(refresh=True) in (
                        JobStatus.QUEUED, JobStatus.STARTED, JobStatus.DEFERRED, JobStatus.SCHEDULED):
                    live.add((scratch, asset.slug))
    return live
