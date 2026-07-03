#!/usr/bin/env python3
"""
Compare a predicted protein structure against a reference structure.

Computes structural similarity metrics: C-alpha RMSD, TM-score (via TMalign
if available), and GDT-TS. Falls back to BioPython-based superimposition if
TMalign is not installed.

Usage:
    python compare.py --predicted predicted.pdb --reference experimental.pdb
"""

import argparse
import math
import os
import shutil
import subprocess
import sys
import tempfile

try:
    import numpy as np
except ImportError:
    print(
        "ERROR: NumPy is not installed. Install with: pip install numpy",
        file=sys.stderr,
    )
    sys.exit(1)

try:
    from Bio.PDB import PDBParser, Superimposer, is_aa
except ImportError:
    print(
        "ERROR: BioPython is not installed. Install with: pip install biopython",
        file=sys.stderr,
    )
    sys.exit(1)


def extract_ca_atoms(structure):
    """Extract CA atom coordinates and residue info from the first model/chain.

    Returns list of (chain_id, res_num, res_name, ca_atom) tuples.
    """
    ca_data = []
    for model in structure:
        for chain in model:
            for residue in chain:
                if not is_aa(residue, standard=True):
                    continue
                ca = residue.child_dict.get("CA")
                if ca is not None:
                    ca_data.append((
                        chain.get_id(),
                        residue.get_id()[1],
                        residue.get_resname(),
                        ca,
                    ))
        break  # Only first model
    return ca_data


def align_sequences_by_residue_number(pred_ca, ref_ca):
    """Align two sets of CA atoms by matching residue numbers.

    Returns two lists of matched CA atoms (pred_matched, ref_matched).
    """
    pred_map = {(chain, resnum): (resname, atom) for chain, resnum, resname, atom in pred_ca}
    ref_map = {(chain, resnum): (resname, atom) for chain, resnum, resname, atom in ref_ca}

    # Try matching by residue number only (ignoring chain ID)
    pred_by_num = {resnum: (resname, atom) for chain, resnum, resname, atom in pred_ca}
    ref_by_num = {resnum: (resname, atom) for chain, resnum, resname, atom in ref_ca}

    common_keys = sorted(set(pred_by_num.keys()) & set(ref_by_num.keys()))

    if len(common_keys) == 0:
        # Fall back to sequential alignment
        min_len = min(len(pred_ca), len(ref_ca))
        pred_atoms = [pred_ca[i][3] for i in range(min_len)]
        ref_atoms = [ref_ca[i][3] for i in range(min_len)]
        return pred_atoms, ref_atoms, min_len

    pred_atoms = [pred_by_num[k][1] for k in common_keys]
    ref_atoms = [ref_by_num[k][1] for k in common_keys]

    return pred_atoms, ref_atoms, len(common_keys)


def compute_rmsd(pred_atoms, ref_atoms):
    """Compute RMSD between two lists of atoms after optimal superimposition."""
    if len(pred_atoms) < 3:
        return None, None

    sup = Superimposer()
    sup.set_atoms(ref_atoms, pred_atoms)
    return sup.rms, sup


def compute_per_residue_distances(pred_atoms, ref_atoms, superimposer):
    """Compute per-residue CA distances after superimposition."""
    # Apply the rotation/translation to predicted atoms
    pred_coords = np.array([a.get_vector().get_array() for a in pred_atoms])
    ref_coords = np.array([a.get_vector().get_array() for a in ref_atoms])

    # Apply superimposer transformation
    rot = superimposer.rotran[0]
    tran = superimposer.rotran[1]
    pred_transformed = np.dot(pred_coords, rot) + tran

    distances = np.sqrt(np.sum((pred_transformed - ref_coords) ** 2, axis=1))
    return distances


