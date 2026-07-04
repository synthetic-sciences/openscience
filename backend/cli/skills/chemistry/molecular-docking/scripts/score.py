#!/usr/bin/env python3
"""
Protein-ligand interaction scoring and analysis.

Analyzes docked poses to identify specific molecular interactions
(hydrogen bonds, hydrophobic contacts, pi-stacking, salt bridges,
halogen bonds) using ProLIF or a custom RDKit-based implementation.

Usage:
    python score.py --protein prepared.pdb --poses poses.sdf --output interactions.json
    python score.py --protein target.pdb --poses docked.sdf --output results.csv
"""

import argparse
import csv
import json
import math
import os
import sys
import warnings
from collections import defaultdict

warnings.filterwarnings("ignore")

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------

try:
    from rdkit import Chem
    from rdkit.Chem import AllChem, rdmolops, Descriptors
    from rdkit import Geometry
except ImportError:
    sys.exit("ERROR: RDKit is required. Install with: pip install rdkit-pypi")

try:
    import numpy as np
except ImportError:
    sys.exit("ERROR: NumPy is required. Install with: pip install numpy")

# Optional: ProLIF for advanced interaction fingerprinting
HAS_PROLIF = False
try:
    import prolif
    HAS_PROLIF = True
except ImportError:
    pass

# Optional: BioPython for protein parsing
HAS_BIOPYTHON = False
try:
    from Bio.PDB import PDBParser, NeighborSearch
    from Bio.PDB.Polypeptide import is_aa
    HAS_BIOPYTHON = True
except ImportError:
    pass


# ---------------------------------------------------------------------------
# Interaction detection (RDKit-based fallback)
# ---------------------------------------------------------------------------

# Donor/acceptor SMARTS
HBOND_DONOR_SMARTS = Chem.MolFromSmarts("[#7,#8,#16][H]")
HBOND_ACCEPTOR_SMARTS = Chem.MolFromSmarts("[#7,#8,#16;!$([#7]~[#6]=[#8]);!$([#8]~[#7]~[#8])]")
AROMATIC_SMARTS = Chem.MolFromSmarts("[a]1[a][a][a][a][a]1")  # 6-membered aromatic
AROMATIC5_SMARTS = Chem.MolFromSmarts("[a]1[a][a][a][a]1")    # 5-membered aromatic
POS_CHARGE_SMARTS = Chem.MolFromSmarts("[+,#7H3,#7H2;!$([#7]~[#6]=[#8])]")
NEG_CHARGE_SMARTS = Chem.MolFromSmarts("[-,#8;$([#8]~[#6]~[#8])]")
HALOGEN_SMARTS = Chem.MolFromSmarts("[#9,#17,#35,#53]")


def get_atom_coords(mol, conf_id=0):
    """Get atom coordinates as numpy arrays."""
    conf = mol.GetConformer(conf_id)
    coords = {}
    for i in range(mol.GetNumAtoms()):
        pos = conf.GetAtomPosition(i)
        coords[i] = np.array([pos.x, pos.y, pos.z])
    return coords


def distance(coord1, coord2):
    """Euclidean distance between two 3D points."""
    return np.linalg.norm(coord1 - coord2)


def angle(v1, v2):
    """Angle between two vectors in degrees."""
    cos_angle = np.dot(v1, v2) / (np.linalg.norm(v1) * np.linalg.norm(v2) + 1e-10)
    cos_angle = np.clip(cos_angle, -1.0, 1.0)
    return np.degrees(np.arccos(cos_angle))


def ring_centroid(mol, ring_atoms, coords):
    """Compute the centroid of a ring."""
    ring_coords = np.array([coords[a] for a in ring_atoms])
    return ring_coords.mean(axis=0)


def ring_normal(mol, ring_atoms, coords):
    """Compute the normal vector to a ring plane."""
    ring_coords = np.array([coords[a] for a in ring_atoms])
    centered = ring_coords - ring_coords.mean(axis=0)
    # SVD to find plane normal
    _, _, vt = np.linalg.svd(centered)
    return vt[-1]  # last row = direction of least variance = normal


