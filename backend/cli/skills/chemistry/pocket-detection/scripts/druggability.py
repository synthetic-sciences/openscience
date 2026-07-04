#!/usr/bin/env python3
"""
Pocket druggability assessment.

Scores detected pockets for drug-likeness using a 6-axis weighted model:
volume, hydrophobicity, enclosure, depth, H-bond capacity, aromaticity.

Usage:
    python druggability.py --input protein.pdb --pockets pockets.json --output druggability.json
"""

import argparse
import json
import os
import sys
import warnings

from output_guard import validate_output_path, log_to_manifest

warnings.filterwarnings("ignore")

try:
    from Bio.PDB import PDBParser, NeighborSearch
except ImportError:
    sys.exit("ERROR: BioPython is required. Install with: pip install biopython")

try:
    import numpy as np
except ImportError:
    sys.exit("ERROR: NumPy is required. Install with: pip install numpy")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

STANDARD_RESIDUES = {
    "ALA", "ARG", "ASN", "ASP", "CYS", "GLN", "GLU", "GLY", "HIS", "ILE",
    "LEU", "LYS", "MET", "PHE", "PRO", "SER", "THR", "TRP", "TYR", "VAL",
    "HID", "HIE", "HIP", "CYX", "ASH", "GLH",
}

WATER_RESIDUES = {"HOH", "WAT", "TIP", "TIP3", "SOL", "H2O"}

# Amino acid property categories
HYDROPHOBIC_RESIDUES = {"ALA", "VAL", "ILE", "LEU", "MET", "PHE", "TRP", "PRO"}
POLAR_RESIDUES = {"SER", "THR", "ASN", "GLN", "CYS", "TYR", "HIS"}
CHARGED_RESIDUES = {"ASP", "GLU", "LYS", "ARG"}
AROMATIC_RESIDUES = {"PHE", "TYR", "TRP", "HIS"}
HBOND_RESIDUES = {"SER", "THR", "ASN", "GLN", "ASP", "GLU", "LYS", "ARG",
                  "HIS", "TYR", "CYS", "TRP"}

# Scoring weights (from the chemistry-agent druggability design spec)
WEIGHTS = {
    "volume": 0.25,
    "hydrophobicity": 0.20,
    "enclosure": 0.25,
    "depth": 0.15,
    "hb_capacity": 0.10,
    "aromaticity": 0.05,
}

# 26 unit direction vectors (cube faces + edges + corners)
DIRECTION_VECTORS = []
for dx in (-1, 0, 1):
    for dy in (-1, 0, 1):
        for dz in (-1, 0, 1):
            if dx == 0 and dy == 0 and dz == 0:
                continue
            v = np.array([dx, dy, dz], dtype=float)
            DIRECTION_VECTORS.append(v / np.linalg.norm(v))


# ---------------------------------------------------------------------------
# Pocket property computation
# ---------------------------------------------------------------------------


def _get_pocket_residues(structure, center, radius=8.0, chain_id=None):
    """Get actual residue objects near a pocket center."""
    atoms = []
    for model in structure:
        for chain in model:
            if chain_id and chain.get_id() != chain_id:
                continue
            for residue in chain:
                resname = residue.get_resname().strip()
                if resname in WATER_RESIDUES:
                    continue
                if resname not in STANDARD_RESIDUES:
                    continue
                for atom in residue:
                    atoms.append(atom)
        break

    if not atoms:
        return []

    ns = NeighborSearch(atoms)
    center_arr = np.array(center, dtype=float)
    nearby = ns.search(center_arr, radius, level="R")
    return [r for r in nearby if r.get_resname().strip() in STANDARD_RESIDUES]


def compute_hydrophobicity(residues):
    """Fraction of pocket residues that are hydrophobic (0.0 - 1.0)."""
    if not residues:
        return 0.0
    n_hydrophobic = sum(
        1 for r in residues
        if r.get_resname().strip() in HYDROPHOBIC_RESIDUES
    )
    return n_hydrophobic / len(residues)


def compute_enclosure(structure, center, probe_distance=10.0, chain_id=None):
    """
    Measure pocket enclosure by casting 26 directional rays from the center
    and checking what fraction hit protein atoms within probe_distance.

    Returns fraction (0.0 - 1.0). Higher = more enclosed.
    """
    atoms = []
    for model in structure:
        for chain in model:
            if chain_id and chain.get_id() != chain_id:
                continue
            for residue in chain:
                resname = residue.get_resname().strip()
                if resname in WATER_RESIDUES:
                    continue
                for atom in residue:
                    atoms.append(atom)
        break

    if not atoms:
        return 0.0

    ns = NeighborSearch(atoms)
    center_arr = np.array(center, dtype=float)

    hits = 0
    for direction in DIRECTION_VECTORS:
        # Sample along the ray at intervals
        for dist in np.arange(2.0, probe_distance, 1.0):
            probe_point = center_arr + direction * dist
            nearby = ns.search(probe_point, 2.5, level="A")
            if nearby:
                hits += 1
                break

    return hits / len(DIRECTION_VECTORS)


