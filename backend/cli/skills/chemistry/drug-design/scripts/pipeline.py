#!/usr/bin/env python3
"""
Drug discovery pipeline orchestrator.

Deterministic script that auto-chains structure prediction, pocket detection,
de novo design, docking, scoring, and ADMET filtering into reproducible
workflows. Each stage runs as a subprocess — failures stop the pipeline
immediately with clear diagnostics.

Modes:
  full      Target → structure → pockets → de novo → filter → dock → score → affinity → consensus
  lead-opt  Existing hit → analogs → filter → dock → affinity → consensus
  screen    Library → pocket detection → batch scoring → dock top hits → consensus
  assess    Protein → pocket detection → druggability → visualization
  denovo    Pocket → SBDD generation → fragment generation → filter → dock → consensus

Usage:
  python pipeline.py --mode full --protein target.pdb --output-dir results/
  python pipeline.py --mode lead-opt --protein target.pdb --ligand hit.sdf --output-dir results/
  python pipeline.py --mode screen --protein target.pdb --library compounds.sdf --output-dir results/
  python pipeline.py --mode assess --protein target.pdb --output-dir results/
  python pipeline.py --mode denovo --protein target.pdb --output-dir results/
"""

import argparse
import json
import os
import subprocess
import sys
import time


# ---------------------------------------------------------------------------
# Script path resolution
# ---------------------------------------------------------------------------

def resolve_skills_dir():
    """
    Find the skills directory. Priority:
    1. OPENSCIENCE_SKILLS_DIR environment variable
    2. Relative to this script (../../ from drug-design/scripts/)
    3. ~/.cache/openscience/skills/
    """
    env_dir = os.environ.get("OPENSCIENCE_SKILLS_DIR")
    if env_dir and os.path.isdir(env_dir):
        return env_dir

    # Relative: this script is at skills/drug-design/scripts/pipeline.py
    # Skills root is at skills/
    script_dir = os.path.dirname(os.path.abspath(__file__))
    relative_root = os.path.join(script_dir, "..", "..")
    if os.path.isdir(os.path.join(relative_root, "pocket-detection")):
        return os.path.realpath(relative_root)

    cache_dir = os.path.expanduser("~/.cache/openscience/skills")
    if os.path.isdir(cache_dir):
        return cache_dir

    return None


def find_script(skills_dir, skill_name, script_name):
    """Resolve a script path within a skill directory."""
    path = os.path.join(skills_dir, skill_name, "scripts", script_name)
    if os.path.isfile(path):
        return path
    return None


# ---------------------------------------------------------------------------
# Output guard (path containment + manifest logging)
# ---------------------------------------------------------------------------

def validate_output_dir(output_dir):
    """Ensure output directory is within CWD."""
    cwd = os.path.realpath(os.getcwd())
    resolved = os.path.realpath(os.path.join(cwd, output_dir))
    if not resolved.startswith(cwd + os.sep) and resolved != cwd:
        print(f"ERROR: Output directory escapes working directory.", file=sys.stderr)
        print(f"  CWD:      {cwd}", file=sys.stderr)
        print(f"  Resolved: {resolved}", file=sys.stderr)
        sys.exit(1)
    return resolved


def log_to_manifest(script_name, args_dict, output_path, stage_name):
    """Append to _script_manifest.jsonl in the working directory."""
    manifest_path = os.path.join(os.getcwd(), "_script_manifest.jsonl")
    entry = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "script": script_name,
        "pipeline_stage": stage_name,
        "args": args_dict,
        "output": os.path.relpath(output_path, os.getcwd()),
    }
    with open(manifest_path, "a") as f:
        f.write(json.dumps(entry) + "\n")


# ---------------------------------------------------------------------------
# Stage runner
# ---------------------------------------------------------------------------

