#!/usr/bin/env python3
"""
Rank and summarize molecular docking results.

Combines docking scores with interaction quality metrics to produce
a composite ranking. Outputs a summary table of the top compounds
with their scores and key interactions.

Usage:
    python rank.py --scores scores.csv --interactions interactions.json --output ranked.csv
    python rank.py --scores scores.csv --interactions interactions.json --output ranked.csv --top-n 20
"""

import argparse
import csv
import json
import os
import sys
import warnings
from collections import defaultdict

warnings.filterwarnings("ignore")

try:
    import numpy as np
except ImportError:
    sys.exit("ERROR: NumPy is required. Install with: pip install numpy")


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------


def load_scores(scores_csv):
    """
    Load docking scores from CSV.

    Expected columns: pose_id, ligand_name, pose_rank, score, rmsd_lb, rmsd_ub
    """
    scores = []
    with open(scores_csv, "r") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                entry = {
                    "pose_id": int(row.get("pose_id", 0)),
                    "ligand_name": row.get("ligand_name", "unknown"),
                    "pose_rank": int(row.get("pose_rank", 0)),
                    "score": float(row.get("score", 0.0)),
                    "rmsd_lb": float(row.get("rmsd_lb", 0.0)),
                    "rmsd_ub": float(row.get("rmsd_ub", 0.0)),
                }
                scores.append(entry)
            except (ValueError, TypeError) as e:
                print(f"WARNING: Skipping malformed row: {row} ({e})")
    return scores


def load_interactions(interactions_path):
    """
    Load interaction data from JSON or CSV.

    Returns dict mapping pose_id -> interaction summary.
    """
    if not interactions_path or not os.path.exists(interactions_path):
        return {}

    ext = os.path.splitext(interactions_path)[1].lower()

    if ext == ".json":
        return _load_interactions_json(interactions_path)
    elif ext == ".csv":
        return _load_interactions_csv(interactions_path)
    else:
        # Try JSON first
        try:
            return _load_interactions_json(interactions_path)
        except (json.JSONDecodeError, KeyError):
            return _load_interactions_csv(interactions_path)


def _load_interactions_json(json_path):
    """Load interactions from the JSON format produced by score.py."""
    with open(json_path) as f:
        data = json.load(f)

    interaction_map = {}
    results = data.get("results", data) if isinstance(data, dict) else data

    if isinstance(results, dict):
        results = results.get("results", [])

    for pose_data in results:
        pose_id = pose_data.get("pose_id", 0)

        # Count interaction types
        n_hbonds = pose_data.get("n_hbonds", 0)
        n_hydrophobic = pose_data.get("n_hydrophobic", 0)
        n_pi_stacking = pose_data.get("n_pi_stacking", 0)
        n_salt_bridges = pose_data.get("n_salt_bridges", 0)
        n_halogen_bonds = pose_data.get("n_halogen_bonds", 0)
        n_total = pose_data.get("n_interactions", 0)

        # If counts not pre-computed, count from interactions list
        if n_total == 0 and "interactions" in pose_data:
            interactions = pose_data["interactions"]
            for inter in interactions:
                itype = inter.get("type", inter.get("interaction_type", ""))
                if "hydrogen" in itype or itype == "HBDonor" or itype == "HBAcceptor":
                    n_hbonds += 1
                elif "hydrophobic" in itype.lower():
                    n_hydrophobic += 1
                elif "pi" in itype.lower() or "stacking" in itype.lower():
                    n_pi_stacking += 1
                elif "salt" in itype.lower():
                    n_salt_bridges += 1
                elif "halogen" in itype.lower():
                    n_halogen_bonds += 1
            n_total = n_hbonds + n_hydrophobic + n_pi_stacking + n_salt_bridges + n_halogen_bonds

        # Collect key residues
        key_residues = set()
        for inter in pose_data.get("interactions", []):
            if "residue" in inter:
                key_residues.add(inter["residue"])

        interaction_map[pose_id] = {
            "n_hbonds": n_hbonds,
            "n_hydrophobic": n_hydrophobic,
            "n_pi_stacking": n_pi_stacking,
            "n_salt_bridges": n_salt_bridges,
            "n_halogen_bonds": n_halogen_bonds,
            "n_total": n_total,
            "key_residues": sorted(key_residues),
        }

    return interaction_map