def detect_hbonds(protein_mol, ligand_mol, protein_coords, ligand_coords,
                  dist_cutoff=3.5, angle_cutoff=120.0):
    """
    Detect hydrogen bonds between protein and ligand.

    Returns list of interaction dicts.
    """
    interactions = []

    # Get donor and acceptor atoms
    protein_donors = set()
    protein_acceptors = set()
    ligand_donors = set()
    ligand_acceptors = set()

    if HBOND_DONOR_SMARTS:
        for match in protein_mol.GetSubstructMatches(HBOND_DONOR_SMARTS):
            protein_donors.add(match[0])  # heavy atom
        for match in ligand_mol.GetSubstructMatches(HBOND_DONOR_SMARTS):
            ligand_donors.add(match[0])

    if HBOND_ACCEPTOR_SMARTS:
        for match in protein_mol.GetSubstructMatches(HBOND_ACCEPTOR_SMARTS):
            protein_acceptors.add(match[0])
        for match in ligand_mol.GetSubstructMatches(HBOND_ACCEPTOR_SMARTS):
            ligand_acceptors.add(match[0])

    # Protein donor -- Ligand acceptor
    for d_idx in protein_donors:
        if d_idx not in protein_coords:
            continue
        for a_idx in ligand_acceptors:
            if a_idx not in ligand_coords:
                continue
            dist = distance(protein_coords[d_idx], ligand_coords[a_idx])
            if dist <= dist_cutoff:
                interactions.append({
                    "type": "hydrogen_bond",
                    "subtype": "protein_donor",
                    "protein_atom": d_idx,
                    "ligand_atom": a_idx,
                    "distance": round(dist, 2),
                })

    # Ligand donor -- Protein acceptor
    for d_idx in ligand_donors:
        if d_idx not in ligand_coords:
            continue
        for a_idx in protein_acceptors:
            if a_idx not in protein_coords:
                continue
            dist = distance(ligand_coords[d_idx], protein_coords[a_idx])
            if dist <= dist_cutoff:
                interactions.append({
                    "type": "hydrogen_bond",
                    "subtype": "ligand_donor",
                    "protein_atom": a_idx,
                    "ligand_atom": d_idx,
                    "distance": round(dist, 2),
                })

    return interactions


def detect_hydrophobic(protein_mol, ligand_mol, protein_coords, ligand_coords,
                       dist_cutoff=4.5):
    """Detect hydrophobic contacts between non-polar atoms."""
    interactions = []

    hydrophobic_elements = {6}  # carbon atoms primarily

    for p_idx in range(protein_mol.GetNumAtoms()):
        p_atom = protein_mol.GetAtomWithIdx(p_idx)
        if p_atom.GetAtomicNum() not in hydrophobic_elements:
            continue
        if p_atom.GetIsAromatic():
            continue  # handle aromatic separately
        if p_idx not in protein_coords:
            continue

        # Check that the carbon is not bonded to polar atoms
        has_polar_neighbor = False
        for neighbor in p_atom.GetNeighbors():
            if neighbor.GetAtomicNum() in (7, 8, 16):
                has_polar_neighbor = True
                break
        if has_polar_neighbor:
            continue

        for l_idx in range(ligand_mol.GetNumAtoms()):
            l_atom = ligand_mol.GetAtomWithIdx(l_idx)
            if l_atom.GetAtomicNum() not in hydrophobic_elements:
                continue
            if l_idx not in ligand_coords:
                continue

            has_polar = False
            for neighbor in l_atom.GetNeighbors():
                if neighbor.GetAtomicNum() in (7, 8, 16):
                    has_polar = True
                    break
            if has_polar:
                continue

            dist = distance(protein_coords[p_idx], ligand_coords[l_idx])
            if dist <= dist_cutoff:
                interactions.append({
                    "type": "hydrophobic",
                    "protein_atom": p_idx,
                    "ligand_atom": l_idx,
                    "distance": round(dist, 2),
                })

    # Deduplicate: keep closest contact per protein atom
    seen_pairs = {}
    for inter in interactions:
        key = inter["protein_atom"]
        if key not in seen_pairs or inter["distance"] < seen_pairs[key]["distance"]:
            seen_pairs[key] = inter

    return list(seen_pairs.values())


