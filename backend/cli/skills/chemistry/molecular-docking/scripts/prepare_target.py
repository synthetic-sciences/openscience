#!/usr/bin/env python3
"""
Protein target preparation for molecular docking.

Cleans PDB structures by removing water molecules and non-standard residues,
selects specific chains, adds hydrogens, and detects binding pockets using
geometric cavity analysis with BioPython's NeighborSearch.

Usage:
    python prepare_target.py --input protein.pdb --output prepared.pdb --detect-pockets
    python prepare_target.py --input protein.pdb --output prepared.pdb --chain A
"""

import argparse
import json
import os
import sys
import warnings
from collections import defaultdict

warnings.filterwarnings("ignore")

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------

try:
    from Bio.PDB import (
        PDBParser,
        PDBIO,
        Select,
        NeighborSearch,
    )
    from Bio.PDB.Polypeptide import is_aa
except ImportError:
    sys.exit(
        "ERROR: BioPython is required. Install with: pip install biopython"
    )

try:
    import numpy as np
except ImportError:
    sys.exit("ERROR: NumPy is required. Install with: pip install numpy")

try:
    from scipy.spatial import ConvexHull
except ImportError:
    ConvexHull = None  # pocket volume estimation will be approximate

try:
    from rdkit import Chem
    from rdkit.Chem import AllChem, rdmolops
    HAS_RDKIT = True
except ImportError:
    HAS_RDKIT = False

# ---------------------------------------------------------------------------
# Standard amino acid residue names
# ---------------------------------------------------------------------------

STANDARD_RESIDUES = {
    "ALA", "ARG", "ASN", "ASP", "CYS", "GLN", "GLU", "GLY", "HIS", "ILE",
    "LEU", "LYS", "MET", "PHE", "PRO", "SER", "THR", "TRP", "TYR", "VAL",
    # Common protonation variants
    "HID", "HIE", "HIP", "CYX", "ASH", "GLH",
}

WATER_RESIDUES = {"HOH", "WAT", "TIP", "TIP3", "SOL", "H2O"}

# ---------------------------------------------------------------------------
# Selection classes for PDBIO
# ---------------------------------------------------------------------------


class CleanSelect(Select):
    """Select only standard amino acid residues from a given chain."""

    def __init__(self, chain_id=None):
        self.chain_id = chain_id

    def accept_chain(self, chain):
        if self.chain_id is not None:
            return chain.get_id() == self.chain_id
        return True

    def accept_residue(self, residue):
        resname = residue.get_resname().strip()
        hetflag = residue.get_id()[0]
        # Keep standard amino acids only (not water, not HETATM unless standard)
        if resname in WATER_RESIDUES:
            return False
        if hetflag.startswith("H") and resname not in STANDARD_RESIDUES:
            return False
        if resname in STANDARD_RESIDUES or hetflag == " ":
            return True
        return False


# ---------------------------------------------------------------------------
# Pocket detection
# ---------------------------------------------------------------------------


def _get_all_atoms(structure, chain_id=None):
    """Extract all protein atom coordinates and atom objects."""
    atoms = []
    for model in structure:
        for chain in model:
            if chain_id and chain.get_id() != chain_id:
                continue
            for residue in chain:
                resname = residue.get_resname().strip()
                if resname in WATER_RESIDUES:
                    continue
                for atom in residue:
                    atoms.append(atom)
        break  # first model only
    return atoms


def _find_hetatm_centers(structure, chain_id=None):
    """Find centers of HETATM groups (potential co-crystallized ligands)."""
    ligand_groups = defaultdict(list)
    for model in structure:
        for chain in model:
            if chain_id and chain.get_id() != chain_id:
                continue
            for residue in chain:
                hetflag = residue.get_id()[0]
                resname = residue.get_resname().strip()
                if hetflag.startswith("H") and resname not in WATER_RESIDUES and resname not in STANDARD_RESIDUES:
                    resid = (chain.get_id(), residue.get_id())
                    for atom in residue:
                        ligand_groups[resid].append(atom.get_vector().get_array())
        break
    centers = []
    for resid, coords in ligand_groups.items():
        coords_arr = np.array(coords)
        center = coords_arr.mean(axis=0)
        centers.append({
            "chain": resid[0],
            "resid": resid[1],
            "center": center,
            "n_atoms": len(coords),
        })
    return centers


def _pocket_from_ligand(structure, ligand_center, radius=8.0, chain_id=None):
    """Identify pocket residues near a co-crystallized ligand."""
    atoms = _get_all_atoms(structure, chain_id)
    ns = NeighborSearch(atoms)
    nearby = ns.search(ligand_center, radius, level="R")
    pocket_residues = []
    for res in nearby:
        resname = res.get_resname().strip()
        if resname in STANDARD_RESIDUES:
            pocket_residues.append(res)
    return pocket_residues