def compute_hb_capacity(residues):
    """Count residues capable of hydrogen bonding."""
    return sum(
        1 for r in residues
        if r.get_resname().strip() in HBOND_RESIDUES
    )


def compute_aromaticity(residues):
    """Count aromatic residues in the pocket."""
    return sum(
        1 for r in residues
        if r.get_resname().strip() in AROMATIC_RESIDUES
    )


# ---------------------------------------------------------------------------
# Scoring functions (piecewise linear from design spec)
# ---------------------------------------------------------------------------


def score_volume(volume):
    """Score pocket volume. Peak at 500 A^3 (Gaussian-like, continuous).

    Based on Halgren 2009: most drug-like pockets are 300-800 A^3,
    but the score is continuous rather than a flat plateau so pockets
    of different sizes get different rankings.
    """
    # Gaussian centered at 500, sigma=250
    optimal = 500.0
    sigma = 250.0
    score = np.exp(-0.5 * ((volume - optimal) / sigma) ** 2)
    return max(0.05, float(score))


def score_hydrophobicity(hydro):
    """Score hydrophobicity fraction. Peak at 0.5 (balanced pocket).

    Purely hydrophobic pockets lack H-bond anchors; purely polar pockets
    lack desolvation-driven binding. Optimal ~0.4-0.6.
    """
    optimal = 0.5
    sigma = 0.15
    score = np.exp(-0.5 * ((hydro - optimal) / sigma) ** 2)
    return max(0.05, float(score))


def score_enclosure(enclosure):
    """Score pocket enclosure. Sigmoid — rewards buried pockets continuously.

    Shallow surface grooves (enclosure <0.3) score low; deep buried cavities
    (>0.7) score high. Not a flat plateau.
    """
    # Sigmoid centered at 0.5, steepness 10
    score = 1.0 / (1.0 + np.exp(-10 * (enclosure - 0.5)))
    return max(0.05, float(score))


def score_depth(depth):
    """Score pocket depth. Sigmoid — rewards deeper pockets continuously.

    Shallow pockets (<3A) score low. Score increases through 5-10A range
    rather than saturating at 5A.
    """
    # Sigmoid centered at 6A, steepness 0.8
    score = 1.0 / (1.0 + np.exp(-0.8 * (depth - 6.0)))
    return max(0.05, float(score))


def score_hb_capacity(n_hb):
    """Score H-bond capacity. Peak at 4-5 residues (Gaussian).

    Too few = weak specificity; too many = high desolvation penalty.
    """
    optimal = 4.5
    sigma = 2.5
    score = np.exp(-0.5 * ((n_hb - optimal) / sigma) ** 2)
    return max(0.05, float(score))


def score_aromaticity(n_aromatic):
    """Score aromatic residue count. Peak at 3-4 (Gaussian).

    Aromatic residues enable pi-stacking and cation-pi interactions.
    Too many (>8) suggests the pocket is mostly solvent-exposed aromatic surface.
    """
    optimal = 3.5
    sigma = 2.0
    score = np.exp(-0.5 * ((n_aromatic - optimal) / sigma) ** 2)
    return max(0.05, float(score))


def classify_druggability(score):
    """Classify pocket druggability from composite score."""
    if score > 0.7:
        return "druggable"
    if score >= 0.4:
        return "difficult"
    return "undruggable"


# ---------------------------------------------------------------------------
# Main assessment pipeline
# ---------------------------------------------------------------------------


