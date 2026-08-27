"""The calendar tools Luna can call, and the code that runs them.

Everything the model is allowed to do to the database lives here. `main.py`
streams tokens and dispatches; it never touches a meeting itself.

Two rules shape this file:

* The model never sees or supplies a user id. It works in names, and this
  module resolves them against the actor's own team — so no prompt can reach
  another team's calendar, whatever it asks for.
* Times cross the boundary as *local* wall-clock strings in the caller's
  timezone, because that is how people say them ("4 pm"). They are converted
  to UTC here, at the edge, and stored as UTC like everything else.
"""

from datetime import datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from .database import SessionLocal
from .models import Meeting, Message, User


MIN_DURATION_MIN = 15
MAX_DURATION_MIN = 480
DEFAULT_DURATION_MIN = 30

# Slots are only ever suggested inside these local hours.
WORKDAY_START = time(9, 0)
WORKDAY_END = time(18, 0)
SLOT_STEP_MIN = 15
SUGGEST_HORIZON_DAYS = 14


# --- Time helpers -----------------------------------------------------------


def zone(name: str) -> ZoneInfo:
    """The caller's timezone, falling back to UTC rather than failing a turn."""
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def parse_local(value: str, tz_name: str) -> datetime:
    """Reads a wall-clock string from the model and returns an aware UTC time."""
    cleaned = value.strip().replace("Z", "+00:00")
    parsed = datetime.fromisoformat(cleaned)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=zone(tz_name))
    return parsed.astimezone(timezone.utc)


def format_local(value: datetime, tz_name: str) -> str:
    """"Thursday, 27 August at 4:00 PM" — for humans, in their own zone."""
    local = value.astimezone(zone(tz_name))
    return f"{local.strftime('%A, %d %B')} at {local.strftime('%I:%M %p').lstrip('0')}"


def iso_local(value: datetime, tz_name: str) -> str:
    return value.astimezone(zone(tz_name)).strftime("%Y-%m-%dT%H:%M")


# --- Lookups ----------------------------------------------------------------


def team_members(session: Session, actor: User) -> list[User]:
    return list(
        session.scalars(
            select(User).where(User.team_id == actor.team_id).order_by(User.name)
        )
    )


def team_boss(session: Session, actor: User) -> User | None:
    return session.scalar(
        select(User).where(User.team_id == actor.team_id, User.role == "BOSS")
    )


def resolve_counterpart(
    session: Session, actor: User, name: str | None
) -> tuple[User | None, str | None]:
    """
    Works out who a meeting is with, from a name the model supplied.

    An employee only ever meets the boss, so their side needs no matching. For
    the boss, the name is matched against their own team and nowhere else.
    Returns (person, error) — the error is text meant for the model to read
    back to the user, not an exception, because "who did you mean?" is a
    conversational outcome rather than a failure.
    """
    if actor.role == "EMPLOYEE":
        boss = team_boss(session, actor)
        if boss is None:
            return None, "This team has no boss to meet with."
        return boss, None

    needle = (name or "").strip().lower()
    if not needle:
        return None, "No name was given. Ask who the meeting is with."

    candidates = [
        member
        for member in team_members(session, actor)
        if member.id != actor.id
    ]

    exact = [
        member
        for member in candidates
        if member.username.lower() == needle or member.name.lower() == needle
    ]
    if len(exact) == 1:
        return exact[0], None

    partial = [
        member
        for member in candidates
        if needle in member.name.lower() or needle in member.username.lower()
    ]
    if len(partial) == 1:
        return partial[0], None
    if len(partial) > 1:
        names = ", ".join(member.name for member in partial)
        return None, f"That matches more than one person: {names}. Ask which one."

    known = ", ".join(member.name for member in candidates) or "nobody"
    return None, f"There is no '{name}' on this team. The team is: {known}."


# --- Availability -----------------------------------------------------------


