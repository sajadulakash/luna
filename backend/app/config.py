"""Environment-backed configuration for the Luna API."""

from dataclasses import dataclass
from functools import lru_cache
import os
from pathlib import Path

from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(PROJECT_ROOT / ".env")


@dataclass(frozen=True)
class Settings:
    database_url: str
    openai_api_key: str
    openai_base_url: str
    openai_chat_model: str
    # The speech-to-speech model behind voice mode. It hears and speaks
    # directly — there is no separate transcription or synthesis step.
    openai_realtime_model: str
    # Still used, but only as the realtime session's *input* transcription:
    # it is what gives us the user's words in text for the chat history.
    openai_stt_model: str
    # Must be a realtime voice. The speech-only voices (nova, fable, onyx)
    # are not available to the realtime model.
    openai_voice: str
    # ISO-639-1. Pins what the transcriber is allowed to hear: left to guess,
    # it reads accented English or a noisy room as Bengali or Hindi and the
    # turn comes back as gibberish.
    openai_voice_language: str
    # near_field for a headset or a phone held close; far_field for a laptop
    # across the desk, where the room is louder relative to the voice.
    openai_noise_reduction: str
    # push_to_talk | server_vad | semantic_vad. push_to_talk disables
    # automatic turn-taking entirely and is the only one that survives other
    # people talking nearby: a voice detector finds voices, so no threshold
    # distinguishes yours from theirs. The other two gate on loudness and on
    # whether a thought sounds finished, respectively.
    openai_vad: str
    # server_vad only. The level audio must reach to count as speech at all.
    # Higher ignores more; 0.5 is the API default.
    openai_vad_threshold: float
    # semantic_vad only: low | medium | high | auto. Lower waits longer before
    # deciding you have finished, so a cough or a passing voice doesn't cut in.
    openai_vad_eagerness: str
    # Optional. Only keys spanning several organisations or projects need them.
    openai_org_id: str
    openai_project_id: str
    app_url: str
    allowed_origins: tuple[str, ...]


def _float_env(name: str, fallback: float) -> float:
    """A tuning knob someone typed by hand. A bad value falls back, loudly."""
    raw = os.getenv(name, "").strip()
    if not raw:
        return fallback
    try:
        return float(raw)
    except ValueError:
        print(f"{name}={raw!r} is not a number; using {fallback}.")
        return fallback


@lru_cache
def get_settings() -> Settings:
    database_url = os.getenv("DATABASE_URL", "").strip()
    if not database_url:
        raise RuntimeError(
            "DATABASE_URL is required. Copy .env.example to .env and configure it."
        )

    origins = tuple(
        origin.strip()
        for origin in os.getenv(
            "LUNA_ALLOWED_ORIGINS",
            "http://localhost:5173,https://localhost:5173,"
            "http://127.0.0.1:5173,https://127.0.0.1:5173",
        ).split(",")
        if origin.strip()
    )

    return Settings(
        database_url=database_url,
        openai_api_key=os.getenv("OPENAI_API_KEY", "").strip(),
        openai_base_url=os.getenv(
            "OPENAI_BASE_URL", "https://api.openai.com/v1"
        ).rstrip("/"),
        openai_chat_model=os.getenv("OPENAI_CHAT_MODEL", "gpt-5.4-mini"),
        openai_realtime_model=os.getenv(
            "OPENAI_REALTIME_MODEL", "gpt-realtime-2.1"
        ),
        openai_stt_model=os.getenv("OPENAI_STT_MODEL", "gpt-4o-transcribe"),
        openai_voice=os.getenv("OPENAI_VOICE", "marin"),
        openai_voice_language=os.getenv("OPENAI_VOICE_LANGUAGE", "en").strip(),
        openai_noise_reduction=os.getenv(
            "OPENAI_NOISE_REDUCTION", "near_field"
        ).strip(),
        openai_vad=os.getenv("OPENAI_VAD", "server_vad").strip(),
        openai_vad_threshold=_float_env("OPENAI_VAD_THRESHOLD", 0.75),
        openai_vad_eagerness=os.getenv("OPENAI_VAD_EAGERNESS", "low").strip(),
        openai_org_id=os.getenv("OPENAI_ORG_ID", "").strip(),
        openai_project_id=os.getenv("OPENAI_PROJECT_ID", "").strip(),
        app_url=os.getenv("LUNA_APP_URL", "https://localhost:5173"),
        allowed_origins=origins,
    )
