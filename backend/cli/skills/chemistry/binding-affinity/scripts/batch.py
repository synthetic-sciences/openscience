#!/usr/bin/env python3
"""
Batch virtual screening for binding affinity.

Efficiently scores a compound library against a protein target using the
empirical descriptor + contact model from predict.py.

Usage:
    python batch.py --protein target.pdb --library compounds.sdf --output hits.csv
    python batch.py --protein target.pdb --library compounds.sdf --output hits.csv --top-n 50 --threshold 6.0
"""

import argparse
import csv
import json
import math
import os
import sys
import time
import warnings

from output_guard import validate_output_path, log_to_manifest

warnings.filterwarnings("ignore")

try:
    from rdkit import Chem
    from rdkit.Chem import Descriptors
except ImportError:
    sys.exit("ERROR: RDKit is required. Install with: pip install rdkit-pypi")

try:
    import numpy as np
except ImportError:
    sys.exit("ERROR: NumPy is required. Install with: pip install numpy")

# Import prediction functions from predict.py in the same directory
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)
from predict import (
    extract_ligand_descriptors,
    extract_contact_features,
    extract_contact_features_rdkit,
    compute_pkd,
    compute_pkd_fallback,
    pkd_to_dg,
    pkd_to_kd_nm,
    assess_confidence,
    PKD_UNCERTAINTY,
)

HAS_BIOPYTHON = False
try:
    from Bio.PDB import PDBParser, NeighborSearch
    HAS_BIOPYTHON = True