def detect_pi_stacking(protein_mol, ligand_mol, protein_coords, ligand_coords,
                       dist_cutoff=5.5):
    """Detect pi-pi stacking interactions between aromatic rings."""
    interactions = []

    def get_aromatic_rings(mol):
        rings = []
        ring_info = mol.GetRingInfo()
        for ring in ring_info.AtomRings():
            if all(mol.GetAtomWithIdx(a).GetIsAromatic() for a in ring):
                rings.append(list(ring))
        return rings

    protein_rings = get_aromatic_rings(protein_mol)
    ligand_rings = get_aromatic_rings(ligand_mol)

    for p_ring in protein_rings:
        if not all(a in protein_coords for a in p_ring):
            continue
        p_centroid = ring_centroid(protein_mol, p_ring, protein_coords)
        p_normal = ring_normal(protein_mol, p_ring, protein_coords)

        for l_ring in ligand_rings:
            if not all(a in ligand_coords for a in l_ring):
                continue
            l_centroid = ring_centroid(ligand_mol, l_ring, ligand_coords)
            l_normal = ring_normal(ligand_mol, l_ring, ligand_coords)

            dist = distance(p_centroid, l_centroid)
            if dist > dist_cutoff:
                continue

            # Angle between ring normals
            ang = angle(p_normal, l_normal)
            # Account for anti-parallel orientation
            if ang > 90:
                ang = 180 - ang

            if ang < 30:
                stack_type = "parallel"
            elif ang > 60:
                stack_type = "T-shaped"
            else:
                stack_type = "offset"

            interactions.append({
                "type": "pi_stacking",
                "subtype": stack_type,
                "protein_ring": p_ring,
                "ligand_ring": l_ring,
                "distance": round(dist, 2),
                "angle": round(ang, 1),
            })

    return interactions


def detect_salt_bridges(protein_mol, ligand_mol, protein_coords, ligand_coords,
                        dist_cutoff=4.0):
    """Detect salt bridges between charged groups."""
    interactions = []

    def get_charged_atoms(mol, coords, charge_type):
        """Find positively or negatively charged atoms."""
        atoms = []
        smarts = POS_CHARGE_SMARTS if charge_type == "positive" else NEG_CHARGE_SMARTS
        if smarts is None:
            return atoms
        for match in mol.GetSubstructMatches(smarts):
            if match[0] in coords:
                atoms.append(match[0])
        return atoms

    protein_pos = get_charged_atoms(protein_mol, protein_coords, "positive")
    protein_neg = get_charged_atoms(protein_mol, protein_coords, "negative")
    ligand_pos = get_charged_atoms(ligand_mol, ligand_coords, "positive")
    ligand_neg = get_charged_atoms(ligand_mol, ligand_coords, "negative")

    # Protein(+) -- Ligand(-)
    for p_idx in protein_pos:
        for l_idx in ligand_neg:
            dist = distance(protein_coords[p_idx], ligand_coords[l_idx])
            if dist <= dist_cutoff:
                interactions.append({
                    "type": "salt_bridge",
                    "subtype": "protein_positive",
                    "protein_atom": p_idx,
                    "ligand_atom": l_idx,
                    "distance": round(dist, 2),
                })

    # Protein(-) -- Ligand(+)
    for p_idx in protein_neg:
        for l_idx in ligand_pos:
            dist = distance(protein_coords[p_idx], ligand_coords[l_idx])
            if dist <= dist_cutoff:
                interactions.append({
                    "type": "salt_bridge",
                    "subtype": "protein_negative",
                    "protein_atom": p_idx,
                    "ligand_atom": l_idx,
                    "distance": round(dist, 2),
                })

    return interactions