def _detect_cavities_grid(structure, chain_id=None, grid_spacing=1.0,
                          probe_radius=1.4, min_cavity_points=30):
    """
    Detect binding pockets using a grid-based solvent-accessible surface
    approach. The algorithm:

    1. Build a 3D grid around the protein.
    2. Mark grid points that are within van der Waals radius of any atom
       as 'protein'.
    3. Mark grid points that are beyond (vdw + probe_radius) of all atoms
       as 'bulk solvent'.
    4. Remaining points are 'cavity' candidates -- clusters of these
       points that are buried (surrounded by protein on multiple sides)
       represent potential binding pockets.
    5. Cluster cavity points and rank by size.
    """
    atoms = _get_all_atoms(structure, chain_id)
    if not atoms:
        return []

    coords = np.array([a.get_vector().get_array() for a in atoms])

    # Build grid
    margin = 6.0
    mins = coords.min(axis=0) - margin
    maxs = coords.max(axis=0) + margin

    xs = np.arange(mins[0], maxs[0], grid_spacing)
    ys = np.arange(mins[1], maxs[1], grid_spacing)
    zs = np.arange(mins[2], maxs[2], grid_spacing)

    # Limit grid size for performance
    total_points = len(xs) * len(ys) * len(zs)
    if total_points > 2_000_000:
        grid_spacing = grid_spacing * (total_points / 2_000_000) ** (1 / 3)
        xs = np.arange(mins[0], maxs[0], grid_spacing)
        ys = np.arange(mins[1], maxs[1], grid_spacing)
        zs = np.arange(mins[2], maxs[2], grid_spacing)

    # Use NeighborSearch for efficient distance queries
    ns = NeighborSearch(atoms)

    # Typical van der Waals radius
    vdw = 1.7
    inner_cutoff = vdw + 0.5
    outer_cutoff = vdw + probe_radius + 2.0

    cavity_points = []

    for x in xs:
        for y in ys:
            for z in zs:
                point = np.array([x, y, z])
                # Find atoms near this grid point
                nearby_inner = ns.search(point, inner_cutoff, level="A")
                if len(nearby_inner) > 0:
                    # Inside protein -- skip
                    continue

                nearby_outer = ns.search(point, outer_cutoff, level="A")
                if len(nearby_outer) == 0:
                    # Bulk solvent -- skip
                    continue

                # Check buriedness: atoms should be present in multiple directions
                if len(nearby_outer) >= 4:
                    nearby_coords = np.array(
                        [a.get_vector().get_array() for a in nearby_outer]
                    )
                    relative = nearby_coords - point
                    # Check spread across octants
                    signs = np.sign(relative)
                    octants = set()
                    for s in signs:
                        octants.add(tuple(s.astype(int)))
                    if len(octants) >= 3:
                        cavity_points.append(point)

    if not cavity_points:
        return []

    cavity_points = np.array(cavity_points)

    # Cluster cavity points using simple distance-based clustering
    clusters = _cluster_points(cavity_points, cluster_radius=3.5)

    # Filter small clusters and sort by size
    clusters = [c for c in clusters if len(c) >= min_cavity_points]
    clusters.sort(key=lambda c: len(c), reverse=True)

    # Convert to pocket descriptions
    pockets = []
    for i, cluster in enumerate(clusters[:5]):
        cluster_arr = np.array(cluster)
        center = cluster_arr.mean(axis=0)

        # Estimate volume
        volume = len(cluster) * (grid_spacing ** 3)
        if ConvexHull is not None and len(cluster) >= 4:
            try:
                hull = ConvexHull(cluster_arr)
                volume = hull.volume
            except Exception:
                pass

        # Find nearby residues
        nearby_residues = ns.search(center, 8.0, level="R")
        res_list = []
        for res in nearby_residues:
            resname = res.get_resname().strip()
            if resname in STANDARD_RESIDUES:
                res_list.append(res)

        pockets.append({
            "rank": i + 1,
            "center": center.tolist(),
            "volume_A3": round(volume, 1),
            "n_grid_points": len(cluster),
            "residues": res_list,
        })

    return pockets


