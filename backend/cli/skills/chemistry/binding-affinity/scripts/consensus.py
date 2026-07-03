#!/usr/bin/env python3
"""
Multi-method consensus scoring for binding affinity.

Combines predictions from predict.py, rescore.py, dock.py scores, and
score.py interactions into a single rank-normalized consensus.

Usage:
    python consensus.py --scores affinity.json mmgbsa.json --output consensus.json
    python consensus.py --scores affinity.json --docking-scores scores.csv --interactions interactions.json --output consensus.json
"""

import argparse
import csv
import json
import math
import os
import sys
import warnings
from collections import defaultdict

from output_guard import validate_output_path, log_to_manifest

warnings.filterwarnings("ignore")

try:
    import numpy as np
except ImportError:
    sys.exit("ERROR: NumPy is required. Install with: pip install numpy")


# ---------------------------------------------------------------------------
# Score loading
# ---------------------------------------------------------------------------


def load_predict_scores(path):
    """Load predictions from predict.py output."""
    with open(path) as f:
        data = json.load(f)
    scores = {}
    for pred in data.get("predictions", []):
        key = pred.get("pose_id", pred.get("pose_name"))
        scores[key] = {
            "value": pred.get("predicted_pKd", 0),
            "pose_name": pred.get("pose_name", ""),
            "higher_is_better": True,
        }
    return "predict", scores


def load_rescore_scores(path):
    """Load results from rescore.py output."""
    with open(path) as f:
        data = json.load(f)
    scores = {}
    for result in data.get("results", []):
        key = result.get("pose_id", result.get("pose_name"))
        dg = result.get("dG_mmgbsa_kcal")
        if dg is None:
            continue
        scores[key] = {
            "value": dg,
            "pose_name": result.get("pose_name", ""),
            "higher_is_better": False,  # more negative = better
        }
    return "rescore", scores


def load_docking_scores(path):
    """Load docking scores from dock.py CSV output."""
    scores = {}
    with open(path) as f:
        reader = csv.DictReader(f)
        for row in reader:
            # Try to find pose_id and score columns
            pose_id = None
            score = None
            for key in ("pose_id", "rank", "mode"):
                if key in row:
                    try:
                        pose_id = int(row[key])
                        break
                    except ValueError:
                        pass

            for key in ("score", "affinity", "energy"):
                if key in row:
                    try:
                        score = float(row[key])
                        break
                    except ValueError:
                        pass

            if pose_id is not None and score is not None:
                scores[pose_id] = {
                    "value": score,
                    "pose_name": row.get("name", row.get("ligand", "")),
                    "higher_is_better": False,  # Vina scores: more negative = better
                }
    return "docking", scores


def load_interaction_scores(path):
    """Load interaction counts from score.py JSON output."""
    with open(path) as f:
        data = json.load(f)
    scores = {}
    for result in data.get("results", []):
        key = result.get("pose_id", result.get("pose_name"))
        scores[key] = {
            "value": result.get("n_interactions", 0),
            "pose_name": result.get("pose_name", ""),
            "higher_is_better": True,
        }
    return "interactions", scores


def load_score_file(path):
    """Auto-detect score file type and load."""
    with open(path) as f:
        try:
            data = json.load(f)
        except json.JSONDecodeError:
            # Try CSV
            return load_docking_scores(path)

    # Detect type from JSON structure
    if "predictions" in data:
        return load_predict_scores(path)
    if "results" in data:
        # Check if it's rescore or interactions
        results = data["results"]
        if results and "dG_mmgbsa_kcal" in results[0]:
            return load_rescore_scores(path)
        if results and "n_interactions" in results[0]:
            return load_interaction_scores(path)
    return "unknown", {}


# ---------------------------------------------------------------------------
# Rank-based normalization
# ---------------------------------------------------------------------------


def rank_normalize(scores_dict):
    """
    Convert raw scores to rank-based normalized values [0, 1].

    Rank 1 (best) → 1.0, last rank → 0.0.
    Robust to different scales across methods.
    """
    if not scores_dict:
        return {}

    higher_is_better = next(iter(scores_dict.values()))["higher_is_better"]

    # Sort by value
    items = sorted(
        scores_dict.items(),
        key=lambda x: x[1]["value"],
        reverse=higher_is_better,
    )

    n = len(items)
    normalized = {}
    for rank, (key, info) in enumerate(items):
        normalized[key] = {
            "rank": rank + 1,
            "normalized": round(1.0 - rank / max(n - 1, 1), 3),
            "raw_value": info["value"],
            "pose_name": info["pose_name"],
        }

    return normalized


