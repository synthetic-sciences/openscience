"""Convert the ``openscience run --format json`` contract to ATIF.

The raw stream remains the authoritative artifact. Root-session steps form the
main trajectory. Each delegated child session (events tagged with ``parentID``)
becomes its own ATIF document, referenced from the ``task`` call that
dispatched it, and the ``done`` roll-up supplies child usage. The converter
does not invent usage for unfinished model steps. Runtime cost is an estimate
from OpenScience's model catalog, not provider billing evidence.
"""

from __future__ import annotations

import json
import math
import re
from datetime import datetime, timezone
from typing import Any

SCHEMA_VERSION = "ATIF-v1.7"
Event = dict[str, Any]

NAMES = ("prompt_tokens", "completion_tokens", "cached_tokens", "cost_usd")
EXCLUDED_USAGE = [
    "unrecorded_auxiliary_model_calls",
    "external_tool_and_compute_charges",
]
RAW_EVENTS = "openscience.txt"
TASK_ENVELOPE = re.compile(r'<task id="([^"]+)"')
UNSAFE = re.compile(r"[^A-Za-z0-9._-]")


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


def parent_id(event: Event) -> str | None:
    """The dispatching session of a child-session event; None on root events."""
    value = event.get("parentID")
    return value if isinstance(value, str) and value else None


def session_id(events: list[Event]) -> str | None:
    """The root session: the first tagged event that no parent dispatched."""
    for event in events:
        value = event.get("sessionID")
        if isinstance(value, str) and value and parent_id(event) is None:
            return value
    return None


def child_filename(session: str) -> str:
    """Where a child session's ATIF document lives, beside ``trajectory.json``."""
    return f"trajectory-{UNSAFE.sub('_', session)}.json"


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
    if not root:
        return "missing or inconsistent root session identity"
    for event in events:
        session = event.get("sessionID")
        parent = parent_id(event)
        if parent is None:
            if session != root:
                return "missing or inconsistent root session identity"
        elif not isinstance(session, str) or session in ("", root, parent):
            return "child event without a distinct session identity"
    # Child steps interleave with the root step that dispatched them, so step
    # balance is a per-session property; part identity is global.
    open_steps: set[str] = set()
    seen: set[str] = set()
    for event in events:
        session = event["sessionID"]
        part = event.get("part")
        if isinstance(part, dict):
            if part.get("sessionID", session) != session:
                return "part belongs to a different session"
            part_id = part.get("id")
            if isinstance(part_id, str):
                if part_id in seen:
                    return "duplicate event part"
                seen.add(part_id)
        kind = event.get("type")
        if kind == "step_start":
            if session in open_steps:
                return "a model step is missing its finish event"
            open_steps.add(session)
        elif kind == "step_finish":
            if session not in open_steps:
                return "a model step is missing its start event"
            open_steps.discard(session)
        elif kind in ("text", "reasoning", "tool_use") and session not in open_steps:
            return "model output outside a model step"
    return "a model step is missing its finish event" if open_steps else None


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
    """Step metrics from anything shaped like a step-finish part: a ``done``
    event and a ``done.children`` entry carry the same ``tokens``/``cost``."""
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


def _owner(event: Event) -> Any:
    """The session an event describes. A ``question`` is tagged with the root
    session but belongs to the session that asked it."""
    if event.get("type") == "question":
        request = event.get("request")
        asked = request.get("sessionID") if isinstance(request, dict) else None
        if isinstance(asked, str) and asked:
            return asked
    return event.get("sessionID")


def _state(part: Event) -> dict[str, Any]:
    state = part.get("state")
    return state if isinstance(state, dict) else {}


def _dispatched(part: Event) -> str | None:
    """The session a ``task`` call dispatched: its result metadata, else the
    ``<task id="...">`` envelope of its output."""
    state = _state(part)
    metadata = state.get("metadata")
    if isinstance(metadata, dict):
        value = metadata.get("sessionId")
        if isinstance(value, str) and value:
            return value
    output = state.get("output")
    match = TASK_ENVELOPE.search(output) if isinstance(output, str) else None
    return match.group(1) if match else None


