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


# A passed-on note, not a document. Anything longer is not something Luna
# should be reading out or writing down on someone's behalf.
MAX_MESSAGE_CHARS = 1_500

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


def match_member(
    candidates: list[User], name: str | None, purpose: str
) -> tuple[User | None, str | None]:
    """
    Matches a spoken name against a list of people.

    Exact on full name or username first, then a unique partial — speech gives
    us "Rakib" for "Rakib Hasan" far more often than the whole thing. Anything
    ambiguous comes back as text for the model to ask about, because "which
    one did you mean?" is a conversational outcome rather than a failure.
    """
    needle = (name or "").strip().lower()
    if not needle:
        return None, f"No name was given. Ask who {purpose}."

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


def resolve_recipient(
    session: Session, actor: User, name: str | None
) -> tuple[User | None, str | None]:
    """
    Who a message may be passed to.

    The boss can write to anyone on the team; everyone else can only write to
    the boss. The same shape as who they can book with — but unlike booking,
    the name still has to match: an employee who says "tell Nabila" must hear
    that they cannot, not have it quietly delivered to the boss instead.
    """
    everyone = [m for m in team_members(session, actor) if m.id != actor.id]
    candidates = everyone
    if actor.role != "BOSS":
        candidates = [m for m in everyone if m.role == "BOSS"]
        if not candidates:
            return None, "This team has no boss to pass a message to."

    person, problem = match_member(candidates, name, "the message is for")
    if person is not None:
        return person, None

    # Naming a real colleague they are not allowed to write to is a different
    # thing from naming nobody, and saying "there is no Nabila" when Nabila is
    # sitting two desks away would be a lie Luna then reads out.
    blocked, _ = match_member(
        [m for m in everyone if m not in candidates], name, "the message is for"
    )
    if blocked is not None:
        allowed = ", ".join(m.name for m in candidates)
        return None, (
            f"{blocked.name} is on the team, but they can only pass messages "
            f"to {allowed}. Say so, and do not send it to anyone else."
        )

    return None, problem


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

    candidates = [m for m in team_members(session, actor) if m.id != actor.id]
    return match_member(candidates, name, "the meeting is with")


def visible_meetings(session: Session, actor: User):
    """
    The meetings this person is allowed to touch.

    The boss manages the team's calendar; everyone else manages only what sits
    on their own. Exactly the scoping `_list_meetings` uses, so nothing can be
    changed that could not be read in the first place.
    """
    statement = (
        select(Meeting)
        .join(Meeting.user)
        .options(joinedload(Meeting.user), joinedload(Meeting.created_by))
        .where(Meeting.status != "CANCELLED")
    )
    return (
        statement.where(User.team_id == actor.team_id)
        if actor.role == "BOSS"
        else statement.where(Meeting.user_id == actor.id)
    )


def resolve_meeting(
    session: Session, actor: User, args: dict, tz_name: str
) -> tuple[Meeting | None, str | None]:
    """
    Works out which meeting is meant, from however the user referred to it.

    People do not say meeting ids out loud. They say "the four o'clock with
    Rakib", or "the design review", or just "tomorrow's" — so this takes an
    id when the model has one from a previous listing, and otherwise matches
    on start time, the other person, and the title, in that order of strength.

    Like `resolve_counterpart`, an ambiguous or missing match comes back as
    text for the model to say out loud rather than as an exception: "which
    one did you mean?" is a conversational outcome, not a failure.
    """
    raw_id = args.get("meeting_id")
    if raw_id not in (None, ""):
        try:
            meeting_id = int(str(raw_id).strip())
        except (TypeError, ValueError):
            return None, "That is not a meeting I can look up."
        meeting = session.scalar(visible_meetings(session, actor).where(Meeting.id == meeting_id))
        if meeting is None:
            return None, "That meeting is not on the calendar any more."
        return meeting, None

    candidates = list(session.scalars(visible_meetings(session, actor).order_by(Meeting.start_at)))

    start_text = (args.get("start") or "").strip()
    if start_text:
        try:
            start = parse_local(start_text, tz_name)
        except ValueError:
            return None, "start must look like 2026-08-27T16:00."
        # Anything running at that moment, not just starting on it — people
        # say "the three o'clock" about a meeting that began at half past two.
        candidates = [
            m for m in candidates if m.start_at <= start < m.end_at or m.start_at == start
        ]

    person = (args.get("person") or "").strip().lower()
    if person:
        candidates = [
            m
            for m in candidates
            if person in m.user.name.lower()
            or (m.created_by is not None and person in m.created_by.name.lower())
        ]

    title = (args.get("title") or "").strip().lower()
    if title:
        narrowed = [m for m in candidates if title in m.title.lower()]
        # Only if it actually helps: a title guessed from speech should not
        # rule out the one meeting that matched the time.
        if narrowed:
            candidates = narrowed

    if not candidates:
        return None, (
            "There is no meeting matching that. Read back what is on the "
            "calendar and ask which one they meant."
        )
    if len(candidates) > 1:
        described = "; ".join(
            f"{m.title} with {m.user.name} at {format_local(m.start_at, tz_name)}"
            for m in candidates[:4]
        )
        return None, f"That matches more than one meeting: {described}. Ask which one."

    return candidates[0], None


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

