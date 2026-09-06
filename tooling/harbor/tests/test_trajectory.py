"""The JSONL → ATIF converter, against a stream captured from a real
`openscience run --format json --auto-approve` turn (tests/fixtures)."""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest
from openscience_harbor import trajectory

FIXTURE = Path(__file__).parent / "fixtures" / "openscience.jsonl"


@pytest.fixture
def events() -> list[dict]:
    return trajectory.parse(FIXTURE.read_text())


def test_parse_skips_stderr_noise_and_blank_lines() -> None:
    text = 'Warning: something on stderr\n\n{"type":"user","timestamp":1,"sessionID":"s","parts":[]}\nnot json\n'
    assert [event["type"] for event in trajectory.parse(text)] == ["user"]


def test_fixture_is_the_documented_event_sequence(events: list[dict]) -> None:
    assert [event["type"] for event in events] == [
        "user",
        "permission",
        "step_start",
        "tool_use",
        "reasoning",
        "step_finish",
        "step_start",
        "text",
        "step_finish",
        "done",
    ]
    assert all(event["sessionID"] == events[0]["sessionID"] for event in events)
    assert trajectory.errors(events) == []
    assert trajectory.exit_code(events) == 0


def test_convert_groups_steps_and_keeps_tool_observations(events: list[dict]) -> None:
    result = trajectory.convert(
        events, agent_version="2.0.70", model_name="stress/fixture-model"
    )
    assert result is not None
    assert result["schema_version"] == "ATIF-v1.7"
    assert result["session_id"] == events[0]["sessionID"]
    assert result["extra"]["usage_components"] == "recorded_agent_steps"
    assert result["extra"]["excluded_usage"] == [
        "unrecorded_auxiliary_model_calls",
        "external_tool_and_compute_charges",
    ]
    assert result["agent"] == {
        "name": "openscience",
        "version": "2.0.70",
        "model_name": "stress/fixture-model",
    }

    steps = result["steps"]
    assert [step["step_id"] for step in steps] == [1, 2, 3]
    assert steps[0]["source"] == "user"
    assert steps[0]["message"] == trajectory.user_text(events[0])
    assert "notes.txt" in steps[0]["message"]

    first = steps[1]
    assert first["source"] == "agent"
    assert (
        first["reasoning_content"] == "I should read the notes file before answering."
    )
    assert first["tool_calls"] == [
        {
            "tool_call_id": "call_read_notes",
            "function_name": "read",
            "arguments": {"filePath": "/app/notes.txt"},
        }
    ]
    observation = first["observation"]["results"][0]
    assert observation["source_call_id"] == "call_read_notes"
    assert "The answer is 42." in observation["content"]
    assert first["metrics"]["prompt_tokens"] == 120
    assert first["metrics"]["completion_tokens"] == 18
    assert first["llm_call_count"] == 1

    last = steps[2]
    assert last["message"] == "The notes say the answer is 42."
    assert "tool_calls" not in last

    done = events[-1]
    assert result["final_metrics"] == {
        "total_prompt_tokens": done["tokens"]["input"]
        + done["tokens"]["cache"]["read"],
        "total_completion_tokens": done["tokens"]["output"],
        "total_cached_tokens": 0,
        "total_cost_usd": done["cost"],
        "total_steps": 3,
        "extra": {
            "observed_root_usage": {
                "prompt_tokens": 280,
                "completion_tokens": 27,
                "cached_tokens": 0,
                "cost_usd": 0,
            },
            "cost_source": "openscience_catalog_estimate",
        },
    }
    # The converter's sums agree with what the CLI reported in `done`.
    assert result["final_metrics"]["total_prompt_tokens"] == 280
    assert result["final_metrics"]["total_completion_tokens"] == 27


def test_failed_tool_calls_are_observed_with_their_error() -> None:
    part = {
        "id": "prt_1",
        "callID": "call_bash",
        "type": "tool",
        "tool": "bash",
        "state": {
            "status": "error",
            "input": {"command": "rm -rf /"},
            "error": "The user rejected permission",
        },
    }
    events = [
        {
            "type": "step_start",
            "timestamp": 1_000,
            "sessionID": "ses_1",
            "part": {"type": "step-start"},
        },
        {"type": "tool_use", "timestamp": 1_001, "sessionID": "ses_1", "part": part},
        {
            "type": "step_finish",
            "timestamp": 1_002,
            "sessionID": "ses_1",
            "part": {"type": "step-finish", "cost": 0.5},
        },
        {
            "type": "done",
            "timestamp": 1_003,
            "sessionID": "ses_1",
            "status": "rejected",
            "exitCode": 3,
        },
    ]
    result = trajectory.convert(events, instruction="Delete everything")
    assert result is not None
    assert result["steps"][0] == {
        "step_id": 1,
        "timestamp": None,
        "source": "user",
        "message": "Delete everything",
    }
    step = result["steps"][1]
    assert step["tool_calls"][0]["arguments"] == {"command": "rm -rf /"}
    assert step["observation"]["results"][0] == {
        "source_call_id": "call_bash",
        "content": "The user rejected permission",
        "extra": {"status": "error"},
    }
    assert step["metrics"]["prompt_tokens"] is None
    assert step["metrics"]["cost_usd"] == 0.5
    assert result["final_metrics"]["total_cost_usd"] is None
    assert result["final_metrics"]["extra"]["observed_root_usage"]["cost_usd"] == 0.5
    assert trajectory.exit_code(events) == 3


