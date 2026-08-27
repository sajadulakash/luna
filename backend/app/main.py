"""FastAPI entry point for the Luna scheduling assistant."""

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
import json
from typing import Any

from fastapi import (
    Cookie,
    Depends,
    FastAPI,
    File,
    Header,
    HTTPException,
    Query,
    Response,
    UploadFile,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import select, text
from sqlalchemy.orm import Session, joinedload

from .config import get_settings
from .database import SessionLocal, get_db
from .models import Meeting, Message, User
from .schemas import (
    ChatRequest,
    CreateMeetingRequest,
    LoginRequest,
    PolicyUpdate,
    RescheduleMeetingRequest,
    TTSRequest,
)
from .scheduling import POLICIES, fake_slots, iso, parse_iso
from .security import access_token_for, verify_password
from .services.openrouter import OpenRouterClient, OpenRouterError
from .tools import TOOL_SCHEMAS, WRITE_TOOLS, execute_tool, zone


# How many times the model may call tools and be given the results before we
# stop and make it answer. A booking needs three at most (look up the person,
# check the time, book it); anything beyond this is a loop.
MAX_TOOL_ROUNDS = 5


def build_system_prompt(
    name: str, role: str, tz_name: str, roster: list[tuple[str, str]]
) -> str:
    """
    Luna's instructions for one turn.

    Rebuilt per request rather than kept as a constant, because the two things
    that make her answers correct — what time it is, and who she is talking to
    — change per request. A model with no clock cannot resolve "tomorrow at
    4 pm" into anything.

    The roster is inlined rather than exposed as a tool. Tool results are not
    persisted between turns, so a lookup tool would be re-called on every
    single message to rediscover the same four names — a whole extra
    round-trip per turn to learn something that costs a line of context.
    """
    now = datetime.now(timezone.utc).astimezone(zone(tz_name))
    stamp = now.strftime("%A, %d %B %Y at %I:%M %p").replace(" 0", " ")
    who = "the boss" if role == "BOSS" else "an employee"
    team = "\n".join(
        f"  - {member} ({'boss' if member_role == 'BOSS' else 'employee'})"
        for member, member_role in roster
    )

    return f"""You are Luna, a warm and concise scheduling assistant.

You are speaking with {name}, who is {who}. It is currently {stamp} in
{tz_name}. Resolve "today", "tomorrow" and "4 pm" against that.

The team is:
{team}

Those are the only people you can book with. If a name is not on that list,
say so and ask who they meant — never invent someone.

You have real tools that read and write the team calendar. Use them. Never
guess at what is already scheduled.

Never narrate your own reasoning, and never mention the tools, their names or
their results as machinery. The user sees only your reply: say what you found
or what you did, not how you went about it.

Never assume a date, a time or a duration the user has not actually given you.
Ask for it instead. Checking a time nobody asked for wastes their turn.

Every time you pass to a tool is local wall-clock in {tz_name}, formatted
YYYY-MM-DDTHH:MM. Never send a UTC time.

To book a meeting, collect four things: who it is with, what it is about,
when it starts, and how long it runs. Ask for whatever is missing, one short
question at a time. Then read all four back and wait for the user to confirm
in their next message. Only call book_meeting after that confirmation — it
writes to the calendar and messages the other person, so never call it to
"check" anything.

If a time is taken, say so plainly and offer the alternatives the tool
returned. Once a booking succeeds, confirm it and say the other person has
been notified.

Keep replies short and spoken-friendly — this is often read aloud. Never
claim an action a tool did not confirm."""

LAN_ORIGIN = (
    r"https?://(localhost|127\.0\.0\.1"
    r"|192\.168\.\d{1,3}\.\d{1,3}"
    r"|10\.\d{1,3}\.\d{1,3}\.\d{1,3}"
    r"|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}):5173"
)
REFRESH_COOKIE = "luna_refresh"

settings = get_settings()
openrouter = OpenRouterClient(settings)


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    await openrouter.close()


app = FastAPI(
    title="Luna API",
    version="0.2.0",
    description="FastAPI backend for Luna chat, voice, scheduling, and PostgreSQL.",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.allowed_origins),
    allow_origin_regex=LAN_ORIGIN,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def sse(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def api_error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"error": code, "message": message},
    )


def serialize_user(user: User) -> dict[str, Any]:
    return {
        "id": str(user.id),
        "team_id": str(user.team_id),
        "name": user.name,
        "role": user.role,
    }


def serialize_message(message: Message) -> dict[str, Any]:
    return {
        "id": str(message.id),
        "role": message.role.lower(),
        "content": message.content,
        "created_at": iso(message.created_at),
    }


