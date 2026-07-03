#!/usr/bin/env python3
"""
Empirical binding affinity prediction from docked poses.

Computes descriptor + contact features from protein-ligand complexes and
applies an empirical scoring function to estimate pKd, ΔG, and Kd.

IMPORTANT: These are computational estimates with typical error of 1-2 log
units pKd (~10-100x in Kd). Use for relative ranking only, not absolute
affinity claims.

Usage:
    python predict.py --protein prepared.pdb --poses poses.sdf --output affinity.json
    python predict.py --protein target.pdb --poses docked.sdf --output affinity.json --method contact
"""

import argparse
import json
import math
import os
import sys
import warnings

from output_guard import validate_output_path, log_to_manifest

warnings.filterwarnings("ignore")

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------

try:
    from rdkit import Chem
    from rdkit.Chem import AllChem, Descriptors, rdMolDescriptors
except ImportError:
    sys.exit("ERROR: RDKit is required. Install with: pip install rdkit-pypi")

try:
    import numpy as np
except ImportError:
    sys.exit("ERROR: NumPy is required. Install with: pip install numpy")

HAS_BIOPYTHON = False
try:
    from Bio.PDB import PDBParser, NeighborSearch
    HAS_BIOPYTHON = True
except ImportError:
    pass

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Empirical scoring coefficients (approximate, derived from PDBbind literature)
# These are NOT a trained ML model — they are rough linear approximations.
SCORING_COEFFICIENTS = {
    "intercept": 1.80,
    "burial_fraction": 2.50,
    "n_hbonds": 0.60,
    "n_hydrophobic": 0.15,
    "n_aromatic": 0.30,
    "n_charged": 0.40,
    "logp_correction": 0.10,
    "mw_penalty": -0.002,  # penalty for very large molecules
    "energy_proxy": 0.50,
}

# Fallback simpler coefficients
FALLBACK_COEFFICIENTS = {
    "hbond_weight": -0.73,
    "hydrophobic_weight": -0.36,
    "contact_sqrt_weight": -0.45,
    "offset": -2.0,
}

# pKd uncertainty (log units) — literature-derived estimate
PKD_UNCERTAINTY = 1.5

# Temperature for thermodynamic conversions
TEMPERATURE_K = 298.15
R_KCAL = 1.987e-3  # kcal/(mol·K)


# ---------------------------------------------------------------------------
# Feature extraction
# ---------------------------------------------------------------------------


def extract_ligand_descriptors(mol):
    """Extract molecular descriptors from an RDKit molecule."""
    return {
        "mw": round(Descriptors.MolWt(mol), 1),
        "logp": round(Descriptors.MolLogP(mol), 2),
        "tpsa": round(Descriptors.TPSA(mol), 1),
        "hbd": Descriptors.NumHDonors(mol),
        "hba": Descriptors.NumHAcceptors(mol),
        "rotatable_bonds": Descriptors.NumRotatableBonds(mol),
        "aromatic_rings": rdMolDescriptors.CalcNumAromaticRings(mol),
        "formal_charge": Chem.GetFormalCharge(mol),
        "n_heavy_atoms": mol.GetNumHeavyAtoms(),
    }


