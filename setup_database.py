#!/usr/bin/env python3
"""Create Luna's PostgreSQL database, run Alembic, and seed development data."""

from pathlib import Path
import subprocess
import sys


PROJECT_ROOT = Path(__file__).resolve().parent
BACKEND_ROOT = PROJECT_ROOT / "backend"
sys.path.insert(0, str(BACKEND_ROOT))

import psycopg
from psycopg import sql
from sqlalchemy.engine import make_url

from app.config import get_settings
from app.seed import seed_database


def ensure_database() -> str:
    url = make_url(get_settings().database_url)
    database_name = url.database
    if not database_name:
        raise RuntimeError("DATABASE_URL must include a database name.")

    with psycopg.connect(
        host=url.host or "127.0.0.1",
        port=url.port or 5432,
        user=url.username or "postgres",
        password=url.password or "",
        dbname="postgres",
        autocommit=True,
    ) as connection:
        exists = connection.execute(
            "SELECT 1 FROM pg_database WHERE datname = %s",
            (database_name,),
        ).fetchone()
        if exists is None:
            connection.execute(
                sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database_name))
            )
            print(f"Created PostgreSQL database: {database_name}")
        else:
            print(f"PostgreSQL database already exists: {database_name}")

    return database_name


def run_migrations() -> None:
    alembic = PROJECT_ROOT / ".venv" / "bin" / "alembic"
    if not alembic.exists():
        raise RuntimeError(
            "Root environment is missing. Install backend/requirements.txt first."
        )
    subprocess.run(
        [
            str(alembic),
            "-c",
            str(PROJECT_ROOT / "alembic.ini"),
            "upgrade",
            "head",
        ],
        cwd=PROJECT_ROOT,
        check=True,
    )


def main() -> None:
    ensure_database()
    run_migrations()
    counts = seed_database()
    print("Seeded data:", ", ".join(f"{name}={count}" for name, count in counts.items()))
    print("Boss login: rafi / value of LUNA_DUMMY_PASSWORD (default: luna123)")
    print("Employee links: /chat/rakib, /chat/nabila, /chat/tanvir")


if __name__ == "__main__":
    main()
