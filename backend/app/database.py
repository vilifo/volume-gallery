from sqlmodel import SQLModel, create_engine, Session
from .config import settings

engine = create_engine(f"sqlite:///{settings.DB_PATH}", connect_args={"check_same_thread": False, "timeout": 30})


# Columns added after the first release. create_all() only creates missing tables, it never
# alters existing ones, so a database made by an older version gets these added here.
_ADDED_COLUMNS = {
    table: (("folder_id", "INTEGER"), ("tags", "TEXT NOT NULL DEFAULT ''"))
    for table in ("volume", "mesh", "pointcloud")
}


def _add_missing_columns():
    with engine.begin() as conn:
        for table, columns in _ADDED_COLUMNS.items():
            existing = {row[1] for row in conn.exec_driver_sql(f"PRAGMA table_info({table})")}
            for name, ddl in columns:
                if name not in existing:
                    conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")
            conn.exec_driver_sql(f"CREATE INDEX IF NOT EXISTS ix_{table}_folder_id ON {table} (folder_id)")


def init_db():
    SQLModel.metadata.create_all(engine)
    _add_missing_columns()


def get_session():
    with Session(engine) as session:
        yield session