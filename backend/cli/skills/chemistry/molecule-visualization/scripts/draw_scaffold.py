#!/usr/bin/env python3
"""
draw_scaffold.py - Scaffold highlighting and R-group decomposition visualization.

Highlights the core scaffold of a molecule and identifies R-group substitution
positions. Supports automatic Murcko scaffold detection, manual scaffold
specification, and R-group decomposition across a series of analogs.

Usage:
    python draw_scaffold.py --smiles "c1ccc(NC(=O)c2ccccc2Cl)cc1" --scaffold "c1ccc(NC(=O)c2ccccc2)cc1" --output scaffold.png
    python draw_scaffold.py --smiles "CC(=O)Oc1ccccc1C(=O)O" --scaffold auto --output murcko.png
    python draw_scaffold.py --smiles "c1ccc(NC(=O)c2ccccc2)cc1" --scaffold auto --analogs analogs.csv --output rgroup.png
"""

import argparse
import csv
import os
import sys

try:
    from rdkit import Chem
    from rdkit.Chem import (
        Draw, AllChem, Descriptors,
        rdMolDraw2D, rdRGroupDecomposition,
    )
    from rdkit.Chem.Scaffolds import MurckoScaffold
except ImportError:
    print("Error: RDKit is required. Install with: pip install rdkit-pypi", file=sys.stderr)
    sys.exit(1)

try:
    from PIL import Image, ImageDraw, ImageFont
    import io
except ImportError:
    print("Error: Pillow is required. Install with: pip install pillow", file=sys.stderr)
    sys.exit(1)


def get_murcko_scaffold(mol):
    """Compute the Murcko generic scaffold for a molecule."""
    try:
        core = MurckoScaffold.GetScaffoldForMol(mol)
        return core
    except Exception as e:
        print(f"Warning: Could not compute Murcko scaffold: {e}", file=sys.stderr)
        return None


def find_scaffold_atoms(mol, scaffold):
    """
    Find the atom indices in mol that correspond to the scaffold substructure.

    Returns a tuple (scaffold_atom_indices, rgroup_atom_indices) or (None, None)
    if the scaffold is not found.
    """
    match = mol.GetSubstructMatch(scaffold)
    if not match:
        return None, None

    scaffold_atoms = set(match)
    all_atoms = set(range(mol.GetNumAtoms()))
    rgroup_atoms = all_atoms - scaffold_atoms

    return list(scaffold_atoms), list(rgroup_atoms)


def draw_highlighted_molecule(mol, scaffold_atoms, rgroup_atoms, output_path,
                              width=500, height=400, title=None):
    """
    Draw a molecule with scaffold atoms in blue and R-group atoms in red.

    Parameters
    ----------
    mol : rdkit.Chem.Mol
        The molecule to draw.
    scaffold_atoms : list of int
        Atom indices belonging to the scaffold (highlighted in blue).
    rgroup_atoms : list of int
        Atom indices belonging to R-groups (highlighted in red).
    output_path : str
        Output file path (.png or .svg).
    width : int
        Image width.
    height : int
        Image height.
    title : str or None
        Optional title/legend.
    """
    AllChem.Compute2DCoords(mol)

    ext = os.path.splitext(output_path)[1].lower()
    is_svg = ext == ".svg"

    if is_svg:
        drawer = rdMolDraw2D.MolDraw2DSVG(width, height)
    else:
        drawer = rdMolDraw2D.MolDraw2DCairo(width, height)

    opts = drawer.drawOptions()
    opts.clearBackground = True
    opts.bondLineWidth = 2.0
    opts.fixedBondLength = 30

    # Build color maps
    highlight_atoms = scaffold_atoms + rgroup_atoms
    atom_colors = {}
    scaffold_color = (0.3, 0.5, 0.9)   # Blue for scaffold
    rgroup_color = (0.9, 0.3, 0.3)      # Red for R-groups

    for idx in scaffold_atoms:
        atom_colors[idx] = scaffold_color
    for idx in rgroup_atoms:
        atom_colors[idx] = rgroup_color

    # Highlight bonds within scaffold
    bond_colors = {}
    highlight_bonds = []
    scaffold_set = set(scaffold_atoms)
    rgroup_set = set(rgroup_atoms)

    for bond in mol.GetBonds():
        b = bond.GetBeginAtomIdx()
        e = bond.GetEndAtomIdx()
        if b in scaffold_set and e in scaffold_set:
            highlight_bonds.append(bond.GetIdx())
            bond_colors[bond.GetIdx()] = scaffold_color
        elif b in rgroup_set and e in rgroup_set:
            highlight_bonds.append(bond.GetIdx())
            bond_colors[bond.GetIdx()] = rgroup_color
        elif (b in scaffold_set and e in rgroup_set) or (b in rgroup_set and e in scaffold_set):
            highlight_bonds.append(bond.GetIdx())
            bond_colors[bond.GetIdx()] = (0.6, 0.4, 0.6)  # Purple for connecting bonds

    legend = title if title else ""
    drawer.DrawMolecule(
        mol,
        legend=legend,
        highlightAtoms=highlight_atoms,
        highlightAtomColors=atom_colors,
        highlightBonds=highlight_bonds,
        highlightBondColors=bond_colors,
    )
    drawer.FinishDrawing()

    if is_svg:
        with open(output_path, "w") as f:
            f.write(drawer.GetDrawingText())
    else:
        with open(output_path, "wb") as f:
            f.write(drawer.GetDrawingText())


