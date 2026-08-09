from pgvector.psycopg import register_vector
from psycopg import Connection
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from app.config import settings


def _configure(conn: Connection) -> None:
    """Sets up a new database connection so it understands vector data (used for similarity search)."""
    register_vector(conn)


pool = ConnectionPool(
    conninfo=settings.DATABASE_URL,
    min_size=2,
    max_size=10,
    kwargs={"row_factory": dict_row},
    configure=_configure,
    open=False,
)
