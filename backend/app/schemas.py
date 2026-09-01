"""Request models used by Luna's HTTP API."""

from typing import Literal

from pydantic import BaseModel, Field


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=50)
    password: str = Field(min_length=1, max_length=200)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=8_000)
    # The viewer's IANA zone, e.g. "Asia/Dhaka". Without it "4 pm" is
    # meaningless: the server stores UTC and the user is speaking wall-clock.
    timezone: str = Field(default="UTC", max_length=64)


class RealtimeSessionRequest(BaseModel):
    """Opens a voice conversation. Same timezone reasoning as ChatRequest."""

    timezone: str = Field(default="UTC", max_length=64)


class RealtimeToolRequest(BaseModel):
    """
    One tool call, relayed from the browser for execution here.

    The model asks the browser to run a tool; the browser cannot, and must not,
    touch the database. It posts the call here instead, where the actor is the
    authenticated user rather than anything the request claims to be.
    """

    name: str = Field(min_length=1, max_length=64)
    # The model emits arguments as a JSON string, forwarded verbatim so a
    # malformed one fails the same way it does on the text path.
    arguments: str = Field(default="{}", max_length=8_000)
    timezone: str = Field(default="UTC", max_length=64)


class RealtimeTranscriptRequest(BaseModel):
    """A finished spoken turn, persisted so voice and text share one history."""

    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=8_000)


class CreateMeetingRequest(BaseModel):
    start: str
    duration_minutes: int = Field(default=30, ge=15, le=480)
    title: str = Field(default="Meeting", min_length=1, max_length=200)
    notes: str | None = Field(default=None, max_length=4_000)


class RescheduleMeetingRequest(BaseModel):
    start: str


class PolicyUpdate(BaseModel):
    default_duration_min: int | None = Field(default=None, ge=15, le=480)
    buffer_min: int | None = Field(default=None, ge=0, le=180)
    min_notice_hours: int | None = Field(default=None, ge=0, le=720)
    max_days_ahead: int | None = Field(default=None, ge=1, le=365)
    max_meetings_per_day: int | None = Field(default=None, ge=1, le=100)
    slot_granularity_min: int | None = Field(default=None, ge=5, le=60)
