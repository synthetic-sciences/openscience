#!/usr/bin/env python3
"""
Evaluate a predicted protein structure for confidence and structural quality.

Reads a PDB file (typically from ESMFold) and computes:
  - Mean and per-residue pLDDT scores (from B-factor column)
  - pLDDT distribution by confidence tier
  - Estimated secondary structure content
  - Low-confidence region identification

Usage:
    python evaluate.py --input predicted.pdb
"""

import argparse
import math
import os
import sys

try:
    import numpy as np
except ImportError:
    print(
        "ERROR: NumPy is not installed. Install with: pip install numpy",
        file=sys.stderr,
    )
    sys.exit(1)

try:
    from Bio.PDB import PDBParser, is_aa
    from Bio.PDB.vectors import calc_dihedral, Vector
except ImportError:
    print(
        "ERROR: BioPython is not installed. Install with: pip install biopython",
        file=sys.stderr,
    )
    sys.exit(1)


def extract_plddt_from_bfactor(structure):
    """Extract per-residue pLDDT scores from the B-factor of CA atoms.

    Returns a list of (chain_id, residue_number, residue_name, plddt) tuples.
    """
    residue_data = []
    for model in structure:
        for chain in model:
            for residue in chain:
                if not is_aa(residue, standard=True):
                    continue
                ca = residue.child_dict.get("CA")
                if ca is not None:
                    plddt = ca.get_bfactor()
                    res_name = residue.get_resname()
                    res_num = residue.get_id()[1]
                    chain_id = chain.get_id()
                    residue_data.append((chain_id, res_num, res_name, plddt))
        break  # Only process the first model
    return residue_data


def estimate_secondary_structure(structure):
    """Estimate secondary structure content from backbone dihedral angles.

    Uses Ramachandran-based classification:
      - Helix: phi in [-160, -20], psi in [-80, 0]
      - Sheet: phi in [-180, -40], psi in [50, 180] or psi in [-180, -120]
      - Coil: everything else

    This is an approximation. For accurate SS assignment, use DSSP.
    """
    phi_psi_list = []

    for model in structure:
        for chain in model:
            residues = [r for r in chain if is_aa(r, standard=True)]
            for i in range(1, len(residues) - 1):
                try:
                    prev_res = residues[i - 1]
                    curr_res = residues[i]
                    next_res = residues[i + 1]

                    # Get atoms for phi: C(i-1), N(i), CA(i), C(i)
                    c_prev = prev_res["C"].get_vector()
                    n_curr = curr_res["N"].get_vector()
                    ca_curr = curr_res["CA"].get_vector()
                    c_curr = curr_res["C"].get_vector()

                    # Get atoms for psi: N(i), CA(i), C(i), N(i+1)
                    n_next = next_res["N"].get_vector()

                    phi = math.degrees(calc_dihedral(c_prev, n_curr, ca_curr, c_curr))
                    psi = math.degrees(calc_dihedral(n_curr, ca_curr, c_curr, n_next))

                    phi_psi_list.append((phi, psi))
                except (KeyError, Exception):
                    continue
        break  # Only process first model

    if len(phi_psi_list) == 0:
        return None

    helix_count = 0
    sheet_count = 0
    coil_count = 0

    for phi, psi in phi_psi_list:
        if -160 <= phi <= -20 and -80 <= psi <= 0:
            helix_count += 1
        elif (-180 <= phi <= -40) and ((50 <= psi <= 180) or (-180 <= psi <= -120)):
            sheet_count += 1
        else:
            coil_count += 1

    total = len(phi_psi_list)
    return {
        "helix": helix_count / total * 100,
        "sheet": sheet_count / total * 100,
        "coil": coil_count / total * 100,
        "total_residues_analyzed": total,
    }


