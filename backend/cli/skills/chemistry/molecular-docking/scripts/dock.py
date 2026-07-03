#!/usr/bin/env python3
"""
Molecular docking engine supporting AutoDock Vina and DiffDock.

Docks prepared ligands against a protein target, generating scored
binding poses. Supports automatic method selection, configurable
search box, and batch docking of multiple ligands.

Usage:
    python dock.py --protein prepared.pdb --ligand ligand.sdf --output-dir results/
    python dock.py --protein target.pdb --ligand "CCO" --method vina --center_x 10 --center_y 20 --center_z 15
    python dock.py --protein target.pdb --ligand library.sdf --output-dir vs_results/ --exhaustiveness 32
"""

import argparse
import csv
import json
import os
import shutil
import subprocess
import sys
import tempfile
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------

try:
    from rdkit import Chem
    from rdkit.Chem import AllChem, rdmolops
except ImportError:
    sys.exit("ERROR: RDKit is required. Install with: pip install rdkit-pypi")

try:
    import numpy as np
except ImportError:
    sys.exit("ERROR: NumPy is required. Install with: pip install numpy")

# Optional dependencies
HAS_VINA = False
try:
    from vina import Vina
    HAS_VINA = True
except ImportError:
    pass

HAS_MEEKO = False
try:
    import meeko
    from meeko import MoleculePreparation, PDBQTWriterLegacy
    HAS_MEEKO = True
except ImportError:
    pass

HAS_DIFFDOCK = False
try:
    # Check if DiffDock CLI is available
    result = subprocess.run(
        ["python", "-c", "import DiffDock"],
        capture_output=True, timeout=10,
    )
    if result.returncode == 0:
        HAS_DIFFDOCK = True
except Exception:
    pass

HAS_OBABEL = shutil.which("obabel") is not None


# ---------------------------------------------------------------------------
# Gasteiger partial charges for standard amino acid atoms
# ---------------------------------------------------------------------------
# Pre-computed Gasteiger charges for backbone + common sidechain atoms.
# Source: empirical Gasteiger-Marsili electronegativity equalization values
# from AMBER ff14SB / AutoDockTools reference charges. Non-standard atoms
# fall back to element-based defaults.

_BACKBONE_CHARGES = {
    "N": -0.350, "H": 0.250, "CA": 0.100, "HA": 0.100,
    "C": 0.550, "O": -0.550, "OXT": -0.700,
}

_RESIDUE_CHARGES = {
    "ALA": {"CB": -0.100, "HB1": 0.050, "HB2": 0.050, "HB3": 0.050},
    "ARG": {"CB": -0.050, "CG": -0.050, "CD": 0.100, "NE": -0.350,
            "HE": 0.300, "CZ": 0.640, "NH1": -0.700, "NH2": -0.700,
            "HH11": 0.350, "HH12": 0.350, "HH21": 0.350, "HH22": 0.350},
    "ASN": {"CB": -0.050, "CG": 0.550, "OD1": -0.550, "ND2": -0.600,
            "HD21": 0.300, "HD22": 0.300},
    "ASP": {"CB": -0.050, "CG": 0.700, "OD1": -0.800, "OD2": -0.800},
    "CYS": {"CB": -0.100, "SG": -0.230, "HG": 0.170},
    "GLN": {"CB": -0.050, "CG": -0.050, "CD": 0.550, "OE1": -0.550,
            "NE2": -0.600, "HE21": 0.300, "HE22": 0.300},
    "GLU": {"CB": -0.050, "CG": -0.050, "CD": 0.700, "OE1": -0.800, "OE2": -0.800},
    "GLY": {},
    "HIS": {"CB": -0.050, "CG": 0.150, "ND1": -0.350, "HD1": 0.300,
            "CD2": 0.100, "CE1": 0.250, "NE2": -0.350, "HE2": 0.300},
    "ILE": {"CB": 0.000, "CG1": -0.050, "CG2": -0.100, "CD1": -0.100},
    "LEU": {"CB": -0.050, "CG": 0.000, "CD1": -0.100, "CD2": -0.100},
    "LYS": {"CB": -0.050, "CG": -0.050, "CD": -0.050, "CE": 0.100,
            "NZ": -0.300, "HZ1": 0.330, "HZ2": 0.330, "HZ3": 0.330},
    "MET": {"CB": -0.050, "CG": -0.050, "SD": -0.100, "CE": -0.050},
    "PHE": {"CB": -0.050, "CG": 0.000, "CD1": -0.100, "CD2": -0.100,
            "CE1": -0.100, "CE2": -0.100, "CZ": -0.100},
    "PRO": {"CB": -0.050, "CG": -0.050, "CD": 0.100},
    "SER": {"CB": 0.050, "OG": -0.550, "HG": 0.350},
    "THR": {"CB": 0.050, "OG1": -0.550, "HG1": 0.350, "CG2": -0.100},
    "TRP": {"CB": -0.050, "CG": 0.000, "CD1": -0.100, "CD2": 0.000,
            "NE1": -0.350, "HE1": 0.300, "CE2": 0.000, "CE3": -0.100,
            "CZ2": -0.100, "CZ3": -0.100, "CH2": -0.100},
    "TYR": {"CB": -0.050, "CG": 0.000, "CD1": -0.100, "CD2": -0.100,
            "CE1": -0.100, "CE2": -0.100, "CZ": 0.150, "OH": -0.550, "HH": 0.350},
    "VAL": {"CB": 0.000, "CG1": -0.100, "CG2": -0.100},
}

