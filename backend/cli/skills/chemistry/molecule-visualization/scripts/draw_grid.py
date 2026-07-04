#!/usr/bin/env python3
"""
draw_grid.py - Generate a grid layout of multiple molecules with optional property annotations.

Creates a single image showing multiple molecules in a grid layout. Input can be
a CSV file with 'name' and 'smiles' columns (and optional property columns) or
a comma-separated list of SMILES strings.

Usage:
    python draw_grid.py --input compounds.csv --output grid.png --properties "qed,mw,logp"
    python draw_grid.py --input "c1ccccc1,c1ccncc1,c1ccoc1" --output rings.png --cols 3
"""

import argparse
import csv
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
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print("Error: Pillow is required. Install with: pip install pillow", file=sys.stderr)
    sys.exit(1)

try:
    import io
except ImportError:
    pass


def parse_size(size_str):
    """Parse a size string like '300x250' into (width, height)."""
    try:
        parts = size_str.lower().split("x")
        return int(parts[0]), int(parts[1])
    except (ValueError, IndexError):
        print(f"Warning: Invalid size '{size_str}', using default 300x250.", file=sys.stderr)
        return 300, 250


def load_molecules_from_csv(csv_path, properties=None, max_mols=20):
    """
    Load molecules from a CSV file.

    Expects columns 'name' and 'smiles'. Additional columns can be used
    for property annotations.

    Returns a list of dicts with keys: name, smiles, mol, properties.
    """
    molecules = []
    if not os.path.exists(csv_path):
        print(f"Error: File not found: {csv_path}", file=sys.stderr)
        sys.exit(1)

    with open(csv_path, "r", newline="") as f:
        reader = csv.DictReader(f)
        headers = reader.fieldnames
        if headers is None:
            print("Error: CSV file is empty or has no headers.", file=sys.stderr)
            sys.exit(1)

        # Normalize header names to lowercase for lookup
        header_map = {h.lower().strip(): h for h in headers}

        smiles_col = header_map.get("smiles", None)
        name_col = header_map.get("name", None)

        if smiles_col is None:
            print("Error: CSV must have a 'smiles' column.", file=sys.stderr)
            sys.exit(1)

        for i, row in enumerate(reader):
            if len(molecules) >= max_mols:
                break

            smi = row.get(smiles_col, "").strip()
            name = row.get(name_col, f"Mol_{i+1}").strip() if name_col else f"Mol_{i+1}"

            mol = Chem.MolFromSmiles(smi) if smi else None
            if mol:
                AllChem.Compute2DCoords(mol)

            # Extract requested properties
            props = {}
            if properties:
                for prop_name in properties:
                    prop_key = header_map.get(prop_name.lower().strip(), None)
                    if prop_key and prop_key in row:
                        props[prop_name] = row[prop_key]

            molecules.append({
                "name": name,
                "smiles": smi,
                "mol": mol,
                "properties": props,
            })

    return molecules


def load_molecules_from_smiles_list(smiles_str, max_mols=20):
    """
    Load molecules from a comma-separated SMILES string.

    Returns a list of dicts with keys: name, smiles, mol, properties.
    """
    molecules = []
    smiles_list = [s.strip() for s in smiles_str.split(",") if s.strip()]

    for i, smi in enumerate(smiles_list[:max_mols]):
        mol = Chem.MolFromSmiles(smi)
        if mol:
            AllChem.Compute2DCoords(mol)
        molecules.append({
            "name": f"Mol_{i+1}",
            "smiles": smi,
            "mol": mol,
            "properties": {},
        })

    return molecules


