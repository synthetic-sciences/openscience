#!/usr/bin/env python3
"""
Ligand preparation for molecular docking.

Converts SMILES strings, CSV files, or SDF files into 3D-optimized
structures suitable for docking. Generates low-energy conformers,
adds hydrogens, and assigns Gasteiger charges.

Usage:
    python prepare_ligands.py --input "CCO" --output ligand.sdf
    python prepare_ligands.py --input compounds.csv --output library.sdf
    python prepare_ligands.py --input molecules.sdf --output prepared.sdf --ph 7.4
"""

import argparse
import csv
import os
import sys
import warnings

warnings.filterwarnings("ignore")

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------

try:
    from rdkit import Chem
    from rdkit.Chem import AllChem, Descriptors, rdmolops, Draw
    from rdkit.Chem import rdDistGeom, rdForceFieldHelpers
except ImportError:
    sys.exit(
        "ERROR: RDKit is required. Install with: pip install rdkit-pypi"
    )

try:
    import numpy as np
except ImportError:
    sys.exit("ERROR: NumPy is required. Install with: pip install numpy")


# ---------------------------------------------------------------------------
# Ligand processing functions
# ---------------------------------------------------------------------------


def smiles_to_3d(smiles, name="ligand", ph=7.4, num_conformers=1):
    """
    Convert a SMILES string to a 3D RDKit molecule with hydrogens
    and optimized geometry.

    Parameters
    ----------
    smiles : str
        SMILES string.
    name : str
        Molecule name/identifier.
    ph : float
        pH for protonation state (used heuristically).
    num_conformers : int
        Number of conformers to generate (returns lowest energy).

    Returns
    -------
    mol : rdkit.Chem.Mol or None
        3D molecule with hydrogens, or None on failure.
    """
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return None

    # Set molecule name
    mol.SetProp("_Name", name)
    mol.SetProp("SMILES", smiles)

    # Add hydrogens
    mol = rdmolops.AddHs(mol)

    # Generate 3D coordinates
    # Use ETKDG (Experimental Torsion Knowledge Distance Geometry)
    params = rdDistGeom.ETKDGv3()
    params.randomSeed = 42
    params.numThreads = 0  # use all available threads
    params.useSmallRingTorsions = True

    n_attempts = max(num_conformers * 5, 50)
    conf_ids = rdDistGeom.EmbedMultipleConfs(
        mol, numConfs=max(num_conformers, 10),
        params=params,
    )

    if len(conf_ids) == 0:
        # Fallback: try with less strict parameters
        params.useRandomCoords = True
        params.maxIterations = 1000
        conf_ids = rdDistGeom.EmbedMultipleConfs(
            mol, numConfs=max(num_conformers, 10),
            params=params,
        )

    if len(conf_ids) == 0:
        print(f"  WARNING: Could not generate 3D coordinates for {name}")
        return None

    # Optimize with MMFF94 force field
    energies = []
    for conf_id in conf_ids:
        try:
            ff = rdForceFieldHelpers.MMFFGetMoleculeForceField(
                mol, AllChem.MMFFGetMoleculeProperties(mol),
                confId=conf_id,
            )
            if ff is not None:
                ff.Minimize(maxIts=500)
                energy = ff.CalcEnergy()
                energies.append((conf_id, energy))
            else:
                # Fallback to UFF
                ff = rdForceFieldHelpers.UFFGetMoleculeForceField(
                    mol, confId=conf_id
                )
                if ff is not None:
                    ff.Minimize(maxIts=500)
                    energy = ff.CalcEnergy()
                    energies.append((conf_id, energy))
        except Exception:
            pass

    if not energies:
        # Keep the first conformer even without optimization
        energies = [(conf_ids[0], 0.0)]

    # Sort by energy and keep the lowest-energy conformer
    energies.sort(key=lambda x: x[1])
    best_conf_id = energies[0][0]
    best_energy = energies[0][1]

    # Remove all conformers except the best one
    confs_to_remove = [cid for cid, _ in energies if cid != best_conf_id]
    for cid in sorted(confs_to_remove, reverse=True):
        mol.RemoveConformer(cid)

    # Assign Gasteiger charges
    try:
        AllChem.ComputeGasteigerCharges(mol)
    except Exception:
        pass

    # Store energy as property
    mol.SetProp("MMFF_Energy", f"{best_energy:.2f}")

    return mol