def find_conflicts(
    session: Session,
    team_id: int,
    start: datetime,
    end: datetime,
    exclude_id: int | None = None,
) -> list[Meeting]:
    """
    Overlapping meetings anywhere in the team.

    Team-wide rather than per-person on purpose: every meeting here has the
    boss on one side of it, so two at once is a double-booking of the boss even
    when the employees differ.
    """
    statement = (
        select(Meeting)
        .join(Meeting.user)
        .options(joinedload(Meeting.user), joinedload(Meeting.created_by))
        .where(
            User.team_id == team_id,
            Meeting.status != "CANCELLED",
            Meeting.start_at < end,
            Meeting.end_at > start,
        )
        .order_by(Meeting.start_at)
    )
    if exclude_id is not None:
        statement = statement.where(Meeting.id != exclude_id)
    return list(session.scalars(statement))


def suggest_slots(
    session: Session,
    team_id: int,
    after: datetime,
    duration_minutes: int,
    tz_name: str,
    limit: int = 3,
) -> list[dict[str, str]]:
    """The next few genuinely free slots inside working hours."""
    tz = zone(tz_name)
    cursor = after.astimezone(tz)

    # Round up onto the slot grid so suggestions land on clean times.
    remainder = cursor.minute % SLOT_STEP_MIN
    if remainder or cursor.second or cursor.microsecond:
        cursor += timedelta(minutes=SLOT_STEP_MIN - remainder)
    cursor = cursor.replace(second=0, microsecond=0)

    horizon = cursor + timedelta(days=SUGGEST_HORIZON_DAYS)
    found: list[dict[str, str]] = []

    while cursor < horizon and len(found) < limit:
        if cursor.time() < WORKDAY_START:
            cursor = cursor.replace(
                hour=WORKDAY_START.hour, minute=WORKDAY_START.minute
            )
            continue

        end_local = cursor + timedelta(minutes=duration_minutes)
        if end_local.time() > WORKDAY_END or end_local.date() != cursor.date():
            cursor = (cursor + timedelta(days=1)).replace(
                hour=WORKDAY_START.hour, minute=WORKDAY_START.minute
            )
            continue

        start_utc = cursor.astimezone(timezone.utc)
        end_utc = end_local.astimezone(timezone.utc)

        if not find_conflicts(session, team_id, start_utc, end_utc):
            found.append(
                {
                    # Local for the model to read back and reuse verbatim,
                    # UTC for the slot cards the browser renders.
                    "start": iso_local(start_utc, tz_name),
                    "start_utc": start_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "end_utc": end_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "label": format_local(start_utc, tz_name),
                }
            )
            cursor = end_local
        else:
            cursor += timedelta(minutes=SLOT_STEP_MIN)

    return found


def clamp_duration(value: Any) -> int:
    try:
        minutes = int(value)
    except (TypeError, ValueError):
        return DEFAULT_DURATION_MIN
    return max(MIN_DURATION_MIN, min(MAX_DURATION_MIN, minutes))


# --- Tool schemas -----------------------------------------------------------

