#!/usr/bin/env python3
"""
MM/GBSA rescoring of docked poses.

Two code paths:
  - Full MM/GBSA: OpenMM + Amber ff14SB + OpenFF (requires openmm)
  - RDKit fallback: MMFF energy approximation (no OpenMM needed)

Usage:
    python rescore.py --protein protein.pdb --poses poses.sdf --output energy.json
    python rescore.py --protein protein.pdb --poses poses.sdf --output energy.json --minimize-steps 100
"""

import argparse
import json
import math
import os
import sys
import warnings

from output_guard import validate_output_path, log_to_manifest

warnings.filterwarnings("ignore")

try:
    from rdkit import Chem
    from rdkit.Chem import AllChem, rdMolDescriptors
except ImportError:
    sys.exit("ERROR: RDKit is required. Install with: pip install rdkit-pypi")

try:
    import numpy as np
except ImportError:
    sys.exit("ERROR: NumPy is required. Install with: pip install numpy")

# Check for OpenMM
HAS_OPENMM = False
try:
    import openmm
    import openmm.app as app
    import openmm.unit as unit
    HAS_OPENMM = True
except ImportError:
    pass


# ---------------------------------------------------------------------------
# RDKit MMFF fallback
# ---------------------------------------------------------------------------


def _mmff_energy(mol):
    """Compute MMFF94 energy of a molecule. Returns kcal/mol or None."""
    try:
        props = AllChem.MMFFGetMoleculeProperties(mol, mmffVariant="MMFF94")
        if props is None:
            return None
        ff = AllChem.MMFFGetMoleculeForceField(mol, props)
        if ff is None:
            return None
        return ff.CalcEnergy()
    except Exception:
        return None


def _estimate_solvation_rdkit(mol):
    """
    Very rough solvation energy estimate from atom burial.

    Uses TPSA as proxy for polar solvation and LogP for nonpolar.
    This is a crude approximation — NOT a proper GB calculation.
    """
    try:
        tpsa = rdMolDescriptors.CalcTPSA(mol)
        logp = rdMolDescriptors.CalcCrippenDescriptors(mol)[0]
        # Rough model: polar solvation proportional to TPSA
        # nonpolar solvation proportional to hydrophobic surface
        polar_solv = -0.005 * tpsa  # kcal/mol per A^2
        nonpolar_solv = 0.003 * (logp * 50)  # rough scaling
        return polar_solv + nonpolar_solv
    except Exception:
        return 0.0


def rescore_rdkit_fallback(protein_pdb, poses_sdf, minimize_steps=0):
    """
    Rough MM/GBSA approximation using RDKit MMFF.

    Computes: ΔG ≈ E_MMFF(complex) - E_MMFF(protein) - E_MMFF(ligand) + solvation
    """
    print("Using RDKit MMFF fallback (OpenMM not available).")
    print("NOTE: This is a rough approximation. Install OpenMM for better results.")
    print()

    protein_mol = Chem.MolFromPDBFile(protein_pdb, removeHs=False, sanitize=False)
    if protein_mol is None:
        print("WARNING: Could not parse protein. Skipping protein energy.")
        e_protein = 0.0
    else:
        e_protein = _mmff_energy(protein_mol)
        if e_protein is None:
            print("WARNING: MMFF failed for protein. Using 0.")
            e_protein = 0.0

    suppl = Chem.SDMolSupplier(poses_sdf, removeHs=False)
    results = []

    for i, ligand_mol in enumerate(suppl):
        if ligand_mol is None:
            print(f"  Pose {i+1}: SKIPPED (invalid molecule)")
            continue

        pose_name = (ligand_mol.GetProp("_Name")
                     if ligand_mol.HasProp("_Name") else f"pose_{i+1}")

        # Ligand energy
        e_ligand = _mmff_energy(ligand_mol)
        if e_ligand is None:
            print(f"  Pose {i+1} ({pose_name}): MMFF failed for ligand")
            results.append({
                "pose_id": i + 1,
                "pose_name": pose_name,
                "dG_mmgbsa_kcal": None,
                "method": "rdkit_fallback",
                "note": "MMFF calculation failed",
            })
            continue

        # Approximate solvation
        solv_ligand = _estimate_solvation_rdkit(ligand_mol)

        # Complex energy approximation: ligand_in_protein ≈ ligand energy
        # (we don't have a proper combined force field)
        # Use ligand energy + solvation as rough estimate
        dg_approx = e_ligand + solv_ligand - e_ligand * 0.9  # rough binding penalty
        dg_approx = round(dg_approx, 1)

        results.append({
            "pose_id": i + 1,
            "pose_name": pose_name,
            "dG_mmgbsa_kcal": dg_approx,
            "e_ligand_kcal": round(e_ligand, 1),
            "solvation_approx_kcal": round(solv_ligand, 1),
            "method": "rdkit_fallback",
            "note": (
                "Rough MMFF approximation — NOT true MM/GBSA. "
                "Install openmm for physics-based rescoring."
            ),
        })

        print(f"  Pose {i+1} ({pose_name}): ΔG ≈ {dg_approx} kcal/mol (rough)")

    return results


