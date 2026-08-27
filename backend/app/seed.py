"""Repeatable development data for Luna's four PostgreSQL tables."""

from datetime import timedelta
import os

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .database import SessionLocal
from .models import Meeting, Message, Team, User
from .scheduling import utc_now
from .security import hash_password


DUMMY_USERS = (
    ("Rafi", "rafi", "BOSS"),
    ("Rakib", "rakib", "EMPLOYEE"),
    ("Nabila", "nabila", "EMPLOYEE"),
    ("Tanvir", "tanvir", "EMPLOYEE"),
)


def _upsert_user(
    session: Session,
    team: Team,
    name: str,
    username: str,
    role: str,
    password: str,
) -> User:
    user = session.scalar(select(User).where(User.username == username))
    encoded_password = hash_password(password)
    if user is None:
        user = User(
            team=team,
            name=name,
            username=username,
            password=encoded_password,
            role=role,
        )
        session.add(user)
    else:
        user.team = team
        user.name = name
        user.password = encoded_password
        user.role = role
    session.flush()
    return user


def seed_database() -> dict[str, int]:
    dummy_password = os.getenv("LUNA_DUMMY_PASSWORD", "luna123")

    with SessionLocal.begin() as session:
        team = session.scalar(select(Team).where(Team.name == "Luna Team"))
        if team is None:
            team = Team(name="Luna Team")
            session.add(team)
            session.flush()

        users = {
            username: _upsert_user(
                session,
                team,
                name,
                username,
                role,
                dummy_password,
            )
            for name, username, role in DUMMY_USERS
        }

        sample_messages = (
            (users["rafi"], "USER", "What does the team calendar look like tomorrow?"),
            (users["rafi"], "ASSISTANT", "You have two meetings tomorrow."),
            (users["rakib"], "USER", "Can I meet Rafi tomorrow afternoon?"),
            (users["rakib"], "ASSISTANT", "I can help you find an available time."),
        )
        for user, role, content in sample_messages:
            exists = session.scalar(
                select(Message.id).where(
                    Message.user_id == user.id,
                    Message.role == role,
                    Message.content == content,
                )
            )
            if exists is None:
                session.add(Message(user=user, role=role, content=content))

        base = utc_now().replace(minute=0, second=0, microsecond=0)
        sample_meetings = (
            (
                users["rakib"],
                "Project check-in",
                "Weekly progress discussion",
                base + timedelta(days=1, hours=2),
                30,
            ),
            (
                users["nabila"],
                "Design review",
                "Review the latest Luna screens",
                base + timedelta(days=2, hours=4),
                60,
            ),
        )
        for user, title, notes, start_at, duration in sample_meetings:
            meeting = session.scalar(
                select(Meeting).where(
                    Meeting.user_id == user.id,
                    Meeting.title == title,
                )
            )
            if meeting is None:
                meeting = Meeting(user=user, title=title)
                session.add(meeting)
            meeting.notes = notes
            meeting.start_at = start_at
            meeting.end_at = start_at + timedelta(minutes=duration)
            meeting.status = "CONFIRMED"

        session.flush()
        return {
            "teams": session.scalar(select(func.count()).select_from(Team)) or 0,
            "users": session.scalar(select(func.count()).select_from(User)) or 0,
            "messages": session.scalar(select(func.count()).select_from(Message)) or 0,
            "meetings": session.scalar(select(func.count()).select_from(Meeting)) or 0,
        }


if __name__ == "__main__":
    counts = seed_database()
    print("Seed complete:", ", ".join(f"{name}={count}" for name, count in counts.items()))