class PipelineStage:
    """A single pipeline stage: runs a script and validates its output."""

    def __init__(self, name, skill, script, args, expected_output, schema_check=None, fatal=True):
        self.name = name
        self.skill = skill
        self.script = script
        self.args = args
        self.expected_output = expected_output
        self.schema_check = schema_check
        self.fatal = fatal
        self.elapsed = 0
        self.status = "pending"

    def run(self, skills_dir):
        """Execute the stage. Returns True on success, False on failure."""
        script_path = find_script(skills_dir, self.skill, self.script)
        if script_path is None:
            print(f"  ERROR: Script not found: {self.skill}/scripts/{self.script}")
            self.status = "missing"
            return False

        cmd = [sys.executable, script_path] + self.args
        print(f"  Running: {self.script} {' '.join(self.args)}")

        start = time.time()
        result = subprocess.run(cmd, capture_output=True, text=True)
        self.elapsed = time.time() - start

        if result.returncode != 0:
            print(f"  FAILED (exit code {result.returncode}, {self.elapsed:.1f}s)")
            if result.stderr:
                for line in result.stderr.strip().split("\n")[-10:]:
                    print(f"    {line}")
            self.status = "failed"
            return False

        # Print stdout summary (last 5 lines)
        if result.stdout:
            lines = result.stdout.strip().split("\n")
            for line in lines[-5:]:
                print(f"    {line}")

        # Check expected output exists
        if self.expected_output and not os.path.exists(self.expected_output):
            print(f"  FAILED: Expected output not found: {self.expected_output}")
            self.status = "no_output"
            return False

        # Schema validation
        if self.schema_check and self.expected_output:
            ok, msg = self.schema_check(self.expected_output)
            if not ok:
                print(f"  FAILED: Schema validation: {msg}")
                self.status = "bad_schema"
                return False

        # Log to manifest
        args_dict = {}
        i = 0
        while i < len(self.args):
            if self.args[i].startswith("--"):
                key = self.args[i]
                if i + 1 < len(self.args) and not self.args[i + 1].startswith("--"):
                    args_dict[key] = self.args[i + 1]
                    i += 2
                else:
                    args_dict[key] = "true"
                    i += 1
            else:
                i += 1

        if self.expected_output:
            log_to_manifest(self.script, args_dict, self.expected_output, self.name)

        self.status = "ok"
        print(f"  OK ({self.elapsed:.1f}s)")
        return True


# ---------------------------------------------------------------------------
# Schema validators
# ---------------------------------------------------------------------------

def check_pockets_json(path):
    """Verify pockets JSON has the fields dock.py expects."""
    try:
        with open(path) as f:
            data = json.load(f)
        if "pockets" not in data:
            return False, "missing 'pockets' key"
        if not data["pockets"]:
            return False, "'pockets' array is empty"
        first = data["pockets"][0]
        if "center" not in first:
            return False, "first pocket missing 'center' field"
        center = first["center"]
        if not isinstance(center, list) or len(center) != 3:
            return False, f"'center' must be [x, y, z], got {center}"
        return True, ""
    except Exception as e:
        return False, str(e)


def check_affinity_json(path):
    """Verify affinity JSON has predictions array."""
    try:
        with open(path) as f:
            data = json.load(f)
        if "predictions" not in data:
            return False, "missing 'predictions' key"
        return True, ""
    except Exception as e:
        return False, str(e)


def check_consensus_json(path):
    """Verify consensus JSON has rankings array."""
    try:
        with open(path) as f:
            data = json.load(f)
        if "rankings" not in data:
            return False, "missing 'rankings' key"
        return True, ""
    except Exception as e:
        return False, str(e)


def check_druggability_json(path):
    """Verify druggability JSON has scored pockets."""
    try:
        with open(path) as f:
            data = json.load(f)
        if "pockets" not in data:
            return False, "missing 'pockets' key"
        if data["pockets"] and "druggability_score" not in data["pockets"][0]:
            return False, "first pocket missing 'druggability_score'"
        return True, ""
    except Exception as e:
        return False, str(e)


def check_file_exists(path):
    """Simple existence check for non-JSON outputs."""
    if os.path.exists(path):
        return True, ""
    return False, f"file not found: {path}"


# ---------------------------------------------------------------------------
# Pipeline builders
# ---------------------------------------------------------------------------