_ELEMENT_DEFAULT_CHARGES = {
    "C": 0.000, "N": -0.350, "O": -0.400, "S": -0.100,
    "H": 0.150, "P": 0.250, "F": -0.200, "Cl": -0.100,
    "Br": -0.050, "I": 0.000, "Fe": 0.200, "Zn": 0.650,
    "Mg": 1.200, "Mn": 0.200, "Ca": 1.000,
}


def _get_gasteiger_charge(resname, atom_name, element):
    """Look up a Gasteiger partial charge for a protein atom."""
    # Try residue-specific sidechain charge
    if resname in _RESIDUE_CHARGES and atom_name in _RESIDUE_CHARGES[resname]:
        return _RESIDUE_CHARGES[resname][atom_name]
    # Try backbone charge
    if atom_name in _BACKBONE_CHARGES:
        return _BACKBONE_CHARGES[atom_name]
    # Fall back to element default
    return _ELEMENT_DEFAULT_CHARGES.get(element, 0.000)


# ---------------------------------------------------------------------------
# Utility functions
# ---------------------------------------------------------------------------


def _read_pocket_center(pocket_path):
    """Try to read the first pocket center from a pocket/druggability JSON file."""
    try:
        with open(pocket_path) as f:
            data = json.load(f)
        if data.get("pockets"):
            center = data["pockets"][0]["center"]
            if isinstance(center, list) and len(center) == 3:
                return center[0], center[1], center[2]
    except Exception:
        pass
    return None


def estimate_box_center(protein_pdb, pockets_arg=None, auto_detect=False):
    """
    Estimate the docking box center from the protein structure.

    Search order:
    1. Explicit --pockets argument (highest priority)
    2. protein_name_pockets.json alongside the PDB
    3. pockets.json in the same directory
    4. druggability.json in the same directory
    5. Auto-run pocket detection (if auto_detect=True)
    6. Geometric center of the protein (fallback)
    """
    # Priority 1: explicit pockets argument
    if pockets_arg and os.path.exists(pockets_arg):
        result = _read_pocket_center(pockets_arg)
        if result:
            print(f"Using pocket center from {pockets_arg}")
            return result

    # Priority 2: protein_name_pockets.json
    pocket_json = protein_pdb.replace(".pdb", "_pockets.json")
    if os.path.exists(pocket_json):
        result = _read_pocket_center(pocket_json)
        if result:
            print(f"Using pocket center from {pocket_json}")
            return result

    # Priority 3: pockets.json in same directory
    pdb_dir = os.path.dirname(os.path.abspath(protein_pdb)) or "."
    for name in ("pockets.json", "druggability.json"):
        candidate = os.path.join(pdb_dir, name)
        if os.path.exists(candidate):
            result = _read_pocket_center(candidate)
            if result:
                print(f"Using pocket center from {candidate}")
                return result

    # Priority 5: auto-run pocket detection
    if auto_detect:
        detect_script = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "..", "..", "pocket-detection", "scripts", "detect.py"
        )
        if os.path.isfile(detect_script):
            auto_pockets = os.path.join(pdb_dir, "pockets.json")
            print(f"Auto-detecting pockets via {os.path.basename(detect_script)}...")
            try:
                subprocess.run(
                    [sys.executable, detect_script,
                     "--input", protein_pdb, "--output", auto_pockets],
                    check=True, capture_output=True, text=True,
                )
                result = _read_pocket_center(auto_pockets)
                if result:
                    print(f"Auto-detected pocket center: ({result[0]:.1f}, {result[1]:.1f}, {result[2]:.1f})")
                    return result
            except subprocess.CalledProcessError as e:
                print(f"  Auto-detection failed: {e.stderr.strip()[:200] if e.stderr else 'unknown error'}")

    # Priority 6: geometric center of the protein
    coords = []
    with open(protein_pdb) as f:
        for line in f:
            if line.startswith(("ATOM", "HETATM")):
                try:
                    x = float(line[30:38])
                    y = float(line[38:46])
                    z = float(line[46:54])
                    coords.append([x, y, z])
                except ValueError:
                    continue

    if not coords:
        sys.exit("ERROR: No atoms found in protein PDB file.")

    coords = np.array(coords)
    center = coords.mean(axis=0)
    print("WARNING: No pocket data found. Using protein geometric center.")
    print(f"  Center: ({center[0]:.1f}, {center[1]:.1f}, {center[2]:.1f})")
    print("  Tip: run pocket-detection/detect.py first, or pass --pockets pockets.json")
    return center[0], center[1], center[2]