def find_low_confidence_regions(residue_data, threshold=50.0):
    """Find contiguous regions with pLDDT below the threshold.

    Returns a list of dicts with chain, start, end, mean_plddt, length.
    """
    regions = []
    current_region = None

    for chain_id, res_num, res_name, plddt in residue_data:
        if plddt < threshold:
            if current_region is None:
                current_region = {
                    "chain": chain_id,
                    "start": res_num,
                    "end": res_num,
                    "plddt_values": [plddt],
                }
            elif chain_id == current_region["chain"] and res_num <= current_region["end"] + 3:
                # Allow small gaps (up to 2 residues) within a low-confidence region
                current_region["end"] = res_num
                current_region["plddt_values"].append(plddt)
            else:
                regions.append(current_region)
                current_region = {
                    "chain": chain_id,
                    "start": res_num,
                    "end": res_num,
                    "plddt_values": [plddt],
                }
        else:
            if current_region is not None:
                regions.append(current_region)
                current_region = None

    if current_region is not None:
        regions.append(current_region)

    # Compute summary stats for each region
    for region in regions:
        region["mean_plddt"] = np.mean(region["plddt_values"])
        region["length"] = len(region["plddt_values"])
        del region["plddt_values"]  # Clean up

    return regions


def print_report(filepath, residue_data, ss_content, low_conf_regions):
    """Print a formatted evaluation report."""
    plddt_values = np.array([r[3] for r in residue_data])

    print("\n" + "=" * 65)
    print("STRUCTURE EVALUATION REPORT")
    print("=" * 65)
    print(f"File:             {filepath}")
    print(f"Total residues:   {len(residue_data)}")

    if len(residue_data) == 0:
        print("WARNING: No amino acid residues found in the structure.")
        print("=" * 65)
        return

    # pLDDT statistics
    print("-" * 65)
    print("pLDDT CONFIDENCE SCORES")
    print("-" * 65)
    print(f"  Mean:     {np.mean(plddt_values):6.1f}")
    print(f"  Median:   {np.median(plddt_values):6.1f}")
    print(f"  Std Dev:  {np.std(plddt_values):6.1f}")
    print(f"  Min:      {np.min(plddt_values):6.1f} (residue {residue_data[np.argmin(plddt_values)][1]})")
    print(f"  Max:      {np.max(plddt_values):6.1f} (residue {residue_data[np.argmax(plddt_values)][1]})")

    # Confidence tier breakdown
    print("-" * 65)
    print("CONFIDENCE DISTRIBUTION")
    print("-" * 65)

    n = len(plddt_values)
    tiers = [
        ("Very high (>90)", np.sum(plddt_values > 90)),
        ("Confident (70-90)", np.sum((plddt_values > 70) & (plddt_values <= 90))),
        ("Low (50-70)", np.sum((plddt_values > 50) & (plddt_values <= 70))),
        ("Very low (<50)", np.sum(plddt_values <= 50)),
    ]

    bar_width = 30
    for label, count in tiers:
        pct = count / n * 100
        filled = int(pct / 100 * bar_width)
        bar = "#" * filled + "." * (bar_width - filled)
        print(f"  {label:20s} [{bar}] {pct:5.1f}% ({int(count):4d} residues)")

    # Histogram of pLDDT values
    print("-" * 65)
    print("pLDDT HISTOGRAM")
    print("-" * 65)
    bins = [(0, 10), (10, 20), (20, 30), (30, 40), (40, 50),
            (50, 60), (60, 70), (70, 80), (80, 90), (90, 100)]
    max_count = 0
    bin_counts = []
    for lo, hi in bins:
        if hi == 100:
            count = int(np.sum((plddt_values >= lo) & (plddt_values <= hi)))
        else:
            count = int(np.sum((plddt_values >= lo) & (plddt_values < hi)))
        bin_counts.append(count)
        if count > max_count:
            max_count = count

    for (lo, hi), count in zip(bins, bin_counts):
        if max_count > 0:
            bar_len = int(count / max_count * 30)
        else:
            bar_len = 0
        bar = "#" * bar_len
        print(f"  {lo:3d}-{hi:3d}: {bar:30s} {count}")

    # Secondary structure content
    print("-" * 65)
    print("SECONDARY STRUCTURE (estimated from backbone dihedrals)")
    print("-" * 65)
    if ss_content is not None:
        print(f"  Alpha helix: {ss_content['helix']:5.1f}%")
        print(f"  Beta sheet:  {ss_content['sheet']:5.1f}%")
        print(f"  Coil/other:  {ss_content['coil']:5.1f}%")
        print(f"  (Based on {ss_content['total_residues_analyzed']} residues with calculable dihedrals)")
    else:
        print("  Could not compute secondary structure (insufficient backbone atoms).")

    # Low-confidence regions
    print("-" * 65)
    print("LOW-CONFIDENCE REGIONS (pLDDT < 50)")
    print("-" * 65)
    if len(low_conf_regions) == 0:
        print("  None found. All residues have pLDDT >= 50.")
    else:
        print(f"  {'Chain':<6} {'Start':<8} {'End':<8} {'Length':<8} {'Mean pLDDT':<12}")
        print(f"  {'-'*5:<6} {'-'*7:<8} {'-'*7:<8} {'-'*7:<8} {'-'*10:<12}")
        for region in low_conf_regions:
            print(
                f"  {region['chain']:<6} {region['start']:<8} {region['end']:<8} "
                f"{region['length']:<8} {region['mean_plddt']:<12.1f}"
            )
        total_low = sum(r["length"] for r in low_conf_regions)
        print(f"\n  Total low-confidence residues: {total_low} ({total_low/n*100:.1f}%)")
        print(
            "  NOTE: These regions may be intrinsically disordered or represent "
            "regions where the prediction is unreliable."
        )

    # Overall assessment
    mean_plddt = np.mean(plddt_values)
    print("-" * 65)
    print("OVERALL ASSESSMENT")
    print("-" * 65)
    if mean_plddt > 80:
        print(
            f"  Mean pLDDT = {mean_plddt:.1f}: HIGH QUALITY PREDICTION\n"
            "  The overall structure is likely reliable. Backbone positions are\n"
            "  expected to be accurate, and most side-chain orientations should\n"
            "  be approximately correct."
        )
    elif mean_plddt > 60:
        print(
            f"  Mean pLDDT = {mean_plddt:.1f}: MODERATE QUALITY PREDICTION\n"
            "  The overall fold topology is likely correct, but local details\n"
            "  (loop conformations, side-chain positions) may be unreliable.\n"
            "  Exercise caution with residue-level analyses."
        )
    elif mean_plddt > 40:
        print(
            f"  Mean pLDDT = {mean_plddt:.1f}: LOW QUALITY PREDICTION\n"
            "  The prediction has limited reliability. The protein may be\n"
            "  partially disordered, or the sequence may be difficult for\n"
            "  single-sequence prediction. Consider using AlphaFold2 with MSA."
        )
    else:
        print(
            f"  Mean pLDDT = {mean_plddt:.1f}: VERY LOW QUALITY PREDICTION\n"
            "  The prediction should not be trusted for structural analysis.\n"
            "  The protein is likely intrinsically disordered, or the sequence\n"
            "  is outside the model's capability."
        )

    print("=" * 65)


