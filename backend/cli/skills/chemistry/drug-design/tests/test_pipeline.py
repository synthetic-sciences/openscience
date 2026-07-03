#!/usr/bin/env python3
"""
End-to-end tests for the drug discovery pipeline.

Tests I/O contracts between stages, output guard validation, and schema checks.
Uses minimal synthetic test data — no GPU, no external tools required.
"""

import json
import os
import subprocess
import sys
import tempfile

import pytest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

SKILLS_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "..")
PIPELINE_SCRIPT = os.path.join(os.path.dirname(__file__), "..", "scripts", "pipeline.py")

# Minimal PDB: a small helix (alanine dipeptide-like, 5 residues)
MINI_PDB = """HEADER    TEST PROTEIN
ATOM      1  N   ALA A   1       1.000   1.000   1.000  1.00  0.00           N
ATOM      2  CA  ALA A   1       2.000   1.000   1.000  1.00  0.00           C
ATOM      3  C   ALA A   1       3.000   1.000   1.000  1.00  0.00           C
ATOM      4  O   ALA A   1       3.000   2.000   1.000  1.00  0.00           O
ATOM      5  CB  ALA A   1       2.000   0.000   1.000  1.00  0.00           C
ATOM      6  N   GLY A   2       4.000   0.000   1.000  1.00  0.00           N
ATOM      7  CA  GLY A   2       5.000   0.000   1.000  1.00  0.00           C
ATOM      8  C   GLY A   2       6.000   0.000   1.000  1.00  0.00           C
ATOM      9  O   GLY A   2       6.000   1.000   1.000  1.00  0.00           O
ATOM     10  N   ALA A   3       7.000  -1.000   1.000  1.00  0.00           N
ATOM     11  CA  ALA A   3       8.000  -1.000   1.000  1.00  0.00           C
ATOM     12  C   ALA A   3       9.000  -1.000   1.000  1.00  0.00           C
ATOM     13  O   ALA A   3       9.000   0.000   1.000  1.00  0.00           O
ATOM     14  CB  ALA A   3       8.000  -2.000   1.000  1.00  0.00           C
ATOM     15  N   LEU A   4      10.000  -2.000   1.000  1.00  0.00           N
ATOM     16  CA  LEU A   4      11.000  -2.000   1.000  1.00  0.00           C
ATOM     17  C   LEU A   4      12.000  -2.000   1.000  1.00  0.00           C
ATOM     18  O   LEU A   4      12.000  -1.000   1.000  1.00  0.00           O
ATOM     19  CB  LEU A   4      11.000  -3.000   1.000  1.00  0.00           C
ATOM     20  N   ALA A   5      13.000  -3.000   1.000  1.00  0.00           N
ATOM     21  CA  ALA A   5      14.000  -3.000   1.000  1.00  0.00           C
ATOM     22  C   ALA A   5      15.000  -3.000   1.000  1.00  0.00           C
ATOM     23  O   ALA A   5      15.000  -2.000   1.000  1.00  0.00           O
ATOM     24  CB  ALA A   5      14.000  -4.000   1.000  1.00  0.00           C
END
"""

# Minimal pocket JSON matching dock.py contract
MINI_POCKETS = {
    "protein": "test.pdb",
    "method": "grid",
    "n_pockets": 1,
    "pockets": [
        {
            "rank": 1,
            "source": "grid",
            "center": [8.0, -1.0, 1.0],
            "volume_A3": 350.0,
            "residues": ["ALA1", "GLY2", "ALA3"],
            "n_residues": 3,
        }
    ],
}

# Druggability JSON (extends pockets)
MINI_DRUGGABILITY = {
    "protein": "test.pdb",
    "method": "grid",
    "n_pockets": 1,
    "pockets": [
        {
            "rank": 1,
            "center": [8.0, -1.0, 1.0],
            "volume_A3": 350.0,
            "druggability_score": 0.65,
            "druggability_class": "difficult",
            "properties": {
                "volume_A3": 350.0,
                "hydrophobicity": 0.4,
                "enclosure": 0.5,
                "depth_A": 4.0,
                "hb_capacity": 3,
                "aromaticity": 1,
            },
        }
    ],
}

# Minimal affinity JSON matching consensus.py contract
MINI_AFFINITY = {
    "protein": "test.pdb",
    "method": "descriptor",
    "n_poses": 1,
    "predictions": [
        {
            "pose_id": 1,
            "pose_name": "test_pose_1",
            "predicted_pKd": 5.5,
            "pKd_uncertainty": 1.5,
            "pKd_range": [4.0, 7.0],
            "predicted_dG_kcal": -7.5,
            "predicted_Kd_nM": 3200,
            "confidence": "low",
        }
    ],
}

