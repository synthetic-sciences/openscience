#!/usr/bin/env python3
"""
Structure-based de novo design (SBDD).

Generates molecules complementary to a protein binding pocket using:
  - Shape-based: fragment assembly guided by pocket geometry
  - Pharmacophore: molecules matching pharmacophore features derived from pocket residues

Usage:
    python generate_sbdd.py --protein target.pdb --pocket-residues "ASP189,SER195,HIS57" --method shape --output hits.csv --num 100
    python generate_sbdd.py --protein target.pdb --pocket-residues auto --method pharmacophore --output hits.csv --num 100

Note: This is a simplified CPU-based approach. For production SBDD, consider
GPU-accelerated generative models (DiffSBDD, Pocket2Mol, etc.).
"""

import argparse
import csv
import sys
import os
import math

try:
    from rdkit import Chem
    from rdkit.Chem import AllChem, Descriptors, QED, DataStructs, rdMolDescriptors
    from rdkit.Chem import RWMol, rdmolops
    from rdkit import RDLogger
    RDLogger.logger().setLevel(RDLogger.ERROR)
except ImportError:
    print("ERROR: RDKit is required. Install with: pip install rdkit-pypi")
    sys.exit(1)

try:
    import numpy as np
except ImportError:
    print("ERROR: numpy is required. Install with: pip install numpy")
    sys.exit(1)

# Optional: BioPython for PDB parsing
try:
    from Bio.PDB import PDBParser, NeighborSearch
    HAS_BIOPYTHON = True
except ImportError:
    HAS_BIOPYTHON = False


# ---------------------------------------------------------------------------
# Seed fragment library for SBDD
# ---------------------------------------------------------------------------
SEED_FRAGMENTS = [
    "c1ccccc1",          # benzene
    "c1ccncc1",          # pyridine
    "c1cc[nH]c1",        # pyrrole
    "c1ccoc1",           # furan
    "c1ccsc1",           # thiophene
    "c1cnc[nH]1",        # imidazole
    "c1cscn1",           # thiazole
    "c1cocn1",           # oxazole
    "c1ccnnc1",          # pyridazine
    "c1ccncn1",          # pyrimidine
    "c1cnccn1",          # pyrazine
    "C1CCCCC1",          # cyclohexane
    "C1CCNCC1",          # piperidine
    "C1CCOCC1",          # tetrahydropyran
    "C1CNCCN1",          # piperazine
    "C1CCOCC1",          # dioxane
    "C1COCCN1",          # morpholine
    "c1ccc2[nH]ccc2c1",  # indole
    "c1ccc2ncccc2c1",    # quinoline
    "c1ccc2cnccc2c1",    # isoquinoline
    "c1ccc2c(c1)cco2",   # benzofuran
    "c1ccc2c(c1)ccs2",   # benzothiophene
    "c1ccc2[nH]cnc2c1",  # benzimidazole
    "c1cnc2ccccc2n1",    # quinazoline
]

# Substituents for growing seed fragments
GROWTH_GROUPS = [
    ("methyl", "C"),
    ("amino", "N"),
    ("hydroxyl", "O"),
    ("fluorine", "F"),
    ("chlorine", "Cl"),
    ("methoxy", "OC"),
    ("cyano", "C#N"),
    ("carboxamide", "C(=O)N"),
    ("sulfonamide", "NS(=O)(=O)C"),
    ("trifluoromethyl", "C(F)(F)F"),
    ("ethylamine", "CCN"),
    ("acetamide", "NC(=O)C"),
    ("morpholino", "N1CCOCC1"),
    ("piperazinyl", "N1CCNCC1"),
    ("hydroxymethyl", "CO"),
    ("dimethylamino", "N(C)C"),
]