def load_ligands(ligand_input):
    """
    Load ligands from an SDF file or a SMILES string.

    Returns a list of (name, rdkit_mol) tuples.
    """
    if os.path.isfile(ligand_input):
        ext = os.path.splitext(ligand_input)[1].lower()
        if ext in (".sdf", ".sd", ".mol"):
            suppl = Chem.SDMolSupplier(ligand_input, removeHs=False)
            mols = []
            for i, mol in enumerate(suppl):
                if mol is not None:
                    name = mol.GetProp("_Name") if mol.HasProp("_Name") else f"ligand_{i+1}"
                    mols.append((name, mol))
            return mols
        elif ext == ".pdbqt":
            sys.exit("ERROR: PDBQT input not supported. Provide SDF or SMILES.")
        else:
            # Try reading as SMILES file
            mols = []
            with open(ligand_input) as f:
                for i, line in enumerate(f):
                    smi = line.strip().split()[0] if line.strip() else ""
                    if smi:
                        mol = Chem.MolFromSmiles(smi)
                        if mol:
                            mol = rdmolops.AddHs(mol)
                            AllChem.EmbedMolecule(mol, AllChem.ETKDGv3())
                            try:
                                AllChem.MMFFOptimizeMolecule(mol)
                            except Exception:
                                pass
                            name = line.strip().split()[1] if len(line.strip().split()) > 1 else f"ligand_{i+1}"
                            mol.SetProp("_Name", name)
                            mols.append((name, mol))
            return mols
    else:
        # Single SMILES string
        mol = Chem.MolFromSmiles(ligand_input)
        if mol is None:
            sys.exit(f"ERROR: Invalid SMILES string: {ligand_input}")
        mol = rdmolops.AddHs(mol)
        AllChem.EmbedMolecule(mol, AllChem.ETKDGv3())
        try:
            AllChem.MMFFOptimizeMolecule(mol)
        except Exception:
            pass
        mol.SetProp("_Name", "ligand_1")
        return [("ligand_1", mol)]


def _obabel_to_pdbqt(input_path, output_pdbqt, input_format=None, rigid=False):
    """
    Convert a file to PDBQT using OpenBabel with Gasteiger charges.

    Args:
        rigid: If True, adds -xr flag for rigid receptor output (no ROOT/BRANCH
               torsion tree tags). Required for protein PDBQT that Vina loads
               via set_receptor().

    Returns True if successful, False otherwise.
    """
    if not HAS_OBABEL:
        return False

    cmd = ["obabel", input_path, "-O", output_pdbqt,
           "-p", "7.4", "--partialcharge", "gasteiger"]
    if rigid:
        cmd.append("-xr")
    if input_format:
        cmd.insert(1, f"-i{input_format}")
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if result.returncode == 0 and os.path.exists(output_pdbqt):
            # Verify the output has actual content
            size = os.path.getsize(output_pdbqt)
            if size > 100:
                print(f"  PDBQT generated via OpenBabel ({size} bytes)")
                return True
    except Exception as e:
        print(f"  OpenBabel conversion failed: {e}")
    return False


def protein_to_pdbqt(protein_pdb, output_pdbqt):
    """
    Convert a protein PDB to PDBQT format for AutoDock Vina.

    Priority:
    1. OpenBabel with Gasteiger charges (most reliable)
    2. Built-in converter with residue-based Gasteiger charge lookup
    """
    # Priority 1: OpenBabel with -xr for rigid receptor (no ROOT/BRANCH tags)
    if _obabel_to_pdbqt(protein_pdb, output_pdbqt, rigid=True):
        return True

    # Priority 2: built-in converter with residue-based charges
    return _simple_pdb_to_pdbqt(protein_pdb, output_pdbqt)