# Minimal consensus JSON
MINI_CONSENSUS = {
    "n_poses": 1,
    "sources": ["predict.py"],
    "agreement_tau": 1.0,
    "agreement_class": "high",
    "rankings": [
        {
            "pose_id": 1,
            "pose_name": "test_pose_1",
            "consensus_score": 0.85,
            "consensus_rank": 1,
            "individual_ranks": {"predict": 1},
        }
    ],
}


# ---------------------------------------------------------------------------
# Tests: I/O Contract Validation
# ---------------------------------------------------------------------------


class TestIOContracts:
    """Verify JSON schemas match what downstream scripts expect."""

    def test_pockets_json_has_center(self):
        """dock.py reads pockets[0].center as [x, y, z]."""
        center = MINI_POCKETS["pockets"][0]["center"]
        assert isinstance(center, list)
        assert len(center) == 3
        assert all(isinstance(c, (int, float)) for c in center)

    def test_pockets_json_has_pockets_key(self):
        """All downstream scripts check for 'pockets' key."""
        assert "pockets" in MINI_POCKETS
        assert len(MINI_POCKETS["pockets"]) > 0

    def test_affinity_json_has_predictions(self):
        """consensus.py reads predictions array."""
        assert "predictions" in MINI_AFFINITY
        assert len(MINI_AFFINITY["predictions"]) > 0

    def test_affinity_prediction_has_pose_id(self):
        """consensus.py matches by pose_id."""
        pred = MINI_AFFINITY["predictions"][0]
        assert "pose_id" in pred
        assert "predicted_pKd" in pred

    def test_consensus_json_has_rankings(self):
        """Final output must have rankings array."""
        assert "rankings" in MINI_CONSENSUS
        assert len(MINI_CONSENSUS["rankings"]) > 0

    def test_druggability_extends_pockets(self):
        """druggability.json must still have 'center' for dock.py."""
        pocket = MINI_DRUGGABILITY["pockets"][0]
        assert "center" in pocket
        assert "druggability_score" in pocket


# ---------------------------------------------------------------------------
# Tests: Output Guard
# ---------------------------------------------------------------------------


class TestOutputGuard:
    """Test path containment and manifest logging."""

    def test_validate_output_path_rejects_traversal(self):
        """Output paths escaping CWD must be rejected."""
        sys.path.insert(0, os.path.join(SKILLS_DIR, "binding-affinity", "scripts"))
        try:
            from output_guard import validate_output_path
            # This should exit with error — catch SystemExit
            with pytest.raises(SystemExit):
                validate_output_path("/etc/passwd")
        finally:
            sys.path.pop(0)

    def test_validate_output_path_accepts_relative(self):
        """Relative paths within CWD should be accepted."""
        sys.path.insert(0, os.path.join(SKILLS_DIR, "binding-affinity", "scripts"))
        try:
            from output_guard import validate_output_path
            result = validate_output_path("output.json")
            assert result.endswith("output.json")
        finally:
            sys.path.pop(0)

    def test_log_to_manifest_creates_valid_jsonl(self):
        """Manifest entries must be valid JSON lines."""
        sys.path.insert(0, os.path.join(SKILLS_DIR, "binding-affinity", "scripts"))
        try:
            from output_guard import log_to_manifest
            with tempfile.TemporaryDirectory() as tmpdir:
                old_cwd = os.getcwd()
                os.chdir(tmpdir)
                try:
                    log_to_manifest("test.py", {"--input": "test.pdb"}, "output.json")
                    manifest = os.path.join(tmpdir, "_script_manifest.jsonl")
                    assert os.path.exists(manifest)
                    with open(manifest) as f:
                        line = f.readline().strip()
                    entry = json.loads(line)
                    assert entry["script"] == "test.py"
                    assert "timestamp" in entry
                    assert "args" in entry
                finally:
                    os.chdir(old_cwd)
        finally:
            sys.path.pop(0)


# ---------------------------------------------------------------------------
# Tests: Schema Validators (from pipeline.py)
# ---------------------------------------------------------------------------