def main():
    parser = argparse.ArgumentParser(
        description="Evaluate a predicted protein structure for confidence and quality.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python evaluate.py --input predicted.pdb\n"
        ),
    )
    parser.add_argument(
        "--input",
        required=True,
        help="Path to the PDB file to evaluate.",
    )
    args = parser.parse_args()

    # Validate input
    if not os.path.isfile(args.input):
        print(f"ERROR: File not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    # Parse PDB
    parser_pdb = PDBParser(QUIET=True)
    try:
        structure = parser_pdb.get_structure("structure", args.input)
    except Exception as e:
        print(f"ERROR: Failed to parse PDB file: {e}", file=sys.stderr)
        sys.exit(1)

    # Extract pLDDT
    residue_data = extract_plddt_from_bfactor(structure)
    if len(residue_data) == 0:
        print(
            "ERROR: No standard amino acid residues with CA atoms found in the PDB file.",
            file=sys.stderr,
        )
        sys.exit(1)

    # Estimate secondary structure
    ss_content = estimate_secondary_structure(structure)

    # Find low-confidence regions
    low_conf_regions = find_low_confidence_regions(residue_data, threshold=50.0)

    # Print report
    print_report(args.input, residue_data, ss_content, low_conf_regions)

    return 0


if __name__ == "__main__":
    sys.exit(main())