def draw_single_cell(mol, name, properties, cell_w, cell_h):
    """
    Draw a single molecule cell and return as a PIL Image.

    The cell contains the 2D structure, molecule name, and property annotations.
    """
    # Reserve space for text below the structure
    text_lines = []
    if name:
        text_lines.append(name)
    for prop_name, prop_val in properties.items():
        text_lines.append(f"{prop_name}: {prop_val}")

    text_height = max(len(text_lines) * 16 + 8, 24)
    draw_h = max(cell_h - text_height, 80)

    # Draw molecule using rdMolDraw2D
    if mol is not None:
        drawer = rdMolDraw2D.MolDraw2DCairo(cell_w, draw_h)
        opts = drawer.drawOptions()
        opts.clearBackground = True
        opts.bondLineWidth = 1.5
        opts.fixedBondLength = 25
        drawer.DrawMolecule(mol)
        drawer.FinishDrawing()
        png_data = drawer.GetDrawingText()
        mol_img = Image.open(io.BytesIO(png_data)).convert("RGBA")
    else:
        # Create blank cell with error message
        mol_img = Image.new("RGBA", (cell_w, draw_h), (255, 255, 255, 255))
        d = ImageDraw.Draw(mol_img)
        try:
            font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 11)
        except (IOError, OSError):
            font = ImageFont.load_default()
        d.text((cell_w // 2 - 40, draw_h // 2 - 8), "Invalid SMILES", fill=(200, 0, 0), font=font)

    # Create full cell image
    cell_img = Image.new("RGBA", (cell_w, cell_h), (255, 255, 255, 255))
    cell_img.paste(mol_img, (0, 0))

    # Draw text labels
    d = ImageDraw.Draw(cell_img)
    try:
        font_name = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 12)
        font_prop = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 10)
    except (IOError, OSError):
        font_name = ImageFont.load_default()
        font_prop = ImageFont.load_default()

    y_cursor = draw_h + 2
    for j, line in enumerate(text_lines):
        fnt = font_name if j == 0 else font_prop
        color = (0, 0, 0) if j == 0 else (80, 80, 80)
        # Center the text
        try:
            bbox = d.textbbox((0, 0), line, font=fnt)
            tw = bbox[2] - bbox[0]
        except AttributeError:
            tw = len(line) * 7
        x_text = max((cell_w - tw) // 2, 4)
        d.text((x_text, y_cursor), line, fill=color, font=fnt)
        y_cursor += 16

    # Draw a thin border around the cell
    d.rectangle([(0, 0), (cell_w - 1, cell_h - 1)], outline=(220, 220, 220), width=1)

    return cell_img


def draw_grid(molecules, output_path, cols=4, cell_w=300, cell_h=250,
              title=None, is_svg=False):
    """
    Assemble molecule cells into a grid image and save.

    Parameters
    ----------
    molecules : list of dict
        Each dict has keys: name, smiles, mol, properties.
    output_path : str
        Output file path (.png or .svg).
    cols : int
        Number of columns in the grid.
    cell_w : int
        Width of each cell in pixels.
    cell_h : int
        Height of each cell in pixels.
    title : str or None
        Optional title for the entire grid.
    is_svg : bool
        Whether to output SVG (currently generates PNG; SVG requires alternative approach).
    """
    n = len(molecules)
    if n == 0:
        print("Error: No molecules to draw.", file=sys.stderr)
        sys.exit(1)

    # Auto-adjust columns if fewer molecules than cols
    cols = min(cols, n)
    rows = (n + cols - 1) // cols

    # Title space
    title_h = 40 if title else 0

    # Total image size
    total_w = cols * cell_w
    total_h = rows * cell_h + title_h

    grid_img = Image.new("RGBA", (total_w, total_h), (255, 255, 255, 255))

    # Draw title
    if title:
        d = ImageDraw.Draw(grid_img)
        try:
            font_title = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 16)
        except (IOError, OSError):
            font_title = ImageFont.load_default()
        try:
            bbox = d.textbbox((0, 0), title, font=font_title)
            tw = bbox[2] - bbox[0]
        except AttributeError:
            tw = len(title) * 10
        x_title = max((total_w - tw) // 2, 4)
        d.text((x_title, 10), title, fill=(0, 0, 0), font=font_title)

    # Draw each molecule cell
    for i, mol_data in enumerate(molecules):
        row = i // cols
        col = i % cols

        cell_img = draw_single_cell(
            mol=mol_data["mol"],
            name=mol_data["name"],
            properties=mol_data["properties"],
            cell_w=cell_w,
            cell_h=cell_h,
        )
        grid_img.paste(cell_img, (col * cell_w, title_h + row * cell_h))

    # Save output
    if is_svg:
        # For SVG output, we save as PNG and notify user
        # True SVG grid would require composing individual SVGs
        png_path = output_path.rsplit(".", 1)[0] + ".png"
        grid_img.save(png_path, "PNG", dpi=(300, 300))
        print(f"Note: Grid saved as PNG ({png_path}). For SVG grids, generate individual SVGs with draw_2d.py.")
        output_path = png_path
    else:
        grid_img.save(output_path, "PNG", dpi=(300, 300))

    return output_path


def main():
    parser = argparse.ArgumentParser(
        description="Generate a grid layout of multiple molecules with property annotations.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s --input compounds.csv --output grid.png --cols 4 --properties "qed,mw,logp"
  %(prog)s --input "c1ccccc1,c1ccncc1,c1ccoc1" --output rings.png --cols 3 --title "Rings"
        """,
    )
    parser.add_argument(
        "--input", required=True,
        help="CSV file path (with 'name','smiles' columns) or comma-separated SMILES strings."
    )
    parser.add_argument(
        "--output", required=True,
        help="Output image file path (.png or .svg)."
    )
    parser.add_argument(
        "--cols", type=int, default=4,
        help="Number of columns in the grid (default: 4)."
    )
    parser.add_argument(
        "--size-per-mol", default="300x250",
        help="Size of each molecule cell as WIDTHxHEIGHT (default: 300x250)."
    )
    parser.add_argument(
        "--properties", default=None,
        help="Comma-separated property column names from CSV to display (e.g., 'qed,mw,logp')."
    )
    parser.add_argument(
        "--title", default=None,
        help="Optional title displayed at the top of the grid."
    )
    parser.add_argument(
        "--max-mols", type=int, default=20,
        help="Maximum number of molecules to display (default: 20)."
    )

    args = parser.parse_args()

    # Parse cell size
    cell_w, cell_h = parse_size(args.size_per_mol)

    # Parse properties list
    properties = None
    if args.properties:
        properties = [p.strip() for p in args.properties.split(",") if p.strip()]

    # Determine if input is a CSV file or a SMILES list
    is_csv = os.path.isfile(args.input)

    if is_csv:
        molecules = load_molecules_from_csv(args.input, properties=properties, max_mols=args.max_mols)
    else:
        molecules = load_molecules_from_smiles_list(args.input, max_mols=args.max_mols)

    if not molecules:
        print("Error: No molecules found in input.", file=sys.stderr)
        sys.exit(1)

    # Ensure output directory exists
    out_dir = os.path.dirname(args.output)
    if out_dir and not os.path.exists(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    # Determine output format
    ext = os.path.splitext(args.output)[1].lower()
    is_svg = ext == ".svg"

    final_path = draw_grid(
        molecules=molecules,
        output_path=args.output,
        cols=args.cols,
        cell_w=cell_w,
        cell_h=cell_h,
        title=args.title,
        is_svg=is_svg,
    )

    valid_count = sum(1 for m in molecules if m["mol"] is not None)
    invalid_count = len(molecules) - valid_count

    print(f"Grid of {len(molecules)} molecules saved to {final_path}")
    if invalid_count > 0:
        print(f"Warning: {invalid_count} molecule(s) could not be parsed and appear as blank cells.")


if __name__ == "__main__":
    main()