def detect_halogen_bonds(protein_mol, ligand_mol, protein_coords, ligand_coords,
                         dist_cutoff=3.5, angle_min=140.0):
    """
    Detect halogen bonds (C-X...Y where X is a halogen, Y is an acceptor).
    """
    interactions = []

    if HALOGEN_SMARTS is None:
        return interactions

    ligand_halogens = ligand_mol.GetSubstructMatches(HALOGEN_SMARTS)
    if not ligand_halogens:
        return interactions

    # Get protein acceptor atoms (N, O, S)
    protein_acceptors = set()
    if HBOND_ACCEPTOR_SMARTS:
        for match in protein_mol.GetSubstructMatches(HBOND_ACCEPTOR_SMARTS):
            protein_acceptors.add(match[0])

    for (x_idx,) in ligand_halogens:
        if x_idx not in ligand_coords:
            continue

        # Find the carbon bonded to the halogen
        x_atom = ligand_mol.GetAtomWithIdx(x_idx)
        c_neighbors = [n.GetIdx() for n in x_atom.GetNeighbors()
                       if n.GetAtomicNum() == 6]
        if not c_neighbors:
            continue
        c_idx = c_neighbors[0]
        if c_idx not in ligand_coords:
            continue

        for a_idx in protein_acceptors:
            if a_idx not in protein_coords:
                continue

            dist = distance(ligand_coords[x_idx], protein_coords[a_idx])
            if dist > dist_cutoff:
                continue

            # Check C-X...Y angle (should be ~165 degrees)
            v_cx = ligand_coords[x_idx] - ligand_coords[c_idx]
            v_xy = protein_coords[a_idx] - ligand_coords[x_idx]
            ang = angle(v_cx, v_xy)

            if ang >= angle_min:
                interactions.append({
                    "type": "halogen_bond",
                    "protein_atom": a_idx,
                    "ligand_atom": x_idx,
                    "distance": round(dist, 2),
                    "angle": round(ang, 1),
                })

    return interactions


# ---------------------------------------------------------------------------
# Residue mapping
# ---------------------------------------------------------------------------


def map_atom_to_residue(protein_pdb, atom_idx_set):
    """
    Map protein atom indices to residue information using PDB file parsing.

    Returns dict mapping atom_idx -> (chain, resname, resid).
    """
    residue_map = {}
    atom_counter = 0

    with open(protein_pdb) as f:
        for line in f:
            if line.startswith(("ATOM", "HETATM")):
                if atom_counter in atom_idx_set:
                    chain = line[21].strip() or "A"
                    resname = line[17:20].strip()
                    resid = line[22:26].strip()
                    residue_map[atom_counter] = {
                        "chain": chain,
                        "resname": resname,
                        "resid": int(resid) if resid.isdigit() else resid,
                    }
                atom_counter += 1

    return residue_map


# ---------------------------------------------------------------------------
# ProLIF-based analysis
# ---------------------------------------------------------------------------


def score_with_prolif(protein_pdb, poses_sdf):
    """
    Use ProLIF for interaction fingerprinting.

    Returns structured interaction data per pose.
    """
    if not HAS_PROLIF:
        return None

    try:
        import MDAnalysis as mda

        # Load protein
        protein = mda.Universe(protein_pdb)
        prot_mol = prolif.Molecule.from_mda(protein)

        # Load poses
        suppl = Chem.SDMolSupplier(poses_sdf, removeHs=False)
        results = []

        for i, mol in enumerate(suppl):
            if mol is None:
                continue

            try:
                lig_mol = prolif.Molecule.from_rdkit(mol)
                fp = prolif.Fingerprint(
                    ["HBDonor", "HBAcceptor", "PiStacking", "Hydrophobic",
                     "SaltBridge", "Cation-Pi", "Halogen"]
                )
                fp.run_from_iterable([lig_mol], prot_mol)

                # Extract interactions
                df = fp.to_dataframe()
                interactions = []
                for col in df.columns:
                    if df[col].any():
                        # Parse column name: (ligand_res, protein_res, interaction_type)
                        parts = col
                        interactions.append({
                            "residue": str(parts[1]) if len(parts) > 1 else str(parts),
                            "interaction_type": str(parts[2]) if len(parts) > 2 else "unknown",
                        })

                pose_name = mol.GetProp("_Name") if mol.HasProp("_Name") else f"pose_{i+1}"
                results.append({
                    "pose_id": i + 1,
                    "pose_name": pose_name,
                    "interactions": interactions,
                    "n_interactions": len(interactions),
                })
            except Exception as e:
                print(f"  ProLIF warning for pose {i+1}: {e}")

        return results if results else None

    except Exception as e:
        print(f"WARNING: ProLIF analysis failed: {e}")
        return None