def test_error_events_and_empty_streams() -> None:
    events = [
        {
            "type": "user",
            "timestamp": 1,
            "sessionID": "ses_1",
            "parts": [{"type": "text", "text": "hi"}],
        },
        {
            "type": "error",
            "timestamp": 2,
            "sessionID": "ses_1",
            "error": {
                "name": "UnknownError",
                "data": {"message": "No model providers are available."},
            },
        },
        {
            "type": "done",
            "timestamp": 3,
            "sessionID": "ses_1",
            "status": "error",
            "exitCode": 2,
        },
    ]
    assert trajectory.errors(events) == ["No model providers are available."]
    assert trajectory.exit_code(events) == 2
    assert trajectory.convert(events)["steps"][0]["message"] == "hi"
    assert trajectory.convert(events)["extra"]["trace_complete"] is False
    assert trajectory.convert([]) is None
    assert trajectory.exit_code([]) is None


def test_trajectory_validates_against_harbor(events: list[dict]) -> None:
    from harbor.models.trajectories import Trajectory
    from harbor.utils.trajectory_validator import validate_trajectory

    result = trajectory.convert(
        events, agent_version="2.0.70", model_name="stress/fixture-model"
    )
    assert result is not None
    parsed = Trajectory.model_validate(result)
    assert len(parsed.steps) == 3
    assert validate_trajectory(json.loads(json.dumps(parsed.to_json_dict()))) is True


def test_cache_writes_are_prompt_tokens_and_zero_remains_reported_zero(events):
    events = copy.deepcopy(events)
    events[5]["part"]["tokens"]["cache"] = {"read": 11, "write": 31}
    events[-1]["tokens"]["cache"] = {"read": 11, "write": 31}
    result = trajectory.convert(events)
    assert result["steps"][1]["metrics"]["prompt_tokens"] == 162
    assert result["final_metrics"]["total_prompt_tokens"] == 322
    assert result["final_metrics"]["total_cached_tokens"] == 11
    assert result["final_metrics"]["total_cost_usd"] == 0
    assert result["extra"]["usage_complete"] is True
    assert "catalog estimate" in result["notes"]


def test_incomplete_step_keeps_tool_and_reasoning_without_fabricated_totals(events):
    from harbor.models.trajectories import Trajectory

    result = trajectory.convert(events[:5])
    parsed = Trajectory.model_validate(result)
    assert len(parsed.steps) == 2
    assert parsed.steps[1].tool_calls[0].function_name == "read"
    assert parsed.steps[1].reasoning_content
    assert parsed.steps[1].llm_call_count is None
    assert parsed.steps[1].metrics is None
    assert parsed.final_metrics.total_prompt_tokens is None
    assert parsed.final_metrics.total_cost_usd is None
    assert parsed.extra["usage_complete"] is False


def test_missing_usage_and_mismatched_totals_are_not_reported_as_zero(events):
    events = copy.deepcopy(events)
    del events[5]["part"]["tokens"]
    result = trajectory.convert(events)
    assert result["steps"][1]["metrics"]["prompt_tokens"] is None
    assert result["final_metrics"]["total_prompt_tokens"] is None
    assert result["extra"]["usage_complete"] is False
    events = trajectory.parse(FIXTURE.read_text())
    events[-1]["tokens"]["input"] += 1
    result = trajectory.convert(events)
    assert result["extra"]["terminal_metric_mismatches"] == ["prompt_tokens"]
    assert result["final_metrics"]["total_prompt_tokens"] is None


def test_repeated_tool_updates_do_not_duplicate_calls_and_delegation_has_no_invented_total(
    events,
):
    events = copy.deepcopy(events)
    duplicate = copy.deepcopy(events[3])
    events.insert(4, duplicate)
    result = trajectory.convert(events)
    assert len(result["steps"][1]["tool_calls"]) == 1
    assert trajectory.completion_failure(events) == "duplicate event part"
    events = trajectory.parse(FIXTURE.read_text())
    events[3]["part"]["tool"] = "task"
    result = trajectory.convert(events)
    assert result["extra"]["delegation_observed"] is True
    assert result["final_metrics"]["total_cost_usd"] is None
    assert "subagent_trajectories" not in result


@pytest.mark.parametrize(
    "mutate",
    [
        lambda events: events.pop(),
        lambda events: events.append(events[-1].copy()),
        lambda events: events[-1].update(exitCode=False),
        lambda events: events[-1].update(status="error"),
        lambda events: events[3].update(sessionID="child"),
        lambda events: events[3]["part"].update(sessionID="child"),
        lambda events: events.pop(5),
    ],
)
def test_success_requires_valid_terminal_and_root_stream(events, mutate):
    assert trajectory.completion_failure(events) is None
    changed = copy.deepcopy(events)
    mutate(changed)
    assert trajectory.completion_failure(changed) is not None