# Amino acid properties for pharmacophore definition
RESIDUE_PROPERTIES = {
    # H-bond donors
    "SER": {"hbd": True, "hba": True, "hydrophobic": False, "charged": False, "aromatic": False},
    "THR": {"hbd": True, "hba": True, "hydrophobic": False, "charged": False, "aromatic": False},
    "TYR": {"hbd": True, "hba": True, "hydrophobic": True, "charged": False, "aromatic": True},
    "ASN": {"hbd": True, "hba": True, "hydrophobic": False, "charged": False, "aromatic": False},
    "GLN": {"hbd": True, "hba": True, "hydrophobic": False, "charged": False, "aromatic": False},
    "CYS": {"hbd": True, "hba": True, "hydrophobic": False, "charged": False, "aromatic": False},
    "TRP": {"hbd": True, "hba": False, "hydrophobic": True, "charged": False, "aromatic": True},
    "HIS": {"hbd": True, "hba": True, "hydrophobic": False, "charged": True, "aromatic": True},
    # H-bond acceptors
    "ASP": {"hbd": False, "hba": True, "hydrophobic": False, "charged": True, "aromatic": False},
    "GLU": {"hbd": False, "hba": True, "hydrophobic": False, "charged": True, "aromatic": False},
    # Charged
    "ARG": {"hbd": True, "hba": False, "hydrophobic": False, "charged": True, "aromatic": False},
    "LYS": {"hbd": True, "hba": False, "hydrophobic": False, "charged": True, "aromatic": False},
    # Hydrophobic
    "ALA": {"hbd": False, "hba": False, "hydrophobic": True, "charged": False, "aromatic": False},
    "VAL": {"hbd": False, "hba": False, "hydrophobic": True, "charged": False, "aromatic": False},
    "LEU": {"hbd": False, "hba": False, "hydrophobic": True, "charged": False, "aromatic": False},
    "ILE": {"hbd": False, "hba": False, "hydrophobic": True, "charged": False, "aromatic": False},
    "PHE": {"hbd": False, "hba": False, "hydrophobic": True, "charged": False, "aromatic": True},
    "MET": {"hbd": False, "hba": True, "hydrophobic": True, "charged": False, "aromatic": False},
    "PRO": {"hbd": False, "hba": False, "hydrophobic": True, "charged": False, "aromatic": False},
    "GLY": {"hbd": True, "hba": True, "hydrophobic": False, "charged": False, "aromatic": False},
}


def compute_properties(mol):
    """Compute molecular properties."""
    if mol is None:
        return None
    try:
        return {
            "mw": round(Descriptors.MolWt(mol), 2),
            "logp": round(Descriptors.MolLogP(mol), 2),
            "qed": round(QED.qed(mol), 4),
            "hba": Descriptors.NumHAcceptors(mol),
            "hbd": Descriptors.NumHDonors(mol),
            "rotbonds": Descriptors.NumRotatableBonds(mol),
            "tpsa": round(Descriptors.TPSA(mol), 2),
        }
    except Exception:
        return None


def compute_sa_score(mol):
    """Estimate synthetic accessibility score (1=easy, 10=hard)."""
    try:
        from rdkit.Chem import rdMolDescriptors
        # Simplified SA proxy: based on ring count, stereo centers, MW
        num_rings = rdMolDescriptors.CalcNumRings(mol)
        num_stereo = rdMolDescriptors.CalcNumAtomStereoCenters(mol)
        mw = Descriptors.MolWt(mol)
        num_rotbonds = Descriptors.NumRotatableBonds(mol)

        # Heuristic: higher ring count, stereocenters, MW -> harder
        sa = 1.0 + 0.3 * num_rings + 0.5 * num_stereo + 0.003 * mw + 0.1 * num_rotbonds
        return round(min(sa, 10.0), 2)
    except Exception:
        return 5.0


def parse_pocket_residues(pocket_str):
    """Parse pocket residue specification."""
    if pocket_str.lower() == "auto":
        return None  # auto-detect
    residues = []
    for r in pocket_str.split(","):
        r = r.strip().upper()
        if r:
            residues.append(r)
    return residues