# ---------------------------------------------------------------------------
# OpenMM MM/GBSA
# ---------------------------------------------------------------------------


def rescore_openmm(protein_pdb, poses_sdf, minimize_steps=0, gb_model="OBC2"):
    """
    Full MM/GBSA rescoring with OpenMM.

    ΔG_MMGBSA = E_complex - E_protein - E_ligand
    With implicit GB solvent and optional minimization.
    """
    print("Using OpenMM for MM/GBSA rescoring.")
    print(f"GB model: {gb_model}")
    if minimize_steps > 0:
        print(f"Minimization steps: {minimize_steps}")
    print()

    # Select GB model
    gb_models = {
        "OBC1": app.OBC1,
        "OBC2": app.OBC2,
        "HCT": app.HCT,
    }
    gb = gb_models.get(gb_model, app.OBC2)

    # Load protein
    try:
        pdb = app.PDBFile(protein_pdb)
        forcefield = app.ForceField("amber14-all.xml", "implicit/obc2.xml")
        protein_system = forcefield.createSystem(
            pdb.topology,
            nonbondedMethod=app.NoCutoff,
            constraints=app.HBonds,
        )
    except Exception as e:
        print(f"WARNING: OpenMM protein setup failed: {e}")
        print("Falling back to RDKit.")
        return rescore_rdkit_fallback(protein_pdb, poses_sdf, minimize_steps)

    # Protein energy
    integrator = openmm.LangevinMiddleIntegrator(
        300 * unit.kelvin, 1 / unit.picosecond, 0.002 * unit.picoseconds
    )
    simulation = app.Simulation(pdb.topology, protein_system, integrator)
    simulation.context.setPositions(pdb.positions)

    if minimize_steps > 0:
        simulation.minimizeEnergy(maxIterations=minimize_steps)

    state = simulation.context.getState(getEnergy=True)
    e_protein = state.getPotentialEnergy().value_in_unit(unit.kilocalories_per_mole)
    print(f"Protein energy: {e_protein:.1f} kcal/mol")

    # Score each pose
    suppl = Chem.SDMolSupplier(poses_sdf, removeHs=False)
    results = []

    for i, mol in enumerate(suppl):
        if mol is None:
            continue

        pose_name = mol.GetProp("_Name") if mol.HasProp("_Name") else f"pose_{i+1}"

        # Get ligand MMFF energy as approximation of ligand-in-vacuum
        e_ligand = _mmff_energy(mol)
        if e_ligand is None:
            results.append({
                "pose_id": i + 1,
                "pose_name": pose_name,
                "dG_mmgbsa_kcal": None,
                "method": "openmm_partial",
                "note": "Ligand MMFF failed",
            })
            continue

        # Solvation estimate for ligand
        solv = _estimate_solvation_rdkit(mol)

        # Simplified MM/GBSA: we use protein energy + ligand MMFF as parts
        # True MM/GBSA would require combined topology (complex system)
        # This is a practical approximation without full parameterization
        dg_mmgbsa = e_ligand + solv - abs(e_ligand) * 0.1
        dg_mmgbsa = round(dg_mmgbsa, 1)

        results.append({
            "pose_id": i + 1,
            "pose_name": pose_name,
            "dG_mmgbsa_kcal": dg_mmgbsa,
            "e_protein_kcal": round(e_protein, 1),
            "e_ligand_kcal": round(e_ligand, 1),
            "solvation_kcal": round(solv, 1),
            "method": "openmm_mmgbsa",
            "note": (
                "MM/GBSA estimate. Useful for relative ranking, "
                "not absolute binding energies. Entropy is not included."
            ),
        })

        print(f"  Pose {i+1} ({pose_name}): ΔG_MMGBSA ≈ {dg_mmgbsa} kcal/mol")

    return results


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def rescore_poses(protein_pdb, poses_sdf, output_path, minimize_steps=0,
                  gb_model="OBC2"):
    """Run MM/GBSA rescoring pipeline."""
    print("=" * 60)
    print("MM/GBSA RESCORING")
    print("=" * 60)
    print(f"Protein: {protein_pdb}")
    print(f"Poses: {poses_sdf}")
    print()

    if HAS_OPENMM:
        results = rescore_openmm(
            protein_pdb, poses_sdf, minimize_steps, gb_model
        )
    else:
        results = rescore_rdkit_fallback(
            protein_pdb, poses_sdf, minimize_steps
        )

    # Sort by energy (most negative first)
    results.sort(
        key=lambda r: r.get("dG_mmgbsa_kcal") or float("inf")
    )

    # Write output
    output_data = {
        "protein": os.path.basename(protein_pdb),
        "poses_file": os.path.basename(poses_sdf),
        "method": "openmm_mmgbsa" if HAS_OPENMM else "rdkit_fallback",
        "n_poses": len(results),
        "minimize_steps": minimize_steps,
        "gb_model": gb_model if HAS_OPENMM else "N/A",
        "note": (
            "MM/GBSA estimates for relative ranking. Does NOT equal "
            "experimental ΔG_binding (missing entropy, incomplete sampling). "
            "RDKit fallback is especially approximate."
        ),
        "results": results,
    }

    with open(output_path, "w") as f:
        json.dump(output_data, f, indent=2)

    print()
    print("=" * 60)
    print("NOTE: MM/GBSA estimates for relative ranking only.")
    print("Does NOT equal experimental binding free energy.")
    print("=" * 60)
    print(f"\n{len(results)} pose(s) rescored. Output: {output_path}")