def serialize_meeting(meeting: Meeting) -> dict[str, Any]:
    # `user` is whose calendar this sits on; `created_by` is who arranged it.
    # Rows written before created_by_id existed fall back to the old reading,
    # where the two were necessarily the same person.
    creator = meeting.created_by or meeting.user
    return {
        "id": str(meeting.id),
        "title": meeting.title,
        "notes": meeting.notes,
        "start_at": iso(meeting.start_at),
        "end_at": iso(meeting.end_at),
        "status": meeting.status,
        "booked_via": "OWNER" if creator.role == "BOSS" else "CHAT",
        "requested_by": {
            "id": str(creator.id),
            "name": creator.name,
        },
    }


def user_from_authorization(
    authorization: str | None,
    db: Session,
) -> User | None:
    if not authorization or not authorization.startswith("Bearer "):
        return None

    token = authorization.removeprefix("Bearer ").strip()
    if token.startswith("luna-"):
        try:
            user_id = int(token.rsplit("-", 1)[1])
        except (ValueError, IndexError):
            return None
        user = db.get(User, user_id)
        if user is None or token != access_token_for(user.id, user.role):
            return None
        return user

    return db.scalar(
        select(User).where(
            User.username == token,
            User.role == "EMPLOYEE",
        )
    )


def require_user(authorization: str | None, db: Session) -> User:
    user = user_from_authorization(authorization, db)
    if user is None:
        raise HTTPException(status_code=401, detail="Invalid or missing access token.")
    return user


def require_boss(authorization: str | None, db: Session) -> User:
    user = require_user(authorization, db)
    if user.role != "BOSS":
        raise HTTPException(status_code=403, detail="Boss access is required.")
    return user


def recent_messages(db: Session, user_id: int, limit: int = 40) -> list[Message]:
    rows = list(
        db.scalars(
            select(Message)
            .where(Message.user_id == user_id)
            .order_by(Message.id.desc())
            .limit(limit)
        )
    )
    rows.reverse()
    return rows


def team_meeting_statement(user: User):
    statement = (
        select(Meeting)
        .join(Meeting.user)
        .options(joinedload(Meeting.user), joinedload(Meeting.created_by))
    )
    if user.role == "BOSS":
        return statement.where(User.team_id == user.team_id)
    return statement.where(Meeting.user_id == user.id)


def meeting_for_boss(db: Session, boss: User, meeting_id: int) -> Meeting | None:
    return db.scalar(
        select(Meeting)
        .join(Meeting.user)
        .options(joinedload(Meeting.user), joinedload(Meeting.created_by))
        .where(
            Meeting.id == meeting_id,
            User.team_id == boss.team_id,
        )
    )


@app.get("/api/health")
def health(db: Session = Depends(get_db)) -> dict[str, Any]:
    db.execute(text("SELECT 1"))
    return {
        "status": "ok",
        "database_connected": True,
        "openrouter_configured": openrouter.configured,
        "chat_model": settings.openrouter_chat_model,
        "tts_model": settings.openrouter_tts_model,
    }


@app.post("/api/auth/login")
def login(
    body: LoginRequest,
    response: Response,
    db: Session = Depends(get_db),
) -> Any:
    user = db.scalar(
        select(User).where(
            User.username == body.username.strip().lower(),
            User.role == "BOSS",
        )
    )
    if user is None or not verify_password(body.password, user.password):
        return api_error(401, "invalid_credentials", "Check your username and password.")

    response.set_cookie(
        REFRESH_COOKIE,
        user.username,
        max_age=7 * 24 * 60 * 60,
        httponly=True,
        secure=settings.app_url.startswith("https://"),
        samesite="lax",
        path="/",
    )
    return {
        "access_token": access_token_for(user.id, user.role),
        "expires_in": 900,
        "user": serialize_user(user),
    }


@app.post("/api/auth/refresh")
def refresh(
    response: Response,
    luna_refresh: str | None = Cookie(default=None),
    db: Session = Depends(get_db),
) -> Any:
    user = db.scalar(
        select(User).where(
            User.username == luna_refresh,
            User.role == "BOSS",
        )
    )
    if user is None:
        return api_error(401, "invalid_session", "Sign in again.")

    response.set_cookie(
        REFRESH_COOKIE,
        user.username,
        max_age=7 * 24 * 60 * 60,
        httponly=True,
        secure=settings.app_url.startswith("https://"),
        samesite="lax",
        path="/",
    )
    return {
        "access_token": access_token_for(user.id, user.role),
        "expires_in": 900,
    }


@app.post("/api/auth/logout", status_code=204)
def logout(response: Response) -> None:
    response.delete_cookie(REFRESH_COOKIE, path="/")


