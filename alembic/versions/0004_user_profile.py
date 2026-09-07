"""Record who an employee is, beyond a display name.

Revision ID: 0004_user_profile
Revises: 0003_meeting_attendees
Create Date: 2026-09-01
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0004_user_profile"
down_revision: str | None = "0003_meeting_attendees"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # All nullable: the four seeded users predate registration and have no
    # answer for any of these. `name` stays the display name everything else
    # already reads; first and last are kept apart because the form collects
    # them apart and joining them is lossy.
    op.add_column("users", sa.Column("first_name", sa.String(length=60), nullable=True))
    op.add_column("users", sa.Column("last_name", sa.String(length=60), nullable=True))
    op.add_column("users", sa.Column("email", sa.String(length=255), nullable=True))
    op.add_column("users", sa.Column("phone", sa.String(length=40), nullable=True))
    op.add_column("users", sa.Column("department", sa.String(length=60), nullable=True))

    # Unique where present. A partial index rather than a plain constraint, so
    # the existing rows with no email do not collide with each other on NULL.
    op.create_index(
        "uq_users_email",
        "users",
        ["email"],
        unique=True,
        postgresql_where=sa.text("email IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_users_email", table_name="users")
    for column in ("department", "phone", "email", "last_name", "first_name"):
        op.drop_column("users", column)
