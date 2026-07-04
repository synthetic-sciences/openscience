#!/usr/bin/env python3
"""
draw_interactions.py - Generate 2D protein-ligand interaction diagrams.

Analyzes the interactions between a protein (PDB) and a ligand (SDF or SMILES),
classifies them (H-bond, hydrophobic, pi-stacking, salt bridge), and generates
a publication-quality 2D interaction diagram using matplotlib.

Usage:
    python draw_interactions.py --protein receptor.pdb --ligand ligand.sdf --output interactions.png
    python draw_interactions.py --protein receptor.pdb --ligand ligand.sdf --output interactions.png --distance-cutoff 4.5
"""

import argparse
import math
import os
import sys

try:
    from rdkit import Chem
    from rdkit.Chem import AllChem, Draw, rdMolDraw2D, Descriptors
except ImportError:
    print("Error: RDKit is required. Install with: pip install rdkit-pypi", file=sys.stderr)
    sys.exit(1)

try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import matplotlib.patches as mpatches
    from matplotlib.patches import FancyBboxPatch
    from matplotlib.lines import Line2D
except ImportError:
    print("Error: matplotlib is required. Install with: pip install matplotlib", file=sys.stderr)
    sys.exit(1)

try:
    from Bio.PDB import PDBParser, NeighborSearch
    from Bio.PDB.Polypeptide import is_aa
    import numpy as np
except ImportError:
    print("Error: BioPython and NumPy are required. Install with: pip install biopython numpy", file=sys.stderr)
    sys.exit(1)

try:
    from PIL import Image
    import io
except ImportError:
    Image = None


# --------------------------------------------------------------------------
# Interaction classification helpers
# --------------------------------------------------------------------------

# Atom element sets for interaction classification
HBOND_DONORS = {"N", "O"}
HBOND_ACCEPTORS = {"N", "O", "S", "F"}
HYDROPHOBIC_ELEMENTS = {"C"}
POSITIVE_RESIDUES = {"ARG", "LYS", "HIS"}
NEGATIVE_RESIDUES = {"ASP", "GLU"}
AROMATIC_RESIDUES = {"PHE", "TYR", "TRP", "HIS"}

# Interaction type colors
INTERACTION_COLORS = {
    "H-bond": "#27AE60",        # Green
    "Hydrophobic": "#95A5A6",   # Gray
    "Pi-stacking": "#E67E22",   # Orange
    "Salt bridge": "#E74C3C",   # Red
}


def get_residue_label(residue):
    """Generate a label like 'ALA 123' for a residue."""
    resname = residue.get_resname().strip()
    resid = residue.get_id()[1]
    chain = residue.get_parent().get_id()
    if chain and chain.strip():
        return f"{resname} {resid} ({chain})"
    return f"{resname} {resid}"


def distance(coord1, coord2):
    """Euclidean distance between two 3D coordinates."""
    return math.sqrt(sum((a - b) ** 2 for a, b in zip(coord1, coord2)))


def angle_between_vectors(v1, v2):
    """Angle (degrees) between two 3D vectors."""
    dot = sum(a * b for a, b in zip(v1, v2))
    mag1 = math.sqrt(sum(a ** 2 for a in v1))
    mag2 = math.sqrt(sum(a ** 2 for a in v2))
    if mag1 == 0 or mag2 == 0:
        return 0.0
    cos_angle = max(-1.0, min(1.0, dot / (mag1 * mag2)))
    return math.degrees(math.acos(cos_angle))


def get_aromatic_centroid(residue):
    """
    Compute the centroid of the aromatic ring atoms for aromatic residues.
    Returns the centroid as (x, y, z) or None.
    """
    ring_atoms = {
        "PHE": ["CG", "CD1", "CD2", "CE1", "CE2", "CZ"],
        "TYR": ["CG", "CD1", "CD2", "CE1", "CE2", "CZ"],
        "TRP": ["CG", "CD1", "CD2", "NE1", "CE2", "CE3", "CZ2", "CZ3", "CH2"],
        "HIS": ["CG", "ND1", "CD2", "CE1", "NE2"],
    }
    resname = residue.get_resname().strip()
    if resname not in ring_atoms:
        return None

    coords = []
    for atom_name in ring_atoms[resname]:
        try:
            atom = residue[atom_name]
            coords.append(atom.get_vector().get_array())
        except KeyError:
            continue

    if len(coords) < 3:
        return None

    centroid = np.mean(coords, axis=0)
    return tuple(centroid)