# ---------------------------------------------------------------------------
# Consensus computation
# ---------------------------------------------------------------------------


def kendall_tau(ranks_a, ranks_b):
    """
    Compute Kendall tau rank correlation between two ranking lists.

    Returns tau in [-1, 1]. Higher = more agreement.
    """
    # Find common keys
    common = set(ranks_a.keys()) & set(ranks_b.keys())
    if len(common) < 2:
        return 0.0

    keys = sorted(common)
    n = len(keys)
    concordant = 0
    discordant = 0

    for i in range(n):
        for j in range(i + 1, n):
            a_diff = ranks_a[keys[i]]["rank"] - ranks_a[keys[j]]["rank"]
            b_diff = ranks_b[keys[i]]["rank"] - ranks_b[keys[j]]["rank"]
            if a_diff * b_diff > 0:
                concordant += 1
            elif a_diff * b_diff < 0:
                discordant += 1

    total = concordant + discordant
    if total == 0:
        return 0.0
    return (concordant - discordant) / total


def compute_consensus(all_normalized, weights=None):
    """
    Compute weighted consensus from multiple normalized ranking sources.
    """
    # Find all pose keys across all sources
    all_keys = set()
    for norm in all_normalized.values():
        all_keys.update(norm.keys())

    if not all_keys:
        return [], 0.0, "low"

    # Default equal weights
    source_names = list(all_normalized.keys())
    if weights is None:
        weights = {name: 1.0 / len(source_names) for name in source_names}
    else:
        total = sum(weights.values())
        weights = {k: v / total for k, v in weights.items()}

    # Compute weighted consensus
    consensus = []
    for key in all_keys:
        weighted_sum = 0.0
        weight_sum = 0.0
        individual_ranks = {}
        pose_name = ""

        for source, norm in all_normalized.items():
            if key in norm:
                w = weights.get(source, 0)
                weighted_sum += norm[key]["normalized"] * w
                weight_sum += w
                individual_ranks[source] = norm[key]["rank"]
                if not pose_name:
                    pose_name = norm[key]["pose_name"]

        if weight_sum > 0:
            score = weighted_sum / weight_sum
        else:
            score = 0

        consensus.append({
            "pose_id": key,
            "pose_name": pose_name,
            "consensus_score": round(score, 3),
            "individual_ranks": individual_ranks,
            "n_sources": len(individual_ranks),
        })

    # Sort by consensus score descending
    consensus.sort(key=lambda x: x["consensus_score"], reverse=True)

    # Assign consensus rank
    for i, item in enumerate(consensus):
        item["consensus_rank"] = i + 1

    # Compute pairwise rank agreement
    tau_values = []
    source_pairs = []
    for i, name_a in enumerate(source_names):
        for name_b in source_names[i + 1:]:
            if name_a in all_normalized and name_b in all_normalized:
                tau = kendall_tau(all_normalized[name_a], all_normalized[name_b])
                tau_values.append(tau)
                source_pairs.append((name_a, name_b, round(tau, 3)))

    avg_tau = np.mean(tau_values) if tau_values else 0.0

    # Classify agreement
    if avg_tau > 0.7:
        agreement_class = "high"
    elif avg_tau >= 0.4:
        agreement_class = "moderate"
    else:
        agreement_class = "low"

    return consensus, round(float(avg_tau), 3), agreement_class


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def run_consensus(score_files, docking_scores_path, interactions_path,
                  output_path, weights_list=None, top_n=None):
    """Run consensus scoring pipeline."""
    print("=" * 60)
    print("CONSENSUS SCORING")
    print("=" * 60)
    print()

    # Load all score sources
    all_scores = {}
    for sf in score_files:
        name, scores = load_score_file(sf)
        if scores:
            all_scores[f"{name}_{os.path.basename(sf)}"] = scores
            print(f"  Loaded {name}: {len(scores)} poses from {sf}")

    if docking_scores_path:
        name, scores = load_docking_scores(docking_scores_path)
        if scores:
            all_scores["docking"] = scores
            print(f"  Loaded docking scores: {len(scores)} poses")

    if interactions_path:
        name, scores = load_interaction_scores(interactions_path)
        if scores:
            all_scores["interactions"] = scores
            print(f"  Loaded interactions: {len(scores)} poses")

    if not all_scores:
        print("\nNo valid score sources found.")
        return

    print(f"\nTotal sources: {len(all_scores)}")

    # Rank-normalize each source
    all_normalized = {}
    for name, scores in all_scores.items():
        all_normalized[name] = rank_normalize(scores)

    # Parse weights
    weights = None
    if weights_list:
        source_names = list(all_normalized.keys())
        weights = {}
        for i, w in enumerate(weights_list):
            if i < len(source_names):
                weights[source_names[i]] = float(w)

    # Compute consensus
    consensus, avg_tau, agreement_class = compute_consensus(
        all_normalized, weights
    )

    # Apply top-n filter
    if top_n and top_n < len(consensus):
        consensus = consensus[:top_n]

    print(f"\nRank agreement (Kendall τ): {avg_tau}")
    print(f"Agreement class: {agreement_class}")
    print()

    # Print top results
    print("Top consensus results:")
    for item in consensus[:10]:
        ranks_str = ", ".join(
            f"{k}: #{v}" for k, v in item["individual_ranks"].items()
        )
        print(f"  #{item['consensus_rank']} {item['pose_name']} "
              f"(score: {item['consensus_score']:.3f}) — {ranks_str}")

    # Write output
    output_data = {
        "n_poses": len(consensus),
        "sources": list(all_scores.keys()),
        "agreement_tau": avg_tau,
        "agreement_class": agreement_class,
        "note": (
            "Consensus of multiple scoring methods. "
            "High agreement (τ > 0.7) increases confidence in ranking. "
            "Low agreement suggests the ranking is uncertain — "
            "do not rely on absolute positions."
        ),
        "rankings": consensus,
    }

    with open(output_path, "w") as f:
        json.dump(output_data, f, indent=2)

    print(f"\nConsensus saved to: {output_path}")