def _tool_call(
    part: Event, fallback_id: str
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    state = _state(part)
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


def _turns(events: list[Event]) -> tuple[str | None, Any, list[dict[str, Any]]]:
    """Group one session's events into model steps: the echoed prompt, its
    timestamp, and one turn per step (parts, finish part, answered questions)."""
    turns: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    user_message: str | None = None
    user_timestamp: Any = None
    seen: set[str] = set()

    def turn(timestamp: Any) -> dict[str, Any]:
        return {"parts": [], "finish": None, "timestamp": timestamp, "questions": []}

    for event in events:
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
            current = turn(event.get("timestamp"))
        elif kind == "step_finish":
            if current is None:
                current = turn(event.get("timestamp"))
            current["finish"] = part
            turns.append(current)
            current = None
        elif kind in ("text", "reasoning", "tool_use"):
            if current is None:
                current = turn(event.get("timestamp"))
            current["parts"].append(part)
        elif kind == "question" and current is not None:
            request = event.get("request")
            current["questions"].append(
                {
                    "id": request.get("id") if isinstance(request, dict) else None,
                    "answers": event.get("answers"),
                }
            )
    if current is not None:
        turns.append(current)
    return user_message, user_timestamp, turns


def _steps(
    turns: list[dict[str, Any]],
    *,
    prompt: str | None,
    prompt_timestamp: Any,
    model_name: str | None,
) -> tuple[list[dict[str, Any]], list[tuple[dict[str, Any], Event]], bool]:
    """ATIF steps for one session, the ``task`` dispatches found in them (the
    observation result to hang a subagent reference on, and the tool part), and
    whether any ``task`` call was observed."""
    steps: list[dict[str, Any]] = []
    dispatches: list[tuple[dict[str, Any], Event]] = []
    delegation = False
    if prompt:
        steps.append(
            {
                "step_id": 1,
                "timestamp": _iso(prompt_timestamp),
                "source": "user",
                "message": prompt,
            }
        )
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
                if observation:
                    observations[call["tool_call_id"]] = observation
                if call["function_name"] != "task":
                    continue
                delegation = True
                if _dispatched(part):
                    result = observations.setdefault(
                        call["tool_call_id"], {"source_call_id": call["tool_call_id"]}
                    )
                    dispatches.append((result, part))
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
        if turn["questions"]:
            step["extra"]["questions"] = turn["questions"]
        if reasoning:
            step["reasoning_content"] = "\n\n".join(reasoning)
        if calls:
            step["tool_calls"] = list(calls.values())
        if observations:
            step["observation"] = {"results": list(observations.values())}
        if complete:
            step["metrics"] = _metrics(turn["finish"])
        steps.append(step)
    return steps, dispatches, delegation


def convert(
    events: list[Event],
    *,
    agent_name: str = "openscience",
    agent_version: str = "unknown",
    model_name: str | None = None,
    instruction: str | None = None,
) -> dict[str, Any] | None:
    """The root session's ATIF document; ``convert_all`` also returns the
    child-session documents it references."""
    documents = convert_all(
        events,
        agent_name=agent_name,
        agent_version=agent_version,
        model_name=model_name,
        instruction=instruction,
    )
    return documents[0] if documents else None


def convert_all(
    events: list[Event],
    *,
    agent_name: str = "openscience",
    agent_version: str = "unknown",
    model_name: str | None = None,
    instruction: str | None = None,
) -> list[dict[str, Any]]:
    """ATIF documents for a run: the root session first, then every child
    session that recorded a step, in dispatch order. Child documents are meant
    to be written beside the root as ``child_filename(session)``."""
    if not events:
        return []
    root = session_id(events)
    failure = completion_failure(events)

    groups: dict[Any, list[Event]] = {}
    parents: dict[str, str] = {}

    def adopt(session: Any, parent: Any) -> None:
        if not isinstance(session, str) or not isinstance(parent, str):
            return
        if session and parent and session != parent and session not in parents:
            parents[session] = parent

    for event in events:
        groups.setdefault(_owner(event), []).append(event)
        adopt(event.get("sessionID"), parent_id(event))
    terminals = [event for event in groups.get(root, []) if event.get("type") == "done"]
    terminal = terminals[-1] if terminals else {}
    rollup = terminal.get("children")
    reported: dict[str, Event] = {}
    for child in rollup if isinstance(rollup, list) else []:
        if not isinstance(child, dict):
            continue
        session = child.get("sessionID")
        if not isinstance(session, str) or not session:
            continue
        reported[session] = child
        adopt(session, child.get("parentID"))

    sessions = {session: _turns(group) for session, group in groups.items()}
    step_metrics = {
        session: [
            _metrics(turn["finish"]) for turn in turns if turn["finish"] is not None
        ]
        for session, (_, _, turns) in sessions.items()
    }
    observed = {
        session: {
            name: sum(m[name] for m in metrics if m[name] is not None) for name in NAMES
        }
        for session, metrics in step_metrics.items()
    }
    steps_complete = all(
        turn["finish"] is not None
        for _, _, turns in sessions.values()
        for turn in turns
    ) and all(
        m[name] is not None
        for metrics in step_metrics.values()
        for m in metrics
        for name in NAMES
    )

    def mismatches(session: Any, expected: dict[str, Any]) -> list[str]:
        metrics = step_metrics.get(session, [])
        own = observed.get(session, {})
        return [
            name
            for name in NAMES
            if expected.get(name) is not None
            and all(m[name] is not None for m in metrics)
            and not math.isclose(
                own.get(name, 0), expected[name], rel_tol=1e-9, abs_tol=1e-9
            )
        ]

    def descendants(session: Any) -> list[str]:
        found: list[str] = []
        pending = [session]
        while pending:
            current = pending.pop(0)
            for child, parent in parents.items():
                if parent == current and child != session and child not in found:
                    found.append(child)
                    pending.append(child)
        return found

    def usage(child: str) -> dict[str, Any]:
        """A child's own usage: the ``done`` roll-up, else its recorded steps."""
        expected = _metrics(reported[child]) if child in reported else {}
        own = observed.get(child, {})
        return {
            name: expected[name] if expected.get(name) is not None else own.get(name)
            for name in NAMES
        }

    def reported_text(session: Any, key: str) -> str | None:
        value = reported.get(session, {}).get(key)
        return value if isinstance(value, str) and value else None

    def model(session: Any) -> str | None:
        # The root ran on the model Harbor selected; a child's model is only
        # known from the roll-up (workers may run on --worker-model).
        return model_name if session == root else reported_text(session, "model")

    terminal_mismatch = mismatches(root, _metrics(terminal)) if terminals else []
    child_mismatch: dict[str, list[str]] = {}
    for child in reported:
        if child not in groups:
            continue
        names = mismatches(child, _metrics(reported[child]))
        if names:
            child_mismatch[child] = names
    tree = descendants(root)
    complete = (
        failure is None
        and steps_complete
        and not terminal_mismatch
        and not child_mismatch
        and all(value is not None for child in tree for value in usage(child).values())
    )

    documents: dict[str, dict[str, Any]] = {}
    building: set[str] = set()

    def final_metrics(session: Any, steps: list[dict[str, Any]]) -> dict[str, Any]:
        subtree = descendants(session)
        child_usage = {child: usage(child) for child in subtree}
        own = observed.get(session) or {name: 0 for name in NAMES}
        spent = {
            name: own[name]
            + sum(
                child_usage[child][name]
                for child in subtree
                if child_usage[child][name] is not None
            )
            for name in NAMES
        }
        return {
            **{"total_" + name: spent[name] if complete else None for name in NAMES},
            "total_steps": len(steps),
            "extra": {
                (
                    "observed_root_usage"
                    if session == root
                    else "observed_session_usage"
                ): own,
                "child_usage": child_usage,
                "observed_usage": spent,
                "cost_source": "openscience_catalog_estimate",
            },
        }

    def build(
        session: Any,
        *,
        prompt: str | None,
        prompt_timestamp: Any,
        dispatch: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        building.add(session)
        turns = sessions[session][2] if session in sessions else []
        steps, dispatches, delegation = _steps(
            turns,
            prompt=prompt,
            prompt_timestamp=prompt_timestamp,
            model_name=model(session),
        )
        if not steps:
            building.discard(session)
            return None
        for result, part in dispatches:
            child = _dispatched(part)
            if child in building or child not in groups:
                continue
            state = _state(part)
            arguments = state.get("input")
            arguments = arguments if isinstance(arguments, dict) else {}
            time = state.get("time")
            document = documents.get(child) or build(
                child,
                prompt=arguments["prompt"]
                if isinstance(arguments.get("prompt"), str) and arguments["prompt"]
                else None,
                prompt_timestamp=time.get("start") if isinstance(time, dict) else None,
                dispatch={
                    "session_id": session,
                    "tool_call_id": result["source_call_id"],
                },
            )
            if document is None:
                continue
            documents.setdefault(child, document)
            reference: dict[str, Any] = {
                "session_id": child,
                "trajectory_path": child_filename(child),
            }
            details = {
                "agent": reported_text(child, "agent"),
                "model": reported_text(child, "model"),
            }
            details = {key: value for key, value in details.items() if value}
            if details:
                reference["extra"] = details
            result.setdefault("subagent_trajectory_ref", []).append(reference)
        # A child whose dispatching call was not observed still recorded steps.
        for child, parent in parents.items():
            if parent != session or child in documents or child in building:
                continue
            if child not in groups:
                continue
            document = build(child, prompt=None, prompt_timestamp=None, dispatch=None)
            if document is not None:
                documents[child] = document
        building.discard(session)
        subtree = descendants(session)
        files = {
            child: child_filename(child) for child in subtree if child in documents
        }
        extra: dict[str, Any] = {
            "usage_scope": (
                "child_session"
                if session != root
                else "root_and_child_sessions"
                if subtree
                else "root_session"
            ),
            "usage_components": "recorded_agent_steps",
            "excluded_usage": EXCLUDED_USAGE,
            "trace_complete": failure is None,
            "usage_complete": complete,
            "completion_failure": failure,
            "delegation_observed": delegation or bool(subtree),
            "child_sessions": subtree,
            "child_trajectories": files,
            "terminal_metric_mismatches": (
                terminal_mismatch
                if session == root
                else child_mismatch.get(session, [])
            ),
            "child_metric_mismatches": {
                child: child_mismatch[child]
                for child in subtree
                if child in child_mismatch
            },
            "raw_events": RAW_EVENTS,
        }
        if session == root:
            extra["exit_code"] = exit_code(events)
            notes = (
                "Root-session steps form this trajectory. "
                + (
                    "Delegated child sessions are separate ATIF documents beside this file "
                    "(extra.child_trajectories), referenced from the task call that dispatched them; "
                    "their usage comes from the done event's children roll-up, cross-checked against "
                    "their recorded steps, and is included in final_metrics totals. "
                    if subtree
                    else "No child sessions were observed. "
                )
                + "Interrupted steps are retained without inferred usage. "
                "Usage completeness covers recorded agent steps only, excluding unrecorded auxiliary model calls and external tool or compute charges. "
                "Cost is OpenScience's catalog estimate, not a verified invoice; a reported zero may mean missing pricing. "
                f"See {RAW_EVENTS} for original events."
            )
        else:
            extra["parent_session_id"] = parents.get(session)
            extra["dispatched_by"] = dispatch
            extra["subagent"] = reported_text(session, "agent")
            extra["trajectory_file"] = child_filename(session)
            notes = (
                f"Child session dispatched from session {parents.get(session)}; the root trajectory is trajectory.json. "
                + (
                    "The user step is the prompt of the dispatching task call. "
                    if prompt
                    else "The dispatching task call was not observed, so no user step is recorded. "
                )
                + "Usage totals come from this session's recorded steps, cross-checked against the done event's children roll-up. "
                "Cost is OpenScience's catalog estimate, not a verified invoice. "
                f"See {RAW_EVENTS} for original events."
            )
        return {
            "schema_version": SCHEMA_VERSION,
            "session_id": session or "unknown",
            "agent": {
                "name": agent_name,
                "version": agent_version,
                "model_name": model(session),
            },
            "steps": steps,
            "notes": notes,
            "extra": extra,
            "final_metrics": final_metrics(session, steps),
        }

    prompt, prompt_timestamp, _ = sessions.get(root, (None, None, []))
    main = build(
        root,
        prompt=prompt or instruction,
        prompt_timestamp=prompt_timestamp,
        dispatch=None,
    )
    if main is None:
        return []
    ordered = [documents[child] for child in tree if child in documents]
    rest = [document for child, document in documents.items() if child not in tree]
    return [main, *ordered, *rest]
