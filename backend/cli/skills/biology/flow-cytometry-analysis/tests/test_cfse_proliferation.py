#!/usr/bin/env python3
"""
Tests for the CFSE proliferation script's handling of a channel with no
positive events.

Uses minimal synthetic CSV data - no FCS files, no flowio, no external tools.
"""

import os
import subprocess
import sys

import pytest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "..", "scripts")
CFSE_SCRIPT = os.path.join(SCRIPTS_DIR, "cfse_proliferation.py")

CHANNEL = "FITC-A"


def write_csv(path, values):
    with open(path, "w") as handle:
        handle.write(CHANNEL + "\n")
        handle.write("\n".join(f"{value:.3f}" for value in values) + "\n")


def run_script(fcs, out_dir):
    return subprocess.run(
        [
            sys.executable,
            CFSE_SCRIPT,
            "--fcs",
            fcs,
            "--cfse-channel",
            CHANNEL,
            "--output-dir",
            out_dir,
        ],
        capture_output=True,
        text=True,
        timeout=300,
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_all_zero_channel_is_refused_with_a_message(tmp_path):
    """A channel of all zeros survives masking as nothing, so there is no
    range to print and nothing to log transform."""
    fcs = tmp_path / "allzero.csv"
    write_csv(fcs, [0.0] * 200)

    result = run_script(str(fcs), str(tmp_path / "out"))

    assert result.returncode == 1
    assert "No finite positive events" in result.stderr
    assert CHANNEL in result.stderr
    assert "zero-size array" not in result.stderr


def test_all_negative_channel_is_refused_with_a_message(tmp_path):
    """An uncompensated detector channel can read entirely below zero."""
    fcs = tmp_path / "allneg.csv"
    write_csv(fcs, [-4.5] * 200)

    result = run_script(str(fcs), str(tmp_path / "out"))

    assert result.returncode == 1
    assert "No finite positive events" in result.stderr
    assert CHANNEL in result.stderr
    assert "zero-size array" not in result.stderr


def test_a_few_positive_events_still_pass_the_mask(tmp_path):
    """The guard must fire on an empty survivor set only, not on a small one."""
    fcs = tmp_path / "mixed.csv"
    write_csv(fcs, [0.0, -1.0, 100.0, 200.0])

    result = run_script(str(fcs), str(tmp_path / "out"))

    assert "No finite positive events" not in result.stderr
    assert "Log10 range:" in result.stdout
    assert "Traceback" not in result.stderr


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))


@pytest.mark.parametrize("values", [[float("inf")] * 10, [float("nan")] * 10, []])
def test_non_finite_or_empty_channel_is_refused(tmp_path, values):
    fcs = tmp_path / "invalid.csv"
    write_csv(fcs, values)
    result = run_script(str(fcs), str(tmp_path / "out"))
    assert result.returncode == 1
    assert "No finite positive events" in result.stderr
    assert CHANNEL in result.stderr
    assert "Traceback" not in result.stderr