def load_analogs_from_csv(csv_path, max_mols=50):
    """Load analog SMILES from a CSV file with 'name' and 'smiles' columns."""
    analogs = []
    with open(csv_path, "r", newline="") as f:
        reader = csv.DictReader(f)
        headers = {h.lower().strip(): h for h in (reader.fieldnames or [])}
        smiles_col = headers.get("smiles", None)
        name_col = headers.get("name", None)

        if smiles_col is None:
            print("Error: Analog CSV must have a 'smiles' column.", file=sys.stderr)
            sys.exit(1)

        for i, row in enumerate(reader):
            if len(analogs) >= max_mols:
                break
            smi = row.get(smiles_col, "").strip()
            name = row.get(name_col, f"Analog_{i+1}").strip() if name_col else f"Analog_{i+1}"
            mol = Chem.MolFromSmiles(smi) if smi else None
            if mol:
                analogs.append({"name": name, "smiles": smi, "mol": mol})

    return analogs


def perform_rgroup_decomposition(core, analogs, output_path, width=800, height=600):
    """
    Perform R-group decomposition and create a grid showing core + R-groups.

    Parameters
    ----------
    core : rdkit.Chem.Mol
        The core/scaffold molecule.
    analogs : list of dict
        Each dict has keys: name, smiles, mol.
    output_path : str
        Output file path.
    width : int
        Total image width.
    height : int
        Total image height.
    """
    mols = [a["mol"] for a in analogs]
    names = [a["name"] for a in analogs]

    # Perform R-group decomposition
    try:
        rgroup_results = rdRGroupDecomposition.RGroupDecompose(
            [core], mols, asSmiles=False, asRows=True
        )
    except Exception as e:
        print(f"Error in R-group decomposition: {e}", file=sys.stderr)
        print("Falling back to simple scaffold highlighting.", file=sys.stderr)
        return False

    if not rgroup_results or len(rgroup_results) == 0:
        print("Warning: R-group decomposition returned no results.", file=sys.stderr)
        return False

    unmatched, results = rgroup_results

    if not results:
        print("Warning: No analogs matched the core scaffold.", file=sys.stderr)
        return False

    # Determine R-group columns
    rgroup_keys = sorted(set().union(*(r.keys() for r in results)))
    rgroup_keys = [k for k in rgroup_keys if k.startswith("R")]

    n_analogs = len(results)
    n_cols = 1 + len(rgroup_keys)  # Core + R-groups
    cell_w = max(width // n_cols, 150)
    cell_h = 200
    header_h = 30

    total_w = n_cols * cell_w
    total_h = header_h + (n_analogs + 1) * cell_h  # +1 for core row

    img = Image.new("RGBA", (total_w, total_h), (255, 255, 255, 255))
    d = ImageDraw.Draw(img)

    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 12)
    except (IOError, OSError):
        font = ImageFont.load_default()

    # Draw header row
    headers_list = ["Core"] + rgroup_keys
    for j, hdr in enumerate(headers_list):
        x = j * cell_w + cell_w // 2 - 20
        d.text((x, 8), hdr, fill=(0, 0, 0), font=font)
    d.line([(0, header_h), (total_w, header_h)], fill=(180, 180, 180), width=1)

    # Draw core in first data row
    AllChem.Compute2DCoords(core)
    core_drawer = rdMolDraw2D.MolDraw2DCairo(cell_w, cell_h)
    core_drawer.drawOptions().clearBackground = True
    core_drawer.DrawMolecule(core)
    core_drawer.FinishDrawing()
    core_img = Image.open(io.BytesIO(core_drawer.GetDrawingText())).convert("RGBA")
    img.paste(core_img, (0, header_h))

    # Draw each analog's R-groups
    for i, result in enumerate(results):
        y_offset = header_h + (i + 1) * cell_h

        # Draw the core column (show the matched molecule with highlighted core)
        if "Core" in result and result["Core"] is not None:
            core_mol = result["Core"]
            AllChem.Compute2DCoords(core_mol)
            cd = rdMolDraw2D.MolDraw2DCairo(cell_w, cell_h)
            cd.drawOptions().clearBackground = True
            cd.DrawMolecule(core_mol, legend=names[i] if i < len(names) else "")
            cd.FinishDrawing()
            ci = Image.open(io.BytesIO(cd.GetDrawingText())).convert("RGBA")
            img.paste(ci, (0, y_offset))

        # Draw each R-group
        for j, rkey in enumerate(rgroup_keys):
            rg_mol = result.get(rkey, None)
            if rg_mol is not None:
                try:
                    AllChem.Compute2DCoords(rg_mol)
                    rd = rdMolDraw2D.MolDraw2DCairo(cell_w, cell_h)
                    rd.drawOptions().clearBackground = True
                    rd.DrawMolecule(rg_mol)
                    rd.FinishDrawing()
                    ri = Image.open(io.BytesIO(rd.GetDrawingText())).convert("RGBA")
                    img.paste(ri, ((j + 1) * cell_w, y_offset))
                except Exception:
                    pass

        # Draw row separator
        d.line([(0, y_offset), (total_w, y_offset)], fill=(230, 230, 230), width=1)

    # Draw column separators
    for j in range(1, n_cols):
        d.line([(j * cell_w, 0), (j * cell_w, total_h)], fill=(230, 230, 230), width=1)

    img.save(output_path, "PNG", dpi=(300, 300))
    return True