def classify_interactions(protein_atoms, ligand_atoms, distance_cutoff=4.0):
    """
    Classify interactions between protein residue atoms and ligand atoms.

    Parameters
    ----------
    protein_atoms : list of Bio.PDB.Atom
        All protein atoms.
    ligand_atoms : list of tuple
        Each tuple: (atom_element, (x, y, z), atom_name, is_aromatic).
    distance_cutoff : float
        Maximum distance in Angstroms for considering contacts.

    Returns
    -------
    interactions : list of dict
        Each dict: {residue_label, interaction_type, distance, protein_atom, ligand_atom_idx}.
    """
    # Build NeighborSearch from protein atoms
    ns = NeighborSearch(protein_atoms)

    interactions = []
    seen_residues = {}  # Track best interaction per residue

    for lig_idx, (lig_elem, lig_coord, lig_name, lig_aromatic) in enumerate(ligand_atoms):
        # Find all protein atoms within cutoff
        nearby = ns.search(np.array(lig_coord), distance_cutoff, level="A")

        for prot_atom in nearby:
            residue = prot_atom.get_parent()
            if not is_aa(residue, standard=True):
                continue

            prot_elem = prot_atom.element.strip().upper()
            prot_coord = tuple(prot_atom.get_vector().get_array())
            dist = distance(lig_coord, prot_coord)
            res_label = get_residue_label(residue)
            resname = residue.get_resname().strip()

            interaction_type = None

            # H-bond classification: distance < 3.5 A, donor/acceptor pairs
            if dist < 3.5:
                if (lig_elem in HBOND_DONORS and prot_elem in HBOND_ACCEPTORS) or \
                   (lig_elem in HBOND_ACCEPTORS and prot_elem in HBOND_DONORS):
                    interaction_type = "H-bond"

            # Salt bridge: charged groups within 4.0 A
            if dist < 4.0 and interaction_type is None:
                if (lig_elem in {"N"} and resname in NEGATIVE_RESIDUES) or \
                   (lig_elem in {"O"} and resname in POSITIVE_RESIDUES):
                    interaction_type = "Salt bridge"

            # Pi-stacking: aromatic ligand atom near aromatic residue centroid
            if interaction_type is None and lig_aromatic and resname in AROMATIC_RESIDUES:
                centroid = get_aromatic_centroid(residue)
                if centroid is not None:
                    centroid_dist = distance(lig_coord, centroid)
                    if centroid_dist < 5.5:
                        interaction_type = "Pi-stacking"

            # Hydrophobic: non-polar atoms within cutoff
            if interaction_type is None and dist < distance_cutoff:
                if lig_elem in HYDROPHOBIC_ELEMENTS and prot_elem in HYDROPHOBIC_ELEMENTS:
                    interaction_type = "Hydrophobic"

            if interaction_type is not None:
                key = (res_label, interaction_type)
                if key not in seen_residues or dist < seen_residues[key]["distance"]:
                    seen_residues[key] = {
                        "residue_label": res_label,
                        "interaction_type": interaction_type,
                        "distance": round(dist, 2),
                        "protein_atom": prot_atom.get_name(),
                        "ligand_atom_idx": lig_idx,
                    }

    interactions = list(seen_residues.values())

    # Sort by interaction type priority, then distance
    type_priority = {"H-bond": 0, "Salt bridge": 1, "Pi-stacking": 2, "Hydrophobic": 3}
    interactions.sort(key=lambda x: (type_priority.get(x["interaction_type"], 99), x["distance"]))

    return interactions


def load_ligand_from_sdf(sdf_path):
    """
    Load a ligand from an SDF file.

    Returns a list of (element, (x, y, z), atom_name, is_aromatic) tuples,
    the RDKit mol object, and the ligand's SMILES.
    """
    suppl = Chem.SDMolSupplier(sdf_path, removeHs=False)
    mol = next(suppl, None)
    if mol is None:
        print(f"Error: Could not read ligand from {sdf_path}", file=sys.stderr)
        sys.exit(1)

    conf = mol.GetConformer()
    atoms = []
    for i, atom in enumerate(mol.GetAtoms()):
        pos = conf.GetAtomPosition(i)
        elem = atom.GetSymbol().upper()
        is_arom = atom.GetIsAromatic()
        atoms.append((elem, (pos.x, pos.y, pos.z), f"{elem}{i}", is_arom))

    smiles = Chem.MolToSmiles(Chem.RemoveHs(mol))
    return atoms, mol, smiles