def build_full_pipeline(args, output_dir):
    """Full drug discovery: target → structure → pockets → design → dock → score → rank."""
    stages = []
    skip = set(args.skip.split(",")) if args.skip else set()

    protein = args.protein
    pockets = os.path.join(output_dir, "pockets.json")
    druggability = os.path.join(output_dir, "druggability.json")
    candidates = os.path.join(output_dir, "candidates.sdf")
    filtered = os.path.join(output_dir, "filtered.sdf")
    dock_dir = os.path.join(output_dir, "docking")
    poses = os.path.join(dock_dir, "poses.sdf")
    scores_csv = os.path.join(dock_dir, "scores.csv")
    interactions = os.path.join(output_dir, "interactions.json")
    affinity = os.path.join(output_dir, "affinity.json")
    mmgbsa = os.path.join(output_dir, "mmgbsa.json")
    consensus = os.path.join(output_dir, "consensus.json")
    viz_html = os.path.join(output_dir, "complex_3d.html")

    # Structure prediction (only if sequence provided and no PDB)
    if args.sequence and "structure-prediction" not in skip:
        predicted_pdb = os.path.join(output_dir, "predicted_structure.pdb")
        stages.append(PipelineStage(
            "structure-prediction", "structure-prediction", "predict.py",
            ["--sequence", args.sequence, "--output", predicted_pdb],
            predicted_pdb, check_file_exists,
        ))
        protein = predicted_pdb

    # Pocket detection
    if args.pocket:
        pockets = args.pocket
    elif "pocket-detection" not in skip:
        stages.append(PipelineStage(
            "pocket-detection", "pocket-detection", "detect.py",
            ["--input", protein, "--output", pockets],
            pockets, check_pockets_json,
        ))

    # Druggability
    if "druggability" not in skip:
        stages.append(PipelineStage(
            "druggability", "pocket-detection", "druggability.py",
            ["--input", protein, "--pockets", pockets, "--output", druggability],
            druggability, check_druggability_json,
        ))

    # De novo design
    if "denovo" not in skip:
        stages.append(PipelineStage(
            "denovo-design", "denovo-design", "generate_sbdd.py",
            ["--protein", protein, "--pockets", pockets, "--output", candidates,
             "--n-molecules", str(args.top_n * 5)],
            candidates, check_file_exists,
        ))

    # Drug-likeness filter
    if "filter" not in skip:
        input_sdf = candidates
        if args.ligand and "denovo" in skip:
            input_sdf = args.ligand
        stages.append(PipelineStage(
            "filter", "denovo-design", "filter.py",
            ["--input", input_sdf, "--output", filtered, "--filters", "lipinski,pains,brenk"],
            filtered, check_file_exists,
        ))

    # Docking
    if "docking" not in skip:
        os.makedirs(dock_dir, exist_ok=True)
        dock_args = [
            "--protein", protein,
            "--ligand", filtered if os.path.exists(filtered) else candidates,
            "--output-dir", dock_dir,
            "--method", args.docking_method,
        ]
        if args.pocket or os.path.exists(pockets):
            dock_args += ["--pockets", pockets if os.path.exists(pockets) else args.pocket]
        stages.append(PipelineStage(
            "docking", "molecular-docking", "dock.py",
            dock_args, poses, check_file_exists,
        ))

    # Interaction scoring
    if "scoring" not in skip:
        stages.append(PipelineStage(
            "interaction-scoring", "molecular-docking", "score.py",
            ["--protein", protein, "--poses", poses, "--output", interactions],
            interactions, check_file_exists,
        ))

    # Binding affinity prediction
    if "affinity" not in skip:
        stages.append(PipelineStage(
            "affinity-prediction", "binding-affinity", "predict.py",
            ["--protein", protein, "--poses", poses, "--output", affinity],
            affinity, check_affinity_json,
        ))

    # MM/GBSA rescoring
    if "rescore" not in skip:
        stages.append(PipelineStage(
            "mmgbsa-rescore", "binding-affinity", "rescore.py",
            ["--protein", protein, "--poses", poses, "--output", mmgbsa],
            mmgbsa, check_file_exists,
        ))

    # Consensus ranking
    if "consensus" not in skip:
        score_files = []
        if os.path.exists(affinity) or "affinity" not in skip:
            score_files.append(affinity)
        if os.path.exists(mmgbsa) or "rescore" not in skip:
            score_files.append(mmgbsa)
        consensus_args = ["--scores"] + score_files + ["--output", consensus, "--top-n", str(args.top_n)]
        if os.path.exists(scores_csv) or "docking" not in skip:
            consensus_args += ["--docking-scores", scores_csv]
        if os.path.exists(interactions) or "scoring" not in skip:
            consensus_args += ["--interactions", interactions]
        stages.append(PipelineStage(
            "consensus", "binding-affinity", "consensus.py",
            consensus_args, consensus, check_consensus_json,
        ))

    # Visualization (non-fatal — missing matplotlib shouldn't crash the pipeline)
    if "visualization" not in skip:
        stages.append(PipelineStage(
            "visualization", "molecule-visualization", "render_3d.py",
            ["--input", protein, "--ligand", poses, "--output", viz_html],
            viz_html, check_file_exists, fatal=False,
        ))

    return stages


