#!/usr/bin/env python3
"""Behavioral tests for bundled dataset helpers; no Hub requests."""

import json
import os
import runpy
import sys

import huggingface_hub
import pytest

sys.path.insert(
    0,
    os.path.join(os.path.dirname(__file__), "..", "scripts"),
)

import dataset_manager  # noqa: E402


SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "scripts"))
DATASET_MANAGER = os.path.join(SCRIPTS_DIR, "dataset_manager.py")

GOOD_ROWS = [
    {"messages": [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "yo"}]},
]
# `messages` must be a non-empty list, so this row is rejected by the chat
# validator before any upload is attempted.
INVALID_ROWS = [{"messages": "not-a-list"}]


class _StubApi:
    """Stands in for HfApi. Every upload is recorded; rejection is opt-in."""

    uploaded = []

    def __init__(self, *args, **kwargs):
        pass

    def upload_file(self, *args, **kwargs):
        if type(self).reject:
            raise huggingface_hub.utils.HfHubHTTPError("403 Forbidden: no write access")
        type(self).uploaded.append(kwargs.get("path_in_repo"))
        return None


@pytest.fixture
def stub_api(monkeypatch):
    """Install the stub and report whether uploads should be rejected."""
    _StubApi.uploaded = []
    _StubApi.reject = False
    monkeypatch.setattr(dataset_manager, "HfApi", _StubApi)
    monkeypatch.setattr(huggingface_hub, "HfApi", _StubApi)
    return _StubApi


def test_successful_upload_is_reported(stub_api):
    """The happy path must keep reporting success."""
    assert dataset_manager.add_rows("user/name", GOOD_ROWS) is True
    assert stub_api.uploaded, "the stub should have been asked to upload"


def test_failed_upload_is_reported(stub_api):
    """A rejected upload used to be indistinguishable from a successful one."""
    stub_api.reject = True
    assert dataset_manager.add_rows("user/name", GOOD_ROWS) is False


def test_validation_failure_is_reported(stub_api):
    """Rows the validator rejects were never committed either."""
    assert dataset_manager.add_rows("user/name", INVALID_ROWS) is False
    assert not stub_api.uploaded, "a rejected row must not be uploaded"


def test_no_rows_is_a_successful_no_op(stub_api):
    """Nothing to add is not a failure; nothing was expected."""
    assert dataset_manager.add_rows("user/name", []) is True
    assert not stub_api.uploaded


def _run_cli(stub_api, rows, reject):
    """Run the add_rows CLI in-process and return its exit status."""
    stub_api.reject = reject
    argv = [
        "dataset_manager.py",
        "add_rows",
        "--repo_id",
        "user/name",
        "--rows_json",
        json.dumps(rows),
    ]
    saved = sys.argv
    sys.argv = argv
    try:
        runpy.run_path(DATASET_MANAGER, run_name="__main__")
    except SystemExit as exc:
        return exc.code
    finally:
        sys.argv = saved
    return 0


def test_cli_exits_non_zero_when_the_upload_fails(stub_api):
    """The regression: this used to print a warning and exit 0."""
    assert _run_cli(stub_api, GOOD_ROWS, reject=True) != 0


def test_cli_exits_zero_when_the_upload_succeeds(stub_api):
    """A committed upload must not start failing the build."""
    assert _run_cli(stub_api, GOOD_ROWS, reject=False) == 0


def test_cli_exits_non_zero_when_validation_rejects_the_rows(stub_api):
    """Rejected rows are not committed rows."""
    assert _run_cli(stub_api, INVALID_ROWS, reject=False) != 0


def test_invalid_json_cli_exits_nonzero(stub_api, monkeypatch):
    monkeypatch.setattr(sys, "argv", ["dataset_manager.py", "add_rows", "--repo_id", "user/name", "--rows_json", "{"])
    with pytest.raises(SystemExit) as error:
        runpy.run_path(DATASET_MANAGER, run_name="__main__")
    assert error.value.code == 1


def test_quick_setup_does_not_report_success_after_failed_seed_upload(stub_api, monkeypatch, capsys):
    monkeypatch.setattr(dataset_manager, "init_dataset", lambda *args, **kwargs: None)
    monkeypatch.setattr(dataset_manager, "define_config", lambda *args, **kwargs: None)
    stub_api.reject = True
    assert dataset_manager.quick_setup("user/name") is False
    assert "Quick setup complete" not in capsys.readouterr().out