def assess_druggability(input_pdb, pockets_json, output_path, chain_id=None):
    """
    Score all pockets in the input JSON for druggability.

    Augments each pocket with druggability_score, druggability_class,
    and a properties dict.
    """
    print("=" * 60)
    print("DRUGGABILITY ASSESSMENT")
    print("=" * 60)
    print(f"Protein: {input_pdb}")
    print(f"Pockets: {pockets_json}")
    print()

    # Load pocket data
    with open(pockets_json) as f:
        data = json.load(f)

    pockets = data.get("pockets", [])
    if not pockets:
        print("No pockets to assess.")
        data["pockets"] = []
        with open(output_path, "w") as f:
            json.dump(data, f, indent=2)
        return

    # Parse protein structure
    parser = PDBParser(QUIET=True)
    structure = parser.get_structure("protein", input_pdb)

    for pocket in pockets:
        center = pocket["center"]
        volume = pocket.get("volume_A3", 0)
        depth = pocket.get("depth_A", 0)

        # Get residues near pocket center
        residues = _get_pocket_residues(
            structure, center, radius=8.0, chain_id=chain_id
        )

        # Compute properties
        hydrophobicity = compute_hydrophobicity(residues)
        enclosure = compute_enclosure(structure, center, chain_id=chain_id)
        hb_capacity = compute_hb_capacity(residues)
        aromaticity = compute_aromaticity(residues)

        # Gorge correction: gorge-type pockets (detected by PCA in detect.py)
        # have lower 3D enclosure because rays escape through the gorge ends,
        # but they are laterally enclosed and highly druggable (e.g. AChE gorge).
        pocket_type = pocket.get("pocket_type", "cavity")
        aspect_ratio = pocket.get("aspect_ratio", 1.0)
        if pocket_type == "gorge" and aspect_ratio > 2.5:
            # Floor enclosure at 0.5 — gorges are inherently enclosed laterally
            enclosure = max(enclosure, 0.5)
            # Prefer grid-based volume for gorges (ConvexHull overestimates)
            grid_vol = pocket.get("grid_volume_A3", 0)
            if grid_vol > 0:
                volume = grid_vol

        # If volume/depth not from detection, estimate from residues
        if volume == 0 and residues:
            res_coords = []
            for r in residues:
                for a in r:
                    res_coords.append(a.get_vector().get_array())
            if len(res_coords) >= 4:
                try:
                    from scipy.spatial import ConvexHull
                    hull = ConvexHull(np.array(res_coords))
                    volume = hull.volume * 0.3  # rough pocket fraction
                except Exception:
                    volume = len(residues) * 30  # rough estimate

        if depth == 0 and residues:
            center_arr = np.array(center)
            dists = [
                np.linalg.norm(
                    np.array(a.get_vector().get_array()) - center_arr
                )
                for r in residues for a in r
            ]
            depth = max(dists) if dists else 0

        # Score each axis
        scores = {
            "volume": score_volume(volume),
            "hydrophobicity": score_hydrophobicity(hydrophobicity),
            "enclosure": score_enclosure(enclosure),
            "depth": score_depth(depth),
            "hb_capacity": score_hb_capacity(hb_capacity),
            "aromaticity": score_aromaticity(aromaticity),
        }

        # Weighted composite
        composite = sum(
            WEIGHTS[k] * scores[k] for k in WEIGHTS
        )

        # Augment pocket data
        pocket["druggability_score"] = round(composite, 2)
        pocket["druggability_class"] = classify_druggability(composite)
        pocket["properties"] = {
            "volume_A3": round(volume, 1),
            "hydrophobicity": round(hydrophobicity, 2),
            "enclosure": round(enclosure, 2),
            "depth_A": round(depth, 1),
            "hb_capacity": hb_capacity,
            "aromaticity": aromaticity,
        }
        pocket["property_scores"] = {k: round(v, 2) for k, v in scores.items()}

        # Print summary
        cls = pocket["druggability_class"]
        type_tag = f" [{pocket_type}]" if pocket_type == "gorge" else ""
        print(f"  Pocket {pocket['rank']}{type_tag} — {cls} (score: {composite:.2f})")
        print(f"    Volume: {volume:.0f} A^3 (score: {scores['volume']:.2f})")
        print(f"    Hydrophobicity: {hydrophobicity:.2f} (score: {scores['hydrophobicity']:.2f})")
        print(f"    Enclosure: {enclosure:.2f} (score: {scores['enclosure']:.2f})")
        print(f"    Depth: {depth:.1f} A (score: {scores['depth']:.2f})")
        print(f"    H-bond capacity: {hb_capacity} (score: {scores['hb_capacity']:.2f})")
        print(f"    Aromaticity: {aromaticity} (score: {scores['aromaticity']:.2f})")
        print()

    # Write output
    print("NOTE: Druggability classification is heuristic (literature thresholds),")
    print("not a validated predictor. Use for prioritization guidance only.")
    print()

    with open(output_path, "w") as f:
        json.dump(data, f, indent=2)

    print(f"Druggability data saved to: {output_path}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(
        description="Assess pocket druggability using a 6-axis weighted model. "
                    "Scores volume, hydrophobicity, enclosure, depth, "
                    "H-bond capacity, and aromaticity.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python druggability.py --input protein.pdb --pockets pockets.json --output druggability.json
  python druggability.py --input protein.pdb --pockets pockets.json --output druggability.json --chain A
        """,
    )
    parser.add_argument("--input", required=True, help="Input PDB file")
    parser.add_argument("--pockets", required=True, help="Pockets JSON from detect.py")
    parser.add_argument("--output", required=True, help="Output druggability JSON")
    parser.add_argument("--chain", default=None, help="Chain ID (optional)")

    args = parser.parse_args()

    if not os.path.exists(args.input):
        sys.exit(f"ERROR: PDB file not found: {args.input}")
    if not os.path.exists(args.pockets):
        sys.exit(f"ERROR: Pockets file not found: {args.pockets}")

    args.output = validate_output_path(args.output)

    output_dir = os.path.dirname(args.output)
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)

    assess_druggability(args.input, args.pockets, args.output, args.chain)

    log_to_manifest("druggability.py", {
        "--input": args.input,
        "--pockets": args.pockets,
        "--chain": args.chain,
    }, args.output)


if __name__ == "__main__":
    main()
