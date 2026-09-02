"""FastAPI entry point for the Luna scheduling assistant."""

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
import json
import random
from typing import Any

from fastapi import (
    Cookie,
    Depends,
    FastAPI,
    Header,
    HTTPException,
    Query,
    Response,
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
    RealtimeSessionRequest,
    RealtimeToolRequest,
    RealtimeTranscriptRequest,
    RescheduleMeetingRequest,
)
from .scheduling import POLICIES, fake_slots, iso, parse_iso
from .security import access_token_for, verify_password
from .services.openai_client import OpenAIClient, OpenAIError
from .tools import (
    TOOL_NAMES,
    TOOL_SCHEMAS,
    WRITE_TOOLS,
    execute_tool,
    realtime_tool_schemas,
    zone,
)


# How many times the model may call tools and be given the results before we
# stop and make it answer. A booking needs three at most (look up the person,
# check the time, book it); anything beyond this is a loop.
MAX_TOOL_ROUNDS = 5

# Enough to name the configured language in the prompt. An unlisted code falls
# through as itself, which still reads sensibly: "Always reply in pt-BR".
LANGUAGE_NAMES = {
    "en": "English",
    "bn": "Bengali",
    "hi": "Hindi",
    "ur": "Urdu",
    "ar": "Arabic",
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "pt": "Portuguese",
    "ja": "Japanese",
    "zh": "Chinese",
}


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
    # The boss is addressed by his title, not his name: "yes boss", never
    # "yes Rafi". Everyone else gets their first name.
    address = (
        f'Address them as "boss" — "yes boss", never "yes {name}". Their name '
        f"is still {name} and you should say so if they ask; it is only the "
        "form of address that is by title."
        if role == "BOSS"
        else f"Address them by their first name, {name.split(' ')[0]}."
    )
    team = "\n".join(
        f"  - {member} ({'boss' if member_role == 'BOSS' else 'employee'})"
        for member, member_role in roster
    )
    language = LANGUAGE_NAMES.get(
        settings.openai_voice_language.lower(), settings.openai_voice_language
    )

    return f"""You are Luna, a warm and concise scheduling assistant.

You are speaking with {name}, who is {who}. {address}

Always reply in {language}, and only in {language}. If they say something in
another language, or you are unsure what you heard, still answer in
{language} — never switch, and never mix two languages in one reply. When you
genuinely cannot make out what was said, ask them to repeat it, in {language}.

It is currently {stamp} in {tz_name}. Resolve "today", "tomorrow" and "4 pm"
against that.

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

You can also move and cancel meetings. Both rewrite the calendar and message
the other person, so both follow the same rule: work out exactly which meeting
is meant, read it back — what it is, who it is with, and when — and wait for
an explicit yes before calling the tool.

Never guess which meeting they mean. If you are not certain, list what is
scheduled and ask. Say which meeting by its start time and who it is with;
that is how the tools find it. When they ask to delay or push something back
without saying how far, ask for the new time rather than inventing one.

If a time is taken, say so plainly and offer the alternatives the tool
returned. Once a booking, move or cancellation succeeds, confirm what happened
and say the other person has been told.

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
openai_client = OpenAIClient(settings)


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    await openai_client.close()


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
        "openai_configured": openai_client.configured,
        "chat_model": settings.openai_chat_model,
        "realtime_model": settings.openai_realtime_model,
        "voice": settings.openai_voice,
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

                async for event in openai_client.stream_chat(convo, tools=TOOL_SCHEMAS):
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
        except OpenAIError as exc:
            yield sse(
                "error",
                {"error": "openai_error", "message": str(exc)},
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


# Voice mode is one speech-to-speech model, not a transcribe-think-speak
# relay. The browser holds a WebRTC connection straight to OpenAI, so audio
# never touches this server; what does come through here is everything that
# needs authority — who the caller is, what the model is allowed to do, and
# what gets written down.


def build_voice_instructions(
    name: str, role: str, tz_name: str, roster: list[tuple[str, str]]
) -> str:
    """
    The system prompt, plus what only matters when Luna is being heard.

    The same builder as the text path so the two cannot drift: she is one
    assistant with one set of rules, whether she is read or listened to.
    """
    return build_system_prompt(name, role, tz_name, roster) + """