def _load_interactions_csv(csv_path):
    """Load interactions from the CSV format produced by score.py."""
    interaction_map = defaultdict(lambda: {
        "n_hbonds": 0, "n_hydrophobic": 0, "n_pi_stacking": 0,
        "n_salt_bridges": 0, "n_halogen_bonds": 0, "n_total": 0,
        "key_residues": set(),
    })

    with open(csv_path) as f:
        reader = csv.DictReader(f)
        for row in reader:
            pose_id = int(row.get("pose_id", 0))
            itype = row.get("interaction_type", "").lower()

            if not itype:
                continue

            interaction_map[pose_id]["n_total"] += 1

            if "hydrogen" in itype or itype in ("hbdonor", "hbacceptor"):
                interaction_map[pose_id]["n_hbonds"] += 1
            elif "hydrophobic" in itype:
                interaction_map[pose_id]["n_hydrophobic"] += 1
            elif "pi" in itype or "stacking" in itype:
                interaction_map[pose_id]["n_pi_stacking"] += 1
            elif "salt" in itype:
                interaction_map[pose_id]["n_salt_bridges"] += 1
            elif "halogen" in itype:
                interaction_map[pose_id]["n_halogen_bonds"] += 1

            residue = row.get("residue", "")
            if residue:
                interaction_map[pose_id]["key_residues"].add(residue)

    # Convert sets to sorted lists
    for pose_id in interaction_map:
        interaction_map[pose_id]["key_residues"] = sorted(
            interaction_map[pose_id]["key_residues"]
        )

    return dict(interaction_map)


# ---------------------------------------------------------------------------
# Composite scoring
# ---------------------------------------------------------------------------


def compute_composite_scores(scores, interaction_map,
                             score_weight=0.6, interaction_weight=0.4):
    """
    Compute composite ranking by combining docking scores with
    interaction quality.

    The composite score is a weighted combination of:
    - Normalized docking score (more negative = better, normalized to [0, 1])
    - Interaction quality score based on:
        - Hydrogen bonds (weight 3.0)
        - Salt bridges (weight 2.5)
        - Pi-stacking (weight 2.0)
        - Hydrophobic contacts (weight 1.0, capped contribution)
        - Halogen bonds (weight 1.5)

    Parameters
    ----------
    scores : list
        Docking score entries from load_scores().
    interaction_map : dict
        Interaction data keyed by pose_id.
    score_weight : float
        Weight for the docking score component (0-1).
    interaction_weight : float
        Weight for the interaction quality component (0-1).

    Returns
    -------
    ranked : list
        Sorted list of result dicts with composite scores.
    """
    if not scores:
        return []

    # Extract valid docking scores
    valid_scores = [s["score"] for s in scores if not np.isnan(s["score"])]

    if not valid_scores:
        print("WARNING: No valid docking scores found.")
        return scores

    score_min = min(valid_scores)
    score_max = max(valid_scores)
    score_range = score_max - score_min if score_max != score_min else 1.0

    # Compute interaction quality scores
    max_interaction_score = 1.0  # will be normalized

    ranked = []
    for entry in scores:
        pose_id = entry["pose_id"]
        docking_score = entry["score"]

        # Normalize docking score: more negative = better -> higher normalized score
        if np.isnan(docking_score):
            norm_dock = 0.0
        else:
            norm_dock = (score_max - docking_score) / score_range

        # Interaction quality
        inter_data = interaction_map.get(pose_id, {})
        n_hbonds = inter_data.get("n_hbonds", 0)
        n_hydrophobic = inter_data.get("n_hydrophobic", 0)
        n_pi_stacking = inter_data.get("n_pi_stacking", 0)
        n_salt_bridges = inter_data.get("n_salt_bridges", 0)
        n_halogen_bonds = inter_data.get("n_halogen_bonds", 0)
        n_total = inter_data.get("n_total", 0)
        key_residues = inter_data.get("key_residues", [])

        # Weighted interaction score
        raw_interaction_score = (
            n_hbonds * 3.0
            + n_salt_bridges * 2.5
            + n_pi_stacking * 2.0
            + n_halogen_bonds * 1.5
            + min(n_hydrophobic, 10) * 1.0  # cap hydrophobic contribution
        )

        ranked.append({
            "pose_id": pose_id,
            "ligand_name": entry["ligand_name"],
            "pose_rank": entry["pose_rank"],
            "docking_score": docking_score,
            "rmsd_lb": entry.get("rmsd_lb", 0.0),
            "norm_dock_score": round(norm_dock, 4),
            "n_hbonds": n_hbonds,
            "n_hydrophobic": n_hydrophobic,
            "n_pi_stacking": n_pi_stacking,
            "n_salt_bridges": n_salt_bridges,
            "n_halogen_bonds": n_halogen_bonds,
            "n_total_interactions": n_total,
            "raw_interaction_score": round(raw_interaction_score, 2),
            "key_residues": "; ".join(key_residues) if key_residues else "",
        })

    # Normalize interaction scores
    max_raw = max(r["raw_interaction_score"] for r in ranked)
    if max_raw > 0:
        for r in ranked:
            r["norm_interaction_score"] = round(
                r["raw_interaction_score"] / max_raw, 4
            )
    else:
        for r in ranked:
            r["norm_interaction_score"] = 0.0

    # Composite score
    for r in ranked:
        r["composite_score"] = round(
            score_weight * r["norm_dock_score"]
            + interaction_weight * r["norm_interaction_score"],
            4,
        )

    # Sort by composite score (descending = best first)
    ranked.sort(key=lambda r: r["composite_score"], reverse=True)

    # Assign final rank
    for i, r in enumerate(ranked):
        r["final_rank"] = i + 1

    return ranked


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------


