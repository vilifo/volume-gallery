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
]


def _run_column_migrations():
    inspector = inspect(engine)
    if "volume" not in inspector.get_table_names():
        return  # fresh database — create_all() below will create it with all columns
    existing_columns = {col["name"] for col in inspector.get_columns("volume")}
    with engine.begin() as conn:
        for table, column, col_type, default_sql in _COLUMN_MIGRATIONS:
            if column not in existing_columns:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {col_type} DEFAULT {default_sql}"))


def init_db():
    _run_column_migrations()
    SQLModel.metadata.create_all(engine)

def get_session():
    with Session(engine) as session:
        yield session
