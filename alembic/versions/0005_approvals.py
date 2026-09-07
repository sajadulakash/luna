"""Meetings an employee requests wait for the boss, and notifications carry that.

Revision ID: 0005_approvals
Revises: 0004_user_profile
Create Date: 2026-09-07
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0005_approvals"
down_revision: str | None = "0004_user_profile"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # A requested meeting is not a scheduled one, and a refused request is not
    # a cancelled meeting — both need saying, so the status gains two values.
    op.drop_constraint("ck_meetings_status", "meetings", type_="check")
    op.create_check_constraint(
        "ck_meetings_status",
        "meetings",
        "status IN ('PENDING', 'CONFIRMED', 'DECLINED', 'CANCELLED')",
    )

    # Notifications are their own thing rather than more chat messages: a chat
    # message is prose, and an approval needs a subject, a state, and two
    # buttons that stop working once someone has pressed one.
    op.create_table(
        "notifications",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=40), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("meeting_id", sa.Integer(), nullable=True),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        # The notification outlives the meeting it refers to: "your request was
        # declined" still makes sense after the row it pointed at is gone.
        sa.ForeignKeyConstraint(["meeting_id"], ["meetings.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_notifications_user_unread",
        "notifications",
        ["user_id", "read_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_notifications_user_unread", table_name="notifications")
    op.drop_table("notifications")
    op.execute("UPDATE meetings SET status = 'CANCELLED' WHERE status IN ('PENDING', 'DECLINED')")
    op.drop_constraint("ck_meetings_status", "meetings", type_="check")
    op.create_check_constraint(
        "ck_meetings_status", "meetings", "status IN ('CONFIRMED', 'CANCELLED')"
    )