def build_lead_opt_pipeline(args, output_dir):
    """Lead optimization: existing hit → analogs → filter → dock → score → rank."""
    stages = []
    skip = set(args.skip.split(",")) if args.skip else set()

    protein = args.protein
    analogs = os.path.join(output_dir, "analogs.sdf")
    filtered = os.path.join(output_dir, "filtered.sdf")
    dock_dir = os.path.join(output_dir, "docking")
    poses = os.path.join(dock_dir, "poses.sdf")
    affinity = os.path.join(output_dir, "affinity.json")
    consensus = os.path.join(output_dir, "consensus.json")

    if not args.ligand:
        print("ERROR: --ligand is required for lead-opt mode", file=sys.stderr)
        sys.exit(1)

    # Analog generation
    if "analogs" not in skip:
        stages.append(PipelineStage(
            "analog-generation", "denovo-design", "generate_analogs.py",
            ["--input", args.ligand, "--output", analogs,
             "--n-analogs", str(args.top_n * 5)],
            analogs, check_file_exists,
        ))

    # Filter
    if "filter" not in skip:
        stages.append(PipelineStage(
            "filter", "denovo-design", "filter.py",
            ["--input", analogs, "--output", filtered, "--filters", "lipinski,pains"],
            filtered, check_file_exists,
        ))

    # Docking
    if "docking" not in skip:
        os.makedirs(dock_dir, exist_ok=True)
        dock_args = ["--protein", protein, "--ligand", filtered,
                     "--output-dir", dock_dir, "--method", args.docking_method]
        if args.pocket:
            dock_args += ["--pockets", args.pocket]
        stages.append(PipelineStage(
            "docking", "molecular-docking", "dock.py",
            dock_args, poses, check_file_exists,
        ))

    # Affinity
    if "affinity" not in skip:
        stages.append(PipelineStage(
            "affinity-prediction", "binding-affinity", "predict.py",
            ["--protein", protein, "--poses", poses, "--output", affinity],
            affinity, check_affinity_json,
        ))

    # Consensus
    if "consensus" not in skip:
        stages.append(PipelineStage(
            "consensus", "binding-affinity", "consensus.py",
            ["--scores", affinity, "--output", consensus, "--top-n", str(args.top_n)],
            consensus, check_consensus_json,
        ))

    return stages