class TestSchemaValidators:
    """Test the pipeline's schema validation functions."""

    def setup_method(self):
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
        from pipeline import (
            check_pockets_json,
            check_affinity_json,
            check_consensus_json,
            check_druggability_json,
        )
        self.check_pockets = check_pockets_json
        self.check_affinity = check_affinity_json
        self.check_consensus = check_consensus_json
        self.check_druggability = check_druggability_json

    def teardown_method(self):
        sys.path.pop(0)

    def test_valid_pockets_json(self):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            json.dump(MINI_POCKETS, f)
            f.flush()
            ok, msg = self.check_pockets(f.name)
        os.unlink(f.name)
        assert ok, msg

    def test_invalid_pockets_missing_center(self):
        bad = {"pockets": [{"rank": 1, "volume_A3": 100}]}
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            json.dump(bad, f)
            f.flush()
            ok, msg = self.check_pockets(f.name)
        os.unlink(f.name)
        assert not ok
        assert "center" in msg

    def test_valid_affinity_json(self):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            json.dump(MINI_AFFINITY, f)
            f.flush()
            ok, msg = self.check_affinity(f.name)
        os.unlink(f.name)
        assert ok, msg

    def test_valid_consensus_json(self):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            json.dump(MINI_CONSENSUS, f)
            f.flush()
            ok, msg = self.check_consensus(f.name)
        os.unlink(f.name)
        assert ok, msg

    def test_valid_druggability_json(self):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            json.dump(MINI_DRUGGABILITY, f)
            f.flush()
            ok, msg = self.check_druggability(f.name)
        os.unlink(f.name)
        assert ok, msg


# ---------------------------------------------------------------------------
# Tests: Pocket Discovery in dock.py
# ---------------------------------------------------------------------------


class TestPocketDiscovery:
    """Test dock.py's pocket file discovery logic."""

    def setup_method(self):
        sys.path.insert(0, os.path.join(SKILLS_DIR, "molecular-docking", "scripts"))

    def teardown_method(self):
        sys.path.pop(0)

    def test_explicit_pockets_arg(self):
        """--pockets flag should be highest priority."""
        from dock import estimate_box_center
        with tempfile.TemporaryDirectory() as tmpdir:
            pdb_path = os.path.join(tmpdir, "protein.pdb")
            pockets_path = os.path.join(tmpdir, "my_pockets.json")
            with open(pdb_path, "w") as f:
                f.write(MINI_PDB)
            with open(pockets_path, "w") as f:
                json.dump(MINI_POCKETS, f)
            cx, cy, cz = estimate_box_center(pdb_path, pockets_arg=pockets_path)
            assert cx == 8.0
            assert cy == -1.0
            assert cz == 1.0

    def test_pockets_json_in_same_dir(self):
        """pockets.json in same directory as PDB should be discovered."""
        from dock import estimate_box_center
        with tempfile.TemporaryDirectory() as tmpdir:
            pdb_path = os.path.join(tmpdir, "protein.pdb")
            pockets_path = os.path.join(tmpdir, "pockets.json")
            with open(pdb_path, "w") as f:
                f.write(MINI_PDB)
            with open(pockets_path, "w") as f:
                json.dump(MINI_POCKETS, f)
            cx, cy, cz = estimate_box_center(pdb_path)
            assert cx == 8.0

    def test_geometric_center_fallback(self):
        """Without any pocket files, should use geometric center."""
        from dock import estimate_box_center
        with tempfile.TemporaryDirectory() as tmpdir:
            pdb_path = os.path.join(tmpdir, "protein.pdb")
            with open(pdb_path, "w") as f:
                f.write(MINI_PDB)
            cx, cy, cz = estimate_box_center(pdb_path)
            # Geometric center of our mini PDB
            assert 5 < cx < 12  # roughly centered


# ---------------------------------------------------------------------------
# Tests: Pipeline Script (smoke test)
# ---------------------------------------------------------------------------


class TestPipelineScript:
    """Smoke tests for pipeline.py argument parsing."""

    def test_pipeline_help(self):
        """pipeline.py --help should exit 0."""
        result = subprocess.run(
            [sys.executable, PIPELINE_SCRIPT, "--help"],
            capture_output=True, text=True,
        )
        assert result.returncode == 0
        assert "drug discovery pipeline" in result.stdout.lower()

    def test_pipeline_missing_mode(self):
        """pipeline.py without --mode should fail."""
        result = subprocess.run(
            [sys.executable, PIPELINE_SCRIPT],
            capture_output=True, text=True,
        )
        assert result.returncode != 0

    def test_pipeline_missing_protein(self):
        """pipeline.py --mode assess without protein/sequence should fail."""
        result = subprocess.run(
            [sys.executable, PIPELINE_SCRIPT, "--mode", "assess"],
            capture_output=True, text=True,
        )
        assert result.returncode != 0


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