def read_smiles_input(input_str):
    """
    Parse input that could be a single SMILES, a CSV file, or an SDF file.

    Returns list of (name, smiles) tuples for SMILES-based inputs,
    or a list of RDKit molecules for SDF inputs.
    """
    # Check if input is a file
    if os.path.isfile(input_str):
        ext = os.path.splitext(input_str)[1].lower()

        if ext == ".csv":
            return _read_csv(input_str), "csv"
        elif ext in (".sdf", ".sd", ".mol"):
            return _read_sdf(input_str), "sdf"
        elif ext == ".smi" or ext == ".smiles" or ext == ".txt":
            return _read_smiles_file(input_str), "smi"
        else:
            # Try to read as CSV first, then as SMILES file
            try:
                result = _read_csv(input_str)
                if result:
                    return result, "csv"
            except Exception:
                pass
            return _read_smiles_file(input_str), "smi"
    else:
        # Treat as a single SMILES string
        return [("ligand_1", input_str)], "smiles"


def _read_csv(filepath):
    """Read CSV with name,smiles columns."""
    entries = []
    with open(filepath, "r") as f:
        reader = csv.DictReader(f)
        headers = [h.lower().strip() for h in reader.fieldnames] if reader.fieldnames else []

        # Find SMILES column
        smiles_col = None
        name_col = None
        for h in reader.fieldnames or []:
            hl = h.lower().strip()
            if hl in ("smiles", "smi", "canonical_smiles", "smile"):
                smiles_col = h
            elif hl in ("name", "id", "compound_id", "molecule_name", "mol_name", "title"):
                name_col = h

        if smiles_col is None:
            # Try first two columns
            if reader.fieldnames and len(reader.fieldnames) >= 2:
                name_col = reader.fieldnames[0]
                smiles_col = reader.fieldnames[1]
            elif reader.fieldnames and len(reader.fieldnames) == 1:
                smiles_col = reader.fieldnames[0]

        if smiles_col is None:
            raise ValueError("Could not find SMILES column in CSV")

        for i, row in enumerate(reader):
            smiles = row.get(smiles_col, "").strip()
            if not smiles:
                continue
            name = row.get(name_col, f"mol_{i+1}").strip() if name_col else f"mol_{i+1}"
            entries.append((name, smiles))

    return entries


def _read_smiles_file(filepath):
    """Read a file with one SMILES per line (optionally with names)."""
    entries = []
    with open(filepath, "r") as f:
        for i, line in enumerate(f):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            smiles = parts[0]
            name = parts[1] if len(parts) > 1 else f"mol_{i+1}"
            entries.append((name, smiles))
    return entries


def _read_sdf(filepath):
    """Read molecules from an SDF file."""
    suppl = Chem.SDMolSupplier(filepath, removeHs=False)
    mols = []
    for i, mol in enumerate(suppl):
        if mol is not None:
            name = mol.GetProp("_Name") if mol.HasProp("_Name") else f"mol_{i+1}"
            mols.append((name, mol))
    return mols


# ---------------------------------------------------------------------------
# Main preparation logic
# ---------------------------------------------------------------------------