def load_protein(pdb_path):
    """
    Load protein atoms from a PDB file.

    Returns a list of Bio.PDB.Atom objects from standard amino acid residues.
    """
    parser = PDBParser(QUIET=True)
    structure = parser.get_structure("protein", pdb_path)

    protein_atoms = []
    for model in structure:
        for chain in model:
            for residue in chain:
                if is_aa(residue, standard=True):
                    for atom in residue:
                        protein_atoms.append(atom)
        break  # Use only first model

    return protein_atoms


def draw_interaction_diagram(ligand_mol, interactions, output_path, width=10, height=10):
    """
    Generate a 2D interaction diagram using matplotlib.

    The ligand is drawn in the center, and interacting residues are arranged
    around it in a circle with colored lines indicating interaction types.

    Parameters
    ----------
    ligand_mol : rdkit.Chem.Mol
        The ligand molecule (with 2D coords generated).
    interactions : list of dict
        Classified interactions from classify_interactions().
    output_path : str
        Output file path.
    width : float
        Figure width in inches.
    height : float
        Figure height in inches.
    """
    fig, ax = plt.subplots(1, 1, figsize=(width, height), dpi=300)
    ax.set_aspect("equal")
    ax.axis("off")

    # Draw ligand 2D image in center
    mol_2d = Chem.RWMol(Chem.RemoveHs(ligand_mol))
    AllChem.Compute2DCoords(mol_2d)

    drawer = rdMolDraw2D.MolDraw2DCairo(400, 400)
    drawer.drawOptions().clearBackground = True
    drawer.drawOptions().bondLineWidth = 2.0
    drawer.DrawMolecule(mol_2d)
    drawer.FinishDrawing()

    if Image is not None:
        mol_img = Image.open(io.BytesIO(drawer.GetDrawingText())).convert("RGBA")
        # Place ligand image in center
        extent = [-2.5, 2.5, -2.5, 2.5]
        ax.imshow(mol_img, extent=extent, zorder=5, alpha=0.95)

    # Deduplicate residues, keeping the strongest interaction for each
    unique_residues = {}
    for interaction in interactions:
        res = interaction["residue_label"]
        if res not in unique_residues:
            unique_residues[res] = interaction
        else:
            # Keep the shorter-distance (stronger) interaction
            if interaction["distance"] < unique_residues[res]["distance"]:
                unique_residues[res] = interaction

    residue_interactions = list(unique_residues.values())
    n_residues = len(residue_interactions)

    if n_residues == 0:
        ax.text(0, -4, "No interactions found within cutoff distance.",
                ha="center", va="center", fontsize=12, style="italic")
        fig.savefig(output_path, dpi=300, bbox_inches="tight", facecolor="white")
        plt.close(fig)
        return

    # Arrange residues in a circle around the ligand
    radius = 5.5
    angle_step = 2 * math.pi / max(n_residues, 1)

    for i, interaction in enumerate(residue_interactions):
        angle = i * angle_step - math.pi / 2  # Start from top
        rx = radius * math.cos(angle)
        ry = radius * math.sin(angle)

        itype = interaction["interaction_type"]
        color = INTERACTION_COLORS.get(itype, "#333333")
        dist_str = f"{interaction['distance']:.1f} A"

        # Draw the residue circle
        residue_bg_colors = {
            "H-bond": "#D5F5E3",
            "Hydrophobic": "#EAECEE",
            "Pi-stacking": "#FDEBD0",
            "Salt bridge": "#FADBD8",
        }
        bg_color = residue_bg_colors.get(itype, "#F0F0F0")

        bbox = FancyBboxPatch(
            (rx - 1.2, ry - 0.5), 2.4, 1.0,
            boxstyle="round,pad=0.2",
            facecolor=bg_color,
            edgecolor=color,
            linewidth=2,
            zorder=10,
        )
        ax.add_patch(bbox)

        # Residue label
        ax.text(rx, ry, interaction["residue_label"],
                ha="center", va="center", fontsize=7, fontweight="bold", zorder=11)

        # Draw dashed line from ligand center to residue
        ax.plot([0, rx], [0, ry], linestyle="--", color=color, linewidth=1.5,
                alpha=0.7, zorder=3)

        # Distance label on the line
        mid_x = rx * 0.55
        mid_y = ry * 0.55
        ax.text(mid_x, mid_y, dist_str, ha="center", va="center",
                fontsize=6, color=color, fontweight="bold",
                bbox=dict(boxstyle="round,pad=0.15", facecolor="white",
                          edgecolor=color, alpha=0.9),
                zorder=8)

    # Add legend
    legend_handles = []
    for itype, color in INTERACTION_COLORS.items():
        count = sum(1 for inter in residue_interactions if inter["interaction_type"] == itype)
        if count > 0:
            legend_handles.append(
                Line2D([0], [0], color=color, linewidth=3, linestyle="--",
                       label=f"{itype} ({count})")
            )

    if legend_handles:
        legend = ax.legend(handles=legend_handles, loc="upper right",
                           fontsize=8, framealpha=0.9, edgecolor="#CCCCCC")
        legend.get_frame().set_facecolor("white")

    # Set axis limits
    margin = 2
    ax.set_xlim(-radius - margin, radius + margin)
    ax.set_ylim(-radius - margin, radius + margin)

    # Title
    ax.set_title("Protein-Ligand Interaction Diagram", fontsize=14, fontweight="bold", pad=15)

    fig.savefig(output_path, dpi=300, bbox_inches="tight", facecolor="white")
    plt.close(fig)