def _simple_pdb_to_pdbqt(pdb_path, pdbqt_path):
    """
    Simple PDB to PDBQT conversion for proteins.
    Adds residue-based Gasteiger partial charges and AutoDock atom types.
    """
    # Map common elements to AD4 atom types
    element_to_ad4 = {
        "C": "C", "N": "N", "O": "OA", "S": "SA",
        "H": "HD", "F": "F", "Cl": "Cl", "Br": "Br",
        "I": "I", "P": "P", "FE": "Fe", "ZN": "Zn",
        "MG": "Mg", "MN": "Mn", "CA": "Ca",
    }

    lines = []
    with open(pdb_path) as f:
        for line in f:
            if line.startswith(("ATOM", "HETATM")):
                # Extract element from columns 77-78 or infer from atom name
                element = line[76:78].strip() if len(line) >= 78 else ""
                atom_name = line[12:16].strip()
                if not element:
                    element = atom_name[0] if atom_name else "C"

                # Extract residue name (columns 17-20)
                resname = line[17:20].strip()

                ad4_type = element_to_ad4.get(element, element)

                # Refine AD4 atom types for H-bond donors/acceptors
                if element == "H":
                    ad4_type = "HD"
                if element == "O":
                    ad4_type = "OA"
                if element == "N" and atom_name in ("N", "NH", "NH1", "NH2", "NE", "NE2", "ND1", "ND2", "NZ"):
                    ad4_type = "NA"

                # Look up Gasteiger partial charge from residue-based table
                charge = _get_gasteiger_charge(resname, atom_name, element)

                # PDBQT format: cols 1-54 coords, 55-60 occupancy, 61-66 B-factor,
                #               67-70 spaces, 71-76 charge, 77-78 AD4 type
                base = line[:54]
                occ = line[54:60].strip() or "1.00"
                bfac = line[60:66].strip() or "0.00"
                pdbqt_line = (
                    f"{base:<54s}"
                    f"{float(occ):>6.2f}"
                    f"{float(bfac):>6.2f}"
                    f"    "
                    f"{charge:>+8.3f}"
                    f" {ad4_type:<2s}\n"
                )
                lines.append(pdbqt_line)
            elif line.startswith(("END", "TER")):
                lines.append(line)

    with open(pdbqt_path, "w") as f:
        f.writelines(lines)

    print(f"  PDBQT generated via built-in converter with residue-based charges ({len(lines)} lines)")
    return True


def ligand_to_pdbqt(mol, output_pdbqt):
    """
    Convert an RDKit molecule to PDBQT format.

    Priority:
    1. Meeko MoleculePreparation (best quality, computes Gasteiger charges)
    2. OpenBabel with Gasteiger charges (reliable fallback)
    3. Built-in converter with element-based charges (last resort)
    """
    # Priority 1: Meeko
    if HAS_MEEKO:
        try:
            preparator = MoleculePreparation()
            mol_setups = preparator.prepare(mol)
            for setup in mol_setups:
                pdbqt_string, is_ok, err = PDBQTWriterLegacy.write_string(setup)
                if is_ok:
                    with open(output_pdbqt, "w") as f:
                        f.write(pdbqt_string)
                    return True
        except Exception as e:
            print(f"WARNING: Meeko ligand conversion failed: {e}")

    # Priority 2: OpenBabel via SDF intermediate
    tmp_sdf = output_pdbqt.replace(".pdbqt", "_tmp.sdf")
    try:
        Chem.MolToMolFile(mol, tmp_sdf)
        if _obabel_to_pdbqt(tmp_sdf, output_pdbqt, input_format="sdf"):
            return True
    except Exception as e:
        print(f"WARNING: OpenBabel ligand conversion failed: {e}")
    finally:
        try:
            os.remove(tmp_sdf)
        except OSError:
            pass

    # Priority 3: built-in converter (element-based charges)
    # WARNING: This fallback produces rigid PDBQT without ROOT/BRANCH torsion tree.
    # Vina will dock the ligand as fully rigid (no rotatable bond flexibility).
    print("  WARNING: Using built-in ligand converter (no Meeko or OpenBabel).")
    print("           Ligand will be docked as RIGID — no rotatable bond flexibility.")
    print("           Install meeko or openbabel-wheel for flexible ligand docking.")
    tmp_pdb = output_pdbqt.replace(".pdbqt", "_tmp.pdb")
    Chem.MolToPDBFile(mol, tmp_pdb)
    _simple_pdb_to_pdbqt(tmp_pdb, output_pdbqt)
    try:
        os.remove(tmp_pdb)
    except OSError:
        pass
    return True