def extract_pocket_from_pdb(pdb_file, specified_residues=None):
    """
    Extract pocket information from a PDB file.
    Returns a dict with pharmacophore features and pocket geometry.
    """
    pocket_info = {
        "residues": [],
        "features": {
            "hbd": 0, "hba": 0, "hydrophobic": 0,
            "charged": 0, "aromatic": 0
        },
        "center": np.array([0.0, 0.0, 0.0]),
        "radius": 10.0,
    }

    if HAS_BIOPYTHON:
        try:
            parser = PDBParser(QUIET=True)
            structure = parser.get_structure("protein", pdb_file)
            model = structure[0]

            all_atoms = []
            pocket_atoms = []
            pocket_residue_names = []

            for chain in model:
                for residue in chain:
                    res_name = residue.get_resname().strip()
                    res_id = str(residue.get_id()[1])
                    res_label = f"{res_name}{res_id}"

                    if specified_residues is not None:
                        # Check if this residue matches any specified
                        match = False
                        for spec in specified_residues:
                            if spec in res_label or spec == res_name or spec == res_id:
                                match = True
                                break
                        if not match:
                            continue

                    for atom in residue:
                        coords = atom.get_vector().get_array()
                        all_atoms.append(coords)
                        pocket_atoms.append(coords)

                    if res_name in RESIDUE_PROPERTIES:
                        pocket_residue_names.append(res_name)
                        props = RESIDUE_PROPERTIES[res_name]
                        for feat, val in props.items():
                            if val:
                                pocket_info["features"][feat] += 1

                    pocket_info["residues"].append(res_label)

            if pocket_atoms:
                pocket_coords = np.array(pocket_atoms)
                pocket_info["center"] = pocket_coords.mean(axis=0)
                distances = np.linalg.norm(pocket_coords - pocket_info["center"], axis=1)
                pocket_info["radius"] = float(distances.max())

            # If auto-detect, find pocket by identifying buried cavity
            if specified_residues is None and all_atoms:
                print("  Auto-detecting binding pocket from structure...")
                coords = np.array(all_atoms)
                center = coords.mean(axis=0)
                pocket_info["center"] = center
                pocket_info["radius"] = 12.0

            return pocket_info

        except Exception as e:
            print(f"WARNING: BioPython PDB parsing failed: {e}")
            print("  Falling back to simple PDB parser.")

    # Fallback: simple PDB line parsing
    try:
        pocket_atoms = []
        with open(pdb_file, "r") as f:
            for line in f:
                if line.startswith("ATOM") or line.startswith("HETATM"):
                    res_name = line[17:20].strip()
                    res_id = line[22:26].strip()
                    res_label = f"{res_name}{res_id}"

                    if specified_residues is not None:
                        match = False
                        for spec in specified_residues:
                            if spec in res_label or spec == res_name or spec == res_id:
                                match = True
                                break
                        if not match:
                            continue

                    try:
                        x = float(line[30:38])
                        y = float(line[38:46])
                        z = float(line[46:54])
                        pocket_atoms.append([x, y, z])
                    except ValueError:
                        continue

                    if res_name in RESIDUE_PROPERTIES:
                        if res_label not in pocket_info["residues"]:
                            pocket_info["residues"].append(res_label)
                            props = RESIDUE_PROPERTIES[res_name]
                            for feat, val in props.items():
                                if val:
                                    pocket_info["features"][feat] += 1

        if pocket_atoms:
            coords = np.array(pocket_atoms)
            pocket_info["center"] = coords.mean(axis=0)
            distances = np.linalg.norm(coords - pocket_info["center"], axis=1)
            pocket_info["radius"] = float(distances.max())

    except Exception as e:
        print(f"WARNING: PDB parsing failed: {e}")
        print("  Using default pocket parameters.")

    return pocket_info