def print_interaction_summary(interactions):
    """Print a formatted table of interactions."""
    if not interactions:
        print("\nNo interactions found within cutoff distance.")
        return

    print(f"\n{'Residue':<20} {'Type':<15} {'Distance (A)':<14} {'Protein Atom':<14}")
    print("-" * 63)

    # Deduplicate for summary
    seen = set()
    for inter in interactions:
        key = (inter["residue_label"], inter["interaction_type"])
        if key in seen:
            continue
        seen.add(key)
        print(f"{inter['residue_label']:<20} {inter['interaction_type']:<15} "
              f"{inter['distance']:<14.2f} {inter['protein_atom']:<14}")

    print(f"\nTotal unique interactions: {len(seen)}")

    # Count by type
    type_counts = {}
    for inter in interactions:
        itype = inter["interaction_type"]
        res = inter["residue_label"]
        key = (res, itype)
        if key not in type_counts:
            type_counts[itype] = type_counts.get(itype, 0) + 1

    if type_counts:
        print("Interaction breakdown:")
        for itype, count in sorted(type_counts.items()):
            print(f"  {itype}: {count}")


def main():
    parser = argparse.ArgumentParser(
        description="Generate a 2D protein-ligand interaction diagram.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s --protein receptor.pdb --ligand ligand.sdf --output interactions.png
  %(prog)s --protein protein.pdb --ligand docked_pose.sdf --output diagram.png --distance-cutoff 4.5
        """,
    )
    parser.add_argument(
        "--protein", required=True,
        help="Path to the protein PDB file."
    )
    parser.add_argument(
        "--ligand", required=True,
        help="Path to the ligand SDF file."
    )
    parser.add_argument(
        "--output", required=True,
        help="Output PNG file path for the interaction diagram."
    )
    parser.add_argument(
        "--distance-cutoff", type=float, default=4.0,
        help="Maximum distance in Angstroms for interaction detection (default: 4.0)."
    )

    args = parser.parse_args()

    # Validate input files
    if not os.path.exists(args.protein):
        print(f"Error: Protein file not found: {args.protein}", file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(args.ligand):
        print(f"Error: Ligand file not found: {args.ligand}", file=sys.stderr)
        sys.exit(1)

    # Ensure output directory exists
    out_dir = os.path.dirname(args.output)
    if out_dir and not os.path.exists(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    print(f"Loading protein from {args.protein}...")
    protein_atoms = load_protein(args.protein)
    print(f"  Loaded {len(protein_atoms)} protein atoms.")

    print(f"Loading ligand from {args.ligand}...")
    ligand_atoms, ligand_mol, ligand_smiles = load_ligand_from_sdf(args.ligand)
    print(f"  Loaded ligand with {len(ligand_atoms)} atoms.")
    print(f"  Ligand SMILES: {ligand_smiles}")

    print(f"\nAnalyzing interactions (cutoff: {args.distance_cutoff} A)...")
    interactions = classify_interactions(
        protein_atoms, ligand_atoms, distance_cutoff=args.distance_cutoff
    )

    print_interaction_summary(interactions)

    print(f"\nGenerating interaction diagram...")
    draw_interaction_diagram(ligand_mol, interactions, args.output)
    print(f"Interaction diagram saved to {args.output}")


if __name__ == "__main__":
    main()