def main():
    parser = argparse.ArgumentParser(
        description="Scaffold highlighting and R-group decomposition visualization.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s --smiles "c1ccc(NC(=O)c2ccccc2Cl)cc1" --scaffold "c1ccc(NC(=O)c2ccccc2)cc1" --output scaffold.png
  %(prog)s --smiles "CC(=O)Oc1ccccc1C(=O)O" --scaffold auto --output murcko.png
  %(prog)s --smiles "c1ccc(NC(=O)c2ccccc2)cc1" --scaffold auto --analogs analogs.csv --output rgroup.png
        """,
    )
    parser.add_argument(
        "--smiles", required=True,
        help="SMILES string of the full molecule."
    )
    parser.add_argument(
        "--scaffold", required=True,
        help="Core scaffold SMILES, or 'auto' to detect Murcko scaffold automatically."
    )
    parser.add_argument(
        "--output", required=True,
        help="Output image file path (.png or .svg)."
    )
    parser.add_argument(
        "--analogs", default=None,
        help="Optional CSV file of analogs for R-group decomposition (columns: name, smiles)."
    )

    args = parser.parse_args()

    # Parse the main molecule
    mol = Chem.MolFromSmiles(args.smiles)
    if mol is None:
        print(f"Error: Could not parse SMILES: {args.smiles}", file=sys.stderr)
        sys.exit(1)

    # Determine the scaffold
    if args.scaffold.lower() == "auto":
        scaffold = get_murcko_scaffold(mol)
        if scaffold is None:
            print("Error: Could not determine Murcko scaffold.", file=sys.stderr)
            sys.exit(1)
        scaffold_smiles = Chem.MolToSmiles(scaffold)
        print(f"Auto-detected Murcko scaffold: {scaffold_smiles}")
    else:
        scaffold = Chem.MolFromSmiles(args.scaffold)
        if scaffold is None:
            print(f"Error: Could not parse scaffold SMILES: {args.scaffold}", file=sys.stderr)
            sys.exit(1)
        scaffold_smiles = Chem.MolToSmiles(scaffold)

    # Ensure output directory exists
    out_dir = os.path.dirname(args.output)
    if out_dir and not os.path.exists(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    # R-group decomposition mode
    if args.analogs:
        if not os.path.exists(args.analogs):
            print(f"Error: Analogs file not found: {args.analogs}", file=sys.stderr)
            sys.exit(1)

        analogs = load_analogs_from_csv(args.analogs)
        if not analogs:
            print("Error: No valid analogs loaded.", file=sys.stderr)
            sys.exit(1)

        # Add the main molecule as the first analog if not already present
        main_smi = Chem.MolToSmiles(mol)
        analog_smiles = [Chem.MolToSmiles(a["mol"]) for a in analogs]
        if main_smi not in analog_smiles:
            analogs.insert(0, {"name": "Query", "smiles": main_smi, "mol": mol})

        success = perform_rgroup_decomposition(scaffold, analogs, args.output)
        if success:
            print(f"Scaffold SMILES: {scaffold_smiles}")
            print(f"R-group decomposition of {len(analogs)} analogs saved to {args.output}")
        else:
            # Fall back to simple scaffold highlighting
            print("Falling back to single-molecule scaffold highlighting.", file=sys.stderr)
            scaffold_atoms, rgroup_atoms = find_scaffold_atoms(mol, scaffold)
            if scaffold_atoms is None:
                print("Warning: Scaffold not found as substructure. Drawing molecule without highlighting.")
                AllChem.Compute2DCoords(mol)
                img = Draw.MolToImage(mol, size=(500, 400))
                img.save(args.output)
            else:
                draw_highlighted_molecule(mol, scaffold_atoms, rgroup_atoms, args.output,
                                          title="Scaffold (blue) / R-groups (red)")
            print(f"Saved to {args.output}")
    else:
        # Simple scaffold highlighting mode
        scaffold_atoms, rgroup_atoms = find_scaffold_atoms(mol, scaffold)

        if scaffold_atoms is None:
            print(f"Warning: Scaffold '{scaffold_smiles}' not found as a substructure of the input molecule.")
            print("Drawing molecule without highlighting.")
            AllChem.Compute2DCoords(mol)
            ext = os.path.splitext(args.output)[1].lower()
            if ext == ".svg":
                drawer = rdMolDraw2D.MolDraw2DSVG(500, 400)
            else:
                drawer = rdMolDraw2D.MolDraw2DCairo(500, 400)
            drawer.drawOptions().clearBackground = True
            drawer.DrawMolecule(mol)
            drawer.FinishDrawing()
            if ext == ".svg":
                with open(args.output, "w") as f:
                    f.write(drawer.GetDrawingText())
            else:
                with open(args.output, "wb") as f:
                    f.write(drawer.GetDrawingText())
        else:
            draw_highlighted_molecule(
                mol, scaffold_atoms, rgroup_atoms, args.output,
                title="Scaffold (blue) / R-groups (red)"
            )

            n_rgroup_positions = 0
            scaffold_set = set(scaffold_atoms)
            for idx in rgroup_atoms:
                atom = mol.GetAtomWithIdx(idx)
                for neighbor in atom.GetNeighbors():
                    if neighbor.GetIdx() in scaffold_set:
                        n_rgroup_positions += 1
                        break

            print(f"Scaffold SMILES: {scaffold_smiles}")
            print(f"Scaffold atoms: {len(scaffold_atoms)}")
            print(f"R-group atoms: {len(rgroup_atoms)}")
            print(f"R-group attachment positions: {n_rgroup_positions}")

        print(f"Saved to {args.output}")


if __name__ == "__main__":
    main()
