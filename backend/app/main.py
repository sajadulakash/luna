"""FastAPI entry point for the Luna scheduling assistant."""

import asyncio
from contextlib import asynccontextmanager
from datetime import timedelta
import json
from typing import Any

from fastapi import Cookie, Depends, FastAPI, Header, HTTPException, Query, Response
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


SYSTEM_PROMPT = """You are Luna, Rafi's concise and warm scheduling assistant.
Reply naturally in short spoken-friendly sentences. You can discuss availability
and help plan meetings, but the model is not yet connected to calendar tools.
Never claim that you booked, moved, cancelled, or checked the live calendar.
Tell the user when an action still needs confirmation in the calendar."""

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
    return {
        "id": str(meeting.id),
        "title": meeting.title,
        "notes": meeting.notes,
        "start_at": iso(meeting.start_at),
        "end_at": iso(meeting.end_at),
        "status": meeting.status,
        "booked_via": "OWNER" if meeting.user.role == "BOSS" else "CHAT",
        "requested_by": {
            "id": str(meeting.user.id),
            "name": meeting.user.name,
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
        .options(joinedload(Meeting.user))
    )
    if user.role == "BOSS":
        return statement.where(User.team_id == user.team_id)
    return statement.where(Meeting.user_id == user.id)


def meeting_for_boss(db: Session, boss: User, meeting_id: int) -> Meeting | None:
    return db.scalar(
        select(Meeting)
        .join(Meeting.user)
        .options(joinedload(Meeting.user))
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
    user_message = Message(
        user_id=user.id,
        role="USER",
        content=body.message.strip(),
    )
    db.add(user_message)
    db.commit()

    history = recent_messages(db, user.id, limit=20)
    upstream_messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        *[
            {"role": message.role.lower(), "content": message.content}
            for message in history
        ],
    ]

    async def generate():
        parts: list[str] = []
        try:
            async for token in openrouter.stream_chat(upstream_messages):
                parts.append(token)
                yield sse("token", {"text": token})
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

        with SessionLocal.begin() as write_db:
            assistant_message = Message(
                user_id=user.id,
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


@app.post("/api/voice/stt")
async def stt() -> JSONResponse:
    return JSONResponse(
        status_code=501,
        content={
            "error": "browser_stt_in_use",
            "message": "Voice input is currently transcribed by the browser.",
        },
    )


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
