"""Record who arranged a meeting, separately from whose calendar it is on.

Revision ID: 0002_meeting_created_by
Revises: 0001_initial
Create Date: 2026-08-27
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0002_meeting_created_by"
down_revision: str | None = "0001_initial"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Nullable: meetings that predate this column have no answer, and
    # inventing one would be worse than leaving it unknown.
    op.add_column(
        "meetings",
        sa.Column("created_by_id", sa.Integer(), nullable=True),
    )
    op.create_index(
        "ix_meetings_created_by_id",
        "meetings",
        ["created_by_id"],
        unique=False,
    )
    # SET NULL rather than CASCADE: removing the person who booked a meeting
    # must not remove the meeting from the attendee's calendar.
    op.create_foreign_key(
        "fk_meetings_created_by_id_users",
        "meetings",
        "users",
        ["created_by_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_meetings_created_by_id_users", "meetings", type_="foreignkey"
    )
    op.drop_index("ix_meetings_created_by_id", table_name="meetings")
    op.drop_column("meetings", "created_by_id")
