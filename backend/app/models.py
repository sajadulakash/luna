"""The four persistent tables used by the Luna MVP."""

from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Index,
    String,
    Table,
    Text,
    func,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


# Who is in a meeting. A meeting names a time; this names the people, and
# there can be several of them — "the review with Nabila and Tanvir" is one
# entry on the calendar, not two.
meeting_attendees = Table(
    "meeting_attendees",
    Base.metadata,
    Column(
        "meeting_id",
        ForeignKey("meetings.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "user_id",
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
        index=True,
    ),
)


class Team(Base):
    __tablename__ = "teams"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)

    users: Mapped[list["User"]] = relationship(
        back_populates="team",
        cascade="all, delete-orphan",
    )


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("role IN ('BOSS', 'EMPLOYEE')", name="ck_users_role"),
        Index(
            "uq_users_one_boss_per_team",
            "team_id",
            unique=True,
            postgresql_where=text("role = 'BOSS'"),
        ),
        # Unique where present, so the rows that have no email do not all
        # collide with one another on NULL.
        Index(
            "uq_users_email",
            "email",
            unique=True,
            postgresql_where=text("email IS NOT NULL"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    team_id: Mapped[int] = mapped_column(
        ForeignKey("teams.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    username: Mapped[str] = mapped_column(String(50), unique=True, nullable=False)
    password: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(20), nullable=False)

    # Filled in at registration. Nullable because the seeded users predate it,
    # and because an employee is usable with nothing but a name and a link.
    first_name: Mapped[str | None] = mapped_column(String(60))
    last_name: Mapped[str | None] = mapped_column(String(60))
    email: Mapped[str | None] = mapped_column(String(255))
    phone: Mapped[str | None] = mapped_column(String(40))
    department: Mapped[str | None] = mapped_column(String(60))

    team: Mapped[Team] = relationship(back_populates="users")
    messages: Mapped[list["Message"]] = relationship(
        back_populates="user",
        cascade="all, delete-orphan",
    )
    # Explicit foreign_keys: meetings points at users twice, so the join for
    # "meetings on this person's calendar" has to be named.
    meetings: Mapped[list["Meeting"]] = relationship(
        back_populates="user",
        cascade="all, delete-orphan",
        foreign_keys="Meeting.user_id",
    )


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (
        CheckConstraint(
            "role IN ('USER', 'ASSISTANT')",
            name="ck_messages_role",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    role: Mapped[str] = mapped_column(String(20), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    user: Mapped[User] = relationship(back_populates="messages")


class Meeting(Base):
    __tablename__ = "meetings"
    __table_args__ = (
        CheckConstraint(
            "status IN ('PENDING', 'CONFIRMED', 'DECLINED', 'CANCELLED')",
            name="ck_meetings_status",
        ),
        CheckConstraint("end_at > start_at", name="ck_meetings_time_range"),
        Index("ix_meetings_start_end", "start_at", "end_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    notes: Mapped[str | None] = mapped_column(Text)
    start_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    end_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # PENDING when an employee asks for it and the boss has not answered yet;
    # CONFIRMED once it is really on the calendar; DECLINED if the boss said
    # no, which is different from CANCELLED — it never was a meeting.
    status: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        server_default="CONFIRMED",
    )
    # Who arranged it, as opposed to whose calendar it lands on. Nullable
    # because meetings created before this column existed have no answer, and
    # SET NULL because deleting the booker must not delete the meeting.
    created_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    user: Mapped[User] = relationship(
        back_populates="meetings",
        foreign_keys=[user_id],
    )
    created_by: Mapped[User | None] = relationship(foreign_keys=[created_by_id])
    # Everyone in the meeting, including the primary attendee above. This is
    # what "is it on my calendar" asks; user_id survives because the team
    # scoping joins through it and because a meeting always has a first
    # attendee worth naming.
    attendees: Mapped[list[User]] = relationship(
        secondary=meeting_attendees,
        lazy="selectin",
        order_by="User.name",
    )


class Notification(Base):
    """
    Something that happened, waiting to be seen.

    Separate from Message because the two are different things: a message is
    prose in a conversation, while this has a kind, a read state, and — for a
    meeting request — two buttons that stop working the moment either is
    pressed. Putting an Approve button inside a chat bubble would mean
    answering the question of what it does when you scroll back to it a week
    later.
    """

    __tablename__ = "notifications"
    __table_args__ = (
        Index("ix_notifications_user_unread", "user_id", "read_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    kind: Mapped[str] = mapped_column(String(40), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    # SET NULL, not CASCADE: "your request was declined" outlives the row it
    # refers to.
    meeting_id: Mapped[int | None] = mapped_column(
        ForeignKey("meetings.id", ondelete="SET NULL"),
    )
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    user: Mapped[User] = relationship(foreign_keys=[user_id])
    meeting: Mapped["Meeting | None"] = relationship(foreign_keys=[meeting_id])