@app.get("/api/me")
def me(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    return serialize_user(require_user(authorization, db))


@app.get("/api/chat/history")
def chat_history(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    user = require_user(authorization, db)
    return [serialize_message(message) for message in recent_messages(db, user.id)]


@app.post("/api/chat")
async def chat(
    body: ChatRequest,
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> StreamingResponse:
    user = require_user(authorization, db)
    # Plain values, not the ORM object: the generator below runs after this
    # function returns, by which point the request-scoped session is gone.
    user_id, user_name, user_role = user.id, user.name, user.role
    tz_name = (body.timezone or "UTC").strip() or "UTC"

    roster = [
        (member.name, member.role)
        for member in db.scalars(
            select(User).where(User.team_id == user.team_id).order_by(User.name)
        )
    ]

    db.add(Message(user_id=user_id, role="USER", content=body.message.strip()))
    db.commit()

    history = recent_messages(db, user_id, limit=20)
    convo: list[dict[str, Any]] = [
        {
            "role": "system",
            "content": build_system_prompt(user_name, user_role, tz_name, roster),
        },
        *[
            {"role": message.role.lower(), "content": message.content}
            for message in history
        ],
    ]

    async def generate():
        parts: list[str] = []
        calendar_changed = False

        try:
            for _ in range(MAX_TOOL_ROUNDS):
                spoken: list[str] = []
                tool_calls: list[dict[str, Any]] = []

                async for event in openrouter.stream_chat(convo, tools=TOOL_SCHEMAS):
                    if event["type"] == "token":
                        spoken.append(event["text"])
                        yield sse("token", {"text": event["text"]})
                    elif event["type"] == "tool_calls":
                        tool_calls = event["tool_calls"]

                # No tools asked for means this was the actual answer.
                if not tool_calls:
                    parts.extend(spoken)
                    break

                # Anything said before a tool call is preamble — "let me just
                # check…" — written before the model knew the answer. The real
                # reply comes in the round after the results land, so the
                # browser is told to drop what it has drawn so far rather than
                # running the two together. The tool line covers the gap.
                if spoken:
                    yield sse("draft_reset", {})

                # The model's own turn has to go back verbatim, tool calls and
                # all, or the tool results that follow have nothing to attach to.
                convo.append(
                    {
                        "role": "assistant",
                        "content": "".join(spoken) or None,
                        "tool_calls": tool_calls,
                    }
                )

                for call in tool_calls:
                    name = call["function"]["name"]
                    yield sse("tool_start", {"name": name})

                    try:
                        arguments = json.loads(call["function"]["arguments"] or "{}")
                    except json.JSONDecodeError:
                        arguments = {}
                    if not isinstance(arguments, dict):
                        arguments = {}

                    # Off the event loop: the tools are synchronous SQLAlchemy,
                    # and blocking here would stall every other request.
                    result = await asyncio.to_thread(
                        execute_tool, name, arguments, user_id, tz_name
                    )
                    succeeded = bool(result.get("ok", True))
                    yield sse("tool_end", {"name": name, "ok": succeeded})

                    if succeeded and name in WRITE_TOOLS:
                        calendar_changed = True

                    # A clash is a normal outcome, so the UI gets to draw it as
                    # Luna offering times rather than as an error.
                    if result.get("reason") == "conflict":
                        yield sse("conflict", {"reason": "booked"})
                    alternatives = result.get("alternatives")
                    if alternatives:
                        yield sse(
                            "slots",
                            {
                                "slots": [
                                    {
                                        "start": slot["start_utc"],
                                        "end": slot["end_utc"],
                                        "label": slot["label"],
                                    }
                                    for slot in alternatives
                                ]
                            },
                        )

                    convo.append(
                        {
                            "role": "tool",
                            "tool_call_id": call["id"],
                            "name": name,
                            "content": json.dumps(result, default=str),
                        }
                    )
        except asyncio.CancelledError:
            raise
        except OpenRouterError as exc:
            yield sse(
                "error",
                {"error": "openrouter_error", "message": str(exc)},
            )
            return
        except Exception:
            yield sse(
                "error",
                {
                    "error": "upstream_error",
                    "message": "Luna could not reach the voice model just now.",
                },
            )
            return

        reply = "".join(parts).strip()
        if not reply:
            yield sse(
                "error",
                {
                    "error": "empty_response",
                    "message": "The model returned an empty response.",
                },
            )
            return

        if calendar_changed:
            yield sse("meetings_changed", {})

        with SessionLocal.begin() as write_db:
            assistant_message = Message(
                user_id=user_id,
                role="ASSISTANT",
                content=reply,
            )
            write_db.add(assistant_message)
            write_db.flush()
            payload = serialize_message(assistant_message)

        yield sse("message", payload)
        yield sse("done", {})

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/voice/tts")
async def tts(body: TTSRequest) -> StreamingResponse:
    try:
        response = await openrouter.open_tts_stream(body.text.strip())
    except OpenRouterError as exc:
        status = exc.status_code if 400 <= exc.status_code < 600 else 502
        raise HTTPException(status_code=status, detail=str(exc)) from exc

    async def audio_bytes():
        try:
            async for chunk in response.aiter_bytes():
                if chunk:
                    yield chunk
        finally:
            await response.aclose()

    return StreamingResponse(
        audio_bytes(),
        media_type=response.headers.get("content-type", "audio/mpeg"),
        headers={"Cache-Control": "no-store"},
    )


# A held utterance, not a recording session. Anything larger than this is not
# someone asking for a meeting.
MAX_AUDIO_BYTES = 25 * 1024 * 1024


@app.post("/api/voice/stt")
async def stt(
    file: UploadFile = File(...),
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> Any:
    """
    Transcribes one recorded utterance.

    The browser records audio and posts it here rather than using its own
    speech recognition: that was Chrome-only, needed a reachable Google
    speech service, and could not share the microphone on mobile at all.
    """
    require_user(authorization, db)

    audio = await file.read()
    if not audio:
        return api_error(400, "empty_audio", "That recording was empty.")
    if len(audio) > MAX_AUDIO_BYTES:
        return api_error(413, "audio_too_large", "That recording is too long.")

    try:
        text = await openrouter.transcribe(
            audio,
            file.filename or "speech.webm",
            file.content_type or "application/octet-stream",
        )
    except OpenRouterError as exc:
        status = exc.status_code if 400 <= exc.status_code < 600 else 502
        return api_error(status, "transcription_failed", str(exc))

    return {"text": text}


@app.get("/api/meetings")
def meetings(
    from_value: str = Query(default="", alias="from"),
    to: str = "",
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    user = require_user(authorization, db)
    statement = team_meeting_statement(user).where(Meeting.status != "CANCELLED")

    if from_value and to:
        try:
            start = parse_iso(from_value)
            end = parse_iso(to)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="Invalid ISO 8601 range.") from exc
        statement = statement.where(
            Meeting.start_at < end,
            Meeting.end_at > start,
        )

    rows = db.scalars(statement.order_by(Meeting.start_at)).all()
    return [serialize_meeting(meeting) for meeting in rows]


@app.get("/api/slots")
def slots(
    duration_minutes: int = 30,
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> list[dict[str, str]]:
    require_user(authorization, db)
    return fake_slots(duration_minutes)


@app.post("/api/meetings")
def create_meeting(
    body: CreateMeetingRequest,
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> JSONResponse:
    user = require_user(authorization, db)
    try:
        start = parse_iso(body.start)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="Invalid meeting start.") from exc
    end = start + timedelta(minutes=body.duration_minutes)

    conflict = db.scalar(
        team_meeting_statement(user).where(
            Meeting.status != "CANCELLED",
            Meeting.start_at < end,
            Meeting.end_at > start,
        )
    )
    if conflict is not None:
        return JSONResponse(
            status_code=409,
            content={
                "error": "conflict",
                "reason": "booked",
                "alternatives": fake_slots(body.duration_minutes),
            },
        )

    meeting = Meeting(
        user_id=user.id,
        created_by_id=user.id,
        title=body.title,
        notes=body.notes,
        start_at=start,
        end_at=end,
        status="CONFIRMED",
    )
    db.add(meeting)
    db.commit()
    db.refresh(meeting)
    meeting.user = user
    meeting.created_by = user
    return JSONResponse(status_code=201, content=serialize_meeting(meeting))


@app.patch("/api/meetings/{meeting_id}")
def reschedule_meeting(
    meeting_id: int,
    body: RescheduleMeetingRequest,
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    boss = require_boss(authorization, db)
    meeting = meeting_for_boss(db, boss, meeting_id)
    if meeting is None:
        raise HTTPException(status_code=404, detail="Meeting not found.")

    try:
        start = parse_iso(body.start)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="Invalid meeting start.") from exc
    duration = meeting.end_at - meeting.start_at
    meeting.start_at = start
    meeting.end_at = start + duration
    db.commit()
    db.refresh(meeting)
    return serialize_meeting(meeting)


@app.delete("/api/meetings/{meeting_id}", status_code=204)
def cancel_meeting(
    meeting_id: int,
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> None:
    boss = require_boss(authorization, db)
    meeting = meeting_for_boss(db, boss, meeting_id)
    if meeting is None:
        raise HTTPException(status_code=404, detail="Meeting not found.")
    meeting.status = "CANCELLED"
    db.commit()


@app.get("/api/policies")
def policies(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict[str, int]:
    require_user(authorization, db)
    return POLICIES.copy()


@app.patch("/api/policies")
def update_policies(
    body: PolicyUpdate,
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict[str, int]:
    require_boss(authorization, db)
    POLICIES.update(body.model_dump(exclude_none=True))
    return POLICIES.copy()