# OpenAI-style function definitions, sent to the API on every chat request.
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
    {
        "type": "function",
        "function": {
            "name": "send_message",
            "description": (
                "Pass a message to someone on the team. It lands in their chat "
                "with Luna, attributed to the person who sent it. Write the "
                "message yourself: take what the user said, or what you have "
                "just been discussing, and put it in short, clear, organised "
                "words. Keep every specific they gave — the deadline, the "
                "number, the name — and add nothing they did not say. Read "
                "your version back and get an explicit yes before calling "
                "this; a sent message cannot be taken back."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "person": {
                        "type": "string",
                        "description": "Who it is for, by name as the user said it.",
                    },
                    "message": {
                        "type": "string",
                        "description": (
                            "Your rewritten message, as it should arrive. Not "
                            "the user's words verbatim, and not a summary that "
                            "drops the details."
                        ),
                    },
                },
                "required": ["person", "message"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "reschedule_meeting",
            "description": (
                "Move an existing meeting to a different time. Use this when "
                "someone wants a meeting delayed, brought forward or moved. "
                "Say which meeting by its start time and who it is with; only "
                "pass meeting_id if you read it from list_meetings. Confirm "
                "the change with the user before calling this — it rewrites "
                "the calendar and tells the other person."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "new_start": {
                        "type": "string",
                        "description": (
                            "The new local start time, YYYY-MM-DDTHH:MM, in "
                            "the user's timezone. Never a UTC time."
                        ),
                    },
                    "start": {
                        "type": "string",
                        "description": (
                            "The meeting's current local start time, "
                            "YYYY-MM-DDTHH:MM. This is how you say which "
                            "meeting to move."
                        ),
                    },
                    "person": {
                        "type": "string",
                        "description": "Who the meeting is with, to tell two apart.",
                    },
                    "title": {
                        "type": "string",
                        "description": "Part of the meeting's subject, to tell two apart.",
                    },
                    "meeting_id": {
                        "type": "string",
                        "description": "Only if you read it from list_meetings.",
                    },
                    "duration_minutes": {
                        "type": "integer",
                        "description": (
                            "Only to change the length as well. Leave it out "
                            "to keep the meeting as long as it already is."
                        ),
                    },
                },
                "required": ["new_start"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "cancel_meeting",
            "description": (
                "Cancel a meeting and tell the other person. Say which one by "
                "its start time and who it is with; only pass meeting_id if "
                "you read it from list_meetings. Always read the meeting back "
                "and get an explicit yes before calling this — it takes the "
                "meeting off the calendar and cannot be undone from here."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "start": {
                        "type": "string",
                        "description": (
                            "The meeting's local start time, "
                            "YYYY-MM-DDTHH:MM. This is how you say which one."
                        ),
                    },
                    "person": {
                        "type": "string",
                        "description": "Who the meeting is with, to tell two apart.",
                    },
                    "title": {
                        "type": "string",
                        "description": "Part of the meeting's subject, to tell two apart.",
                    },
                    "meeting_id": {
                        "type": "string",
                        "description": "Only if you read it from list_meetings.",
                    },
                },
                "required": [],
            },
        },
    },
]

TOOL_NAMES = frozenset(
    schema["function"]["name"] for schema in TOOL_SCHEMAS
)


def realtime_tool_schemas() -> list[dict[str, Any]]:
    """
    The same three tools, in the shape the realtime model expects.

    Chat completions nests the definition under "function"; the realtime API
    flattens it onto the tool itself. Same tools, same descriptions — deriving
    one from the other rather than writing them twice is what keeps voice and
    text from quietly drifting apart.
    """
    return [
        {"type": "function", **schema["function"]} for schema in TOOL_SCHEMAS
    ]


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


