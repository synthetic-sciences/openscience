#!/usr/bin/env python3
"""
Cross-structure pocket comparison.

Detects pockets on 2+ protein structures and matches them by spatial proximity,
reporting volume changes, residue composition changes, and unique pockets.

Usage:
    python compare.py --structures apo.pdb holo.pdb --output comparison.json
    python compare.py --structures wt.pdb mut.pdb --labels WT Mutant --output comparison.json --align
"""

import argparse
import json
import os
import sys
import warnings

warnings.filterwarnings("ignore")

try:
    from Bio.PDB import PDBParser, Superimposer
except ImportError:
    sys.exit("ERROR: BioPython is required. Install with: pip install biopython")

try:
    import numpy as np
except ImportError:
    sys.exit("ERROR: NumPy is required. Install with: pip install numpy")

# Import detect functions from detect.py in the same directory
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)
from detect import detect_grid


# ---------------------------------------------------------------------------
# Structure alignment
# ---------------------------------------------------------------------------


def align_structures(structures, reference_idx=0):
    """
    Superimpose all structures onto the reference using C-alpha atoms.

    Returns the RMSD of each alignment.
    """
    ref_structure = structures[reference_idx]
    ref_cas = []
    for model in ref_structure:
        for chain in model:
            for residue in chain:
                if residue.has_id("CA"):
                    ref_cas.append(residue["CA"])
        break

    rmsds = [0.0] * len(structures)
    for i, structure in enumerate(structures):
        if i == reference_idx:
            continue
        mob_cas = []
        for model in structure:
            for chain in model:
                for residue in chain:
                    if residue.has_id("CA"):
                        mob_cas.append(residue["CA"])
            break

        # Use minimum common length
        n = min(len(ref_cas), len(mob_cas))
        if n < 3:
            print(f"  WARNING: Structure {i} has too few CA atoms for alignment.")
            continue

        sup = Superimposer()
        sup.set_atoms(ref_cas[:n], mob_cas[:n])
        sup.apply(list(structure.get_atoms()))
        rmsds[i] = round(sup.rms, 2)
        print(f"  Aligned structure {i} to reference: RMSD = {rmsds[i]:.2f} A")

    return rmsds


# ---------------------------------------------------------------------------
# Pocket matching
# ---------------------------------------------------------------------------


def match_pockets(pocket_sets, labels, matching_radius=5.0):
    """
    Match pockets across structures by center proximity.

    Returns a list of matched groups and orphan (unmatched) pockets.
    """
    if len(pocket_sets) < 2:
        return [], []

    # Use first structure's pockets as reference
    ref_pockets = pocket_sets[0]
    matched = []
    used = {i: set() for i in range(len(pocket_sets))}

    for ri, ref_p in enumerate(ref_pockets):
        ref_center = np.array(ref_p["center"])
        group = {labels[0]: ref_p}
        used[0].add(ri)

        for si in range(1, len(pocket_sets)):
            best_dist = float("inf")
            best_idx = None
            for pi, pocket in enumerate(pocket_sets[si]):
                if pi in used[si]:
                    continue
                dist = np.linalg.norm(np.array(pocket["center"]) - ref_center)
                if dist < matching_radius and dist < best_dist:
                    best_dist = dist
                    best_idx = pi

            if best_idx is not None:
                group[labels[si]] = pocket_sets[si][best_idx]
                group[f"{labels[si]}_distance"] = round(best_dist, 1)
                used[si].add(best_idx)

        matched.append(group)

    # Find orphan pockets
    orphans = []
    for si in range(len(pocket_sets)):
        for pi, pocket in enumerate(pocket_sets[si]):
            if pi not in used[si]:
                orphans.append({
                    "structure": labels[si],
                    "pocket": pocket,
                })

    return matched, orphans


# ---------------------------------------------------------------------------
# Comparison analysis
# ---------------------------------------------------------------------------


