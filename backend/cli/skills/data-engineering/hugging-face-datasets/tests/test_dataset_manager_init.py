#!/usr/bin/env python3
"""
Tests for dataset_manager's `init` repository visibility.

`init_dataset` defaults to `private=True` and `quick_setup` hardcodes
`private=True`, but the CLI declared `--private` with `action="store_true"`,
which argparse defaults to False, and then passed that False straight to
`init_dataset` -- overriding the safe default with the opposite of it. The
invocation the module's own docstring shows therefore created a public
repository:

    uv run dataset_manager.py init --repo_id username/dataset-name

`--private` now means "the default" rather than "the only way to be private",
and `--public` is the explicit opt-out.

No network: `create_repo` and HfApi are stubbed, and the CLI is exercised by
running its __main__ block in-process.
"""

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


DATASET_MANAGER = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "scripts", "dataset_manager.py")
)

created = []


def _fake_create_repo(repo_id, repo_type=None, private=None, token=None):
    created.append({"repo_id": repo_id, "private": private})


class _StubApi:
    """Stands in for HfApi; uploads are accepted and discarded."""

    def __init__(self, *args, **kwargs):
        pass

    def upload_file(self, *args, **kwargs):
        return None


@pytest.fixture(autouse=True)
def stub_hub(monkeypatch):
    """Stub the Hub entry points on huggingface_hub, where runpy re-reads them."""
    created.clear()
    monkeypatch.setattr(huggingface_hub, "create_repo", _fake_create_repo)
    monkeypatch.setattr(huggingface_hub, "HfApi", _StubApi)
    return created


def _run_cli(*argv):
    """Run the dataset_manager CLI in-process, returning its exit status."""
    saved = sys.argv
    sys.argv = ["dataset_manager.py", *argv]
    try:
        runpy.run_path(DATASET_MANAGER, run_name="__main__")
    except SystemExit as exc:
        return exc.code
    finally:
        sys.argv = saved
    return 0


def test_init_without_flags_creates_a_private_repository():
    """The regression: the documented invocation published the dataset."""
    assert _run_cli("init", "--repo_id", "user/name") == 0
    assert created == [{"repo_id": "user/name", "private": True}]


def test_explicit_private_flag_still_creates_a_private_repository():
    """Existing callers passing --private must keep working."""
    assert _run_cli("init", "--repo_id", "user/name", "--private") == 0
    assert created[0]["private"] is True


def test_public_flag_creates_a_public_repository():
    """Creating a public dataset stays possible, but only on request."""
    assert _run_cli("init", "--repo_id", "user/name", "--public") == 0
    assert created[0]["private"] is False


def test_private_and_public_are_mutually_exclusive():
    """Asking for both at once is a usage error, not a silent winner."""
    assert _run_cli("init", "--repo_id", "user/name", "--private", "--public") != 0
    assert not created


def test_quick_setup_still_creates_a_private_repository():
    """quick_setup hardcoded private=True; `init` now agrees with it."""
    assert _run_cli("quick_setup", "--repo_id", "user/name") == 0
    assert created and created[0]["private"] is True