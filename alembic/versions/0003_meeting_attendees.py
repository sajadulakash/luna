"""Let a meeting have more than one attendee.

Revision ID: 0003_meeting_attendees
Revises: 0002_meeting_created_by
Create Date: 2026-09-01
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0003_meeting_attendees"
down_revision: str | None = "0002_meeting_created_by"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # meetings.user_id stays: it is the primary attendee, and the team-scoping
    # joins all hang off it. This table is who is *in* the meeting, which for
    # every row that already exists is exactly that one person.
    op.create_table(
        "meeting_attendees",
        sa.Column("meeting_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["meeting_id"], ["meetings.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("meeting_id", "user_id"),
    )
    op.create_index(
        "ix_meeting_attendees_user_id",
        "meeting_attendees",
        ["user_id"],
        unique=False,
    )

    # Backfill, so no meeting is left with nobody in it.
    op.execute(
        """
        INSERT INTO meeting_attendees (meeting_id, user_id)
        SELECT id, user_id FROM meetings
        ON CONFLICT DO NOTHING
        """
    )


def downgrade() -> None:
    op.drop_index("ix_meeting_attendees_user_id", table_name="meeting_attendees")
    op.drop_table("meeting_attendees")