def extract_contact_features(protein_coords, ligand_mol, ligand_conf_id=0):
    """
    Count atom-type contacts between protein and ligand.

    protein_coords: list of (coord_array, atomic_num) tuples from BioPython
    """
    ligand_conf = ligand_mol.GetConformer(ligand_conf_id)

    # Get ligand atom info
    ligand_atoms = []
    for i in range(ligand_mol.GetNumAtoms()):
        atom = ligand_mol.GetAtomWithIdx(i)
        pos = ligand_conf.GetAtomPosition(i)
        ligand_atoms.append({
            "coord": np.array([pos.x, pos.y, pos.z]),
            "atomic_num": atom.GetAtomicNum(),
            "is_aromatic": atom.GetIsAromatic(),
        })

    # Count contacts by type
    n_hydrophobic = 0  # C…C within 4.5 A
    n_hbond = 0        # N/O…N/O within 3.5 A
    n_aromatic = 0     # aromatic C…aromatic C within 5.0 A
    n_charged = 0      # charged…charged within 4.0 A
    n_total = 0
    sum_inv_r6 = 0.0
    min_distances = []

    polar_nums = {7, 8}     # N, O
    carbon_num = 6
    charged_nums = {7, 8}   # simplified — N can be + (NH3), O can be - (COO)

    for la in ligand_atoms:
        closest_dist = float("inf")
        for p_coord, p_anum in protein_coords:
            dist = np.linalg.norm(la["coord"] - p_coord)

            if dist < closest_dist:
                closest_dist = dist

            # Hydrophobic: C…C within 4.5 A
            if (la["atomic_num"] == carbon_num and p_anum == carbon_num
                    and dist <= 4.5):
                n_hydrophobic += 1

            # H-bond: N/O…N/O within 3.5 A
            if (la["atomic_num"] in polar_nums and p_anum in polar_nums
                    and dist <= 3.5):
                n_hbond += 1

            # Aromatic: aromatic C…aromatic C within 5.0 A
            if (la["is_aromatic"] and la["atomic_num"] == carbon_num
                    and p_anum == carbon_num and dist <= 5.0):
                n_aromatic += 1

            # Charged: within 4.0 A
            if (la["atomic_num"] in charged_nums and p_anum in charged_nums
                    and dist <= 4.0):
                n_charged += 1

            # Close contacts for energy proxy
            if dist <= 6.0 and dist > 0.5:
                n_total += 1
                sum_inv_r6 += 1.0 / (dist ** 6)

        min_distances.append(closest_dist)

    # Burial fraction: fraction of ligand atoms with closest protein atom < 4 A
    buried = sum(1 for d in min_distances if d < 4.0)
    burial_fraction = buried / len(min_distances) if min_distances else 0

    # Contact surface area proxy
    close_atoms = sum(1 for d in min_distances if d < 5.0)

    return {
        "n_hydrophobic": n_hydrophobic,
        "n_hbonds": n_hbond,
        "n_aromatic": n_aromatic,
        "n_charged": n_charged,
        "n_total_contacts": n_total,
        "burial_fraction": round(burial_fraction, 2),
        "contact_surface_proxy": close_atoms,
        "energy_proxy": round(sum_inv_r6, 4),
    }


def extract_contact_features_rdkit(protein_mol, ligand_mol, ligand_conf_id=0):
    """
    Fallback: extract contact features using RDKit protein parsing.

    Used when BioPython is not available.
    """
    try:
        protein_conf = protein_mol.GetConformer(0)
    except Exception:
        return _empty_contacts()

    ligand_conf = ligand_mol.GetConformer(ligand_conf_id)

    protein_atoms = []
    for i in range(protein_mol.GetNumAtoms()):
        pos = protein_conf.GetAtomPosition(i)
        atom = protein_mol.GetAtomWithIdx(i)
        protein_atoms.append(
            (np.array([pos.x, pos.y, pos.z]), atom.GetAtomicNum())
        )

    # Reuse the main function with RDKit-extracted coords
    return extract_contact_features(protein_atoms, ligand_mol, ligand_conf_id)


def _empty_contacts():
    return {
        "n_hydrophobic": 0, "n_hbonds": 0, "n_aromatic": 0,
        "n_charged": 0, "n_total_contacts": 0, "burial_fraction": 0,
        "contact_surface_proxy": 0, "energy_proxy": 0,
    }


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------


def compute_pkd(descriptors, contacts):
    """
    Compute empirical pKd from descriptors and contacts.

    This is an approximate linear model — NOT a trained ML predictor.
    """
    c = SCORING_COEFFICIENTS

    pkd = c["intercept"]
    pkd += c["burial_fraction"] * contacts["burial_fraction"]
    pkd += c["n_hbonds"] * min(contacts["n_hbonds"], 10)  # cap
    pkd += c["n_hydrophobic"] * min(contacts["n_hydrophobic"], 30)  # cap
    pkd += c["n_aromatic"] * min(contacts["n_aromatic"], 10)
    pkd += c["n_charged"] * min(contacts["n_charged"], 5)
    pkd += c["logp_correction"] * descriptors["logp"]
    pkd += c["mw_penalty"] * max(0, descriptors["mw"] - 500)
    pkd += c["energy_proxy"] * min(contacts["energy_proxy"], 5.0)

    # Clamp to reasonable range
    pkd = max(1.0, min(pkd, 12.0))
    return pkd


