#!/usr/bin/env python3
"""
draw_2d.py - Generate publication-quality 2D molecular structure drawings.

Renders a single molecule from SMILES as a high-quality PNG or SVG image
using RDKit's rdMolDraw2D module. Supports atom highlighting, stereochemistry
display, atom index labeling, and customizable image dimensions.

Usage:
    python draw_2d.py --smiles "CC(=O)Oc1ccccc1C(=O)O" --output aspirin.png
    python draw_2d.py --smiles "c1ccccc1" --output benzene.svg --title "Benzene"
    python draw_2d.py --smiles "C1CCCCC1" --output cyclohexane.png --highlight-atoms 0,1,2
"""

import argparse
import os
import sys

try:
    from rdkit import Chem
    from rdkit.Chem import Draw, AllChem, Descriptors
    from rdkit.Chem.Draw import rdMolDraw2D
except ImportError:
    print("Error: RDKit is required. Install with: pip install rdkit-pypi", file=sys.stderr)
    sys.exit(1)

try:
    from PIL import Image
    import io
except ImportError:
    Image = None


def parse_size(size_str):
    """Parse a size string like '400x300' into (width, height)."""
    try:
        parts = size_str.lower().split("x")
        return int(parts[0]), int(parts[1])
    except (ValueError, IndexError):
        print(f"Warning: Invalid size '{size_str}', using default 400x300.", file=sys.stderr)
        return 400, 300


def hex_to_rgb_float(hex_color):
    """Convert a hex color string like '#FF7F7F' to an (r, g, b) tuple of floats 0-1."""
    hex_color = hex_color.lstrip("#")
    if len(hex_color) != 6:
        return (1.0, 0.5, 0.5)
    r = int(hex_color[0:2], 16) / 255.0
    g = int(hex_color[2:4], 16) / 255.0
    b = int(hex_color[4:6], 16) / 255.0
    return (r, g, b)


def draw_molecule(smiles, output_path, width=400, height=300, title=None,
                  highlight_atoms=None, highlight_color="#FF7F7F",
                  show_atom_indices=False, kekulize=True):
    """
    Draw a single molecule and save to PNG or SVG.

    Parameters
    ----------
    smiles : str
        SMILES string of the molecule.
    output_path : str
        Output file path. Extension determines format (.png or .svg).
    width : int
        Image width in pixels.
    height : int
        Image height in pixels.
    title : str or None
        Optional title/label to display below the molecule.
    highlight_atoms : list of int or None
        Atom indices to highlight.
    highlight_color : str
        Hex color for highlighted atoms (e.g., '#FF7F7F').
    show_atom_indices : bool
        If True, label each atom with its index.
    kekulize : bool
        If True, kekulize the molecule before drawing.
    """
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        print(f"Error: Could not parse SMILES: {smiles}", file=sys.stderr)
        sys.exit(1)

    # Generate 2D coordinates
    AllChem.Compute2DCoords(mol)

    # Kekulize if requested
    if kekulize:
        try:
            Chem.Kekulize(mol, clearAromaticFlags=False)
        except Exception:
            pass  # Some molecules cannot be kekulized; continue with aromatic form

    # Determine output format
    ext = os.path.splitext(output_path)[1].lower()
    is_svg = ext == ".svg"

    # Set up atom labels for index display
    if show_atom_indices:
        for atom in mol.GetAtoms():
            atom.SetProp("atomNote", str(atom.GetIdx()))

    # Create the drawer
    if is_svg:
        drawer = rdMolDraw2D.MolDraw2DSVG(width, height)
    else:
        drawer = rdMolDraw2D.MolDraw2DCairo(width, height)

    # Configure drawing options
    opts = drawer.drawOptions()
    opts.clearBackground = True
    opts.bondLineWidth = 2.0
    opts.additionalAtomLabelPadding = 0.1
    opts.annotationFontScale = 0.7
    opts.fixedBondLength = 30

    if title:
        # Use legend parameter in DrawMolecule for the title
        pass

    # Prepare highlight information
    highlight_atom_list = []
    highlight_bond_list = []
    atom_colors = {}
    bond_colors = {}

    if highlight_atoms:
        rgb = hex_to_rgb_float(highlight_color)
        highlight_atom_list = highlight_atoms

        for idx in highlight_atoms:
            atom_colors[idx] = rgb

        # Highlight bonds between highlighted atoms
        for bond in mol.GetBonds():
            begin_idx = bond.GetBeginAtomIdx()
            end_idx = bond.GetEndAtomIdx()
            if begin_idx in highlight_atoms and end_idx in highlight_atoms:
                highlight_bond_list.append(bond.GetIdx())
                bond_colors[bond.GetIdx()] = rgb

    # Draw the molecule
    legend = title if title else ""
    drawer.DrawMolecule(
        mol,
        legend=legend,
        highlightAtoms=highlight_atom_list,
        highlightAtomColors=atom_colors if atom_colors else {},
        highlightBonds=highlight_bond_list,
        highlightBondColors=bond_colors if bond_colors else {},
    )
    drawer.FinishDrawing()

    # Get the output
    if is_svg:
        svg_text = drawer.GetDrawingText()
        with open(output_path, "w") as f:
            f.write(svg_text)
    else:
        png_data = drawer.GetDrawingText()
        with open(output_path, "wb") as f:
            f.write(png_data)

    # Compute and print molecule info
    mol_clean = Chem.MolFromSmiles(smiles)
    formula = Descriptors.MolecularFormula(mol_clean) if mol_clean else "N/A"
    canonical = Chem.MolToSmiles(mol_clean) if mol_clean else smiles

    print(f"Saved to {output_path}")
    print(f"Molecular formula: {formula}")
    print(f"SMILES: {canonical}")

    if highlight_atoms:
        print(f"Highlighted atoms: {highlight_atoms}")
    if title:
        print(f"Title: {title}")


