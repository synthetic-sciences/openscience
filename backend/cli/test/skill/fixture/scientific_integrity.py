"""Offline behavioral tests for method attribution and incomplete validation."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SKILLS = Path(__file__).resolve().parents[3] / "skills"


def load(name, relative):
    source = SKILLS / relative
    spec = importlib.util.spec_from_file_location(name, source)
    module = importlib.util.module_from_spec(spec)
    with patch.object(sys, "path", [str(source.parent)] + sys.path):
        spec.loader.exec_module(module)
    return module


class Integrity(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.rescore = load("rescore", "chemistry/binding-affinity/scripts/rescore.py")
        self.consensus = load("consensus", "chemistry/binding-affinity/scripts/consensus.py")
        self.venue = load("venue", "writing/venue-templates/scripts/validate_format.py")
        self.rip = load("self_instruct", "other/hugging-face-jobs/scripts/cot-self-instruct.py")

    def cli(self, relative, *args):
        return subprocess.run([sys.executable, "-B", "-S", str(SKILLS / relative), *args], cwd=self.root, text=True, capture_output=True, timeout=10)

    def test_mmgbsa_fails_before_dependencies_or_files(self):
        result = self.cli("chemistry/binding-affinity/scripts/rescore.py", "--poses", "absent.sdf", "--output", "scores.json")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Full MM/GBSA is not implemented", result.stderr)
        self.assertFalse((self.root / "scores.json").exists())
        with self.assertRaisesRegex(ValueError, "Full MM/GBSA"):
            self.rescore.rescore_openmm(None)

    def test_heuristic_parameters_do_not_silently_claim_gb_or_minimization(self):
        self.rescore.require_method("ligand-heuristic")
        for options in [(1, None), (0, "OBC2")]:
            with self.assertRaisesRegex(ValueError, "does not implement"):
                self.rescore.require_method("ligand-heuristic", *options)
        self.assertNotIn("rdkit", sys.modules)

    def test_consensus_keeps_heuristic_identity_and_rejects_legacy_claim(self):
        file = self.root / "scores.json"
        file.write_text(json.dumps({"method": "ligand_energy_heuristic", "receptor_used": False, "results": [{"pose_id": 1, "ligand_score": 0.0}]}))
        name, scores = self.consensus.load_score_file(file)
        self.assertEqual(name, "ligand_heuristic")
        self.assertEqual(scores[1]["value"], 0.0)
        file.write_text(json.dumps({"method": "openmm_mmgbsa", "results": [{"pose_id": 1, "dG_mmgbsa_kcal": -7}]}))
        with self.assertRaisesRegex(ValueError, "Legacy rescore"):
            self.consensus.load_score_file(file)

    def test_rip_fails_before_loading_models_or_publishing(self):
        for method in ["rip", "both"]:
            result = self.cli("other/hugging-face-jobs/scripts/cot-self-instruct.py", "--seed-dataset", "unused/source", "--output-dataset", "unused/destination", "--filter-method", method)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("RIP reward-model filtering is not implemented", result.stderr)
            with self.assertRaisesRegex(ValueError, "not implemented"):
                self.rip.create_dataset_card("reasoning", "source", "model", method, 10, 5, "date")
        with self.assertRaisesRegex(ValueError, "not implemented"):
            self.rip.rip_filter()
        self.assertFalse(any(name in sys.modules for name in ["torch", "vllm", "datasets"]))

    def test_supported_card_and_filter_modes(self):
        self.rip.validate_filter("answer-consistency", "reasoning")
        self.rip.validate_filter("none", "instruction")
        with self.assertRaisesRegex(ValueError, "requires reasoning"):
            self.rip.validate_filter("answer-consistency", "instruction")
        card = self.rip.create_dataset_card("reasoning", "source", "model", "answer-consistency", 10, 5, "date")
        self.assertIn("Answer-Consistency", card)
        self.assertNotIn("reward model", card)

    def test_venue_incomplete_report_and_bad_input_exit(self):
        pdf = self.root / "paper.pdf"
        pdf.write_bytes(b"%PDF-1.4\n% Offline margin-only fixture\n")
        report = self.root / "report.txt"
        result = self.cli("writing/venue-templates/scripts/validate_format.py", "--file", str(pdf), "--venue", "Nature", "--check", "margins", "--report", str(report))
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("VALIDATION INCOMPLETE", result.stdout)
        self.assertNotIn("PASSED", report.read_text())
        self.assertIn("Summary: INCOMPLETE", report.read_text())
        for args in [("--venue", "unknown"), ("--venue", "Nature", "--check", "unknown")]:
            result = self.cli("writing/venue-templates/scripts/validate_format.py", "--file", str(pdf), *args)
            self.assertEqual(result.returncode, 2)
        pdf.write_text("not a PDF")
        result = self.cli("writing/venue-templates/scripts/validate_format.py", "--file", str(pdf), "--venue", "Nature", "--check", "margins")
        self.assertEqual(result.returncode, 2)
        self.assertIn("not a PDF", result.stderr)

    def test_venue_performed_failed_and_skipped_checks_remain_distinct(self):
        self.assertEqual(self.venue.validation_status({}), "incomplete")
        self.assertEqual(self.venue.validation_status({"page-count": {"status": "skip"}}), "incomplete")
        with patch.object(self.venue, "get_pdf_info", return_value={"Pages": "2"}):
            passed = self.venue.check_page_count(None, {"page_limit": 3})
            failed = self.venue.check_page_count(None, {"page_limit": 1})
        self.assertEqual(self.venue.validation_status({"page-count": passed}), "passed")
        self.assertEqual(self.venue.validation_status({"page-count": failed}), "failed")
        self.assertEqual(self.venue.validation_status({"page-count": passed, "margins": {"status": "info"}}), "incomplete")


if __name__ == "__main__":
    unittest.main()