def compute_pkd_fallback(contacts):
    """Simpler fallback scoring when descriptors are limited."""
    c = FALLBACK_COEFFICIENTS
    dg = (c["hbond_weight"] * contacts["n_hbonds"]
          + c["hydrophobic_weight"] * contacts["n_hydrophobic"]
          + c["contact_sqrt_weight"] * math.sqrt(max(contacts["n_total_contacts"], 1))
          + c["offset"])
    # ΔG → pKd: pKd = -ΔG / (R * T * ln(10))
    pkd = -dg / (R_KCAL * TEMPERATURE_K * math.log(10))
    return max(1.0, min(pkd, 12.0))


def pkd_to_dg(pkd):
    """Convert pKd to ΔG in kcal/mol at 298K."""
    return -R_KCAL * TEMPERATURE_K * math.log(10) * pkd


def pkd_to_kd_nm(pkd):
    """Convert pKd to Kd in nM. Cap false precision to 1 significant figure."""
    kd_m = 10 ** (-pkd)
    kd_nm = kd_m * 1e9
    # Round to 1 significant figure to avoid false precision
    if kd_nm == 0:
        return 0
    magnitude = 10 ** math.floor(math.log10(abs(kd_nm)))
    return round(kd_nm / magnitude) * magnitude


def assess_confidence(descriptors, contacts):
    """Assess prediction confidence based on applicability domain."""
    mw = descriptors.get("mw", 0)
    logp = descriptors.get("logp", 0)
    n_contacts = contacts.get("n_total_contacts", 0)

    issues = []
    if mw < 200:
        issues.append("MW too low (<200)")
    if mw > 600:
        issues.append("MW too high (>600)")
    if logp < -1:
        issues.append("LogP too low (<-1)")
    if logp > 5:
        issues.append("LogP too high (>5)")
    if n_contacts < 10:
        issues.append("Too few contacts (<10)")

    if not issues:
        if n_contacts > 30:
            return "high", []
        return "moderate", []

    if len(issues) >= 2:
        return "low", issues

    return "moderate", issues


# ---------------------------------------------------------------------------
# Main prediction pipeline
# ---------------------------------------------------------------------------


