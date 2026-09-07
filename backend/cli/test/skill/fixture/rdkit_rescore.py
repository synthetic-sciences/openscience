#!/usr/bin/env python3
"""Real RDKit checks for the local rescore helper; no model or service calls."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import platform
import subprocess
import sys

from rdkit import Chem, rdBase
from rdkit.Chem import AllChem


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[3] / "skills/chemistry/binding-affinity/scripts/rescore.py")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    source = args.source.resolve()
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=False)
    fixtures = root / "fixtures"
    fixtures.mkdir()

    ethanol = Chem.AddHs(Chem.MolFromSmiles("CCO"))
    assert AllChem.EmbedMolecule(ethanol, randomSeed=20260907) == 0
    ethanol.SetProp("_Name", "ethanol_explicit_h_3d")
    assert ethanol.GetConformer().Is3D()
    props = AllChem.MMFFGetMoleculeProperties(ethanol, mmffVariant="MMFF94")
    force = AllChem.MMFFGetMoleculeForceField(ethanol, props)
    energy = force.CalcEnergy()
    assert math.isfinite(energy)
    valid = Chem.MolToMolBlock(ethanol) + "\n$$$$\n"
    (fixtures / "ethanol.sdf").write_text(valid)

    uranium = Chem.MolFromSmiles("[U]")
    uranium.AddConformer(Chem.Conformer(1))
    uranium.SetProp("_Name", "uranium_without_mmff_parameters")
    assert AllChem.MMFFGetMoleculeProperties(uranium, mmffVariant="MMFF94") is None
    (fixtures / "unsupported.sdf").write_text(Chem.MolToMolBlock(uranium) + "\n$$$$\n")
    invalid = "malformed record\nnot a valid molfile\n$$$$\n"
    (fixtures / "malformed.sdf").write_text(invalid)
    (fixtures / "mixed.sdf").write_text(valid + invalid)
    (fixtures / "empty.sdf").write_text("")

    report = {
        "source": str(source),
        "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "python": sys.version,
        "executable": sys.executable,
        "platform": platform.platform(),
        "rdkit": rdBase.rdkitVersion,
        "reference_embedded_ethanol_mmff94_kcal": energy,
        "cases": [],
        "scope": "Numerical execution and attribution/error contracts only; not scientific validation of heuristic affinity or MM/GBSA.",
    }

    def run(name, fixture, method="ligand-heuristic", extra=()):
        work = root / name
        work.mkdir()
        command = [sys.executable, "-B", str(source), "--method", method,
                   "--poses", str(fixtures / fixture), "--output", "scores.json", *extra]
        result = subprocess.run(command, cwd=work, text=True, capture_output=True, timeout=30)
        (work / "stdout.txt").write_text(result.stdout)
        (work / "stderr.txt").write_text(result.stderr)
        data = json.loads((work / "scores.json").read_text()) if (work / "scores.json").exists() else None
        case = {"name": name, "command": command, "exit_code": result.returncode,
                "output_exists": data is not None,
                "manifest_exists": (work / "_script_manifest.jsonl").exists()}
        report["cases"].append(case)
        (root / "report.json").write_text(json.dumps(report, indent=2))
        return result, data, case

    result, data, case = run("success", "ethanol.sdf", extra=("--protein", "reference_not_read.pdb"))
    assert result.returncode == 0, result.stderr
    assert data["method"] == "ligand_energy_heuristic"
    assert data["receptor_used"] is False and data["score_units"] == "heuristic"
    assert data["protein_reference"] == "reference_not_read.pdb"
    assert "not MM/GBSA" in data["note"] and "unvalidated" in data["note"]
    assert data["n_poses"] == 1 and case["manifest_exists"]
    row = data["results"][0]
    assert row["status"] == "succeeded" and row["pose_name"] == ethanol.GetProp("_Name")
    assert all(math.isfinite(row[key]) for key in ("ligand_score", "mmff_energy_kcal", "descriptor_term"))
    # SDF serialization rounds coordinates, so compare within the declared 0.1 precision.
    assert abs(row["mmff_energy_kcal"] - energy) < 0.1
    assert "dG_mmgbsa_kcal" not in row and "binding_energy" not in row

    for name, fixture, error in (
        ("malformed", "malformed.sdf", "Invalid SDF molecule"),
        ("unparameterized", "unsupported.sdf", "parameters are unavailable"),
    ):
        result, data, case = run(name, fixture)
        assert result.returncode != 0 and not case["manifest_exists"]
        assert data is not None and data["n_poses"] == 1
        row = data["results"][0]
        assert row["status"] == "failed" and row["ligand_score"] is None
        assert error in row["error"] and "mmff_energy_kcal" not in row

    result, data, case = run("mixed", "mixed.sdf")
    assert result.returncode != 0 and not case["manifest_exists"]
    assert data["n_poses"] == 2
    assert [row["status"] for row in data["results"]] == ["succeeded", "failed"]
    assert math.isfinite(data["results"][0]["ligand_score"])
    assert data["results"][1]["ligand_score"] is None

    for name, fixture, method, extra in (
        ("empty", "empty.sdf", "ligand-heuristic", ()),
        ("missing", "missing.sdf", "ligand-heuristic", ()),
        ("unsupported_method", "missing.sdf", "mmgbsa", ()),
        ("unsupported_minimization", "ethanol.sdf", "ligand-heuristic", ("--minimize-steps", "5")),
        ("unsupported_gb", "ethanol.sdf", "ligand-heuristic", ("--gb-model", "OBC2")),
    ):
        result, data, case = run(name, fixture, method, extra)
        assert result.returncode != 0 and data is None and not case["manifest_exists"]
        assert "ERROR:" in result.stderr

    report["status"] = "passed"
    report["case_count"] = len(report["cases"])
    (root / "report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps({"status": "passed", "cases": len(report["cases"]), "rdkit": rdBase.rdkitVersion,
                      "report": str(root / "report.json")}, indent=2))


if __name__ == "__main__":
    main()