def pdbqt_poses_to_sdf(pdbqt_path, reference_mol, output_sdf):
    """
    Convert Vina PDBQT output poses back to SDF format.
    Uses Meeko for conversion if available, otherwise parses coordinates.
    """
    if HAS_MEEKO:
        try:
            from meeko import PDBQTMolecule, RDKitMolCreate
            pdbqt_mol = PDBQTMolecule.from_file(pdbqt_path)
            rd_mols = RDKitMolCreate.from_pdbqt_mol(pdbqt_mol)
            writer = Chem.SDWriter(output_sdf)
            for i, rd_mol in enumerate(rd_mols):
                try:
                    if rd_mol:
                        rd_mol.SetProp("_Name", f"pose_{i+1}")
                        writer.write(rd_mol)
                except Exception:
                    pass
            writer.close()
            return True
        except Exception as e:
            print(f"WARNING: Meeko PDBQT-to-SDF conversion failed: {e}")

    # Fallback: parse PDBQT coordinates and map onto reference molecule
    poses = _parse_pdbqt_poses(pdbqt_path)
    if not poses:
        return False

    writer = Chem.SDWriter(output_sdf)
    for i, pose_coords in enumerate(poses):
        try:
            mol_copy = Chem.RWMol(reference_mol)
            conf = mol_copy.GetConformer()

            # Map coordinates (best effort -- PDBQT may have different atom order)
            n_atoms = min(len(pose_coords), mol_copy.GetNumAtoms())
            for j in range(n_atoms):
                conf.SetAtomPosition(j, pose_coords[j])

            mol_copy.SetProp("_Name", f"pose_{i+1}")
            writer.write(mol_copy)
        except Exception:
            pass

    writer.close()
    return True


def _parse_pdbqt_poses(pdbqt_path):
    """Parse multiple poses from a Vina PDBQT output file."""
    poses = []
    current_coords = []

    with open(pdbqt_path) as f:
        for line in f:
            if line.startswith("MODEL") and current_coords:
                poses.append(current_coords)
                current_coords = []
            elif line.startswith(("ATOM", "HETATM")):
                try:
                    x = float(line[30:38])
                    y = float(line[38:46])
                    z = float(line[46:54])
                    current_coords.append((x, y, z))
                except ValueError:
                    continue
            elif line.startswith("ENDMDL"):
                if current_coords:
                    poses.append(current_coords)
                    current_coords = []

    if current_coords:
        poses.append(current_coords)

    return poses


# ---------------------------------------------------------------------------
# Docking engines
# ---------------------------------------------------------------------------