def _cluster_points(points, cluster_radius=3.5):
    """Simple greedy clustering of 3D points."""
    if len(points) == 0:
        return []

    remaining = list(range(len(points)))
    clusters = []

    while remaining:
        seed_idx = remaining[0]
        seed = points[seed_idx]
        cluster = [seed]
        new_remaining = []

        for idx in remaining[1:]:
            dist = np.linalg.norm(points[idx] - seed)
            if dist <= cluster_radius:
                cluster.append(points[idx])
            else:
                new_remaining.append(idx)

        # Iteratively expand cluster from center
        if len(cluster) > 1:
            center = np.mean(cluster, axis=0)
            still_remaining = []
            for idx in new_remaining:
                dist = np.linalg.norm(points[idx] - center)
                if dist <= cluster_radius * 1.5:
                    cluster.append(points[idx])
                else:
                    still_remaining.append(idx)
            new_remaining = still_remaining

        clusters.append(cluster)
        remaining = new_remaining

    return clusters


# ---------------------------------------------------------------------------
# Hydrogen addition
# ---------------------------------------------------------------------------


def _add_hydrogens_rdkit(pdb_path, output_path):
    """Add hydrogens using RDKit (best effort for proteins)."""
    if not HAS_RDKIT:
        print("WARNING: RDKit not available. Skipping hydrogen addition.")
        return False

    try:
        mol = Chem.MolFromPDBFile(pdb_path, removeHs=False, sanitize=False)
        if mol is None:
            print("WARNING: RDKit could not parse PDB. Skipping hydrogen addition.")
            return False

        mol = rdmolops.AddHs(mol, addCoords=True)
        Chem.MolToPDBFile(mol, output_path)
        return True
    except Exception as e:
        print(f"WARNING: RDKit hydrogen addition failed: {e}")
        return False


# ---------------------------------------------------------------------------
# Main preparation logic
# ---------------------------------------------------------------------------