def compute_gdt_ts(distances):
    """Compute GDT-TS (Global Distance Test - Total Score).

    GDT-TS = (GDT_1 + GDT_2 + GDT_4 + GDT_8) / 4
    where GDT_X is the percentage of CA atoms within X Angstroms.
    """
    n = len(distances)
    if n == 0:
        return None, {}

    thresholds = [1.0, 2.0, 4.0, 8.0]
    gdt_components = {}
    for t in thresholds:
        gdt_components[t] = np.sum(distances <= t) / n * 100

    gdt_ts = np.mean([gdt_components[t] for t in thresholds])
    return gdt_ts, gdt_components


def compute_tm_score_approx(distances, target_length):
    """Compute an approximate TM-score using the TM-score formula.

    This is an approximation since we use residue-number-based alignment
    rather than the optimal structural alignment that TMalign computes.

    TM-score = (1/L) * sum(1 / (1 + (di/d0)^2))
    where d0 = 1.24 * (L - 15)^(1/3) - 1.8
    """
    L = target_length
    if L <= 15:
        return None

    d0 = 1.24 * ((L - 15) ** (1.0 / 3.0)) - 1.8
    if d0 <= 0:
        d0 = 0.5  # Minimum d0

    tm_sum = np.sum(1.0 / (1.0 + (distances / d0) ** 2))
    tm_score = tm_sum / L

    return tm_score