This is a live spoken conversation. They can hear you, and they can interrupt
you — if they start talking, stop and listen.

Speak only the language named above, in every reply, no matter what you think
you heard. A noisy room can make a sentence sound like another language; it
almost never is. If a stretch of audio is unclear, treat it as unclear speech
in that language and ask them to say it again — never answer in another
language, and never try to guess at or translate what you heard.

Speak the way people speak. Say "half past four", not "16:30". Never read out
an ID, a date in numbers, or anything else that only looks right written down.
Keep turns to a sentence or two: they are waiting on you in real time, and a
paragraph out loud is far longer than it looks on a page."""


# What Luna opens with when a voice call starts.
#
# Chosen here rather than asked for in the prompt. Every call is a brand-new
# session with no memory of the last one, so "vary your greeting" is an
# instruction the model has no way to follow — asked four times in a row it
# returns the same sentence four times. Picking the line server-side is what
# actually makes it vary, and it gets the time of day right from a real clock
# instead of hoping the model reads the timestamp.
GREETINGS: dict[str, tuple[str, ...]] = {
    "morning": (
        "Good morning, {who}. What do you need?",
        "Morning, {who}. What's first today?",
        "Good morning, {who}. How can I help?",
        "Morning, {who}. What are we starting with?",
    ),
    "afternoon": (
        "Good afternoon, {who}. What can I do for you?",
        "Afternoon, {who}. What do you need?",
        "Good afternoon, {who}. How can I help?",
        "Afternoon, {who}. What's next?",
    ),
    "evening": (
        "Good evening, {who}. What can I help with?",
        "Evening, {who}. What do you need?",
        "Good evening, {who}. What's on your mind?",
    ),
    "night": (
        "Still working, {who}? What do you need?",
        "Late one, {who}. How can I help?",
        "Evening, {who}. What can I do for you?",
    ),
}


def part_of_day(hour: int) -> str:
    if 5 <= hour < 12:
        return "morning"
    if 12 <= hour < 17:
        return "afternoon"
    if 17 <= hour < 22:
        return "evening"
    return "night"


def build_greeting(name: str, role: str, tz_name: str) -> str:
    """The one-line opener for this wake, as an instruction for one response."""
    now = datetime.now(timezone.utc).astimezone(zone(tz_name))
    # The boss is addressed by title, everyone else by first name — the same
    # rule the system prompt states, applied to the line we hand over.
    who = "boss" if role == "BOSS" else name.split(" ")[0]
    line = random.choice(GREETINGS[part_of_day(now.hour)]).format(who=who)

    return (
        f'Open the conversation by saying, warmly and in one breath: "{line}" '
        "Then stop and wait for them. Say nothing else, and do not call any "
        "tools — you have not been asked for anything yet."
    )


def turn_detection_config() -> dict[str, Any] | None:
    """
    When Luna decides you have stopped talking.

    Returning None disables automatic turn-taking altogether: nothing is a
    turn until the browser says so. That is push-to-talk, and it is the only
    setting that survives other people talking nearby — a voice detector is
    built to find voices, so no threshold can be set high enough to hear you
    and not the room, only high enough to hear neither.

    Of the automatic two, server_vad gates on loudness and semantic_vad on
    whether a thought sounds finished. semantic_vad reads beautifully in a
    quiet room and falls apart in a noisy one, having nothing that filters on
    level at all.

    `interrupt_response` is barge-in for the automatic modes; under
    push-to-talk the button does that job.
    """
    if settings.openai_vad in {"push_to_talk", "manual", "none"}:
        return None

    if settings.openai_vad == "server_vad":
        return {
            "type": "server_vad",
            "threshold": settings.openai_vad_threshold,
            "prefix_padding_ms": 300,
            # Long enough that a pause mid-sentence is not taken as the end of
            # a turn — the one thing semantic_vad was better at, bought back.
            "silence_duration_ms": 900,
            "interrupt_response": True,
        }
    return {
        "type": "semantic_vad",
        "eagerness": settings.openai_vad_eagerness,
        "interrupt_response": True,
    }


def realtime_session_config(
    name: str, role: str, tz_name: str, roster: list[tuple[str, str]]
) -> dict[str, Any]:
    """
    Everything the voice session is allowed to be, fixed here at mint time.

    No audio format is named: WebRTC negotiates the codec itself. The input
    transcription is not what Luna hears — she hears the audio directly — it
    only gives us the caller's words as text for the chat history.
    """
    return {
        "type": "realtime",
        "model": settings.openai_realtime_model,
        "instructions": build_voice_instructions(name, role, tz_name, roster),
        "output_modalities": ["audio"],
        "audio": {
            "input": {
                "transcription": {
                    "model": settings.openai_stt_model,
                    # Without this the transcriber guesses, and it guesses
                    # badly on accented speech and background chatter —
                    # returning Bengali or Hindi for English that was simply
                    # noisy. Pinning the language is the fix.
                    "language": settings.openai_voice_language,
                },
                # Runs before both the transcriber and the model, so a noisy
                # room stops being heard as speech in the first place.
                "noise_reduction": {"type": settings.openai_noise_reduction},
                # None when push-to-talk: no automatic turn-taking at all.
                "turn_detection": turn_detection_config(),
            },
            "output": {"voice": settings.openai_voice},
        },
        "tools": realtime_tool_schemas(),
        "tool_choice": "auto",
    }


@app.post("/api/voice/realtime/session")
async def realtime_session(
    body: RealtimeSessionRequest,
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> Any:
    """Mints an ephemeral key for one voice conversation."""
    user = require_user(authorization, db)
    tz_name = (body.timezone or "UTC").strip() or "UTC"

    roster = [
        (member.name, member.role)
        for member in db.scalars(
            select(User).where(User.team_id == user.team_id).order_by(User.name)
        )
    ]

    try:
        minted = await openai_client.create_realtime_client_secret(
            realtime_session_config(user.name, user.role, tz_name, roster)
        )
    except OpenAIError as exc:
        status = exc.status_code if 400 <= exc.status_code < 600 else 502
        return api_error(status, "realtime_unavailable", str(exc))

    # Only the secret and its expiry. The session body echoes the whole prompt
    # back, and the browser has no use for it.
    return {
        "client_secret": minted.get("value"),
        "expires_at": minted.get("expires_at"),
        "model": settings.openai_realtime_model,
        # Spoken the moment the connection opens, so opening the line is met
        # by a voice rather than by silence.
        "greeting": build_greeting(user.name, user.role, tz_name),
    }


@app.post("/api/voice/realtime/tool")
async def realtime_tool(
    body: RealtimeToolRequest,
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """
    Runs one tool the voice model asked for.

    The browser relays the call but never carries the authority for it: the
    actor is the authenticated user of *this* request, so a session that asks
    to read someone else's calendar gets its own, exactly as on the text path.
    """
    user = require_user(authorization, db)
    tz_name = (body.timezone or "UTC").strip() or "UTC"

    if body.name not in TOOL_NAMES:
        return {
            "ok": False,
            "error": f"There is no tool called {body.name}.",
            "calendar_changed": False,
        }

    try:
        arguments = json.loads(body.arguments or "{}")
    except json.JSONDecodeError:
        arguments = {}
    if not isinstance(arguments, dict):
        arguments = {}

    # Off the event loop: execute_tool is synchronous SQLAlchemy.
    result = await asyncio.to_thread(
        execute_tool, body.name, arguments, user.id, tz_name
    )
    succeeded = bool(result.get("ok", True))

    return {
        "result": result,
        # Saves the browser having to know which tools write.
        "calendar_changed": succeeded and body.name in WRITE_TOOLS,
    }


@app.post("/api/voice/realtime/transcript", status_code=201)
def realtime_transcript(
    body: RealtimeTranscriptRequest,
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """
    Writes down a spoken turn.

    Voice and text share one conversation: something said out loud has to be
    in the history the text path reads back, or Luna forgets it the moment the
    call ends.
    """
    user = require_user(authorization, db)

    message = Message(
        user_id=user.id,
        role=body.role.upper(),
        content=body.content.strip(),
    )
    db.add(message)
    db.commit()
    db.refresh(message)
    return serialize_message(message)


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
