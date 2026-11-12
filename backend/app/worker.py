"""RQ worker: `python -m app.worker`. Runs the conversions queued by the web process (app/jobs.py).

One job at a time per worker process (a conversion already uses several threads and a lot of
RAM); run more containers for more parallelism (docker compose up --scale volume-gallery-worker=2).
"""
from redis import Redis
from rq import Queue, Worker

from .config import settings, check_secret_key
from .database import init_db, engine
from . import jobs


def main() -> None:
    if not settings.REDIS_URL:
        raise SystemExit("VG_REDIS_URL is not set: nothing to work on")
    check_secret_key()
    init_db()
    # Same housekeeping the web process does at start-up without a queue, but aware of jobs that
    # are still queued or running on other workers.
    from .main import _recover_interrupted_jobs
    _recover_interrupted_jobs()
    engine.dispose()  # RQ forks one process per job: no open SQLite connection may cross the fork
    conn = Redis.from_url(settings.REDIS_URL)
    Worker([Queue(settings.QUEUE_NAME, connection=conn)], connection=conn).work()


if __name__ == "__main__":
    main()