def main():
    parser = argparse.ArgumentParser(
        description="Generate a publication-quality 2D molecular structure drawing.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s --smiles "c1ccccc1" --output benzene.png
  %(prog)s --smiles "CC(=O)Oc1ccccc1C(=O)O" --output aspirin.svg --title "Aspirin"
  %(prog)s --smiles "c1ccccc1" --output benzene.png --highlight-atoms 0,1,2 --highlight-color "#4A90D9"
  %(prog)s --smiles "C1CCCCC1" --output cyclohexane.png --show-atom-indices
        """,
    )
    parser.add_argument(
        "--smiles", required=True, help="SMILES string of the molecule to draw."
    )
    parser.add_argument(
        "--output", required=True,
        help="Output file path. Use .png for raster or .svg for vector output."
    )
    parser.add_argument(
        "--size", default="400x300",
        help="Image dimensions as WIDTHxHEIGHT in pixels (default: 400x300)."
    )
    parser.add_argument(
        "--title", default=None,
        help="Optional title/label displayed below the molecule."
    )
    parser.add_argument(
        "--highlight-atoms", default=None,
        help="Comma-separated atom indices to highlight (e.g., '0,1,2,3')."
    )
    parser.add_argument(
        "--highlight-color", default="#FF7F7F",
        help="Hex color for highlighted atoms (default: #FF7F7F)."
    )
    parser.add_argument(
        "--show-atom-indices", action="store_true",
        help="Label each atom with its index number."
    )
    parser.add_argument(
        "--kekulize", action="store_true", default=True,
        help="Kekulize the molecule before drawing (default: true)."
    )
    parser.add_argument(
        "--no-kekulize", action="store_false", dest="kekulize",
        help="Do not kekulize the molecule before drawing."
    )

    args = parser.parse_args()

    # Parse size
    width, height = parse_size(args.size)

    # Parse highlight atoms
    highlight_atoms = None
    if args.highlight_atoms:
        try:
            highlight_atoms = [int(x.strip()) for x in args.highlight_atoms.split(",")]
        except ValueError:
            print("Error: --highlight-atoms must be comma-separated integers.", file=sys.stderr)
            sys.exit(1)

    # Ensure output directory exists
    out_dir = os.path.dirname(args.output)
    if out_dir and not os.path.exists(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    draw_molecule(
        smiles=args.smiles,
        output_path=args.output,
        width=width,
        height=height,
        title=args.title,
        highlight_atoms=highlight_atoms,
        highlight_color=args.highlight_color,
        show_atom_indices=args.show_atom_indices,
        kekulize=args.kekulize,
    )


if __name__ == "__main__":
    main()