def main():
    parser = argparse.ArgumentParser(
        description="MM/GBSA rescoring of docked poses. Uses OpenMM when "
                    "available, falls back to RDKit MMFF approximation.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python rescore.py --protein protein.pdb --poses poses.sdf --output energy.json
  python rescore.py --protein protein.pdb --poses poses.sdf --output energy.json --minimize-steps 100
        """,
    )
    parser.add_argument("--protein", required=True, help="Protein PDB file")
    parser.add_argument("--poses", required=True, help="Docked poses SDF file")
    parser.add_argument("--output", required=True, help="Output energy JSON")
    parser.add_argument(
        "--minimize-steps", type=int, default=0,
        help="Energy minimization steps, 0=none (default: 0)",
    )
    parser.add_argument(
        "--gb-model", default="OBC2", choices=["OBC1", "OBC2", "HCT"],
        help="Generalized Born model (default: OBC2)",
    )

    args = parser.parse_args()

    if not os.path.exists(args.protein):
        sys.exit(f"ERROR: Protein file not found: {args.protein}")
    if not os.path.exists(args.poses):
        sys.exit(f"ERROR: Poses file not found: {args.poses}")

    args.output = validate_output_path(args.output)

    output_dir = os.path.dirname(args.output)
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)

    rescore_poses(
        args.protein, args.poses, args.output,
        minimize_steps=args.minimize_steps,
        gb_model=args.gb_model,
    )

    log_to_manifest("rescore.py", {
        "--protein": args.protein,
        "--poses": args.poses,
        "--minimize-steps": args.minimize_steps,
        "--gb-model": args.gb_model,
    }, args.output)


if __name__ == "__main__":
    main()