# ---------------------------------------------------------------------------
# Main scoring pipeline
# ---------------------------------------------------------------------------


def score_poses(protein_pdb, poses_sdf, output_path):
    """
    Main scoring and interaction analysis pipeline.

    Tries ProLIF first, falls back to custom RDKit-based analysis.
    """
    print("=" * 60)
    print("INTERACTION SCORING AND ANALYSIS")
    print("=" * 60)
    print(f"Protein: {protein_pdb}")
    print(f"Poses: {poses_sdf}")
    print()

    # Try ProLIF first
    prolif_results = score_with_prolif(protein_pdb, poses_sdf)
    if prolif_results:
        print("Using ProLIF for interaction fingerprinting.")
        all_results = prolif_results
    else:
        if HAS_PROLIF:
            print("ProLIF analysis failed. Falling back to RDKit-based detection.")
        else:
            print("ProLIF not installed. Using RDKit-based interaction detection.")
        print()

        # Load protein as RDKit mol
        protein_mol = Chem.MolFromPDBFile(protein_pdb, removeHs=False, sanitize=False)
        if protein_mol is None:
            sys.exit("ERROR: Could not parse protein PDB file with RDKit.")

        protein_coords = get_atom_coords(protein_mol)

        # Load poses
        suppl = Chem.SDMolSupplier(poses_sdf, removeHs=False)
        all_results = []

        for i, ligand_mol in enumerate(suppl):
            if ligand_mol is None:
                print(f"  Pose {i+1}: SKIPPED (invalid molecule)")
                continue

            pose_name = ligand_mol.GetProp("_Name") if ligand_mol.HasProp("_Name") else f"pose_{i+1}"
            ligand_coords = get_atom_coords(ligand_mol)

            print(f"Analyzing pose {i+1} ({pose_name})...")

            # Detect all interaction types
            hbonds = detect_hbonds(protein_mol, ligand_mol, protein_coords, ligand_coords)
            hydrophobic = detect_hydrophobic(protein_mol, ligand_mol, protein_coords, ligand_coords)
            pi_stack = detect_pi_stacking(protein_mol, ligand_mol, protein_coords, ligand_coords)
            salt_br = detect_salt_bridges(protein_mol, ligand_mol, protein_coords, ligand_coords)
            hal_bonds = detect_halogen_bonds(protein_mol, ligand_mol, protein_coords, ligand_coords)

            all_interactions = hbonds + hydrophobic + pi_stack + salt_br + hal_bonds

            # Map protein atoms to residues
            protein_atom_indices = set()
            for inter in all_interactions:
                if "protein_atom" in inter:
                    protein_atom_indices.add(inter["protein_atom"])
                if "protein_ring" in inter:
                    protein_atom_indices.update(inter["protein_ring"])

            residue_map = map_atom_to_residue(protein_pdb, protein_atom_indices)

            # Annotate interactions with residue information
            for inter in all_interactions:
                if "protein_atom" in inter and inter["protein_atom"] in residue_map:
                    res_info = residue_map[inter["protein_atom"]]
                    inter["residue"] = f"{res_info['resname']}{res_info['resid']}"
                    inter["chain"] = res_info["chain"]
                elif "protein_ring" in inter:
                    # Use first ring atom for residue assignment
                    first_atom = inter["protein_ring"][0]
                    if first_atom in residue_map:
                        res_info = residue_map[first_atom]
                        inter["residue"] = f"{res_info['resname']}{res_info['resid']}"
                        inter["chain"] = res_info["chain"]

            # Clean up non-serializable fields
            for inter in all_interactions:
                if "protein_ring" in inter:
                    inter["protein_ring"] = list(inter["protein_ring"])
                if "ligand_ring" in inter:
                    inter["ligand_ring"] = list(inter["ligand_ring"])

            pose_result = {
                "pose_id": i + 1,
                "pose_name": pose_name,
                "n_interactions": len(all_interactions),
                "n_hbonds": len(hbonds),
                "n_hydrophobic": len(hydrophobic),
                "n_pi_stacking": len(pi_stack),
                "n_salt_bridges": len(salt_br),
                "n_halogen_bonds": len(hal_bonds),
                "interactions": all_interactions,
            }

            all_results.append(pose_result)

            # Print summary
            print(f"  Hydrogen bonds: {len(hbonds)}")
            print(f"  Hydrophobic contacts: {len(hydrophobic)}")
            print(f"  Pi-stacking: {len(pi_stack)}")
            print(f"  Salt bridges: {len(salt_br)}")
            print(f"  Halogen bonds: {len(hal_bonds)}")
            print(f"  Total interactions: {len(all_interactions)}")

            # Print key residues
            residues_by_type = defaultdict(set)
            for inter in all_interactions:
                if "residue" in inter:
                    residues_by_type[inter["type"]].add(inter["residue"])

            if residues_by_type:
                print(f"  Key residues:")
                for itype, residues in residues_by_type.items():
                    print(f"    {itype}: {', '.join(sorted(residues))}")
            print()

    # Write output
    ext = os.path.splitext(output_path)[1].lower()

    if ext == ".csv":
        _write_csv_output(all_results, output_path)
    else:
        # Default to JSON
        if not output_path.endswith(".json"):
            output_path = output_path + ".json" if "." not in os.path.basename(output_path) else output_path

        with open(output_path, "w") as f:
            json.dump({
                "protein": os.path.basename(protein_pdb),
                "poses_file": os.path.basename(poses_sdf),
                "n_poses": len(all_results),
                "results": all_results,
            }, f, indent=2)

    print("=" * 60)
    print(f"SUMMARY: {len(all_results)} pose(s) analyzed")
    print(f"Output saved to: {output_path}")
    print("=" * 60)

    return all_results


