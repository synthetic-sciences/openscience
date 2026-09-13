"""The JSONL → ATIF converter, against a stream captured from a real
`openscience run --format json --auto-approve` turn (tests/fixtures)."""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest
from openscience_harbor import trajectory

FIXTURE = Path(__file__).parent / "fixtures" / "openscience.jsonl"
DELEGATION = Path(__file__).parent / "fixtures" / "delegation.jsonl"


@pytest.fixture
def events() -> list[dict]:
    return trajectory.parse(FIXTURE.read_text())


@pytest.fixture
def delegated() -> list[dict]:
    return trajectory.parse(DELEGATION.read_text())


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
    usage = {
        "prompt_tokens": 280,
        "completion_tokens": 27,
        "cached_tokens": 0,
        "cost_usd": 0,
    }
    assert result["final_metrics"] == {
        "total_prompt_tokens": done["tokens"]["input"]
        + done["tokens"]["cache"]["read"],
        "total_completion_tokens": done["tokens"]["output"],
        "total_cached_tokens": 0,
        "total_cost_usd": done["cost"],
        "total_steps": 3,
        "extra": {
            "observed_root_usage": usage,
            "child_usage": {},
            "observed_usage": usage,
            "cost_source": "openscience_catalog_estimate",
        },
    }
    # The converter's sums agree with what the CLI reported in `done`.
    assert result["final_metrics"]["total_prompt_tokens"] == 280
    assert result["final_metrics"]["total_completion_tokens"] == 27
    assert result["extra"]["usage_scope"] == "root_session"
    assert result["extra"]["child_sessions"] == []
    assert result["extra"]["delegation_observed"] is False
    assert trajectory.convert_all(events)[1:] == []


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


def test_repeated_tool_updates_do_not_duplicate_calls_and_unmatched_task_keeps_totals(
    events,
):
    events = copy.deepcopy(events)
    duplicate = copy.deepcopy(events[3])
    events.insert(4, duplicate)
    result = trajectory.convert(events)
    assert len(result["steps"][1]["tool_calls"]) == 1
    assert trajectory.completion_failure(events) == "duplicate event part"
    # A task call whose child never streamed and is absent from the roll-up:
    # child usage is observable now, so delegation alone withholds nothing,
    # and no child trajectory is invented.
    events = trajectory.parse(FIXTURE.read_text())
    events[3]["part"]["tool"] = "task"
    result = trajectory.convert(events)
    assert result["extra"]["delegation_observed"] is True
    assert result["extra"]["usage_complete"] is True
    assert result["extra"]["child_sessions"] == []
    assert result["final_metrics"]["total_cost_usd"] == 0
    assert result["final_metrics"]["total_prompt_tokens"] == 280
    assert "subagent_trajectories" not in result
    assert (
        "subagent_trajectory_ref" not in result["steps"][1]["observation"]["results"][0]
    )
    assert trajectory.convert_all(events)[1:] == []