def score_molecule_shape(mol, pocket_info):
    """
    Score a molecule based on shape complementarity to the pocket.
    Uses molecular volume and shape descriptors as proxy.
    """
    try:
        # Generate 3D coordinates
        mol_3d = Chem.AddHs(mol)
        result = AllChem.EmbedMolecule(mol_3d, AllChem.ETKDGv3())
        if result != 0:
            # Fallback embedding
            result = AllChem.EmbedMolecule(mol_3d, randomSeed=42)
            if result != 0:
                return 0.0
        AllChem.MMFFOptimizeMolecule(mol_3d, maxIters=200)
        mol_3d = Chem.RemoveHs(mol_3d)

        # Compute molecular volume proxy (from conformer bounding box)
        conf = mol_3d.GetConformer()
        positions = conf.GetPositions()
        extents = positions.max(axis=0) - positions.min(axis=0)
        mol_vol = extents[0] * extents[1] * extents[2]

        # Pocket volume proxy
        pocket_vol = (4.0 / 3.0) * math.pi * (pocket_info["radius"] ** 3)

        # Shape complementarity: molecule should fill ~30-70% of pocket
        fill_ratio = mol_vol / max(pocket_vol, 1.0)
        if fill_ratio < 0.01:
            shape_score = 0.1
        elif fill_ratio < 0.3:
            shape_score = fill_ratio / 0.3
        elif fill_ratio <= 0.7:
            shape_score = 1.0
        else:
            shape_score = max(0.0, 1.0 - (fill_ratio - 0.7) / 0.5)

        return round(shape_score, 4)

    except Exception:
        return 0.3  # Default moderate score on failure


def score_molecule_pharmacophore(mol, pocket_info):
    """
    Score a molecule based on pharmacophore feature matching to the pocket.
    Checks if molecule has complementary features to pocket residues.
    """
    try:
        features = pocket_info["features"]
        score = 0.0
        max_score = 0.0

        # Molecule should have HBA to complement pocket HBD
        mol_hba = Descriptors.NumHAcceptors(mol)
        mol_hbd = Descriptors.NumHDonors(mol)

        # HBD in pocket -> need HBA in molecule
        if features["hbd"] > 0:
            max_score += 1.0
            hba_match = min(mol_hba / max(features["hbd"], 1), 1.0)
            score += hba_match

        # HBA in pocket -> need HBD in molecule
        if features["hba"] > 0:
            max_score += 1.0
            hbd_match = min(mol_hbd / max(features["hba"], 1), 1.0)
            score += hbd_match

        # Hydrophobic pocket -> need hydrophobic groups in molecule
        if features["hydrophobic"] > 0:
            max_score += 1.0
            logp = Descriptors.MolLogP(mol)
            if 1.0 <= logp <= 4.0:
                score += 1.0
            elif 0.0 <= logp < 1.0 or 4.0 < logp <= 5.0:
                score += 0.5
            else:
                score += 0.1

        # Aromatic pocket -> need aromatic rings
        if features["aromatic"] > 0:
            max_score += 1.0
            num_aromatic = rdMolDescriptors.CalcNumAromaticRings(mol)
            if num_aromatic > 0:
                score += min(num_aromatic / max(features["aromatic"], 1), 1.0)

        # Charged pocket -> need complementary charges
        if features["charged"] > 0:
            max_score += 1.0
            # Check for ionizable groups
            has_basic = mol.HasSubstructMatch(Chem.MolFromSmarts("[NH2,NH1,nH]")) if Chem.MolFromSmarts("[NH2,NH1,nH]") else False
            has_acidic = mol.HasSubstructMatch(Chem.MolFromSmarts("[OH1]C(=O)")) if Chem.MolFromSmarts("[OH1]C(=O)") else False
            if has_basic or has_acidic:
                score += 0.8

        # QED bonus
        max_score += 1.0
        qed_score = QED.qed(mol)
        score += qed_score

        if max_score == 0:
            return 0.5
        return round(score / max_score, 4)

    except Exception:
        return 0.3


