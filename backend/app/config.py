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
    openrouter_api_key: str
    openrouter_base_url: str
    openrouter_chat_model: str
    openrouter_tts_model: str
    openrouter_voice: str
    app_url: str
    app_name: str
    allowed_origins: tuple[str, ...]


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
        openrouter_api_key=os.getenv("OPENROUTER_API_KEY", "").strip(),
        openrouter_base_url=os.getenv(
            "OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"
        ).rstrip("/"),
        openrouter_chat_model=os.getenv(
            "OPENROUTER_CHAT_MODEL", "openai/gpt-5.4-mini"
        ),
        openrouter_tts_model=os.getenv(
            "OPENROUTER_TTS_MODEL", "deepgram/aura-2"
        ),
        openrouter_voice=os.getenv("OPENROUTER_VOICE", "aura-2-thalia-en"),
        app_url=os.getenv("LUNA_APP_URL", "https://localhost:5173"),
        app_name=os.getenv("LUNA_APP_NAME", "Luna"),
        allowed_origins=origins,
    )