def _notify(session: Session, meeting: Meeting, actor: User, text: str) -> str | None:
    """
    Tells the other side what changed.

    The person to tell is whoever is not doing the telling: when the boss moves
    a meeting the employee hears about it, and when an employee moves their own
    the boss does. Returns their name, or None when there is nobody to tell.
    """
    other = meeting.created_by if meeting.user_id == actor.id else meeting.user
    if other is None or other.id == actor.id:
        return None

    session.add(
        Message(
            user_id=other.id,
            role="ASSISTANT",
            content=f"Hey {other.name.split(' ')[0]} — {text}",
        )
    )
    return other.name


def _send_message(session: Session, actor: User, args: dict, tz_name: str) -> dict:
    recipient, problem = resolve_recipient(session, actor, args.get("person"))
    if recipient is None:
        return {"ok": False, "error": problem}

    body = (args.get("message") or "").strip()
    if not body:
        return {"ok": False, "error": "There is nothing to send. Ask what to say."}
    if len(body) > MAX_MESSAGE_CHARS:
        return {
            "ok": False,
            "error": "That is too long to pass on. Ask them to shorten it.",
        }

    # Attributed, not ventriloquised. The recipient has to be able to tell
    # that this came from a person, and which one — Luna is carrying it, not
    # deciding it.
    session.add(
        Message(
            user_id=recipient.id,
            role="ASSISTANT",
            content=(
                f"Hey {recipient.name.split(' ')[0]} — {actor.name} asked me to "
                f"pass this on:\n\n{body}"
            ),
        )
    )
    session.flush()

    return {"ok": True, "sent_to": recipient.name, "message": body}


def _reschedule_meeting(
    session: Session, actor: User, args: dict, tz_name: str
) -> dict:
    meeting, problem = resolve_meeting(session, actor, args, tz_name)
    if meeting is None:
        return {"ok": False, "error": problem}

    try:
        new_start = parse_local(args["new_start"], tz_name)
    except (KeyError, ValueError):
        return {"ok": False, "error": "new_start must look like 2026-08-27T16:00."}

    # Keeps its current length unless asked otherwise.
    duration = (
        clamp_duration(args["duration_minutes"])
        if args.get("duration_minutes") is not None
        else int((meeting.end_at - meeting.start_at).total_seconds() // 60)
    )
    new_end = new_start + timedelta(minutes=duration)

    if new_start <= datetime.now(timezone.utc):
        return {
            "ok": False,
            "error": "That time is in the past. Ask for a time later than now.",
        }

    was = format_local(meeting.start_at, tz_name)

    # Excluding itself, or a meeting would always collide with where it
    # already is and nothing could ever be moved by ten minutes.
    conflicts = find_conflicts(
        session, actor.team_id, new_start, new_end, exclude_id=meeting.id
    )
    if conflicts:
        return {
            "ok": False,
            "reason": "conflict",
            "error": "That time is already taken. Offer the alternatives.",
            "conflicts": [describe_meeting(row, tz_name) for row in conflicts],
            "alternatives": suggest_slots(
                session, actor.team_id, new_start, duration, tz_name
            ),
        }

    meeting.start_at = new_start
    meeting.end_at = new_end
    session.flush()

    notified = _notify(
        session,
        meeting,
        actor,
        f'"{meeting.title}" has moved from {was} to '
        f"{format_local(new_start, tz_name)}, for {duration} minutes.",
    )
    return {
        "ok": True,
        "moved": describe_meeting(meeting, tz_name),
        "was": was,
        "notified": notified,
    }


def _cancel_meeting(session: Session, actor: User, args: dict, tz_name: str) -> dict:
    meeting, problem = resolve_meeting(session, actor, args, tz_name)
    if meeting is None:
        return {"ok": False, "error": problem}

    # Cancelled, not deleted: the row stays so the meeting can be accounted
    # for afterwards, and every read already filters CANCELLED out.
    cancelled = describe_meeting(meeting, tz_name)
    meeting.status = "CANCELLED"
    session.flush()

    notified = _notify(
        session,
        meeting,
        actor,
        f'"{meeting.title}" on {cancelled["when"]} has been cancelled.',
    )
    return {"ok": True, "cancelled": cancelled, "notified": notified}


HANDLERS = {
    "send_message": _send_message,
    "list_meetings": _list_meetings,
    "check_availability": _check_availability,
    "book_meeting": _book_meeting,
    "reschedule_meeting": _reschedule_meeting,
    "cancel_meeting": _cancel_meeting,
}

# Tools that change the calendar, so the caller knows to tell the UI to refresh.
WRITE_TOOLS = frozenset({"book_meeting", "reschedule_meeting", "cancel_meeting"})


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