def prepare_target(input_pdb, output_pdb, chain_id=None, detect_pockets=False):
    """
    Full protein preparation pipeline.

    1. Parse PDB
    2. Remove water and non-standard residues
    3. Select chain (if specified)
    4. Write cleaned PDB
    5. Attempt hydrogen addition
    6. Detect pockets (if requested)
    """
    parser = PDBParser(QUIET=True)
    structure = parser.get_structure("target", input_pdb)

    # Report input stats
    n_chains = 0
    n_residues = 0
    n_hetatm = 0
    n_water = 0
    for model in structure:
        for chain in model:
            n_chains += 1
            for residue in chain:
                resname = residue.get_resname().strip()
                hetflag = residue.get_id()[0]
                if resname in WATER_RESIDUES:
                    n_water += 1
                elif hetflag.startswith("H") and resname not in STANDARD_RESIDUES:
                    n_hetatm += 1
                else:
                    n_residues += 1
        break

    print(f"Input: {input_pdb}")
    print(f"  Chains: {n_chains}")
    print(f"  Protein residues: {n_residues}")
    print(f"  HETATM groups: {n_hetatm}")
    print(f"  Water molecules: {n_water}")
    if chain_id:
        print(f"  Selecting chain: {chain_id}")
    print()

    # Write cleaned PDB
    io = PDBIO()
    io.set_structure(structure)
    selector = CleanSelect(chain_id=chain_id)
    io.save(output_pdb, selector)

    # Count residues in cleaned output
    clean_structure = parser.get_structure("clean", output_pdb)
    clean_residues = 0
    for model in clean_structure:
        for chain in model:
            for residue in chain:
                if is_aa(residue, standard=True):
                    clean_residues += 1
        break

    print(f"Output: {output_pdb}")
    print(f"  Protein residues retained: {clean_residues}")
    print(f"  Removed: {n_water} waters, {n_hetatm} HETATM groups")

    # Attempt hydrogen addition
    h_output = output_pdb
    if HAS_RDKIT:
        h_temp = output_pdb.replace(".pdb", "_H.pdb")
        success = _add_hydrogens_rdkit(output_pdb, h_temp)
        if success and os.path.exists(h_temp):
            os.replace(h_temp, output_pdb)
            print("  Hydrogens added via RDKit")
        else:
            print("  Hydrogens: skipped (RDKit could not process this structure)")
    else:
        print("  Hydrogens: skipped (install rdkit-pypi for automatic H addition)")

    print()

    # Pocket detection
    pocket_data = None
    if detect_pockets:
        print("=" * 60)
        print("POCKET DETECTION")
        print("=" * 60)

        pockets = []

        # Strategy 1: Look for co-crystallized ligands
        ligand_centers = _find_hetatm_centers(structure, chain_id)
        if ligand_centers:
            print(f"\nFound {len(ligand_centers)} co-crystallized ligand(s).")
            for lc in ligand_centers:
                resid_str = f"{lc['chain']}:{lc['resid'][1]}"
                print(f"  Ligand at {resid_str} ({lc['n_atoms']} atoms)")
                pocket_residues = _pocket_from_ligand(
                    structure, lc["center"], radius=8.0, chain_id=chain_id
                )
                if pocket_residues:
                    center = lc["center"]
                    res_names = [
                        f"{r.get_resname()}{r.get_id()[1]}"
                        for r in pocket_residues
                    ]
                    pocket = {
                        "rank": len(pockets) + 1,
                        "source": "co-crystallized_ligand",
                        "center": center.tolist(),
                        "residues": res_names,
                        "n_residues": len(res_names),
                    }
                    pockets.append(pocket)

                    print(f"\n  Pocket {pocket['rank']} (from ligand):")
                    print(f"    Center: ({center[0]:.1f}, {center[1]:.1f}, {center[2]:.1f})")
                    print(f"    Residues ({len(res_names)}): {', '.join(res_names[:10])}")
                    if len(res_names) > 10:
                        print(f"      ... and {len(res_names) - 10} more")

        # Strategy 2: Grid-based cavity detection
        print("\nRunning grid-based cavity detection...")
        grid_pockets = _detect_cavities_grid(structure, chain_id)

        if grid_pockets:
            print(f"Detected {len(grid_pockets)} cavity/cavities.\n")
            for gp in grid_pockets:
                res_names = [
                    f"{r.get_resname()}{r.get_id()[1]}"
                    for r in gp["residues"]
                ]
                pocket = {
                    "rank": len(pockets) + 1,
                    "source": "grid_cavity_detection",
                    "center": gp["center"],
                    "volume_A3": gp["volume_A3"],
                    "n_grid_points": gp["n_grid_points"],
                    "residues": res_names,
                    "n_residues": len(res_names),
                }
                pockets.append(pocket)

                c = gp["center"]
                print(f"  Pocket {pocket['rank']} (cavity detection):")
                print(f"    Center: ({c[0]:.1f}, {c[1]:.1f}, {c[2]:.1f})")
                print(f"    Volume: ~{gp['volume_A3']:.0f} A^3")
                print(f"    Residues ({len(res_names)}): {', '.join(res_names[:10])}")
                if len(res_names) > 10:
                    print(f"      ... and {len(res_names) - 10} more")
                print()
        else:
            print("No significant cavities detected by grid analysis.")

        if not pockets:
            print("\nNo pockets detected. Consider providing manual coordinates")
            print("for the docking box via --center_x/y/z in the dock step.")

        # Save pocket data
        pocket_json_path = output_pdb.replace(".pdb", "_pockets.json")
        pocket_data = {
            "protein": os.path.basename(input_pdb),
            "prepared_protein": os.path.basename(output_pdb),
            "chain": chain_id,
            "n_pockets": len(pockets),
            "pockets": pockets,
        }
        with open(pocket_json_path, "w") as f:
            json.dump(pocket_data, f, indent=2)
        print(f"\nPocket data saved to: {pocket_json_path}")

        # Recommend best pocket for docking
        if pockets:
            best = pockets[0]
            c = best["center"]
            print(f"\nRecommended docking center (Pocket 1):")
            print(f"  --center_x {c[0]:.1f} --center_y {c[1]:.1f} --center_z {c[2]:.1f}")

    return pocket_data


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(
        description="Prepare protein target for molecular docking. "
                    "Removes water, non-standard residues, adds hydrogens, "
                    "and optionally detects binding pockets.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python prepare_target.py --input 1abc.pdb --output prepared.pdb
  python prepare_target.py --input 1abc.pdb --output prepared.pdb --chain A
  python prepare_target.py --input 1abc.pdb --output prepared.pdb --detect-pockets
        """,
    )
    parser.add_argument(
        "--input", required=True,
        help="Input PDB file path",
    )
    parser.add_argument(
        "--output", required=True,
        help="Output prepared PDB file path",
    )
    parser.add_argument(
        "--chain", default=None,
        help="Chain ID to select (e.g., A). If not specified, all chains are kept.",
    )
    parser.add_argument(
        "--detect-pockets", action="store_true",
        help="Run binding pocket detection on the prepared structure",
    )

    args = parser.parse_args()

    if not os.path.exists(args.input):
        sys.exit(f"ERROR: Input file not found: {args.input}")

    output_dir = os.path.dirname(args.output)
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)

    prepare_target(
        input_pdb=args.input,
        output_pdb=args.output,
        chain_id=args.chain,
        detect_pockets=args.detect_pockets,
    )


if __name__ == "__main__":
    main()