def _write_csv_output(results, output_path):
    """Write interaction results as a flat CSV table."""
    rows = []
    for pose in results:
        for inter in pose.get("interactions", []):
            row = {
                "pose_id": pose["pose_id"],
                "pose_name": pose.get("pose_name", ""),
                "interaction_type": inter.get("type", ""),
                "subtype": inter.get("subtype", ""),
                "residue": inter.get("residue", ""),
                "chain": inter.get("chain", ""),
                "distance": inter.get("distance", ""),
                "angle": inter.get("angle", ""),
            }
            rows.append(row)

    if not rows:
        # Write header-only file
        rows = [{"pose_id": "", "pose_name": "", "interaction_type": "",
                 "subtype": "", "residue": "", "chain": "",
                 "distance": "", "angle": ""}]

    fieldnames = ["pose_id", "pose_name", "interaction_type", "subtype",
                  "residue", "chain", "distance", "angle"]
    with open(output_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(
        description="Score docked poses and analyze protein-ligand interactions. "
                    "Detects hydrogen bonds, hydrophobic contacts, pi-stacking, "
                    "salt bridges, and halogen bonds.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # JSON output (default)
  python score.py --protein prepared.pdb --poses poses.sdf --output interactions.json

  # CSV output (flat interaction table)
  python score.py --protein prepared.pdb --poses poses.sdf --output interactions.csv
        """,
    )
    parser.add_argument(
        "--protein", required=True,
        help="Protein PDB file",
    )
    parser.add_argument(
        "--poses", required=True,
        help="Docked poses SDF file",
    )
    parser.add_argument(
        "--output", required=True,
        help="Output file (JSON or CSV)",
    )

    args = parser.parse_args()

    if not os.path.exists(args.protein):
        sys.exit(f"ERROR: Protein file not found: {args.protein}")
    if not os.path.exists(args.poses):
        sys.exit(f"ERROR: Poses file not found: {args.poses}")

    output_dir = os.path.dirname(args.output)
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)

    score_poses(
        protein_pdb=args.protein,
        poses_sdf=args.poses,
        output_path=args.output,
    )


if __name__ == "__main__":
    main()