def test_child_sessions_become_referenced_trajectories_with_rolled_up_usage(
    delegated,
):
    from harbor.models.trajectories import Trajectory
    from harbor.utils.trajectory_validator import validate_trajectory

    assert trajectory.completion_failure(delegated) is None
    assert trajectory.session_id(delegated) == "ses_root"
    documents = trajectory.convert_all(
        delegated, agent_version="2.0.80", model_name="stress/lead-model"
    )
    assert [document["session_id"] for document in documents] == [
        "ses_root",
        "ses_child",
    ]
    root, child = documents
    for document in documents:
        parsed = Trajectory.model_validate(document)
        assert validate_trajectory(json.loads(json.dumps(parsed.to_json_dict())))
    assert (
        trajectory.convert(
            delegated, agent_version="2.0.80", model_name="stress/lead-model"
        )
        == root
    )

    # Root steps: prompt, the dispatching step, the final answer. Child
    # events interleaved inside the dispatching step do not leak into it.
    assert [step["source"] for step in root["steps"]] == ["user", "agent", "agent"]
    dispatch = root["steps"][1]
    assert [call["function_name"] for call in dispatch["tool_calls"]] == ["task"]
    assert dispatch["metrics"]["prompt_tokens"] == 200
    assert "questions" not in dispatch["extra"]
    observation = dispatch["observation"]["results"][0]
    assert observation["source_call_id"] == "call_task_notes"
    assert '<task id="ses_child" state="completed">' in observation["content"]
    assert observation["subagent_trajectory_ref"] == [
        {
            "session_id": "ses_child",
            "trajectory_path": "trajectory-ses_child.json",
            "extra": {"agent": "explore", "model": "stress/worker-model"},
        }
    ]
    assert trajectory.child_filename("ses_child") == "trajectory-ses_child.json"

    # Totals: root steps (500/50/0/0.15) plus the child's roll-up (133/22/5/0.03).
    metrics = root["final_metrics"]
    assert metrics["total_prompt_tokens"] == 633
    assert metrics["total_completion_tokens"] == 72
    assert metrics["total_cached_tokens"] == 5
    assert metrics["total_cost_usd"] == pytest.approx(0.18)
    assert metrics["total_steps"] == 3
    assert metrics["extra"]["observed_root_usage"]["prompt_tokens"] == 500
    assert metrics["extra"]["child_usage"] == {
        "ses_child": {
            "prompt_tokens": 133,
            "completion_tokens": 22,
            "cached_tokens": 5,
            "cost_usd": 0.03,
        }
    }
    assert metrics["extra"]["observed_usage"]["prompt_tokens"] == 633
    assert root["extra"]["usage_complete"] is True
    assert root["extra"]["trace_complete"] is True
    assert root["extra"]["usage_scope"] == "root_and_child_sessions"
    assert root["extra"]["delegation_observed"] is True
    assert root["extra"]["child_sessions"] == ["ses_child"]
    assert root["extra"]["child_trajectories"] == {
        "ses_child": "trajectory-ses_child.json"
    }
    assert root["extra"]["terminal_metric_mismatches"] == []
    assert root["extra"]["child_metric_mismatches"] == {}
    assert "No child trajectories" not in root["notes"]
    assert "child_trajectories" in root["notes"]

    # The child document: the task prompt is its user step, its steps carry
    # their own usage, the answered question is recorded, and the roll-up
    # names the worker agent and model.
    assert child["agent"]["model_name"] == "stress/worker-model"
    assert [step["source"] for step in child["steps"]] == ["user", "agent", "agent"]
    assert child["steps"][0]["message"] == (
        "Read /app/notes.txt and report the answer it contains."
    )
    assert child["steps"][0]["timestamp"] is not None
    assert child["steps"][1]["tool_calls"][0]["function_name"] == "read"
    assert child["steps"][1]["model_name"] == "stress/worker-model"
    assert child["steps"][1]["extra"]["questions"] == [
        {"id": "que_child_format", "answers": [["One sentence"]]}
    ]
    assert child["steps"][1]["metrics"]["prompt_tokens"] == 55
    assert child["steps"][2]["message"] == "The notes say the answer is 42."
    assert child["final_metrics"]["total_prompt_tokens"] == 133
    assert child["final_metrics"]["total_cost_usd"] == pytest.approx(0.03)
    assert (
        child["final_metrics"]["extra"]["observed_session_usage"]["completion_tokens"]
        == 22
    )
    assert child["extra"]["usage_scope"] == "child_session"
    assert child["extra"]["parent_session_id"] == "ses_root"
    assert child["extra"]["dispatched_by"] == {
        "session_id": "ses_root",
        "tool_call_id": "call_task_notes",
    }
    assert child["extra"]["subagent"] == "explore"
    assert child["extra"]["trajectory_file"] == "trajectory-ses_child.json"
    assert child["extra"]["usage_complete"] is True