def generate_molecules_shape(pocket_info, num_molecules=100, seed=42):
    """Generate molecules using shape-based approach: fragment assembly."""
    rng = np.random.RandomState(seed)
    results = []
    seen = set()

    # Build molecules by growing seed fragments with substituents
    for _ in range(num_molecules * 5):
        if len(results) >= num_molecules:
            break

        try:
            # Pick a random seed fragment
            seed_smi = SEED_FRAGMENTS[rng.randint(0, len(SEED_FRAGMENTS))]
            seed_mol = Chem.MolFromSmiles(seed_smi)
            if seed_mol is None:
                continue

            # Add 1-3 random substituents
            current_mol = seed_mol
            num_additions = rng.randint(1, 4)

            for _ in range(num_additions):
                group_name, group_smi = GROWTH_GROUPS[rng.randint(0, len(GROWTH_GROUPS))]
                group_mol = Chem.MolFromSmiles(group_smi)
                if group_mol is None:
                    continue

                # Find attachment point
                pattern = Chem.MolFromSmarts("[cH]")
                if pattern is None:
                    pattern = Chem.MolFromSmarts("[CH3,CH2]")
                if pattern is None:
                    continue

                matches = current_mol.GetSubstructMatches(pattern)
                if not matches:
                    # Try aliphatic
                    pattern2 = Chem.MolFromSmarts("[CH3,CH2,CH]")
                    if pattern2:
                        matches = current_mol.GetSubstructMatches(pattern2)
                if not matches:
                    continue

                match_idx = matches[rng.randint(0, len(matches))][0]

                combined = AllChem.CombineMols(current_mol, group_mol)
                rw = RWMol(combined)
                new_start = current_mol.GetNumAtoms()
                rw.AddBond(match_idx, new_start, Chem.BondType.SINGLE)

                try:
                    Chem.SanitizeMol(rw)
                    current_mol = rw.GetMol()
                except Exception:
                    continue

            smi = Chem.MolToSmiles(current_mol)
            check_mol = Chem.MolFromSmiles(smi)
            if check_mol is None:
                continue
            can_smi = Chem.MolToSmiles(check_mol)
            if can_smi in seen:
                continue

            # Basic property check
            mw = Descriptors.MolWt(check_mol)
            if mw < 150 or mw > 700:
                continue

            seen.add(can_smi)
            shape_score = score_molecule_shape(check_mol, pocket_info)
            pharm_score = score_molecule_pharmacophore(check_mol, pocket_info)
            binding_estimate = round(0.6 * shape_score + 0.4 * pharm_score, 4)

            results.append((can_smi, check_mol, binding_estimate, shape_score, pharm_score))

        except Exception:
            continue

    # Sort by binding estimate
    results.sort(key=lambda x: x[2], reverse=True)
    return results