def dock_vina(protein_pdb, ligands, output_dir,
              center_x=None, center_y=None, center_z=None,
              size_x=20.0, size_y=20.0, size_z=20.0,
              exhaustiveness=16, num_poses=10, **kwargs):
    """
    Run AutoDock Vina docking.

    Parameters
    ----------
    protein_pdb : str
        Path to the prepared protein PDB file.
    ligands : list
        List of (name, rdkit_mol) tuples.
    output_dir : str
        Directory for output files.
    center_x/y/z : float
        Docking box center coordinates.
    size_x/y/z : float
        Docking box dimensions in Angstroms.
    exhaustiveness : int
        Vina exhaustiveness parameter.
    num_poses : int
        Number of poses to generate.

    Returns
    -------
    all_results : list
        List of docking result dicts.
    """
    if not HAS_VINA:
        sys.exit(
            "ERROR: AutoDock Vina Python bindings not found.\n"
            "Install with: pip install vina\n"
            "Also install Meeko for PDBQT conversion: pip install meeko"
        )

    # Auto-detect center if not provided
    if center_x is None or center_y is None or center_z is None:
        pockets_arg = kwargs.get("pockets_arg")
        auto_detect = kwargs.get("auto_detect_pockets", False)
        cx, cy, cz = estimate_box_center(protein_pdb, pockets_arg=pockets_arg,
                                          auto_detect=auto_detect)
        center_x = center_x if center_x is not None else cx
        center_y = center_y if center_y is not None else cy
        center_z = center_z if center_z is not None else cz

    print(f"Docking box center: ({center_x:.1f}, {center_y:.1f}, {center_z:.1f})")
    print(f"Docking box size: ({size_x:.1f}, {size_y:.1f}, {size_z:.1f})")
    print(f"Exhaustiveness: {exhaustiveness}")
    print(f"Max poses: {num_poses}")
    print()

    # Convert protein to PDBQT
    protein_pdbqt = os.path.join(output_dir, "protein.pdbqt")
    protein_to_pdbqt(protein_pdb, protein_pdbqt)

    all_results = []
    all_pose_mols = []
    pose_counter = 0

    for lig_idx, (name, mol) in enumerate(ligands):
        print(f"Docking {name} ({lig_idx + 1}/{len(ligands)})...")

        # Convert ligand to PDBQT
        ligand_pdbqt = os.path.join(output_dir, f"{name}_ligand.pdbqt")
        ligand_to_pdbqt(mol, ligand_pdbqt)

        # Output PDBQT for poses
        output_pdbqt = os.path.join(output_dir, f"{name}_poses.pdbqt")

        try:
            v = Vina(sf_name="vina")
            v.set_receptor(protein_pdbqt)
            v.set_ligand_from_file(ligand_pdbqt)
            v.compute_vina_maps(
                center=[center_x, center_y, center_z],
                box_size=[size_x, size_y, size_z],
            )

            v.dock(
                exhaustiveness=exhaustiveness,
                n_poses=num_poses,
            )

            v.write_poses(output_pdbqt, n_poses=num_poses, overwrite=True)

            # Parse scores from energies()
            # v.energies() columns: [total, inter, intra, torsions, intra_best_pose]
            # RMSD must be parsed from REMARK VINA RESULT lines in the output PDBQT
            energies = v.energies(n_poses=num_poses)

            # Parse RMSD from output PDBQT (REMARK VINA RESULT: score rmsd_lb rmsd_ub)
            pose_rmsds = []
            if os.path.exists(output_pdbqt):
                with open(output_pdbqt) as pf:
                    for pline in pf:
                        if pline.startswith("REMARK VINA RESULT:"):
                            parts = pline.split()
                            # Format: REMARK VINA RESULT:  -5.720  0.000  0.000
                            #         parts[0:3] = REMARK VINA RESULT:
                            #         parts[3] = score, parts[4] = rmsd_lb, parts[5] = rmsd_ub
                            if len(parts) >= 6:
                                pose_rmsds.append((float(parts[4]), float(parts[5])))

            for i, energy in enumerate(energies):
                pose_counter += 1
                rmsd_lb = pose_rmsds[i][0] if i < len(pose_rmsds) else 0.0
                rmsd_ub = pose_rmsds[i][1] if i < len(pose_rmsds) else 0.0
                result = {
                    "pose_id": pose_counter,
                    "ligand_name": name,
                    "pose_rank": i + 1,
                    "score": round(energy[0], 3),
                    "rmsd_lb": round(rmsd_lb, 3),
                    "rmsd_ub": round(rmsd_ub, 3),
                    "inter_energy": round(energy[1], 3) if len(energy) > 1 else 0.0,
                    "intra_energy": round(energy[2], 3) if len(energy) > 2 else 0.0,
                }
                all_results.append(result)

            # Convert poses to SDF
            pose_sdf = os.path.join(output_dir, f"{name}_poses.sdf")
            pdbqt_poses_to_sdf(output_pdbqt, mol, pose_sdf)

            # Read back poses for combined SDF
            if os.path.exists(pose_sdf):
                suppl = Chem.SDMolSupplier(pose_sdf, removeHs=False)
                for pose_mol in suppl:
                    if pose_mol is not None:
                        all_pose_mols.append(pose_mol)

            print(f"  Best score: {energies[0][0]:.3f} kcal/mol")
            print(f"  Poses generated: {len(energies)}")

        except Exception as e:
            print(f"  FAILED: {e}")
            all_results.append({
                "pose_id": pose_counter + 1,
                "ligand_name": name,
                "pose_rank": 0,
                "score": float("nan"),
                "rmsd_lb": float("nan"),
                "rmsd_ub": float("nan"),
                "inter_energy": float("nan"),
                "intra_energy": float("nan"),
            })
            pose_counter += 1

        # Clean up temporary PDBQT files
        for tmp in [ligand_pdbqt]:
            try:
                os.remove(tmp)
            except OSError:
                pass

    # Write combined poses SDF
    combined_sdf = os.path.join(output_dir, "poses.sdf")
    if all_pose_mols:
        writer = Chem.SDWriter(combined_sdf)
        for mol in all_pose_mols:
            writer.write(mol)
        writer.close()

    return all_results