def run_tmalign(predicted_pdb, reference_pdb):
    """Run TMalign external program if available.

    Returns dict with tm_score_pred, tm_score_ref, rmsd, gdt_ts, aligned_length
    or None if TMalign is not available.
    """
    tmalign_path = shutil.which("TMalign") or shutil.which("tmalign")
    if tmalign_path is None:
        return None

    try:
        result = subprocess.run(
            [tmalign_path, predicted_pdb, reference_pdb],
            capture_output=True,
            text=True,
            timeout=120,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return None

    if result.returncode != 0:
        return None

    output = result.stdout
    tmalign_results = {}

    for line in output.splitlines():
        line = line.strip()
        if line.startswith("Aligned length="):
            parts = line.split(",")
            for part in parts:
                part = part.strip()
                if part.startswith("Aligned length="):
                    try:
                        tmalign_results["aligned_length"] = int(
                            part.split("=")[1].strip()
                        )
                    except (ValueError, IndexError):
                        pass
                elif part.startswith("RMSD="):
                    try:
                        tmalign_results["rmsd"] = float(part.split("=")[1].strip())
                    except (ValueError, IndexError):
                        pass
        elif line.startswith("TM-score="):
            try:
                tm_val = float(line.split("=")[1].split("(")[0].strip())
                if "normalized by length of Chain_1" in line:
                    tmalign_results["tm_score_pred"] = tm_val
                elif "normalized by length of Chain_2" in line:
                    tmalign_results["tm_score_ref"] = tm_val
                elif "tm_score_pred" not in tmalign_results:
                    tmalign_results["tm_score_pred"] = tm_val
            except (ValueError, IndexError):
                pass

    # Parse GDT-TS if present in TMalign output
    # Some TMalign versions include GDT scores with -a flag
    # We'll compute it ourselves from distances if not available

    return tmalign_results if tmalign_results else None


def print_comparison_report(
    predicted_path,
    reference_path,
    num_pred_residues,
    num_ref_residues,
    num_aligned,
    rmsd,
    distances,
    tmalign_results,
):
    """Print a formatted comparison report."""
    print("\n" + "=" * 65)
    print("STRUCTURE COMPARISON REPORT")
    print("=" * 65)
    print(f"Predicted:     {predicted_path}")
    print(f"Reference:     {reference_path}")
    print(f"Pred residues: {num_pred_residues}")
    print(f"Ref residues:  {num_ref_residues}")
    print(f"Aligned pairs: {num_aligned}")

    print("-" * 65)
    print("GLOBAL METRICS")
    print("-" * 65)

    use_tmalign = tmalign_results is not None

    # RMSD
    if use_tmalign and "rmsd" in tmalign_results:
        print(f"  C-alpha RMSD:          {tmalign_results['rmsd']:.2f} A  (TMalign)")
    elif rmsd is not None:
        print(f"  C-alpha RMSD:          {rmsd:.2f} A  (BioPython superimposition)")
    else:
        print("  C-alpha RMSD:          N/A")

    # TM-score
    if use_tmalign and "tm_score_ref" in tmalign_results:
        tm = tmalign_results["tm_score_ref"]
        print(f"  TM-score (ref norm):   {tm:.4f}  (TMalign)")
        if "tm_score_pred" in tmalign_results:
            print(f"  TM-score (pred norm):  {tmalign_results['tm_score_pred']:.4f}  (TMalign)")
    elif use_tmalign and "tm_score_pred" in tmalign_results:
        print(f"  TM-score:              {tmalign_results['tm_score_pred']:.4f}  (TMalign)")
    elif distances is not None:
        # Approximate TM-score
        tm_approx = compute_tm_score_approx(distances, num_ref_residues)
        if tm_approx is not None:
            print(
                f"  TM-score (approx):     {tm_approx:.4f}  "
                "(BioPython-based, install TMalign for accurate score)"
            )

    # GDT-TS
    if distances is not None:
        gdt_ts, gdt_components = compute_gdt_ts(distances)
        if gdt_ts is not None:
            print(f"  GDT-TS:                {gdt_ts:.1f}%")
            print(f"    GDT_1 (<1A):         {gdt_components[1.0]:.1f}%")
            print(f"    GDT_2 (<2A):         {gdt_components[2.0]:.1f}%")
            print(f"    GDT_4 (<4A):         {gdt_components[4.0]:.1f}%")
            print(f"    GDT_8 (<8A):         {gdt_components[8.0]:.1f}%")

    # Per-residue distance analysis
    if distances is not None and len(distances) > 0:
        print("-" * 65)
        print("PER-RESIDUE DISTANCE STATISTICS (after superimposition)")
        print("-" * 65)
        print(f"  Mean distance:    {np.mean(distances):.2f} A")
        print(f"  Median distance:  {np.median(distances):.2f} A")
        print(f"  Max distance:     {np.max(distances):.2f} A")
        print(f"  Std deviation:    {np.std(distances):.2f} A")

        # Distance distribution
        print("\n  Distance distribution:")
        dist_bins = [
            ("  < 1 A", 1.0),
            ("  < 2 A", 2.0),
            ("  < 3 A", 3.0),
            ("  < 5 A", 5.0),
            ("  < 10 A", 10.0),
        ]
        for label, threshold in dist_bins:
            count = int(np.sum(distances < threshold))
            pct = count / len(distances) * 100
            print(f"    {label}: {count:4d} / {len(distances)} ({pct:5.1f}%)")

        # Regions with high deviation (> 5 A)
        high_dev_indices = np.where(distances > 5.0)[0]
        if len(high_dev_indices) > 0:
            print(f"\n  WARNING: {len(high_dev_indices)} residues deviate by > 5 A.")
            print("  These may represent flexible loops, domain shifts, or modeling errors.")

    # Interpretation
    print("-" * 65)
    print("INTERPRETATION")
    print("-" * 65)

    if use_tmalign and "tm_score_ref" in tmalign_results:
        tm = tmalign_results["tm_score_ref"]
    elif use_tmalign and "tm_score_pred" in tmalign_results:
        tm = tmalign_results["tm_score_pred"]
    elif distances is not None:
        tm = compute_tm_score_approx(distances, num_ref_residues)
    else:
        tm = None

    if tm is not None:
        if tm > 0.5:
            print(f"  TM-score = {tm:.4f} (> 0.5): Structures share the same fold.")
        elif tm > 0.17:
            print(
                f"  TM-score = {tm:.4f} (0.17-0.5): Structures may share some "
                "structural similarity but are not confidently the same fold."
            )
        else:
            print(f"  TM-score = {tm:.4f} (< 0.17): Structures are essentially unrelated.")

    effective_rmsd = tmalign_results.get("rmsd", rmsd) if use_tmalign else rmsd
    if effective_rmsd is not None:
        if effective_rmsd < 2.0:
            print(f"  RMSD = {effective_rmsd:.2f} A: Excellent structural agreement.")
        elif effective_rmsd < 4.0:
            print(
                f"  RMSD = {effective_rmsd:.2f} A: Good agreement. "
                "Core regions are likely well-predicted."
            )
        elif effective_rmsd < 8.0:
            print(
                f"  RMSD = {effective_rmsd:.2f} A: Moderate agreement. "
                "Overall fold may be correct but significant local deviations exist."
            )
        else:
            print(
                f"  RMSD = {effective_rmsd:.2f} A: Poor agreement. "
                "Structures may represent different conformations or folds."
            )

    if not use_tmalign:
        print(
            "\n  NOTE: Install TMalign for more accurate TM-score and "
            "structure-based alignment."
        )
        print("  Download: https://zhanggroup.org/TM-align/")

    print("=" * 65)


def main():
    parser = argparse.ArgumentParser(
        description="Compare a predicted protein structure against a reference.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python compare.py --predicted pred.pdb --reference ref.pdb\n"
        ),
    )
    parser.add_argument(
        "--predicted",
        required=True,
        help="Path to the predicted PDB file.",
    )
    parser.add_argument(
        "--reference",
        required=True,
        help="Path to the reference (experimental) PDB file.",
    )
    args = parser.parse_args()

    # Validate inputs
    for path, label in [(args.predicted, "Predicted"), (args.reference, "Reference")]:
        if not os.path.isfile(path):
            print(f"ERROR: {label} file not found: {path}", file=sys.stderr)
            sys.exit(1)

    # Parse structures
    pdb_parser = PDBParser(QUIET=True)
    try:
        pred_structure = pdb_parser.get_structure("predicted", args.predicted)
    except Exception as e:
        print(f"ERROR: Failed to parse predicted PDB: {e}", file=sys.stderr)
        sys.exit(1)

    try:
        ref_structure = pdb_parser.get_structure("reference", args.reference)
    except Exception as e:
        print(f"ERROR: Failed to parse reference PDB: {e}", file=sys.stderr)
        sys.exit(1)

    # Extract CA atoms
    pred_ca = extract_ca_atoms(pred_structure)
    ref_ca = extract_ca_atoms(ref_structure)

    if len(pred_ca) == 0:
        print("ERROR: No CA atoms found in predicted structure.", file=sys.stderr)
        sys.exit(1)
    if len(ref_ca) == 0:
        print("ERROR: No CA atoms found in reference structure.", file=sys.stderr)
        sys.exit(1)

    # Align by residue number
    pred_atoms, ref_atoms, num_aligned = align_sequences_by_residue_number(pred_ca, ref_ca)

    if num_aligned < 3:
        print(
            f"ERROR: Only {num_aligned} residues could be aligned. "
            "Need at least 3 for superimposition.",
            file=sys.stderr,
        )
        sys.exit(1)

    print(f"Aligned {num_aligned} CA atom pairs for comparison.")

    # Compute BioPython RMSD
    rmsd, superimposer = compute_rmsd(pred_atoms, ref_atoms)

    # Compute per-residue distances
    distances = None
    if superimposer is not None:
        distances = compute_per_residue_distances(pred_atoms, ref_atoms, superimposer)

    # Try TMalign
    tmalign_results = run_tmalign(args.predicted, args.reference)
    if tmalign_results:
        print("TMalign found and executed successfully.")
    else:
        print(
            "TMalign not found. Using BioPython-based comparison. "
            "Install TMalign for more accurate metrics."
        )

    # Print report
    print_comparison_report(
        args.predicted,
        args.reference,
        len(pred_ca),
        len(ref_ca),
        num_aligned,
        rmsd,
        distances,
        tmalign_results,
    )

    return 0


if __name__ == "__main__":
    sys.exit(main())