def generate_molecules_pharmacophore(pocket_info, num_molecules=100, seed=42):
    """Generate molecules using pharmacophore-based approach."""
    rng = np.random.RandomState(seed)
    results = []
    seen = set()
    features = pocket_info["features"]

    # Select seed fragments based on pocket features
    preferred_seeds = []

    if features.get("aromatic", 0) > 0:
        preferred_seeds.extend([
            "c1ccccc1", "c1ccncc1", "c1ccc2[nH]ccc2c1",
            "c1ccc2ncccc2c1", "c1ccc2[nH]cnc2c1"
        ])
    if features.get("hba", 0) > 0 or features.get("hbd", 0) > 0:
        preferred_seeds.extend([
            "c1cc[nH]c1", "c1cnc[nH]1", "C1CCNCC1", "C1CNCCN1", "C1COCCN1"
        ])
    if features.get("hydrophobic", 0) > 0:
        preferred_seeds.extend([
            "c1ccccc1", "C1CCCCC1", "c1ccsc1", "c1ccc2c(c1)ccs2"
        ])

    if not preferred_seeds:
        preferred_seeds = SEED_FRAGMENTS

    # Select growth groups based on pocket features
    preferred_groups = []
    if features.get("hbd", 0) > 0:
        preferred_groups.extend([
            ("hydroxyl", "O"), ("amino", "N"), ("carboxamide", "C(=O)N"),
        ])
    if features.get("hba", 0) > 0:
        preferred_groups.extend([
            ("amino", "N"), ("hydroxymethyl", "CO"), ("dimethylamino", "N(C)C"),
        ])
    if features.get("hydrophobic", 0) > 0:
        preferred_groups.extend([
            ("methyl", "C"), ("trifluoromethyl", "C(F)(F)F"), ("fluorine", "F"),
        ])
    if features.get("charged", 0) > 0:
        preferred_groups.extend([
            ("amino", "N"), ("piperazinyl", "N1CCNCC1"), ("morpholino", "N1CCOCC1"),
        ])

    if not preferred_groups:
        preferred_groups = GROWTH_GROUPS

    for _ in range(num_molecules * 5):
        if len(results) >= num_molecules:
            break

        try:
            seed_smi = preferred_seeds[rng.randint(0, len(preferred_seeds))]
            seed_mol = Chem.MolFromSmiles(seed_smi)
            if seed_mol is None:
                continue

            current_mol = seed_mol
            num_additions = rng.randint(1, 4)

            for _ in range(num_additions):
                group_name, group_smi = preferred_groups[rng.randint(0, len(preferred_groups))]
                group_mol = Chem.MolFromSmiles(group_smi)
                if group_mol is None:
                    continue

                pattern = Chem.MolFromSmarts("[cH]")
                matches = current_mol.GetSubstructMatches(pattern) if pattern else []
                if not matches:
                    pattern2 = Chem.MolFromSmarts("[CH3,CH2]")
                    matches = current_mol.GetSubstructMatches(pattern2) if pattern2 else []
                if not matches:
                    continue

                match_idx = matches[rng.randint(0, len(matches))][0]
                combined = AllChem.CombineMols(current_mol, group_mol)
                rw = RWMol(combined)
                new_start = current_mol.GetNumAtoms()
                rw.AddBond(match_idx, new_start, Chem.BondType.SINGLE)

                try:
                    Chem.SanitizeMol(rw)
                    current_mol = rw.GetMol()
                except Exception:
                    continue

            smi = Chem.MolToSmiles(current_mol)
            check_mol = Chem.MolFromSmiles(smi)
            if check_mol is None:
                continue
            can_smi = Chem.MolToSmiles(check_mol)
            if can_smi in seen:
                continue

            mw = Descriptors.MolWt(check_mol)
            if mw < 150 or mw > 700:
                continue

            seen.add(can_smi)
            shape_score = score_molecule_shape(check_mol, pocket_info)
            pharm_score = score_molecule_pharmacophore(check_mol, pocket_info)
            binding_estimate = round(0.3 * shape_score + 0.7 * pharm_score, 4)

            results.append((can_smi, check_mol, binding_estimate, shape_score, pharm_score))

        except Exception:
            continue

    results.sort(key=lambda x: x[2], reverse=True)
    return results


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description="Structure-based de novo design: generate molecules complementary to a protein pocket."
    )
    parser.add_argument(
        "--protein", required=True,
        help="Path to protein PDB file."
    )
    parser.add_argument(
        "--pocket-residues", required=True,
        help="Comma-separated pocket residue IDs (e.g., 'ASP189,SER195') or 'auto' for auto-detection."
    )
    parser.add_argument(
        "--output", required=True,
        help="Output file path (CSV)."
    )
    parser.add_argument(
        "--num", type=int, default=100,
        help="Number of molecules to generate (default: 100)."
    )
    parser.add_argument(
        "--method", default="shape", choices=["shape", "pharmacophore"],
        help="Design method: shape (shape complementarity) or pharmacophore (feature matching)."
    )
    parser.add_argument(
        "--seed", type=int, default=42,
        help="Random seed for reproducibility (default: 42)."
    )
    args = parser.parse_args()

    # Validate PDB file
    if not os.path.isfile(args.protein):
        print(f"ERROR: PDB file not found: {args.protein}")
        sys.exit(1)

    # Parse pocket residues
    specified_residues = parse_pocket_residues(args.pocket_residues)
    if specified_residues:
        print(f"Specified pocket residues: {specified_residues}")
    else:
        print("Auto-detecting binding pocket...")

    # Extract pocket information
    print(f"Parsing protein structure: {args.protein}")
    pocket_info = extract_pocket_from_pdb(args.protein, specified_residues)

    print(f"Pocket residues found: {len(pocket_info['residues'])}")
    print(f"Pocket center: [{pocket_info['center'][0]:.1f}, {pocket_info['center'][1]:.1f}, {pocket_info['center'][2]:.1f}]")
    print(f"Pocket radius: {pocket_info['radius']:.1f} A")
    print(f"Pharmacophore features:")
    for feat, count in pocket_info["features"].items():
        if count > 0:
            print(f"  {feat}: {count}")

    # Generate molecules
    print(f"\n--- Generating molecules ({args.method} method, target: {args.num}) ---")

    if args.method == "shape":
        raw_results = generate_molecules_shape(pocket_info, args.num, seed=args.seed)
    else:
        raw_results = generate_molecules_pharmacophore(pocket_info, args.num, seed=args.seed)

    print(f"Generated: {len(raw_results)} candidate molecules")

    # Build output
    output_rows = []
    for idx, (can_smi, mol, binding_est, shape_sc, pharm_sc) in enumerate(raw_results):
        props = compute_properties(mol)
        if props is None:
            continue
        sa = compute_sa_score(mol)
        output_rows.append({
            "rank": idx + 1,
            "id": f"sbdd_{idx+1:04d}",
            "smiles": can_smi,
            "binding_score": binding_est,
            "shape_score": shape_sc,
            "pharmacophore_score": pharm_sc,
            "mw": props["mw"],
            "logp": props["logp"],
            "qed": props["qed"],
            "hba": props["hba"],
            "hbd": props["hbd"],
            "rotbonds": props["rotbonds"],
            "tpsa": props["tpsa"],
            "sa_score": sa,
        })

    output_rows = output_rows[:args.num]

    # Write CSV
    if output_rows:
        output_dir = os.path.dirname(args.output)
        if output_dir and not os.path.exists(output_dir):
            os.makedirs(output_dir, exist_ok=True)

        fieldnames = ["rank", "id", "smiles", "binding_score", "shape_score",
                       "pharmacophore_score", "mw", "logp", "qed", "hba", "hbd",
                       "rotbonds", "tpsa", "sa_score"]
        with open(args.output, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(output_rows)
        print(f"\nWrote {len(output_rows)} molecules to {args.output}")
    else:
        print("\nWARNING: No valid molecules generated.")
        sys.exit(1)

    # Print top 10
    print("\n=== Top 10 Candidates ===")
    print(f"{'Rank':<6}{'SMILES':<50}{'Binding':<10}{'MW':<8}{'LogP':<8}{'QED':<8}{'SA':<6}")
    print("-" * 96)
    for row in output_rows[:10]:
        smi_display = row["smiles"][:47] + "..." if len(row["smiles"]) > 47 else row["smiles"]
        print(f"{row['rank']:<6}{smi_display:<50}{row['binding_score']:<10.4f}{row['mw']:<8.1f}"
              f"{row['logp']:<8.2f}{row['qed']:<8.4f}{row['sa_score']:<6.1f}")

    # Summary
    if output_rows:
        binding_vals = [r["binding_score"] for r in output_rows]
        mw_vals = [r["mw"] for r in output_rows]
        qed_vals = [r["qed"] for r in output_rows]

        print(f"\n=== Summary ===")
        print(f"  Total molecules: {len(output_rows)}")
        print(f"  Binding score range: {min(binding_vals):.4f} - {max(binding_vals):.4f}")
        print(f"  MW range: {min(mw_vals):.1f} - {max(mw_vals):.1f}")
        print(f"  QED range: {min(qed_vals):.4f} - {max(qed_vals):.4f}")
        print(f"  Method: {args.method}")

    print("\nNote: This is a simplified SBDD approach. For production use, consider")
    print("GPU-accelerated models like DiffSBDD, Pocket2Mol, or 3D-SBDD for better results.")


if __name__ == "__main__":
    main()
