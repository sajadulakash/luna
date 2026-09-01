"""Minimal async OpenAI client for chat streaming, transcription and speech."""

from collections.abc import AsyncIterator
import json
from typing import Any

import httpx

from ..config import Settings


class OpenAIError(RuntimeError):
    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


class OpenAIClient:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(90, connect=15))

    @property
    def configured(self) -> bool:
        return bool(self.settings.openai_api_key)

    def _headers(self) -> dict[str, str]:
        if not self.configured:
            raise OpenAIError(
                "OPENAI_API_KEY is missing from the root .env file.", 503
            )
        headers = {
            "Authorization": f"Bearer {self.settings.openai_api_key}",
            "Content-Type": "application/json",
        }
        # Only needed for keys that belong to several organisations or
        # projects. A project-scoped key already carries both.
        if self.settings.openai_org_id:
            headers["OpenAI-Organization"] = self.settings.openai_org_id
        if self.settings.openai_project_id:
            headers["OpenAI-Project"] = self.settings.openai_project_id
        return headers

    async def close(self) -> None:
        await self._client.aclose()

    async def stream_chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """
        Streams one model turn as events.

        Yields `{"type": "token"}` as text arrives, then a single
        `{"type": "tool_calls"}` at the end if the model asked for tools.
        Tool calls cannot be forwarded as they stream: the arguments arrive as
        JSON split across arbitrarily many deltas, so they are only usable once
        the turn is complete.
        """
        payload: dict[str, Any] = {
            "model": self.settings.openai_chat_model,
            "messages": messages,
            "stream": True,
            "temperature": 0.4,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"

        pending: dict[int, dict[str, Any]] = {}

        async with self._client.stream(
            "POST",
            f"{self.settings.openai_base_url}/chat/completions",
            headers=self._headers(),
            json=payload,
        ) as response:
            if response.status_code >= 400:
                detail = await _error_detail(response)
                raise OpenAIError(detail, response.status_code)

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

                delta = _delta(packet)
                text = _delta_text(delta)
                if text:
                    yield {"type": "token", "text": text}
                _accumulate_tool_calls(delta, pending)

        if pending:
            yield {
                "type": "tool_calls",
                "tool_calls": [pending[index] for index in sorted(pending)],
            }

    async def create_realtime_client_secret(
        self, session: dict[str, object]
    ) -> dict[str, object]:
        """
        Mints a short-lived key for one voice conversation.

        The browser talks straight to OpenAI over WebRTC — that is what makes
        voice mode feel immediate, and it is why the real API key can never go
        anywhere near it. Instead the whole session is configured here, server
        side, and handed out as an ephemeral secret that expires in minutes and
        can only open the session we just described.

        So the model's instructions, its voice, and the tools it may call are
        fixed at mint time by us. A tampered-with browser can spend the
        session, but it cannot widen it.
        """
        response = await self._client.post(
            f"{self.settings.openai_base_url}/realtime/client_secrets",
            headers=self._headers(),
            json={"session": session},
        )
        if response.status_code >= 400:
            raise OpenAIError(
                await _error_detail(response), response.status_code
            )
        return response.json()


async def _error_detail(response: httpx.Response) -> str:
    """
    The human-readable half of an OpenAI error body.

    Shape is `{"error": {"message": ..., "type": ..., "code": ...}}`. Only the
    message is worth showing: the rest is either the status code again or a
    field name the caller cannot act on.
    """
    try:
        body: Any = json.loads((await response.aread()).decode())
    except (json.JSONDecodeError, UnicodeDecodeError):
        return f"The OpenAI request failed ({response.status_code})."

    error = body.get("error") if isinstance(body, dict) else None
    if isinstance(error, dict) and isinstance(error.get("message"), str):
        return error["message"]
    if isinstance(error, str):
        return error
    return f"The OpenAI request failed ({response.status_code})."


def _delta(packet: Any) -> dict[str, Any]:
    """The first choice's delta object, or an empty one."""
    if not isinstance(packet, dict):
        return {}
    choices = packet.get("choices")
    if not isinstance(choices, list) or not choices:
        return {}
    choice = choices[0]
    if not isinstance(choice, dict):
        return {}
    delta = choice.get("delta")
    return delta if isinstance(delta, dict) else {}


def _accumulate_tool_calls(
    delta: dict[str, Any], pending: dict[int, dict[str, Any]]
) -> None:
    """
    Folds one delta's tool-call fragments into the calls being assembled.

    Keyed by `index` rather than by position: a single turn can request
    several tools at once, and their fragments interleave. The name arrives
    once, the id arrives once, and `arguments` arrives as a JSON string in
    pieces that have to be concatenated in order.
    """
    calls = delta.get("tool_calls")
    if not isinstance(calls, list):
        return

    for call in calls:
        if not isinstance(call, dict):
            continue

        index = call.get("index")
        if not isinstance(index, int):
            index = 0

        slot = pending.setdefault(
            index,
            {"id": "", "type": "function", "function": {"name": "", "arguments": ""}},
        )

        if isinstance(call.get("id"), str) and call["id"]:
            slot["id"] = call["id"]

        function = call.get("function")
        if not isinstance(function, dict):
            continue
        if isinstance(function.get("name"), str) and function["name"]:
            slot["function"]["name"] = function["name"]
        if isinstance(function.get("arguments"), str):
            slot["function"]["arguments"] += function["arguments"]


def _delta_text(delta: dict[str, Any]) -> str:
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