def predict_affinity(protein_pdb, poses_sdf, output_path, method="descriptor",
                     contact_radius=4.5, chain_id=None):
    """
    Predict binding affinity for docked poses.
    """
    print("=" * 60)
    print("BINDING AFFINITY PREDICTION")
    print("=" * 60)
    print(f"Protein: {protein_pdb}")
    print(f"Poses: {poses_sdf}")
    print(f"Method: {method}")
    print()

    # Parse protein
    protein_coords = None
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
        protein_coords = [
            (atom.get_vector().get_array(), atom.element.strip())
            for atom in atoms
        ]
        # Map element names to atomic numbers
        element_to_num = {"C": 6, "N": 7, "O": 8, "S": 16, "H": 1, "P": 15}
        protein_coords = [
            (coord, element_to_num.get(elem, 6))
            for coord, elem in protein_coords
        ]
        print(f"Parsed protein with BioPython: {len(protein_coords)} atoms")
    else:
        print("BioPython not available. Using RDKit for protein parsing.")

    protein_mol = None
    if not protein_coords:
        protein_mol = Chem.MolFromPDBFile(protein_pdb, removeHs=False, sanitize=False)
        if protein_mol is None:
            sys.exit("ERROR: Could not parse protein PDB with RDKit.")
        print(f"Parsed protein with RDKit: {protein_mol.GetNumAtoms()} atoms")

    # Load poses
    suppl = Chem.SDMolSupplier(poses_sdf, removeHs=False)
    predictions = []

    for i, mol in enumerate(suppl):
        if mol is None:
            print(f"  Pose {i+1}: SKIPPED (invalid molecule)")
            continue

        pose_name = mol.GetProp("_Name") if mol.HasProp("_Name") else f"pose_{i+1}"
        print(f"Scoring pose {i+1} ({pose_name})...")

        # Extract ligand descriptors
        descriptors = extract_ligand_descriptors(mol)

        # Extract contact features
        if protein_coords:
            contacts = extract_contact_features(protein_coords, mol)
        else:
            contacts = extract_contact_features_rdkit(protein_mol, mol)

        # Compute pKd
        if method == "descriptor":
            pkd = compute_pkd(descriptors, contacts)
        else:
            pkd = compute_pkd_fallback(contacts)

        # Round to 1 decimal (cap false precision)
        pkd = round(pkd, 1)

        # Convert
        dg = round(pkd_to_dg(pkd), 1)
        kd_nm = pkd_to_kd_nm(pkd)

        # Confidence
        confidence, issues = assess_confidence(descriptors, contacts)

        pred = {
            "pose_id": i + 1,
            "pose_name": pose_name,
            "predicted_pKd": pkd,
            "pKd_uncertainty": PKD_UNCERTAINTY,
            "pKd_range": [round(pkd - PKD_UNCERTAINTY, 1),
                          round(pkd + PKD_UNCERTAINTY, 1)],
            "predicted_dG_kcal": dg,
            "predicted_Kd_nM": kd_nm,
            "confidence": confidence,
            "features": {
                "mw": descriptors["mw"],
                "logp": descriptors["logp"],
                "tpsa": descriptors["tpsa"],
                "hbd": descriptors["hbd"],
                "hba": descriptors["hba"],
                "n_hbonds": contacts["n_hbonds"],
                "n_hydrophobic": contacts["n_hydrophobic"],
                "n_aromatic": contacts["n_aromatic"],
                "n_charged": contacts["n_charged"],
                "n_total_contacts": contacts["n_total_contacts"],
                "burial_fraction": contacts["burial_fraction"],
            },
        }
        if issues:
            pred["confidence_issues"] = issues

        predictions.append(pred)

        # Print
        print(f"  pKd: {pkd} (range: {pred['pKd_range'][0]}-{pred['pKd_range'][1]})")
        print(f"  ΔG: {dg} kcal/mol")
        print(f"  Kd: ~{kd_nm} nM")
        print(f"  Confidence: {confidence}")
        if issues:
            print(f"  Issues: {', '.join(issues)}")
        print()

    # Sort by pKd descending
    predictions.sort(key=lambda p: p["predicted_pKd"], reverse=True)

    # Write output
    output_data = {
        "protein": os.path.basename(protein_pdb),
        "poses_file": os.path.basename(poses_sdf),
        "method": method,
        "n_poses": len(predictions),
        "note": (
            "Empirical estimate, not experimentally validated. "
            "Typical error: 1-2 log units pKd (~10-100x in Kd). "
            "Use for relative ranking only, not absolute affinity claims."
        ),
        "predictions": predictions,
    }

    with open(output_path, "w") as f:
        json.dump(output_data, f, indent=2)

    print("=" * 60)
    print("NOTE: Empirical estimate, not experimentally validated.")
    print("Typical error: 1-2 log units pKd (~10-100x in Kd).")
    print("Use for relative ranking only, not absolute affinity claims.")
    print("=" * 60)
    print(f"\n{len(predictions)} pose(s) scored. Output: {output_path}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(
        description="Predict binding affinity from docked poses using "
                    "empirical descriptor + contact features. "
                    "NOTE: Estimates only — typical error is 1-2 log units pKd.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python predict.py --protein protein.pdb --poses poses.sdf --output affinity.json
  python predict.py --protein target.pdb --poses docked.sdf --output affinity.json --method contact
        """,
    )
    parser.add_argument("--protein", required=True, help="Protein PDB file")
    parser.add_argument("--poses", required=True, help="Docked poses SDF file")
    parser.add_argument("--output", required=True, help="Output affinity JSON")
    parser.add_argument(
        "--method", default="descriptor", choices=["descriptor", "contact"],
        help="Scoring method (default: descriptor)",
    )
    parser.add_argument(
        "--contact-radius", type=float, default=4.5,
        help="Contact detection radius in A (default: 4.5)",
    )
    parser.add_argument("--chain", default=None, help="Chain ID (optional)")

    args = parser.parse_args()

    if not os.path.exists(args.protein):
        sys.exit(f"ERROR: Protein file not found: {args.protein}")
    if not os.path.exists(args.poses):
        sys.exit(f"ERROR: Poses file not found: {args.poses}")

    args.output = validate_output_path(args.output)

    output_dir = os.path.dirname(args.output)
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)

    predict_affinity(
        args.protein, args.poses, args.output,
        method=args.method, contact_radius=args.contact_radius,
        chain_id=args.chain,
    )

    log_to_manifest("predict.py", {
        "--protein": args.protein,
        "--poses": args.poses,
        "--method": args.method,
    }, args.output)


if __name__ == "__main__":
    main()
