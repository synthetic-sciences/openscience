"""Convert the root-session ``openscience run --format json`` contract to ATIF.

The raw stream remains the authoritative artifact. This converter does not
invent child trajectories or usage for unfinished model steps. Runtime cost is
an estimate from OpenScience's model catalog, not provider billing evidence.
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from typing import Any

SCHEMA_VERSION = "ATIF-v1.7"
Event = dict[str, Any]


def parse(text: str) -> list[Event]:
    """Parse JSON lines, skipping stderr noise merged into the output."""
    events: list[Event] = []
    for line in text.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict) and isinstance(event.get("type"), str):
            events.append(event)
    return events


def errors(events: list[Event]) -> list[str]:
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
    for event in reversed(events):
        if event.get("type") == "done":
            code = event.get("exitCode")
            return code if type(code) is int else None
    return None


def session_id(events: list[Event]) -> str | None:
    for event in events:
        value = event.get("sessionID")
        if isinstance(value, str) and value:
            return value
    return None


def completion_failure(events: list[Event]) -> str | None:
    """Require positive completion evidence; process exit zero alone is insufficient."""
    messages = errors(events)
    if messages:
        return "; ".join(messages[:3])
    terminals = [event for event in events if event.get("type") == "done"]
    if len(terminals) != 1 or events[-1] is not terminals[0]:
        return "expected exactly one final done event"
    terminal = terminals[0]
    if terminal.get("status") != "completed" or exit_code(events) != 0:
        return f"terminal status {terminal.get('status')!r}, exit code {exit_code(events)!r}"
    root = session_id(events)
    if not root or any(event.get("sessionID") != root for event in events):
        return "missing or inconsistent root session identity"
    current = False
    seen: set[str] = set()
    for event in events:
        part = event.get("part")
        if isinstance(part, dict):
            if part.get("sessionID", root) != root:
                return "part belongs to a different session"
            part_id = part.get("id")
            if isinstance(part_id, str):
                if part_id in seen:
                    return "duplicate event part"
                seen.add(part_id)
        if event.get("type") == "step_start":
            if current:
                return "a model step is missing its finish event"
            current = True
        elif event.get("type") == "step_finish":
            if not current:
                return "a model step is missing its start event"
            current = False
        elif event.get("type") in ("text", "reasoning", "tool_use") and not current:
            return "model output outside a model step"
    return "a model step is missing its finish event" if current else None


def user_text(event: Event) -> str | None:
    parts = event.get("parts")
    if not isinstance(parts, list):
        return None
    texts = [
        str(part.get("text", ""))
        for part in parts
        if isinstance(part, dict) and part.get("type") == "text"
    ]
    return "\n".join(text for text in texts if text) or None


def _iso(timestamp_ms: Any) -> str | None:
    if not isinstance(timestamp_ms, (int, float)):
        return None
    try:
        return datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc).isoformat()
    except (OSError, ValueError, OverflowError):
        return None


def _number(value: Any, *, integer: bool = False) -> int | float | None:
    if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
        return None
    if integer:
        return int(value) if value == int(value) else None
    return value


def _metrics(finish: Event) -> dict[str, Any]:
    tokens = finish.get("tokens")
    tokens = tokens if isinstance(tokens, dict) else {}
    cache = tokens.get("cache")
    cache = cache if isinstance(cache, dict) else {}
    uncached = _number(tokens.get("input"), integer=True)
    cached = _number(cache.get("read"), integer=True)
    written = _number(cache.get("write"), integer=True)
    prompt = (
        sum((uncached, cached, written))
        if all(v is not None for v in (uncached, cached, written))
        else None
    )
    return {
        "prompt_tokens": prompt,
        "completion_tokens": _number(tokens.get("output"), integer=True),
        "cached_tokens": cached,
        "cost_usd": _number(finish.get("cost")),
        "extra": {
            "reasoning_tokens": _number(tokens.get("reasoning"), integer=True),
            "cache_write_tokens": written,
            "cost_source": "openscience_catalog_estimate",
        },
    }


def _tool_call(
    part: Event, fallback_id: str
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    state = part.get("state")
    state = state if isinstance(state, dict) else {}
    call_id = str(part.get("callID") or part.get("id") or fallback_id)
    arguments = state.get("input", {})
    if not isinstance(arguments, dict):
        arguments = {"value": arguments}
    call = {
        "tool_call_id": call_id,
        "function_name": str(part.get("tool", "unknown")),
        "arguments": arguments,
    }
    status = state.get("status")
    content = state.get("output") if status == "completed" else state.get("error")
    if content is None:
        return call, None
    observation: dict[str, Any] = {
        "source_call_id": call_id,
        "content": content
        if isinstance(content, str)
        else json.dumps(content, ensure_ascii=False),
    }
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
    if not events:
        return None
    root = session_id(events)
    root_events = [event for event in events if event.get("sessionID") == root]
    failure = completion_failure(events)
    turns: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    user_message: str | None = None
    user_timestamp: Any = None
    seen: set[str] = set()
    for event in root_events:
        kind = event.get("type")
        part = event.get("part")
        part = part if isinstance(part, dict) else {}
        part_id = part.get("id")
        if isinstance(part_id, str):
            if part_id in seen:
                continue
            seen.add(part_id)
        if kind == "user" and user_message is None:
            user_message = user_text(event)
            user_timestamp = event.get("timestamp")
        elif kind == "step_start":
            if current is not None:
                turns.append(current)
            current = {"parts": [], "finish": None, "timestamp": event.get("timestamp")}
        elif kind == "step_finish":
            if current is None:
                current = {
                    "parts": [],
                    "finish": None,
                    "timestamp": event.get("timestamp"),
                }
            current["finish"] = part
            turns.append(current)
            current = None
        elif kind in ("text", "reasoning", "tool_use"):
            if current is None:
                current = {
                    "parts": [],
                    "finish": None,
                    "timestamp": event.get("timestamp"),
                }
            current["parts"].append(part)
    if current is not None:
        turns.append(current)

    steps: list[dict[str, Any]] = []
    prompt_text = user_message or instruction
    if prompt_text:
        steps.append(
            {
                "step_id": 1,
                "timestamp": _iso(user_timestamp),
                "source": "user",
                "message": prompt_text,
            }
        )
    delegation = False
    for turn in turns:
        texts: list[str] = []
        reasoning: list[str] = []
        calls: dict[str, dict[str, Any]] = {}
        observations: dict[str, dict[str, Any]] = {}
        for part in turn["parts"]:
            kind = part.get("type")
            if kind == "text" and part.get("text"):
                texts.append(str(part["text"]))
            elif kind == "reasoning" and part.get("text"):
                reasoning.append(str(part["text"]))
            elif kind == "tool":
                call, observation = _tool_call(
                    part, f"unidentified-{len(steps) + 1}-{len(calls) + 1}"
                )
                calls[call["tool_call_id"]] = call
                delegation |= call["function_name"] == "task"
                if observation:
                    observations[call["tool_call_id"]] = observation
        complete = turn["finish"] is not None
        step: dict[str, Any] = {
            "step_id": len(steps) + 1,
            "timestamp": _iso(turn.get("timestamp")),
            "source": "agent",
            "message": "\n".join(texts),
            "model_name": model_name,
            "llm_call_count": 1 if complete else None,
            "extra": {"step_complete": complete},
        }
        if reasoning:
            step["reasoning_content"] = "\n\n".join(reasoning)
        if calls:
            step["tool_calls"] = list(calls.values())
        if observations:
            step["observation"] = {"results": list(observations.values())}
        if complete:
            step["metrics"] = _metrics(turn["finish"])
        steps.append(step)
    if not steps:
        return None

    metrics = [_metrics(turn["finish"]) for turn in turns if turn["finish"] is not None]
    names = ("prompt_tokens", "completion_tokens", "cached_tokens", "cost_usd")
    observed = {
        name: sum(m[name] for m in metrics if m[name] is not None) for name in names
    }
    complete = failure is None and not delegation
    terminals = [event for event in root_events if event.get("type") == "done"]
    terminal_metrics = _metrics(terminals[-1]) if terminals else {}
    mismatch = [
        name
        for name in names
        if terminal_metrics.get(name) is not None
        and all(m[name] is not None for m in metrics)
        and not math.isclose(
            observed[name], terminal_metrics[name], rel_tol=1e-9, abs_tol=1e-9
        )
    ]
    complete &= not mismatch
    totals = {
        "total_" + name: observed[name]
        if complete and all(m[name] is not None for m in metrics)
        else None
        for name in names
    }
    return {
        "schema_version": SCHEMA_VERSION,
        "session_id": root or "unknown",
        "agent": {
            "name": agent_name,
            "version": agent_version,
            "model_name": model_name,
        },
        "steps": steps,
        "notes": (
            "Only root-session events are available. Interrupted steps are retained without inferred usage. "
            "Usage completeness covers recorded agent steps only, excluding unrecorded auxiliary model calls and external tool or compute charges. "
            "Cost is OpenScience's catalog estimate, not a verified invoice; a reported zero may mean missing pricing. "
            "No child trajectories are synthesized. See openscience.txt for original events."
        ),
        "extra": {
            "usage_scope": "root_session",
            "usage_components": "recorded_agent_steps",
            "excluded_usage": [
                "unrecorded_auxiliary_model_calls",
                "external_tool_and_compute_charges",
            ],
            "trace_complete": failure is None,
            "usage_complete": complete
            and all(m[name] is not None for m in metrics for name in names),
            "completion_failure": failure,
            "exit_code": exit_code(root_events),
            "delegation_observed": delegation,
            "terminal_metric_mismatches": mismatch,
            "raw_events": "openscience.txt",
        },
        "final_metrics": {
            **totals,
            "total_steps": len(steps),
            "extra": {
                "observed_root_usage": observed,
                "cost_source": "openscience_catalog_estimate",
            },
        },
    }