def test_child_usage_is_cross_checked_against_the_roll_up(delegated):
    changed = copy.deepcopy(delegated)
    changed[-1]["children"][0]["tokens"]["input"] += 1
    root = trajectory.convert(changed)
    assert root["extra"]["child_metric_mismatches"] == {"ses_child": ["prompt_tokens"]}
    assert root["extra"]["usage_complete"] is False
    assert root["final_metrics"]["total_prompt_tokens"] is None
    assert root["final_metrics"]["extra"]["observed_usage"]["prompt_tokens"] == 634
    child = trajectory.convert_all(changed)[1]
    assert child["extra"]["terminal_metric_mismatches"] == ["prompt_tokens"]
    assert child["final_metrics"]["total_prompt_tokens"] is None

    # Without a roll-up the child's recorded steps supply its usage.
    changed = copy.deepcopy(delegated)
    del changed[-1]["children"]
    root = trajectory.convert(changed)
    assert root["extra"]["usage_complete"] is True
    assert root["final_metrics"]["total_prompt_tokens"] == 633
    assert root["final_metrics"]["total_cost_usd"] == pytest.approx(0.18)
    assert root["extra"]["child_sessions"] == ["ses_child"]
    child = trajectory.convert_all(changed)[1]
    assert child["agent"]["model_name"] is None

    # A child step without usage withholds every total, root included.
    changed = copy.deepcopy(delegated)
    del changed[6]["part"]["tokens"]
    root = trajectory.convert(changed)
    assert root["extra"]["usage_complete"] is False
    assert root["final_metrics"]["total_cost_usd"] is None

    # A child listed only in the roll-up (no streamed steps) still counts.
    changed = copy.deepcopy(delegated)
    changed[-1]["children"].append(
        {
            "sessionID": "ses_silent",
            "parentID": "ses_root",
            "tokens": {
                "input": 7,
                "output": 1,
                "reasoning": 0,
                "cache": {"read": 0, "write": 0},
            },
            "cost": 0.001,
        }
    )
    documents = trajectory.convert_all(changed)
    assert [document["session_id"] for document in documents] == [
        "ses_root",
        "ses_child",
    ]
    assert documents[0]["extra"]["child_sessions"] == ["ses_child", "ses_silent"]
    assert documents[0]["final_metrics"]["total_prompt_tokens"] == 640
    assert documents[0]["final_metrics"]["total_cost_usd"] == pytest.approx(0.181)