def main():
    parser = argparse.ArgumentParser(
        description="Combine multiple scoring methods into a rank-based "
                    "consensus. Accepts outputs from predict.py, rescore.py, "
                    "dock.py scores CSV, and score.py interactions JSON.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python consensus.py --scores affinity.json mmgbsa.json --output consensus.json
  python consensus.py --scores affinity.json --docking-scores scores.csv --interactions interactions.json --output consensus.json --top-n 10
        """,
    )
    parser.add_argument(
        "--scores", required=True, nargs="+",
        help="Prediction JSONs from predict.py and/or rescore.py",
    )
    parser.add_argument(
        "--docking-scores", default=None,
        help="Scores CSV from dock.py (optional)",
    )
    parser.add_argument(
        "--interactions", default=None,
        help="Interactions JSON from score.py (optional)",
    )
    parser.add_argument("--output", required=True, help="Output consensus JSON")
    parser.add_argument(
        "--weights", nargs="+", type=float, default=None,
        help="Custom weights per source in order (optional)",
    )
    parser.add_argument(
        "--top-n", type=int, default=None,
        help="Only output top N poses (optional)",
    )

    args = parser.parse_args()

    for sf in args.scores:
        if not os.path.exists(sf):
            sys.exit(f"ERROR: Score file not found: {sf}")
    if args.docking_scores and not os.path.exists(args.docking_scores):
        sys.exit(f"ERROR: Docking scores not found: {args.docking_scores}")
    if args.interactions and not os.path.exists(args.interactions):
        sys.exit(f"ERROR: Interactions file not found: {args.interactions}")

    args.output = validate_output_path(args.output)

    output_dir = os.path.dirname(args.output)
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)

    run_consensus(
        args.scores, args.docking_scores, args.interactions,
        args.output, args.weights, args.top_n,
    )

    log_to_manifest("consensus.py", {
        "--scores": args.scores,
        "--docking-scores": args.docking_scores,
        "--interactions": args.interactions,
    }, args.output)


if __name__ == "__main__":
    main()