def build_screen_pipeline(args, output_dir):
    """Virtual screening: library → pocket detection → batch score → dock top hits → rank."""
    stages = []
    skip = set(args.skip.split(",")) if args.skip else set()

    protein = args.protein
    pockets = os.path.join(output_dir, "pockets.json")
    hits_csv = os.path.join(output_dir, "screening_hits.csv")
    dock_dir = os.path.join(output_dir, "docking")
    poses = os.path.join(dock_dir, "poses.sdf")
    affinity = os.path.join(output_dir, "affinity.json")
    consensus = os.path.join(output_dir, "consensus.json")

    if not args.library:
        print("ERROR: --library is required for screen mode", file=sys.stderr)
        sys.exit(1)

    # Pocket detection
    if args.pocket:
        pockets = args.pocket
    elif "pocket-detection" not in skip:
        stages.append(PipelineStage(
            "pocket-detection", "pocket-detection", "detect.py",
            ["--input", protein, "--output", pockets],
            pockets, check_pockets_json,
        ))

    # Batch scoring
    if "batch" not in skip:
        stages.append(PipelineStage(
            "batch-scoring", "binding-affinity", "batch.py",
            ["--protein", protein, "--library", args.library,
             "--output", hits_csv, "--top-n", str(args.top_n)],
            hits_csv, check_file_exists,
        ))

    # Dock top hits
    if "docking" not in skip:
        os.makedirs(dock_dir, exist_ok=True)
        dock_args = ["--protein", protein, "--ligand", hits_csv,
                     "--output-dir", dock_dir, "--method", args.docking_method]
        if args.pocket or os.path.exists(pockets):
            dock_args += ["--pockets", pockets if os.path.exists(pockets) else args.pocket]
        stages.append(PipelineStage(
            "docking", "molecular-docking", "dock.py",
            dock_args, poses, check_file_exists,
        ))

    # Affinity
    if "affinity" not in skip:
        stages.append(PipelineStage(
            "affinity-prediction", "binding-affinity", "predict.py",
            ["--protein", protein, "--poses", poses, "--output", affinity],
            affinity, check_affinity_json,
        ))

    # Consensus
    if "consensus" not in skip:
        stages.append(PipelineStage(
            "consensus", "binding-affinity", "consensus.py",
            ["--scores", affinity, "--output", consensus, "--top-n", str(args.top_n)],
            consensus, check_consensus_json,
        ))

    return stages


def build_assess_pipeline(args, output_dir):
    """Target assessment: protein → pockets → druggability → visualization."""
    stages = []
    skip = set(args.skip.split(",")) if args.skip else set()

    protein = args.protein
    pockets = os.path.join(output_dir, "pockets.json")
    druggability = os.path.join(output_dir, "druggability.json")
    summary_png = os.path.join(output_dir, "pocket_summary.png")
    radar_png = os.path.join(output_dir, "druggability_radar.png")
    viz_html = os.path.join(output_dir, "protein_3d.html")

    # Structure prediction
    if args.sequence and "structure-prediction" not in skip:
        predicted_pdb = os.path.join(output_dir, "predicted_structure.pdb")
        stages.append(PipelineStage(
            "structure-prediction", "structure-prediction", "predict.py",
            ["--sequence", args.sequence, "--output", predicted_pdb],
            predicted_pdb, check_file_exists,
        ))
        protein = predicted_pdb

    # Pocket detection
    if "pocket-detection" not in skip:
        stages.append(PipelineStage(
            "pocket-detection", "pocket-detection", "detect.py",
            ["--input", protein, "--output", pockets],
            pockets, check_pockets_json,
        ))

    # Druggability
    if "druggability" not in skip:
        stages.append(PipelineStage(
            "druggability", "pocket-detection", "druggability.py",
            ["--input", protein, "--pockets", pockets, "--output", druggability],
            druggability, check_druggability_json,
        ))

    # Visualization: summary (non-fatal — missing matplotlib shouldn't crash the pipeline)
    if "visualization" not in skip:
        stages.append(PipelineStage(
            "pocket-summary", "pocket-detection", "visualize.py",
            ["--input", protein, "--pockets", druggability,
             "--output", summary_png, "--plot-type", "summary"],
            summary_png, check_file_exists, fatal=False,
        ))
        stages.append(PipelineStage(
            "druggability-radar", "pocket-detection", "visualize.py",
            ["--input", protein, "--pockets", druggability,
             "--output", radar_png, "--plot-type", "druggability-radar"],
            radar_png, check_file_exists, fatal=False,
        ))

    # 3D view (non-fatal)
    if "visualization" not in skip:
        stages.append(PipelineStage(
            "3d-view", "molecule-visualization", "render_3d.py",
            ["--input", protein, "--output", viz_html],
            viz_html, check_file_exists, fatal=False,
        ))

    return stages