def analyze_match(group, labels):
    """Analyze a matched pocket group for changes."""
    analysis = {}

    # Volume change
    volumes = {}
    for label in labels:
        if label in group:
            volumes[label] = group[label].get("volume_A3", 0)
    if len(volumes) >= 2:
        vals = list(volumes.values())
        analysis["volume_change_A3"] = round(vals[-1] - vals[0], 1)
        if vals[0] > 0:
            analysis["volume_change_pct"] = round(
                100 * (vals[-1] - vals[0]) / vals[0], 1
            )

    # Residue composition change
    residue_sets = {}
    for label in labels:
        if label in group:
            residue_sets[label] = set(group[label].get("residues", []))
    if len(residue_sets) >= 2:
        keys = list(residue_sets.keys())
        shared = residue_sets[keys[0]] & residue_sets[keys[-1]]
        gained = residue_sets[keys[-1]] - residue_sets[keys[0]]
        lost = residue_sets[keys[0]] - residue_sets[keys[-1]]
        analysis["residues_shared"] = len(shared)
        analysis["residues_gained"] = sorted(gained)
        analysis["residues_lost"] = sorted(lost)

    # Druggability change
    drug_scores = {}
    for label in labels:
        if label in group:
            drug_scores[label] = group[label].get("druggability_score", None)
    analysis["druggability_scores"] = {
        k: v for k, v in drug_scores.items() if v is not None
    }

    return analysis


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def compare_pockets(structure_files, labels, output_path, method="grid",
                    matching_radius=5.0, align=False, chain=None):
    """Run pocket detection on each structure and compare."""
    print("=" * 60)
    print("CROSS-STRUCTURE POCKET COMPARISON")
    print("=" * 60)
    print(f"Structures: {', '.join(labels)}")
    print(f"Method: {method}")
    print(f"Matching radius: {matching_radius} A")
    print()

    pdb_parser = PDBParser(QUIET=True)
    structures = []
    for f in structure_files:
        structures.append(pdb_parser.get_structure(f, f))

    # Optionally align
    rmsds = None
    if align:
        print("Aligning structures...")
        rmsds = align_structures(structures)
        print()

    # Detect pockets on each structure
    pocket_sets = []
    for i, (structure, label) in enumerate(zip(structures, labels)):
        print(f"Detecting pockets on {label}...")
        pockets = detect_grid(structure, chain)
        print(f"  Found {len(pockets)} pocket(s)")
        pocket_sets.append(pockets)

    print()

    # Match pockets across structures
    matched, orphans = match_pockets(pocket_sets, labels, matching_radius)

    print(f"Matched pocket groups: {len(matched)}")
    print(f"Unmatched (unique) pockets: {len(orphans)}")
    print()

    # Analyze matches
    comparison_results = []
    for i, group in enumerate(matched):
        analysis = analyze_match(group, labels)
        result = {
            "match_id": i + 1,
            "pockets": {},
            "analysis": analysis,
        }
        for label in labels:
            if label in group:
                pocket = group[label]
                result["pockets"][label] = {
                    "rank": pocket.get("rank"),
                    "center": pocket.get("center"),
                    "volume_A3": pocket.get("volume_A3", 0),
                    "n_residues": pocket.get("n_residues", 0),
                    "druggability_score": pocket.get("druggability_score"),
                }
                if f"{label}_distance" in group:
                    result["pockets"][label]["center_distance_A"] = group[f"{label}_distance"]

        comparison_results.append(result)

        # Print summary
        present = [l for l in labels if l in group]
        print(f"  Match {i + 1}: present in {', '.join(present)}")
        if "volume_change_A3" in analysis:
            print(f"    Volume change: {analysis['volume_change_A3']:+.0f} A^3"
                  f" ({analysis.get('volume_change_pct', 0):+.1f}%)")
        if "residues_gained" in analysis and analysis["residues_gained"]:
            print(f"    Residues gained: {', '.join(analysis['residues_gained'][:5])}")
        if "residues_lost" in analysis and analysis["residues_lost"]:
            print(f"    Residues lost: {', '.join(analysis['residues_lost'][:5])}")
        print()

    if orphans:
        print("Unique (unmatched) pockets:")
        for o in orphans:
            p = o["pocket"]
            c = p["center"]
            print(f"  {o['structure']} Pocket {p.get('rank', '?')}: "
                  f"center ({c[0]:.1f}, {c[1]:.1f}, {c[2]:.1f}), "
                  f"vol ~{p.get('volume_A3', 0):.0f} A^3")
        print()

    # Write output
    output_data = {
        "structures": labels,
        "method": method,
        "matching_radius_A": matching_radius,
        "aligned": align,
        "alignment_rmsds": rmsds,
        "n_matched": len(comparison_results),
        "n_orphans": len(orphans),
        "matched_pockets": comparison_results,
        "orphan_pockets": [
            {
                "structure": o["structure"],
                "center": o["pocket"].get("center"),
                "volume_A3": o["pocket"].get("volume_A3", 0),
                "residues": o["pocket"].get("residues", []),
            }
            for o in orphans
        ],
    }

    with open(output_path, "w") as f:
        json.dump(output_data, f, indent=2)

    print(f"Comparison saved to: {output_path}")


def main():
    parser = argparse.ArgumentParser(
        description="Compare binding pockets across 2+ protein structures. "
                    "Detects pockets on each, matches by proximity, and "
                    "reports volume/residue/druggability changes.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python compare.py --structures apo.pdb holo.pdb --output comparison.json
  python compare.py --structures wt.pdb mut.pdb --labels WT Mutant --output comparison.json --align
        """,
    )
    parser.add_argument(
        "--structures", required=True, nargs="+",
        help="2+ PDB files to compare",
    )
    parser.add_argument("--labels", nargs="+", help="Labels for each structure")
    parser.add_argument("--output", required=True, help="Output comparison JSON")
    parser.add_argument(
        "--method", default="grid",
        choices=["grid"],
        help="Detection method (default: grid)",
    )
    parser.add_argument(
        "--pocket-radius", type=float, default=5.0,
        help="Matching radius in A for pocket correspondence (default: 5.0)",
    )
    parser.add_argument(
        "--align", action="store_true",
        help="Superimpose structures before comparison",
    )
    parser.add_argument("--chain", default=None, help="Chain ID (optional)")

    args = parser.parse_args()

    if len(args.structures) < 2:
        sys.exit("ERROR: At least 2 structure files are required.")

    for f in args.structures:
        if not os.path.exists(f):
            sys.exit(f"ERROR: File not found: {f}")

    labels = args.labels or [
        os.path.splitext(os.path.basename(f))[0] for f in args.structures
    ]
    while len(labels) < len(args.structures):
        labels.append(f"Structure_{len(labels) + 1}")

    output_dir = os.path.dirname(args.output)
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)

    compare_pockets(
        args.structures, labels, args.output,
        method=args.method, matching_radius=args.pocket_radius,
        align=args.align, chain=args.chain,
    )


if __name__ == "__main__":
    main()