# OpenAI-style function definitions, sent to OpenRouter on every chat request.
# The descriptions are load-bearing: they are the only instructions the model
# gets about how to use these, so they say what each tool is *for* rather than
# restating the parameter names.
TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "list_meetings",
            "description": (
                "Read meetings already on the calendar. Use this to answer any "
                "question about what is scheduled. Defaults to the next seven "
                "days when no range is given."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "from_date": {
                        "type": "string",
                        "description": "Local start date, YYYY-MM-DD.",
                    },
                    "to_date": {
                        "type": "string",
                        "description": "Local end date, YYYY-MM-DD.",
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "check_availability",
            "description": (
                "Check whether one specific time is free before offering it. "
                "Returns what clashes, and the nearest free alternatives when "
                "it is taken."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "start": {
                        "type": "string",
                        "description": (
                            "Local start time, YYYY-MM-DDTHH:MM, in the "
                            "user's timezone. Never a UTC time."
                        ),
                    },
                    "duration_minutes": {
                        "type": "integer",
                        "description": "15 to 480. Defaults to 30.",
                    },
                },
                "required": ["start"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "book_meeting",
            "description": (
                "Book a meeting and notify the other person. Only call this "
                "after the user has explicitly confirmed the person, subject, "
                "date, time and duration you read back to them. This writes to "
                "the calendar and sends a message — it is not reversible from "
                "here, so never call it speculatively."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "person": {
                        "type": "string",
                        "description": (
                            "Who the meeting is with, by name as the user said "
                            "it. Ignored when an employee books, since their "
                            "meetings are always with the boss."
                        ),
                    },
                    "title": {
                        "type": "string",
                        "description": "Short subject line, e.g. 'Market Intelligence update'.",
                    },
                    "start": {
                        "type": "string",
                        "description": "Local start time, YYYY-MM-DDTHH:MM.",
                    },
                    "duration_minutes": {
                        "type": "integer",
                        "description": "15 to 480. Defaults to 30.",
                    },
                    "notes": {
                        "type": "string",
                        "description": "Optional detail to include in the invitation.",
                    },
                },
                "required": ["title", "start"],
            },
        },
    },
]

TOOL_NAMES = frozenset(
    schema["function"]["name"] for schema in TOOL_SCHEMAS
)


# --- Execution --------------------------------------------------------------


def describe_meeting(meeting: Meeting, tz_name: str) -> dict[str, Any]:
    return {
        "id": str(meeting.id),
        "title": meeting.title,
        "with": meeting.user.name,
        "booked_by": meeting.created_by.name if meeting.created_by else None,
        "when": format_local(meeting.start_at, tz_name),
        "start": iso_local(meeting.start_at, tz_name),
        "duration_minutes": int(
            (meeting.end_at - meeting.start_at).total_seconds() // 60
        ),
        "notes": meeting.notes,
    }


def _list_meetings(
    session: Session, actor: User, args: dict, tz_name: str
) -> dict:
    tz = zone(tz_name)
    now_local = datetime.now(timezone.utc).astimezone(tz)

    try:
        start_local = (
            datetime.fromisoformat(args["from_date"]).replace(tzinfo=tz)
            if args.get("from_date")
            else now_local.replace(hour=0, minute=0, second=0, microsecond=0)
        )
        end_local = (
            datetime.fromisoformat(args["to_date"]).replace(
                hour=23, minute=59, tzinfo=tz
            )
            if args.get("to_date")
            else start_local + timedelta(days=7)
        )
    except ValueError:
        return {"ok": False, "error": "Dates must be YYYY-MM-DD."}

    statement = (
        select(Meeting)
        .join(Meeting.user)
        .options(joinedload(Meeting.user), joinedload(Meeting.created_by))
        .where(
            Meeting.status != "CANCELLED",
            Meeting.start_at < end_local.astimezone(timezone.utc),
            Meeting.end_at > start_local.astimezone(timezone.utc),
        )
        .order_by(Meeting.start_at)
    )
    # The boss sees the team's calendar; everyone else sees their own.
    statement = (
        statement.where(User.team_id == actor.team_id)
        if actor.role == "BOSS"
        else statement.where(Meeting.user_id == actor.id)
    )

    rows = list(session.scalars(statement))
    return {
        "ok": True,
        "count": len(rows),
        "meetings": [describe_meeting(row, tz_name) for row in rows],
    }


def _check_availability(
    session: Session, actor: User, args: dict, tz_name: str
) -> dict:
    try:
        start = parse_local(args["start"], tz_name)
    except (KeyError, ValueError):
        return {"ok": False, "error": "start must look like 2026-08-27T16:00."}

    duration = clamp_duration(args.get("duration_minutes"))
    end = start + timedelta(minutes=duration)

    conflicts = find_conflicts(session, actor.team_id, start, end)
    if not conflicts:
        return {
            "ok": True,
            "available": True,
            "when": format_local(start, tz_name),
            "duration_minutes": duration,
        }

    return {
        "ok": True,
        "available": False,
        "when": format_local(start, tz_name),
        "conflicts": [describe_meeting(row, tz_name) for row in conflicts],
        "alternatives": suggest_slots(
            session, actor.team_id, start, duration, tz_name
        ),
    }