def build_denovo_pipeline(args, output_dir):
    """De novo design: pocket → SBDD → fragments → filter → dock → rank."""
    stages = []
    skip = set(args.skip.split(",")) if args.skip else set()

    protein = args.protein
    pockets = os.path.join(output_dir, "pockets.json")
    candidates_sbdd = os.path.join(output_dir, "candidates_sbdd.sdf")
    candidates_frag = os.path.join(output_dir, "candidates_frag.sdf")
    filtered = os.path.join(output_dir, "filtered.sdf")
    dock_dir = os.path.join(output_dir, "docking")
    poses = os.path.join(dock_dir, "poses.sdf")
    affinity = os.path.join(output_dir, "affinity.json")
    consensus = os.path.join(output_dir, "consensus.json")

    # Pocket detection
    if args.pocket:
        pockets = args.pocket
    elif "pocket-detection" not in skip:
        stages.append(PipelineStage(
            "pocket-detection", "pocket-detection", "detect.py",
            ["--input", protein, "--output", pockets],
            pockets, check_pockets_json,
        ))

    # SBDD generation
    if "sbdd" not in skip:
        stages.append(PipelineStage(
            "sbdd-generation", "denovo-design", "generate_sbdd.py",
            ["--protein", protein, "--pockets", pockets, "--output", candidates_sbdd,
             "--n-molecules", str(args.top_n * 5)],
            candidates_sbdd, check_file_exists,
        ))

    # Fragment generation
    if "fragments" not in skip:
        stages.append(PipelineStage(
            "fragment-generation", "denovo-design", "generate_fragments.py",
            ["--protein", protein, "--pockets", pockets, "--output", candidates_frag,
             "--mode", "grow", "--n-molecules", str(args.top_n * 3)],
            candidates_frag, check_file_exists,
        ))

    # Filter (merge candidates then filter)
    if "filter" not in skip:
        # Use whichever candidate file exists
        input_sdf = candidates_sbdd
        stages.append(PipelineStage(
            "filter", "denovo-design", "filter.py",
            ["--input", input_sdf, "--output", filtered, "--filters", "lipinski,pains,brenk"],
            filtered, check_file_exists,
        ))

    # Docking
    if "docking" not in skip:
        os.makedirs(dock_dir, exist_ok=True)
        dock_args = ["--protein", protein, "--ligand", filtered,
                     "--output-dir", dock_dir, "--method", args.docking_method]
        if args.pocket or os.path.exists(pockets):
            dock_args += ["--pockets", pockets if os.path.exists(pockets) else args.pocket]
        stages.append(PipelineStage(
            "docking", "molecular-docking", "dock.py",
            dock_args, poses, check_file_exists,
        ))

    # Affinity
    if "affinity" not in skip:
        stages.append(PipelineStage(
            "affinity-prediction", "binding-affinity", "predict.py",
            ["--protein", protein, "--poses", poses, "--output", affinity],
            affinity, check_affinity_json,
        ))

    # Consensus
    if "consensus" not in skip:
        stages.append(PipelineStage(
            "consensus", "binding-affinity", "consensus.py",
            ["--scores", affinity, "--output", consensus, "--top-n", str(args.top_n)],
            consensus, check_consensus_json,
        ))

    return stages


# ---------------------------------------------------------------------------
# Pipeline runner
# ---------------------------------------------------------------------------

