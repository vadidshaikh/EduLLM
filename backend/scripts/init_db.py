"""Apply backend/db/schema.sql idempotently. Safe to re-run.

Usage: python scripts/init_db.py   (run from backend/, with DATABASE_URL set)
"""
from __future__ import annotations

import sys
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.config import settings  # noqa: E402

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "db" / "schema.sql"


def main() -> None:
    """Load the database schema file and apply it to the configured database, creating any missing tables."""
    sql = SCHEMA_PATH.read_text()
    with psycopg.connect(settings.DATABASE_URL, autocommit=True) as conn:
        conn.execute(sql)
    print(f"Schema applied from {SCHEMA_PATH}")


if __name__ == "__main__":
    main()