except ImportError:
    pass


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def batch_screen(protein_pdb, library_sdf, output_path, method="descriptor",
                 top_n=None, threshold=None, sort_by="predicted_pKd",
                 chain_id=None):
    """Screen a compound library against a protein target."""
    print("=" * 60)
    print("BATCH VIRTUAL SCREENING")
    print("=" * 60)
    print(f"Protein: {protein_pdb}")
    print(f"Library: {library_sdf}")
    if top_n:
        print(f"Top N: {top_n}")
    if threshold:
        print(f"pKd threshold: {threshold}")
    print()

    # Parse protein once
    protein_coords = None
    protein_mol = None

    if HAS_BIOPYTHON:
        parser = PDBParser(QUIET=True)
        structure = parser.get_structure("protein", protein_pdb)
        atoms = []
        for model in structure:
            for chain in model:
                if chain_id and chain.get_id() != chain_id:
                    continue
                for residue in chain:
                    for atom in residue:
                        atoms.append(atom)
            break
        element_to_num = {"C": 6, "N": 7, "O": 8, "S": 16, "H": 1, "P": 15}
        protein_coords = [
            (atom.get_vector().get_array(),
             element_to_num.get(atom.element.strip(), 6))
            for atom in atoms
        ]
        print(f"Parsed protein: {len(protein_coords)} atoms (BioPython)")
    else:
        protein_mol = Chem.MolFromPDBFile(protein_pdb, removeHs=False, sanitize=False)
        if protein_mol is None:
            sys.exit("ERROR: Could not parse protein PDB.")
        print(f"Parsed protein: {protein_mol.GetNumAtoms()} atoms (RDKit)")

    # Process library
    suppl = Chem.SDMolSupplier(library_sdf, removeHs=False)
    results = []
    n_processed = 0
    n_failed = 0
    start_time = time.time()

    for i, mol in enumerate(suppl):
        if mol is None:
            n_failed += 1
            continue

        n_processed += 1
        pose_name = mol.GetProp("_Name") if mol.HasProp("_Name") else f"mol_{i+1}"

        try:
            # Extract features
            descriptors = extract_ligand_descriptors(mol)
            if protein_coords:
                contacts = extract_contact_features(protein_coords, mol)
            else:
                contacts = extract_contact_features_rdkit(protein_mol, mol)

            # Score
            if method == "descriptor":
                pkd = compute_pkd(descriptors, contacts)
            else:
                pkd = compute_pkd_fallback(contacts)

            pkd = round(pkd, 1)

            # Apply threshold filter
            if threshold and pkd < threshold:
                continue

            dg = round(pkd_to_dg(pkd), 1)
            kd_nm = pkd_to_kd_nm(pkd)
            confidence, _ = assess_confidence(descriptors, contacts)

            # Get SMILES
            smiles = Chem.MolToSmiles(mol)

            results.append({
                "pose_name": pose_name,
                "smiles": smiles,
                "predicted_pKd": pkd,
                "pKd_uncertainty": PKD_UNCERTAINTY,
                "predicted_dG_kcal": dg,
                "predicted_Kd_nM": kd_nm,
                "confidence": confidence,
                "mw": descriptors["mw"],
                "logp": descriptors["logp"],
            })

        except Exception as e:
            n_failed += 1
            if n_failed <= 5:
                print(f"  WARNING: Failed on {pose_name}: {e}")

        # Progress reporting
        if n_processed % 100 == 0:
            elapsed = time.time() - start_time
            rate = n_processed / elapsed if elapsed > 0 else 0
            print(f"  Processed {n_processed} molecules ({rate:.0f}/sec)...")

    elapsed = time.time() - start_time
    print(f"\nProcessed {n_processed} molecules in {elapsed:.1f}s")
    if n_failed > 0:
        print(f"Failed: {n_failed}")
    print(f"Hits passing threshold: {len(results)}")

    # Sort
    if sort_by == "predicted_dG":
        results.sort(key=lambda r: r["predicted_dG_kcal"])
    else:
        results.sort(key=lambda r: r["predicted_pKd"], reverse=True)

    # Apply top-n
    if top_n and top_n < len(results):
        results = results[:top_n]

    # Write CSV
    fieldnames = [
        "rank", "pose_name", "smiles", "predicted_pKd", "pKd_uncertainty",
        "predicted_dG_kcal", "predicted_Kd_nM", "confidence", "mw", "logp",
    ]
    with open(output_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for i, result in enumerate(results):
            result["rank"] = i + 1
            writer.writerow(result)

    print(f"\nTop {len(results)} hits saved to: {output_path}")

    # Print disclaimer
    print()
    print("=" * 60)
    print("NOTE: Empirical estimates, not experimentally validated.")
    print("Typical error: 1-2 log units pKd (~10-100x in Kd).")
    print("Use for compound prioritization, not affinity claims.")
    print("=" * 60)

    # Print top 5
    if results:
        print("\nTop 5 hits:")
        for r in results[:5]:
            print(f"  #{r['rank']} {r['pose_name']}: "
                  f"pKd={r['predicted_pKd']}, "
                  f"Kd~{r['predicted_Kd_nM']}nM, "
                  f"conf={r['confidence']}")


def main():
    parser = argparse.ArgumentParser(
        description="Batch virtual screening. Scores a compound library "
                    "for binding affinity against a protein target. "
                    "NOTE: Estimates only — typical error is 1-2 log units pKd.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python batch.py --protein target.pdb --library compounds.sdf --output hits.csv
  python batch.py --protein target.pdb --library compounds.sdf --output hits.csv --top-n 50 --threshold 6.0
        """,
    )
    parser.add_argument("--protein", required=True, help="Protein PDB file")
    parser.add_argument("--library", required=True, help="Compound library SDF")
    parser.add_argument("--output", required=True, help="Output hits CSV")
    parser.add_argument(
        "--method", default="descriptor", choices=["descriptor", "contact"],
        help="Scoring method (default: descriptor)",
    )
    parser.add_argument(
        "--top-n", type=int, default=None,
        help="Only output top N hits (optional)",
    )
    parser.add_argument(
        "--threshold", type=float, default=None,
        help="Minimum pKd to report (optional)",
    )
    parser.add_argument(
        "--sort-by", default="predicted_pKd",
        choices=["predicted_pKd", "predicted_dG"],
        help="Sort by (default: predicted_pKd)",
    )
    parser.add_argument("--chain", default=None, help="Chain ID (optional)")

    args = parser.parse_args()

    if not os.path.exists(args.protein):
        sys.exit(f"ERROR: Protein file not found: {args.protein}")
    if not os.path.exists(args.library):
        sys.exit(f"ERROR: Library file not found: {args.library}")

    args.output = validate_output_path(args.output)

    output_dir = os.path.dirname(args.output)
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)

    batch_screen(
        args.protein, args.library, args.output,
        method=args.method, top_n=args.top_n,
        threshold=args.threshold, sort_by=args.sort_by,
        chain_id=args.chain,
    )

    log_to_manifest("batch.py", {
        "--protein": args.protein,
        "--library": args.library,
        "--method": args.method,
        "--top-n": args.top_n,
        "--threshold": args.threshold,
    }, args.output)


if __name__ == "__main__":
    main()