def write_ranked_output(ranked, output_path, top_n=None):
    """Write ranked results to CSV."""
    if top_n:
        ranked = ranked[:top_n]

    fieldnames = [
        "final_rank", "pose_id", "ligand_name", "pose_rank",
        "docking_score", "composite_score",
        "n_hbonds", "n_hydrophobic", "n_pi_stacking",
        "n_salt_bridges", "n_halogen_bonds", "n_total_interactions",
        "norm_dock_score", "norm_interaction_score",
        "raw_interaction_score", "rmsd_lb", "key_residues",
    ]

    with open(output_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(ranked)


def print_ranked_table(ranked, top_n=10):
    """Print a formatted ranking table to stdout."""
    display = ranked[:top_n]

    print()
    header = (
        f"{'Rank':<6} {'Ligand':<18} {'Dock Score':<12} "
        f"{'Composite':<11} {'HB':<4} {'Hydr':<5} {'Pi':<4} "
        f"{'Salt':<5} {'Total':<6} {'Key Residues'}"
    )
    print(header)
    print("-" * min(len(header) + 20, 120))

    for r in display:
        residues_str = r.get("key_residues", "")
        if len(residues_str) > 30:
            residues_str = residues_str[:27] + "..."

        print(
            f"{r['final_rank']:<6} "
            f"{r['ligand_name']:<18} "
            f"{r['docking_score']:<12.3f} "
            f"{r['composite_score']:<11.4f} "
            f"{r['n_hbonds']:<4} "
            f"{r['n_hydrophobic']:<5} "
            f"{r['n_pi_stacking']:<4} "
            f"{r['n_salt_bridges']:<5} "
            f"{r['n_total_interactions']:<6} "
            f"{residues_str}"
        )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def rank_results(scores_csv, interactions_path, output_csv, top_n=10):
    """
    Main ranking pipeline.

    Load scores and interactions, compute composite ranking,
    write output, and print summary.
    """
    print("=" * 60)
    print("DOCKING RESULT RANKING")
    print("=" * 60)
    print(f"Scores: {scores_csv}")
    print(f"Interactions: {interactions_path or 'not provided'}")
    print(f"Output: {output_csv}")
    print(f"Top N: {top_n}")
    print()

    # Load data
    scores = load_scores(scores_csv)
    if not scores:
        sys.exit("ERROR: No valid scores found in CSV.")

    print(f"Loaded {len(scores)} pose score(s)")

    interaction_map = {}
    if interactions_path and os.path.exists(interactions_path):
        interaction_map = load_interactions(interactions_path)
        print(f"Loaded interaction data for {len(interaction_map)} pose(s)")

        if not interaction_map:
            print("WARNING: Interaction file loaded but no data parsed.")
    else:
        print("No interaction data provided. Ranking by docking score only.")

    print()

    # Compute composite ranking
    if interaction_map:
        ranked = compute_composite_scores(scores, interaction_map)
    else:
        # Rank by docking score alone
        ranked = []
        for entry in scores:
            ranked.append({
                "pose_id": entry["pose_id"],
                "ligand_name": entry["ligand_name"],
                "pose_rank": entry["pose_rank"],
                "docking_score": entry["score"],
                "rmsd_lb": entry.get("rmsd_lb", 0.0),
                "composite_score": entry["score"],  # just use raw score
                "norm_dock_score": 0.0,
                "norm_interaction_score": 0.0,
                "raw_interaction_score": 0.0,
                "n_hbonds": 0,
                "n_hydrophobic": 0,
                "n_pi_stacking": 0,
                "n_salt_bridges": 0,
                "n_halogen_bonds": 0,
                "n_total_interactions": 0,
                "key_residues": "",
            })
        ranked.sort(key=lambda r: r["docking_score"])
        for i, r in enumerate(ranked):
            r["final_rank"] = i + 1

    # Write output
    write_ranked_output(ranked, output_csv, top_n=None)

    # Print summary
    print_ranked_table(ranked, top_n=top_n)

    print()
    print(f"Full ranked results ({len(ranked)} entries) saved to: {output_csv}")
    print()

    # Summary statistics
    if ranked:
        dock_scores = [r["docking_score"] for r in ranked if not np.isnan(r["docking_score"])]
        if dock_scores:
            print("Score statistics:")
            print(f"  Best docking score: {min(dock_scores):.3f} kcal/mol")
            print(f"  Mean docking score: {np.mean(dock_scores):.3f} kcal/mol")
            print(f"  Worst docking score: {max(dock_scores):.3f} kcal/mol")

        if interaction_map:
            total_ints = [r["n_total_interactions"] for r in ranked]
            print(f"  Mean interactions per pose: {np.mean(total_ints):.1f}")
            print(f"  Max interactions: {max(total_ints)}")

    return ranked


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(
        description="Rank molecular docking results by combining docking scores "
                    "with interaction quality metrics into a composite ranking.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Basic ranking
  python rank.py --scores scores.csv --interactions interactions.json \\
      --output ranked.csv --top-n 10

  # Rank without interaction data (score-only ranking)
  python rank.py --scores scores.csv --output ranked.csv

  # Show top 20
  python rank.py --scores scores.csv --interactions interactions.json \\
      --output ranked.csv --top-n 20
        """,
    )
    parser.add_argument(
        "--scores", required=True,
        help="Docking scores CSV (from dock.py)",
    )
    parser.add_argument(
        "--interactions", default=None,
        help="Interaction analysis file (JSON or CSV from score.py)",
    )
    parser.add_argument(
        "--output", required=True,
        help="Output ranked summary CSV",
    )
    parser.add_argument(
        "--top-n", type=int, default=10,
        help="Number of top results to display (default: 10). "
             "All results are saved to the output file.",
    )

    args = parser.parse_args()

    if not os.path.exists(args.scores):
        sys.exit(f"ERROR: Scores file not found: {args.scores}")

    output_dir = os.path.dirname(args.output)
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)

    rank_results(
        scores_csv=args.scores,
        interactions_path=args.interactions,
        output_csv=args.output,
        top_n=args.top_n,
    )


if __name__ == "__main__":
    main()
