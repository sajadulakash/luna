"""Minimal async OpenRouter client for chat streaming and speech synthesis."""

from collections.abc import AsyncIterator
import json
from typing import Any

import httpx

from ..config import Settings


class OpenRouterError(RuntimeError):
    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


class OpenRouterClient:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(90, connect=15))

    @property
    def configured(self) -> bool:
        return bool(self.settings.openrouter_api_key)

    def _headers(self) -> dict[str, str]:
        if not self.configured:
            raise OpenRouterError(
                "OPENROUTER_API_KEY is missing from the root .env file.", 503
            )
        return {
            "Authorization": f"Bearer {self.settings.openrouter_api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": self.settings.app_url,
            "X-Title": self.settings.app_name,
        }

    async def close(self) -> None:
        await self._client.aclose()

    async def stream_chat(
        self, messages: list[dict[str, str]]
    ) -> AsyncIterator[str]:
        payload = {
            "model": self.settings.openrouter_chat_model,
            "messages": messages,
            "stream": True,
            "temperature": 0.4,
        }

        async with self._client.stream(
            "POST",
            f"{self.settings.openrouter_base_url}/chat/completions",
            headers=self._headers(),
            json=payload,
        ) as response:
            if response.status_code >= 400:
                detail = await _error_detail(response)
                raise OpenRouterError(detail, response.status_code)

            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                raw = line[5:].strip()
                if not raw or raw == "[DONE]":
                    continue
                try:
                    packet = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                text = _delta_text(packet)
                if text:
                    yield text

    async def open_tts_stream(self, text: str) -> httpx.Response:
        request = self._client.build_request(
            "POST",
            f"{self.settings.openrouter_base_url}/audio/speech",
            headers=self._headers(),
            json={
                "model": self.settings.openrouter_tts_model,
                "input": text,
                "voice": self.settings.openrouter_voice,
                "response_format": "mp3",
            },
        )
        response = await self._client.send(request, stream=True)
        if response.status_code >= 400:
            detail = await _error_detail(response)
            await response.aclose()
            raise OpenRouterError(detail, response.status_code)
        return response


async def _error_detail(response: httpx.Response) -> str:
    try:
        body: Any = json.loads((await response.aread()).decode())
    except (json.JSONDecodeError, UnicodeDecodeError):
        return f"OpenRouter request failed ({response.status_code})."

    error = body.get("error") if isinstance(body, dict) else None
    if isinstance(error, dict) and isinstance(error.get("message"), str):
        metadata = error.get("metadata")
        if isinstance(metadata, dict) and isinstance(metadata.get("raw"), str):
            try:
                provider_body = json.loads(metadata["raw"])
                provider_error = provider_body.get("error")
                if isinstance(provider_error, dict) and isinstance(
                    provider_error.get("message"), str
                ):
                    return provider_error["message"]
            except json.JSONDecodeError:
                pass
        return error["message"]
    if isinstance(error, str):
        return error
    return f"OpenRouter request failed ({response.status_code})."


def _delta_text(packet: Any) -> str:
    if not isinstance(packet, dict):
        return ""
    choices = packet.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    choice = choices[0]
    if not isinstance(choice, dict):
        return ""
    delta = choice.get("delta")
    if not isinstance(delta, dict):
        return ""
    content = delta.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            part.get("text", "")
            for part in content
            if isinstance(part, dict) and isinstance(part.get("text"), str)
        )
    return ""