def prepare_ligands(input_str, output_sdf, ph=7.4):
    """
    Main ligand preparation pipeline.

    Reads input (SMILES, CSV, SDF), converts to 3D, optimizes geometry,
    adds hydrogens, assigns charges, and writes multi-molecule SDF.
    """
    print(f"Input: {input_str}")
    print(f"Output: {output_sdf}")
    print(f"pH: {ph}")
    print()

    data, input_type = read_smiles_input(input_str)

    if not data:
        sys.exit("ERROR: No valid molecules found in input.")

    writer = Chem.SDWriter(output_sdf)
    n_success = 0
    n_fail = 0
    failures = []

    if input_type == "sdf":
        # Input is already 3D molecules from SDF
        print(f"Processing {len(data)} molecule(s) from SDF...")
        for name, mol in data:
            try:
                # Add hydrogens if not present
                mol = rdmolops.AddHs(mol, addCoords=True)

                # Optimize geometry
                try:
                    AllChem.MMFFOptimizeMolecule(mol, maxIters=500)
                except Exception:
                    try:
                        AllChem.UFFOptimizeMolecule(mol, maxIters=500)
                    except Exception:
                        pass

                # Assign Gasteiger charges
                try:
                    AllChem.ComputeGasteigerCharges(mol)
                except Exception:
                    pass

                mol.SetProp("_Name", name)
                writer.write(mol)
                n_success += 1
                print(f"  OK: {name}")
            except Exception as e:
                n_fail += 1
                failures.append((name, str(e)))
                print(f"  FAIL: {name} -- {e}")
    else:
        # Input is SMILES-based
        print(f"Processing {len(data)} molecule(s) from SMILES...")
        for name, smiles in data:
            mol = smiles_to_3d(smiles, name=name, ph=ph)
            if mol is not None:
                # Compute basic descriptors
                mol_no_h = rdmolops.RemoveHs(mol)
                mw = Descriptors.MolWt(mol_no_h)
                logp = Descriptors.MolLogP(mol_no_h)
                hbd = Descriptors.NumHDonors(mol_no_h)
                hba = Descriptors.NumHAcceptors(mol_no_h)
                n_atoms = mol_no_h.GetNumAtoms()

                mol.SetProp("MW", f"{mw:.1f}")
                mol.SetProp("LogP", f"{logp:.2f}")
                mol.SetProp("HBD", str(hbd))
                mol.SetProp("HBA", str(hba))
                mol.SetProp("NumHeavyAtoms", str(n_atoms))

                writer.write(mol)
                n_success += 1
                print(f"  OK: {name} (MW={mw:.1f}, LogP={logp:.2f}, "
                      f"HBD={hbd}, HBA={hba})")
            else:
                n_fail += 1
                failures.append((name, smiles))
                print(f"  FAIL: {name} ({smiles})")

    writer.close()

    print()
    print("=" * 50)
    print(f"SUMMARY")
    print(f"  Successfully prepared: {n_success}")
    print(f"  Failed: {n_fail}")
    print(f"  Output file: {output_sdf}")

    if failures:
        print(f"\nFailed molecules:")
        for name, info in failures:
            print(f"  {name}: {info}")

    if n_success == 0:
        sys.exit("ERROR: No molecules were successfully prepared.")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(
        description="Prepare ligands for molecular docking. Converts SMILES, "
                    "CSV, or SDF input to 3D-optimized structures with "
                    "hydrogens and Gasteiger charges.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Single SMILES
  python prepare_ligands.py --input "c1ccccc1" --output benzene.sdf

  # CSV file (must have 'name' and 'smiles' columns)
  python prepare_ligands.py --input compounds.csv --output library.sdf

  # Existing SDF file (re-optimize and add charges)
  python prepare_ligands.py --input raw_molecules.sdf --output prepared.sdf

  # With custom pH
  python prepare_ligands.py --input "CC(=O)O" --output aspirin.sdf --ph 7.4
        """,
    )
    parser.add_argument(
        "--input", required=True,
        help="Input: SMILES string, CSV file (name,smiles columns), "
             "SDF file, or SMILES file (one per line)",
    )
    parser.add_argument(
        "--output", required=True,
        help="Output SDF file path",
    )
    parser.add_argument(
        "--ph", type=float, default=7.4,
        help="pH for protonation state assignment (default: 7.4)",
    )

    args = parser.parse_args()

    output_dir = os.path.dirname(args.output)
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)

    prepare_ligands(
        input_str=args.input,
        output_sdf=args.output,
        ph=args.ph,
    )


if __name__ == "__main__":
    main()