def _book_meeting(
    session: Session, actor: User, args: dict, tz_name: str
) -> dict:
    counterpart, problem = resolve_counterpart(session, actor, args.get("person"))
    if counterpart is None:
        return {"ok": False, "error": problem}

    try:
        start = parse_local(args["start"], tz_name)
    except (KeyError, ValueError):
        return {"ok": False, "error": "start must look like 2026-08-27T16:00."}

    duration = clamp_duration(args.get("duration_minutes"))
    end = start + timedelta(minutes=duration)
    title = (args.get("title") or "Meeting").strip()[:200]
    notes = (args.get("notes") or None)

    if start <= datetime.now(timezone.utc):
        return {
            "ok": False,
            "error": "That time is in the past. Ask for a time later than now.",
        }

    conflicts = find_conflicts(session, actor.team_id, start, end)
    if conflicts:
        return {
            "ok": False,
            "reason": "conflict",
            "error": "That time is already taken. Offer the alternatives.",
            "conflicts": [describe_meeting(row, tz_name) for row in conflicts],
            "alternatives": suggest_slots(
                session, actor.team_id, start, duration, tz_name
            ),
        }

    # The calendar it lands on is the employee's either way: when the boss
    # books, that is the counterpart; when an employee books, it is their own.
    owner = counterpart if actor.role == "BOSS" else actor
    recipient = counterpart if actor.role == "BOSS" else counterpart

    meeting = Meeting(
        user_id=owner.id,
        created_by_id=actor.id,
        title=title,
        notes=notes,
        start_at=start,
        end_at=end,
        status="CONFIRMED",
    )
    session.add(meeting)
    session.flush()

    # The notification is a real message in the other person's conversation,
    # so it is waiting for them the next time they open their chat.
    detail = f" {notes}" if notes else ""
    session.add(
        Message(
            user_id=recipient.id,
            role="ASSISTANT",
            content=(
                f"Hey {recipient.name.split(' ')[0]} — you have a meeting with "
                f"{actor.name}: \"{title}\" on {format_local(start, tz_name)}, "
                f"for {duration} minutes.{detail}"
            ),
        )
    )

    meeting.user = owner
    meeting.created_by = actor
    return {
        "ok": True,
        "booked": describe_meeting(meeting, tz_name),
        "notified": recipient.name,
    }


HANDLERS = {
    "list_meetings": _list_meetings,
    "check_availability": _check_availability,
    "book_meeting": _book_meeting,
}

# Tools that change the calendar, so the caller knows to tell the UI to refresh.
WRITE_TOOLS = frozenset({"book_meeting"})


def execute_tool(
    name: str, arguments: dict[str, Any], actor_id: int, tz_name: str
) -> dict[str, Any]:
    """
    Runs one tool call in its own transaction.

    Its own session, not the request's: this runs from inside the streaming
    generator, long after the request-scoped session has been handed back.
    A handler that raises returns an error to the model rather than killing
    the stream — the model can then explain the problem instead of the
    conversation dying mid-sentence.
    """
    handler = HANDLERS.get(name)
    if handler is None:
        return {"ok": False, "error": f"There is no tool called {name}."}

    try:
        with SessionLocal.begin() as session:
            actor = session.get(User, actor_id)
            if actor is None:
                return {"ok": False, "error": "That account no longer exists."}
            return handler(session, actor, arguments, tz_name)
    except Exception as exc:  # noqa: BLE001 - reported to the model, not raised
        return {"ok": False, "error": f"That didn't work: {exc}"}
