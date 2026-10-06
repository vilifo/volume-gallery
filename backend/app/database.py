from sqlalchemy import inspect, text
from sqlmodel import SQLModel, create_engine, Session
from .config import settings

engine = create_engine(f"sqlite:///{settings.DB_PATH}", connect_args={"check_same_thread": False})

# Columns added to existing tables after their first release. SQLModel's
# create_all() only creates missing *tables*, not missing *columns* on ones
# that already exist — a database file from an earlier version of this app
# would otherwise crash the first time these columns are read. Each entry is
# (table, column, DDL type, default SQL literal).
_COLUMN_MIGRATIONS = [
    ("volume", "status", "TEXT", "'ready'"),
    ("volume", "status_log", "TEXT", "''"),
    ("volume", "num_lod_levels", "INTEGER", "NULL"),
    ("volumeaccess", "can_download", "BOOLEAN", "0"),
    ("pointcloudaccess", "can_download", "BOOLEAN", "0"),
    ("mesh", "volume_id", "INTEGER", "NULL"),
]


def _run_column_migrations():
    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())
    if "volume" not in existing_tables:
        return
    columns_by_table = {}
    with engine.begin() as conn:
        for table, column, col_type, default_sql in _COLUMN_MIGRATIONS:
            if table not in existing_tables:
                continue  # a brand-new table from this version — create_all() handles it
            if table not in columns_by_table:
                columns_by_table[table] = {col["name"] for col in inspector.get_columns(table)}
            if column not in columns_by_table[table]:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {col_type} DEFAULT {default_sql}"))
                columns_by_table[table].add(column)


def init_db():
    _run_column_migrations()
    SQLModel.metadata.create_all(engine)

def get_session():
    with Session(engine) as session:
        yield session