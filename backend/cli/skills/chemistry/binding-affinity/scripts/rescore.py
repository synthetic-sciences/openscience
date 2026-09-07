#!/usr/bin/env python3
"""Inspect ligand conformer energies with an explicitly requested RDKit heuristic.

This script does not implement MM/GBSA. The former OpenMM path never built a
protein-ligand complex and must not be used as binding-energy evidence. Use a
validated external MM/GBSA workflow for receptor-dependent energy calculations.

Usage:
    python rescore.py --method ligand-heuristic --poses poses.sdf --output ligand_scores.json
"""

import argparse
import json
import io
import math
import os
import sys

from output_guard import validate_output_path, log_to_manifest

METHOD = "ligand_energy_heuristic"
LIMITATION = (
    "Ligand-only MMFF energy plus a descriptor heuristic. No receptor or complex "
    "energy is calculated. This is not MM/GBSA, binding free energy, or evidence "
    "of receptor-dependent affinity. Scores are unvalidated heuristic units."
)
UNSUPPORTED = (
    "Full MM/GBSA is not implemented by this script. Use a validated external "
    "workflow that parameterizes the receptor, ligand and complex and records "
    "the executed method. Installing OpenMM alone does not enable that method. "
    "For ligand-only inspection, explicitly select --method ligand-heuristic."
)


def require_method(method, minimize_steps=0, gb_model=None):
    if method != "ligand-heuristic":
        raise ValueError(UNSUPPORTED)
    if minimize_steps or gb_model is not None:
        raise ValueError("Ligand heuristic mode does not implement minimization or GB models; omit these options.")


def _mmff_energy(mol, all_chem):
    props = all_chem.MMFFGetMoleculeProperties(mol, mmffVariant="MMFF94")
    if props is None:
        raise ValueError("MMFF94 parameters are unavailable for this ligand")
    force = all_chem.MMFFGetMoleculeForceField(mol, props)
    if force is None:
        raise ValueError("MMFF94 force field could not be created for this ligand")
    energy = force.CalcEnergy()
    if not math.isfinite(energy):
        raise ValueError("MMFF94 returned a non-finite energy")
    return energy


def sdf_records(poses_sdf):
    """Preserve every declared SDF record, including ones RDKit would skip."""
    with open(poses_sdf, "rb") as source:
        lines = []
        for line in source:
            lines.append(line)
            if line.rstrip(b"\r\n") == b"$$$$":
                yield b"".join(lines)
                lines = []
        if b"".join(lines).strip():
            yield b"".join(lines)


def ligand_heuristic(poses_sdf):
    # Import only after explicit method validation, so unavailable MM/GBSA fails
    # before dependency setup, file processing, or scientific output creation.
    try:
        from rdkit import Chem
        from rdkit.Chem import AllChem, rdMolDescriptors
    except ImportError as error:
        raise RuntimeError("RDKit is required for ligand-heuristic mode; use a configured RDKit environment.") from error

    results = []
    for index, record in enumerate(sdf_records(poses_sdf), 1):
        mol = next(Chem.ForwardSDMolSupplier(io.BytesIO(record), removeHs=False), None)
        name = mol.GetProp("_Name") if mol is not None and mol.HasProp("_Name") else f"pose_{index}"
        row = {"pose_id": index, "pose_name": name, "method": METHOD}
        try:
            if mol is None:
                raise ValueError("Invalid SDF molecule")
            energy = _mmff_energy(mol, AllChem)
            tpsa = rdMolDescriptors.CalcTPSA(mol)
            logp = rdMolDescriptors.CalcCrippenDescriptors(mol)[0]
            # Retain the historical fallback calculation with truthful naming.
            descriptor = -0.005 * tpsa + 0.003 * (logp * 50)
            score = energy + descriptor - energy * 0.9
            if not math.isfinite(score):
                raise ValueError("Ligand heuristic returned a non-finite score")
            row.update(status="succeeded", ligand_score=round(score, 1), mmff_energy_kcal=round(energy, 1), descriptor_term=round(descriptor, 1))
        except (ValueError, RuntimeError) as error:
            row.update(status="failed", ligand_score=None, error=str(error))
        results.append(row)
    if not results:
        raise ValueError("No ligand records were found in the SDF; no scores were produced")
    return sorted(results, key=lambda row: row["ligand_score"] if row["ligand_score"] is not None else math.inf)


def rescore_poses(protein_pdb, poses_sdf, output_path, minimize_steps=0, gb_model=None, method="mmgbsa"):
    require_method(method, minimize_steps, gb_model)
    results = ligand_heuristic(poses_sdf)
    data = {
        "schema_version": 2,
        "method": METHOD,
        "score_units": "heuristic",
        "receptor_used": False,
        "protein_reference": os.path.basename(protein_pdb) if protein_pdb else None,
        "poses_file": os.path.basename(poses_sdf),
        "n_poses": len(results),
        "note": LIMITATION,
        "results": results,
    }
    with open(output_path, "w") as output:
        json.dump(data, output, indent=2, allow_nan=False)
    print(LIMITATION)
    print(f"Saved {len(results)} ligand inspection records to {output_path}")
    if any(row["status"] != "succeeded" for row in results):
        raise ValueError("One or more ligand records failed; inspect the retained output before using any score")
    return data


def rescore_openmm(*args, **kwargs):
    """Reject the former incorrectly attributed implementation for library callers."""
    raise ValueError(UNSUPPORTED)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--method", choices=["mmgbsa", "ligand-heuristic"], default="mmgbsa")
    parser.add_argument("--protein", help="Optional provenance reference; never used by the ligand heuristic")
    parser.add_argument("--poses", required=True, help="Ligand conformers in SDF format")
    parser.add_argument("--output", required=True)
    parser.add_argument("--minimize-steps", type=int, default=0, help="Unsupported; retained to reject obsolete invocations")
    parser.add_argument("--gb-model", choices=["OBC1", "OBC2", "HCT"], help="Unsupported; retained to reject obsolete invocations")
    args = parser.parse_args()
    try:
        require_method(args.method, args.minimize_steps, args.gb_model)
        if not os.path.isfile(args.poses):
            raise ValueError(f"Pose file not found: {args.poses}")
        args.output = validate_output_path(args.output)
        os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
        rescore_poses(args.protein, args.poses, args.output, args.minimize_steps, args.gb_model, args.method)
        log_to_manifest("rescore.py", {"--method": args.method, "--protein": args.protein, "--poses": args.poses}, args.output)
    except (ValueError, RuntimeError, OSError) as error:
        parser.exit(1, f"ERROR: {error}\n")


if __name__ == "__main__":
    main()