def dock_diffdock(protein_pdb, ligands, output_dir, num_poses=10):
    """
    Run DiffDock docking via CLI.

    Requires DiffDock to be installed and accessible. Falls back
    to Vina if DiffDock is not available.
    """
    print("Attempting DiffDock docking...")

    # Check for DiffDock installation
    diffdock_cmd = shutil.which("diffdock") or shutil.which("python")
    diffdock_script = None

    # Look for DiffDock in common locations
    common_paths = [
        os.path.expanduser("~/DiffDock/inference.py"),
        os.path.expanduser("~/diffdock/inference.py"),
        "/opt/DiffDock/inference.py",
    ]
    for p in common_paths:
        if os.path.exists(p):
            diffdock_script = p
            break

    if diffdock_script is None:
        print("WARNING: DiffDock installation not found.")
        print("Falling back to AutoDock Vina.")
        return None

    all_results = []
    pose_counter = 0

    for lig_idx, (name, mol) in enumerate(ligands):
        print(f"DiffDock: docking {name} ({lig_idx + 1}/{len(ligands)})...")

        # Write ligand SMILES
        smiles = Chem.MolToSmiles(rdmolops.RemoveHs(mol))

        # Prepare DiffDock CSV input
        csv_path = os.path.join(output_dir, f"{name}_diffdock_input.csv")
        with open(csv_path, "w") as f:
            f.write("complex_name,protein_path,ligand_description,protein_sequence\n")
            f.write(f"{name},{os.path.abspath(protein_pdb)},{smiles},\n")

        # Run DiffDock
        dd_output = os.path.join(output_dir, f"{name}_diffdock_out")
        cmd = [
            sys.executable, diffdock_script,
            "--config", "default_inference_args.yaml",
            "--protein_path", os.path.abspath(protein_pdb),
            "--ligand", smiles,
            "--out_dir", dd_output,
            "--samples_per_complex", str(num_poses),
        ]

        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=600,
            )
            if result.returncode != 0:
                print(f"  DiffDock failed: {result.stderr[:200]}")
                continue

            # Parse DiffDock output (SDF files with confidence scores)
            sdf_files = sorted(Path(dd_output).glob("*.sdf"))
            for i, sdf_file in enumerate(sdf_files[:num_poses]):
                pose_counter += 1
                suppl = Chem.SDMolSupplier(str(sdf_file), removeHs=False)
                for pose_mol in suppl:
                    if pose_mol is not None:
                        confidence = 0.0
                        if pose_mol.HasProp("confidence"):
                            confidence = float(pose_mol.GetProp("confidence"))

                        all_results.append({
                            "pose_id": pose_counter,
                            "ligand_name": name,
                            "pose_rank": i + 1,
                            "score": round(confidence, 3),
                            "rmsd_lb": 0.0,
                            "rmsd_ub": 0.0,
                            "inter_energy": 0.0,
                            "intra_energy": 0.0,
                        })

        except subprocess.TimeoutExpired:
            print(f"  DiffDock timed out for {name}")
        except Exception as e:
            print(f"  DiffDock error: {e}")

        # Clean up
        try:
            os.remove(csv_path)
        except OSError:
            pass

    return all_results if all_results else None


# ---------------------------------------------------------------------------
# Main docking pipeline
# ---------------------------------------------------------------------------