def test_child_matched_from_task_envelope_and_nested_dispatch(delegated):
    from harbor.models.trajectories import Trajectory

    changed = copy.deepcopy(delegated)
    del changed[10]["part"]["state"]["metadata"]["sessionId"]
    root = trajectory.convert(changed)
    reference = root["steps"][1]["observation"]["results"][0]["subagent_trajectory_ref"]
    assert reference[0]["trajectory_path"] == "trajectory-ses_child.json"

    # A grandchild dispatched by the child: referenced from the child's task
    # call, rolled into both the child's and the root's totals.
    nested = copy.deepcopy(delegated)
    grandchild = [
        {
            "type": "step_start",
            "timestamp": 1788529680062,
            "sessionID": "ses_grandchild",
            "parentID": "ses_child",
            "part": {
                "id": "prt_gc_start",
                "sessionID": "ses_grandchild",
                "type": "step-start",
            },
        },
        {
            "type": "text",
            "timestamp": 1788529680063,
            "sessionID": "ses_grandchild",
            "parentID": "ses_child",
            "part": {
                "id": "prt_gc_text",
                "sessionID": "ses_grandchild",
                "type": "text",
                "text": "42",
                "time": {"start": 1788529680062, "end": 1788529680063},
            },
        },
        {
            "type": "step_finish",
            "timestamp": 1788529680064,
            "sessionID": "ses_grandchild",
            "parentID": "ses_child",
            "part": {
                "id": "prt_gc_finish",
                "sessionID": "ses_grandchild",
                "type": "step-finish",
                "cost": 0.004,
                "tokens": {
                    "input": 9,
                    "output": 2,
                    "reasoning": 0,
                    "cache": {"read": 0, "write": 0},
                },
            },
        },
        {
            "type": "tool_use",
            "timestamp": 1788529680065,
            "sessionID": "ses_child",
            "parentID": "ses_root",
            "part": {
                "id": "prt_child_2_task",
                "sessionID": "ses_child",
                "type": "tool",
                "callID": "call_child_task",
                "tool": "task",
                "state": {
                    "status": "completed",
                    "input": {
                        "description": "Double-check",
                        "prompt": "Confirm the number.",
                    },
                    "output": '<task id="ses_grandchild" state="completed">\n<task_result>\n42\n</task_result>\n</task>',
                    "time": {"start": 1788529680061, "end": 1788529680065},
                },
            },
        },
    ]
    nested[8:8] = grandchild
    nested[-1]["children"].append(
        {
            "sessionID": "ses_grandchild",
            "parentID": "ses_child",
            "agent": "explore",
            "model": "stress/worker-model",
            "tokens": {
                "input": 9,
                "output": 2,
                "reasoning": 0,
                "cache": {"read": 0, "write": 0},
            },
            "cost": 0.004,
        }
    )
    assert trajectory.completion_failure(nested) is None
    documents = trajectory.convert_all(nested)
    assert [document["session_id"] for document in documents] == [
        "ses_root",
        "ses_child",
        "ses_grandchild",
    ]
    for document in documents:
        Trajectory.model_validate(document)
    root, child, grandchild_document = documents
    assert root["extra"]["child_sessions"] == ["ses_child", "ses_grandchild"]
    assert root["final_metrics"]["total_prompt_tokens"] == 642
    assert child["extra"]["child_sessions"] == ["ses_grandchild"]
    assert child["final_metrics"]["total_prompt_tokens"] == 142
    assert child["steps"][2]["observation"]["results"][0]["subagent_trajectory_ref"][
        0
    ] == {
        "session_id": "ses_grandchild",
        "trajectory_path": "trajectory-ses_grandchild.json",
        "extra": {"agent": "explore", "model": "stress/worker-model"},
    }
    assert grandchild_document["extra"]["parent_session_id"] == "ses_child"
    assert grandchild_document["steps"][0]["message"] == "Confirm the number."
    assert grandchild_document["final_metrics"]["total_prompt_tokens"] == 9


def test_child_streams_must_be_balanced_and_tagged(delegated):
    assert trajectory.completion_failure(delegated) is None
    child_finish = next(
        i
        for i, event in enumerate(delegated)
        if event["type"] == "step_finish" and event["sessionID"] == "ses_child"
    )
    changed = copy.deepcopy(delegated)
    del changed[child_finish]
    assert (
        trajectory.completion_failure(changed)
        == "a model step is missing its finish event"
    )
    changed = copy.deepcopy(delegated)
    del changed[3]  # the child's first step_start; its read follows
    assert trajectory.completion_failure(changed) == "model output outside a model step"
    changed = copy.deepcopy(delegated)
    del changed[3:5]  # the child's first step_start and its read
    assert (
        trajectory.completion_failure(changed)
        == "a model step is missing its start event"
    )
    changed = copy.deepcopy(delegated)
    del changed[3]["parentID"]
    assert (
        trajectory.completion_failure(changed)
        == "missing or inconsistent root session identity"
    )
    changed = copy.deepcopy(delegated)
    changed[3]["sessionID"] = "ses_root"
    assert (
        trajectory.completion_failure(changed)
        == "child event without a distinct session identity"
    )
    changed = copy.deepcopy(delegated)
    changed[4]["part"]["sessionID"] = "ses_root"
    assert (
        trajectory.completion_failure(changed) == "part belongs to a different session"
    )


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