def run_pipeline(stages, skills_dir, output_dir):
    """Execute all stages sequentially. Stop on first failure."""
    total = len(stages)
    report = {
        "pipeline_start": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "skills_dir": skills_dir,
        "output_dir": output_dir,
        "stages": [],
    }

    passed = 0
    for i, stage in enumerate(stages):
        print(f"\n[{i + 1}/{total}] {stage.name}")
        ok = stage.run(skills_dir)
        report["stages"].append({
            "name": stage.name,
            "script": f"{stage.skill}/scripts/{stage.script}",
            "status": stage.status,
            "elapsed_s": round(stage.elapsed, 1),
            "output": stage.expected_output,
        })

        if not ok:
            if stage.fatal:
                print(f"\nPIPELINE FAILED at stage '{stage.name}'")
                report["status"] = "failed"
                report["failed_stage"] = stage.name
                break
            else:
                print(f"  SKIPPED (non-fatal): {stage.name}")
                continue
        passed += 1

    if passed == total:
        report["status"] = "completed"
        print(f"\nPIPELINE COMPLETED: {passed}/{total} stages passed")
    else:
        print(f"\nPIPELINE STOPPED: {passed}/{total} stages passed")

    report["pipeline_end"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    # Write pipeline report
    report_path = os.path.join(output_dir, "pipeline_report.json")
    with open(report_path, "w") as f:
        json.dump(report, f, indent=2)
    print(f"\nPipeline report: {report_path}")

    return report["status"] == "completed"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Drug discovery pipeline orchestrator.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Modes:
  full      Target → structure → pockets → design → dock → score → rank
  lead-opt  Existing hit → analogs → filter → dock → score → rank
  screen    Library → pockets → batch score → dock hits → rank
  assess    Protein → pockets → druggability → visualization
  denovo    Pocket → SBDD → fragments → filter → dock → rank

Examples:
  %(prog)s --mode full --protein target.pdb --output-dir results/
  %(prog)s --mode lead-opt --protein target.pdb --ligand hit.sdf --output-dir results/
  %(prog)s --mode screen --protein target.pdb --library compounds.sdf --output-dir results/
  %(prog)s --mode assess --protein target.pdb --output-dir results/
  %(prog)s --mode denovo --protein target.pdb --output-dir results/
        """,
    )

    parser.add_argument("--mode", required=True,
                        choices=["full", "lead-opt", "screen", "assess", "denovo"],
                        help="Pipeline mode.")
    parser.add_argument("--protein", help="Input PDB file.")
    parser.add_argument("--sequence", help="Protein sequence (triggers structure prediction).")
    parser.add_argument("--ligand", help="Input ligand SDF/SMILES (for lead-opt).")
    parser.add_argument("--library", help="Compound library SDF (for screen mode).")
    parser.add_argument("--pocket", help="Pre-computed pocket JSON file.")
    parser.add_argument("--output-dir", default="./pipeline_results/",
                        help="Output directory (default: ./pipeline_results/).")
    parser.add_argument("--skip", default="",
                        help="Comma-separated stages to skip (e.g., 'structure-prediction,visualization').")
    parser.add_argument("--top-n", type=int, default=10,
                        help="Number of top compounds to carry forward (default: 10).")
    parser.add_argument("--docking-method", default="vina", choices=["vina", "diffdock"],
                        help="Docking method (default: vina).")

    args = parser.parse_args()

    # Validate inputs
    if not args.protein and not args.sequence:
        parser.error("Either --protein or --sequence is required.")

    if args.protein and not os.path.exists(args.protein):
        parser.error(f"Protein file not found: {args.protein}")

    if args.ligand and os.path.isfile(args.ligand) and not os.path.exists(args.ligand):
        parser.error(f"Ligand file not found: {args.ligand}")

    if args.library and not os.path.exists(args.library):
        parser.error(f"Library file not found: {args.library}")

    # Resolve skills directory
    skills_dir = resolve_skills_dir()
    if skills_dir is None:
        print("ERROR: Cannot find skills directory.", file=sys.stderr)
        print("  Set OPENSCIENCE_SKILLS_DIR or ensure this script is within the skills tree.",
              file=sys.stderr)
        sys.exit(1)

    print(f"Skills directory: {skills_dir}")

    # Validate and create output directory
    output_dir = validate_output_dir(args.output_dir)
    os.makedirs(output_dir, exist_ok=True)
    print(f"Output directory: {output_dir}")

    # Build pipeline stages
    builders = {
        "full": build_full_pipeline,
        "lead-opt": build_lead_opt_pipeline,
        "screen": build_screen_pipeline,
        "assess": build_assess_pipeline,
        "denovo": build_denovo_pipeline,
    }

    stages = builders[args.mode](args, output_dir)

    if not stages:
        print("No stages to run (all skipped?).")
        sys.exit(0)

    print(f"\nPipeline: {args.mode} ({len(stages)} stages)")
    for i, s in enumerate(stages):
        print(f"  {i + 1}. {s.name}")

    # Run
    ok = run_pipeline(stages, skills_dir, output_dir)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