def run_docking(protein_pdb, ligand_input, output_dir, method="auto",
                center_x=None, center_y=None, center_z=None,
                size_x=20.0, size_y=20.0, size_z=20.0,
                exhaustiveness=16, num_poses=10,
                pockets_arg=None, auto_detect_pockets=False):
    """
    Main docking pipeline.

    Loads ligands, selects docking method, runs docking, and writes results.
    """
    os.makedirs(output_dir, exist_ok=True)

    print("=" * 60)
    print("MOLECULAR DOCKING")
    print("=" * 60)
    print(f"Protein: {protein_pdb}")
    print(f"Ligand input: {ligand_input}")
    print(f"Method: {method}")
    print(f"Output: {output_dir}")
    print()

    # Load ligands
    ligands = load_ligands(ligand_input)
    if not ligands:
        sys.exit("ERROR: No valid ligands found.")

    print(f"Loaded {len(ligands)} ligand(s)")
    print()

    # Select docking method
    results = None
    method_used = None

    if method == "diffdock" or (method == "auto" and HAS_DIFFDOCK):
        results = dock_diffdock(protein_pdb, ligands, output_dir, num_poses)
        if results is not None:
            method_used = "diffdock"
        elif method == "auto":
            print("DiffDock unavailable. Trying Vina...")

    if results is None and method in ("vina", "auto"):
        method_used = "vina"
        results = dock_vina(
            protein_pdb, ligands, output_dir,
            center_x=center_x, center_y=center_y, center_z=center_z,
            size_x=size_x, size_y=size_y, size_z=size_z,
            exhaustiveness=exhaustiveness, num_poses=num_poses,
            pockets_arg=pockets_arg, auto_detect_pockets=auto_detect_pockets,
        )

    if results is None:
        sys.exit("ERROR: No docking method available. Install vina: pip install vina meeko")

    # Write scores CSV
    scores_csv = os.path.join(output_dir, "scores.csv")
    if results:
        fieldnames = ["pose_id", "ligand_name", "pose_rank", "score", "rmsd_lb", "rmsd_ub",
                      "inter_energy", "intra_energy"]
        with open(scores_csv, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(results)

    # Print summary
    print()
    print("=" * 60)
    print("DOCKING RESULTS")
    print("=" * 60)

    if results:
        # Vina: more negative = better (ascending). DiffDock: higher confidence = better (descending).
        reverse_sort = method_used == "diffdock"
        sorted_results = sorted(results, key=lambda r: r["score"], reverse=reverse_sort)
        top_n = min(5, len(sorted_results))

        print(f"\nTop {top_n} poses:")
        print(f"{'Rank':<6} {'Ligand':<20} {'Pose':<6} {'Score':<10} {'RMSD_LB':<10}")
        print("-" * 52)
        for i, r in enumerate(sorted_results[:top_n]):
            print(
                f"{i+1:<6} {r['ligand_name']:<20} {r['pose_rank']:<6} "
                f"{r['score']:<10.3f} {r['rmsd_lb']:<10.3f}"
            )

    print(f"\nScores saved to: {scores_csv}")
    poses_sdf = os.path.join(output_dir, "poses.sdf")
    if os.path.exists(poses_sdf):
        print(f"Poses saved to: {poses_sdf}")
    print()

    return results


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(
        description="Run molecular docking with AutoDock Vina or DiffDock. "
                    "Docks prepared ligands against a protein target and "
                    "generates scored binding poses.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Basic docking with auto-detected pocket
  python dock.py --protein prepared.pdb --ligand ligand.sdf --output-dir results/

  # Dock with explicit box center
  python dock.py --protein target.pdb --ligand ligand.sdf --output-dir results/ \\
      --center_x 10.5 --center_y 22.3 --center_z 15.0

  # Dock SMILES directly
  python dock.py --protein target.pdb --ligand "c1ccccc1" --output-dir results/

  # Virtual screening with high exhaustiveness
  python dock.py --protein target.pdb --ligand library.sdf --output-dir vs/ \\
      --exhaustiveness 32 --num-poses 5

  # Force DiffDock method
  python dock.py --protein target.pdb --ligand ligand.sdf --output-dir results/ \\
      --method diffdock
        """,
    )
    parser.add_argument(
        "--protein", required=True,
        help="Prepared protein PDB file",
    )
    parser.add_argument(
        "--ligand", required=True,
        help="Ligand input: SDF file, SMILES string, or SMILES file",
    )
    parser.add_argument(
        "--output-dir", required=True,
        help="Output directory for docking results",
    )
    parser.add_argument(
        "--method", default="auto", choices=["auto", "vina", "diffdock"],
        help="Docking method (default: auto -- tries DiffDock, falls back to Vina)",
    )
    parser.add_argument(
        "--center_x", type=float, default=None,
        help="Docking box center X coordinate (auto-detected if not specified)",
    )
    parser.add_argument(
        "--center_y", type=float, default=None,
        help="Docking box center Y coordinate (auto-detected if not specified)",
    )
    parser.add_argument(
        "--center_z", type=float, default=None,
        help="Docking box center Z coordinate (auto-detected if not specified)",
    )
    parser.add_argument(
        "--size_x", type=float, default=20.0,
        help="Docking box size X (Angstroms, default: 20.0)",
    )
    parser.add_argument(
        "--size_y", type=float, default=20.0,
        help="Docking box size Y (Angstroms, default: 20.0)",
    )
    parser.add_argument(
        "--size_z", type=float, default=20.0,
        help="Docking box size Z (Angstroms, default: 20.0)",
    )
    parser.add_argument(
        "--exhaustiveness", type=int, default=16,
        help="Vina exhaustiveness parameter (default: 16, higher = more thorough)",
    )
    parser.add_argument(
        "--num-poses", type=int, default=10,
        help="Number of poses to generate per ligand (default: 10)",
    )
    parser.add_argument(
        "--pockets", default=None,
        help="Pocket detection JSON file (from pocket-detection/detect.py). "
             "Used to set the docking box center to the top-ranked pocket.",
    )
    parser.add_argument(
        "--auto-detect-pockets", action="store_true",
        help="Auto-run pocket detection if no pocket JSON file is found. "
             "Requires pocket-detection skill to be installed.",
    )

    args = parser.parse_args()

    if not os.path.exists(args.protein):
        sys.exit(f"ERROR: Protein file not found: {args.protein}")

    run_docking(
        protein_pdb=args.protein,
        ligand_input=args.ligand,
        output_dir=args.output_dir,
        method=args.method,
        center_x=args.center_x,
        center_y=args.center_y,
        center_z=args.center_z,
        size_x=args.size_x,
        size_y=args.size_y,
        size_z=args.size_z,
        exhaustiveness=args.exhaustiveness,
        num_poses=args.num_poses,
        pockets_arg=args.pockets,
        auto_detect_pockets=args.auto_detect_pockets,
    )


if __name__ == "__main__":
    main()
