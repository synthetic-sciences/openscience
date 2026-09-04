"""Convert ``openscience run --format json`` events into an ATIF trajectory.

The stdout contract is frozen in ``backend/cli/src/cli/run-events.ts``: one
JSON object per line, each carrying ``type``, ``timestamp`` (ms), and
``sessionID``. ``step_start``/``step_finish`` bracket one model call; ``text``,
``reasoning``, and ``tool_use`` parts arrive in between; ``user`` echoes the
prompt before the first step; ``error`` reports a session error; ``done``
closes the run with the exit code and usage summed over every step.

This module deliberately builds plain dictionaries so it runs without Harbor;
``agent.py`` validates the result against Harbor's ``Trajectory`` model.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

SCHEMA_VERSION = "ATIF-v1.7"

Event = dict[str, Any]


def parse(text: str) -> list[Event]:
    """Parse JSON lines, skipping blank and non-JSON lines (stderr is merged in)."""
    events: list[Event] = []
    for line in text.splitlines():
        line = line.strip()
        if not line or not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            events.append(event)
    return events


def errors(events: list[Event]) -> list[str]:
    """Messages of every ``error`` event, in order."""
    messages: list[str] = []
    for event in events:
        if event.get("type") != "error":
            continue
        error = event.get("error")
        if isinstance(error, dict):
            data = error.get("data")
            message = data.get("message") if isinstance(data, dict) else None
            messages.append(str(message or error.get("name") or error))
        else:
            messages.append(str(error))
    return messages


def exit_code(events: list[Event]) -> int | None:
    """The ``done`` event's exit code, or ``None`` when the run never finished."""
    for event in reversed(events):
        if event.get("type") == "done":
            code = event.get("exitCode")
            return code if isinstance(code, int) else None
    return None


def session_id(events: list[Event]) -> str | None:
    for event in events:
        value = event.get("sessionID")
        if value:
            return str(value)
    return None


def user_text(event: Event) -> str | None:
    """The joined text parts of a ``user`` event."""
    parts = event.get("parts")
    if not isinstance(parts, list):
        return None
    texts = [
        str(part.get("text", ""))
        for part in parts
        if isinstance(part, dict) and part.get("type") == "text"
    ]
    joined = "\n".join(text for text in texts if text)
    return joined or None


def _iso(timestamp_ms: Any) -> str | None:
    if not isinstance(timestamp_ms, (int, float)):
        return None
    try:
        return datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc).isoformat()
    except (OSError, ValueError, OverflowError):
        return None


def _tool_call(part: Event) -> tuple[dict[str, Any], dict[str, Any] | None]:
    state = part.get("state") or {}
    call_id = str(part.get("callID") or part.get("id") or "")
    arguments = state.get("input", {})
    if not isinstance(arguments, dict):
        arguments = {"value": arguments} if arguments else {}
    call = {
        "tool_call_id": call_id,
        "function_name": str(part.get("tool", "")),
        "arguments": arguments,
    }
    status = state.get("status")
    content = state.get("output") if status == "completed" else state.get("error")
    if content is None:
        return call, None
    observation = {"source_call_id": call_id or None, "content": str(content)}
    if status == "error":
        observation["extra"] = {"status": "error"}
    return call, observation


def convert(
    events: list[Event],
    *,
    agent_name: str = "openscience",
    agent_version: str = "unknown",
    model_name: str | None = None,
    instruction: str | None = None,
) -> dict[str, Any] | None:
    """Group events into ATIF steps. Returns ``None`` when nothing ran."""
    if not events:
        return None

    turns: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    user_message: str | None = None
    user_timestamp: Any = None
    for event in events:
        kind = event.get("type")
        if kind == "user":
            if user_message is None:
                user_message = user_text(event)
                user_timestamp = event.get("timestamp")
            continue
        if kind == "step_start":
            current = {"parts": [], "finish": {}, "timestamp": event.get("timestamp")}
            continue
        if kind == "step_finish":
            if current is not None:
                current["finish"] = event.get("part") or {}
                turns.append(current)
                current = None
            continue
        if current is not None and kind in ("text", "reasoning", "tool_use"):
            current["parts"].append(event.get("part") or {})

    steps: list[dict[str, Any]] = []
    total_cost = 0.0
    total_prompt = 0
    total_completion = 0
    total_cached = 0
    for turn in turns:
        texts: list[str] = []
        reasoning: list[str] = []
        calls: list[dict[str, Any]] = []
        observations: list[dict[str, Any]] = []
        for part in turn["parts"]:
            kind = part.get("type")
            if kind == "text" and part.get("text"):
                texts.append(str(part["text"]))
            elif kind == "reasoning" and part.get("text"):
                reasoning.append(str(part["text"]))
            elif kind == "tool":
                call, observation = _tool_call(part)
                calls.append(call)
                if observation:
                    observations.append(observation)

        tokens = turn["finish"].get("tokens") or {}
        cache = tokens.get("cache") or {}
        cost = float(turn["finish"].get("cost") or 0)
        prompt = int(tokens.get("input") or 0) + int(cache.get("read") or 0)
        completion = int(tokens.get("output") or 0)
        cached = int(cache.get("read") or 0)
        total_cost += cost
        total_prompt += prompt
        total_completion += completion
        total_cached += cached

        step: dict[str, Any] = {
            "step_id": len(steps) + 1,
            "timestamp": _iso(turn.get("timestamp")),
            "source": "agent",
            "message": "\n".join(texts),
            "model_name": model_name,
            "llm_call_count": 1,
        }
        if reasoning:
            step["reasoning_content"] = "\n\n".join(reasoning)
        if calls:
            step["tool_calls"] = calls
        if observations:
            step["observation"] = {"results": observations}
        if prompt or completion:
            extra = {
                key: value
                for key, value in {
                    "reasoning_tokens": int(tokens.get("reasoning") or 0),
                    "cache_write_tokens": int(cache.get("write") or 0),
                }.items()
                if value
            }
            step["metrics"] = {
                "prompt_tokens": prompt,
                "completion_tokens": completion,
                "cached_tokens": cached or None,
                "cost_usd": cost or None,
                "extra": extra or None,
            }
        steps.append(step)

    if not steps:
        return None

    prompt_text = user_message or instruction
    if prompt_text:
        steps.insert(
            0,
            {
                "step_id": 1,
                "timestamp": _iso(user_timestamp),
                "source": "user",
                "message": prompt_text,
            },
        )
        for index, step in enumerate(steps, start=1):
            step["step_id"] = index

    return {
        "schema_version": SCHEMA_VERSION,
        "session_id": session_id(events) or "unknown",
        "agent": {"name": agent_name, "version": agent_version, "model_name": model_name},
        "steps": steps,
        "final_metrics": {
            "total_prompt_tokens": total_prompt or None,
            "total_completion_tokens": total_completion or None,
            "total_cached_tokens": total_cached or None,
            "total_cost_usd": total_cost or None,
            "total_steps": len(steps),
        },
    }
