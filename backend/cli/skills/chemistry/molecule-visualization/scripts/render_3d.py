#!/usr/bin/env python3
"""
render_3d.py - Generate interactive 3D molecular viewers as self-contained HTML files.

Creates standalone HTML files with embedded py3Dmol JavaScript viewers that
can be opened in any modern web browser. Supports proteins (PDB), small
molecules (SDF/SMILES), protein-ligand complexes, pocket visualization,
and multi-pose docking results.

Usage:
    python render_3d.py --input protein.pdb --output view.html --style cartoon --color chain
    python render_3d.py --input ligand.sdf --output ligand.html --style stick
    python render_3d.py --input protein.pdb --ligand ligand.sdf --output complex.html
    python render_3d.py --input "c1ccccc1" --output benzene.html --style sphere
    python render_3d.py --input protein.pdb --pockets pockets.json --mode pockets --output pockets.html
    python render_3d.py --input protein.pdb --poses poses.sdf --mode docking-results --output docking.html
"""

import argparse
import json
import os
import sys

try:
    from rdkit import Chem
    from rdkit.Chem import AllChem
except ImportError:
    Chem = None

# CDN URL for py3Dmol JavaScript library
PY3DMOL_CDN = "https://3dmol.csb.pitt.edu/build/3Dmol-min.js"


def read_file_content(file_path):
    """Read the entire content of a file as a string."""
    with open(file_path, "r") as f:
        return f.read()


def smiles_to_sdf_block(smiles):
    """
    Convert a SMILES string to an SDF block with 3D coordinates.

    Uses RDKit to generate 3D coordinates via ETKDG embedding.
    """
    if Chem is None:
        print("Error: RDKit is required to convert SMILES to 3D. Install with: pip install rdkit-pypi",
              file=sys.stderr)
        sys.exit(1)

    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        print(f"Error: Could not parse SMILES: {smiles}", file=sys.stderr)
        sys.exit(1)

    mol = Chem.AddHs(mol)

    # Generate 3D coordinates
    params = AllChem.ETKDGv3()
    params.randomSeed = 42
    result = AllChem.EmbedMolecule(mol, params)
    if result != 0:
        # Fallback: try without ETKDG constraints
        result = AllChem.EmbedMolecule(mol, randomSeed=42)
        if result != 0:
            print("Warning: Could not generate 3D coordinates. Using 2D layout.", file=sys.stderr)
            AllChem.Compute2DCoords(mol)

    # Optimize geometry
    try:
        AllChem.MMFFOptimizeMolecule(mol, maxIters=500)
    except Exception:
        try:
            AllChem.UFFOptimizeMolecule(mol, maxIters=500)
        except Exception:
            pass

    sdf_block = Chem.MolToMolBlock(mol)
    return sdf_block


def detect_input_type(input_path):
    """
    Detect whether the input is a PDB file, SDF file, or SMILES string.

    Returns one of: 'pdb', 'sdf', 'smiles'.
    """
    if os.path.isfile(input_path):
        ext = os.path.splitext(input_path)[1].lower()
        if ext == ".pdb":
            return "pdb"
        elif ext in (".sdf", ".mol", ".mol2"):
            return "sdf"
        else:
            # Try to guess from content
            with open(input_path, "r") as f:
                first_lines = f.read(500)
            if "ATOM" in first_lines or "HETATM" in first_lines:
                return "pdb"
            return "sdf"
    else:
        # Assume SMILES string
        return "smiles"


def load_pockets(pockets_path):
    """Load pocket data from a pockets/druggability JSON file."""
    with open(pockets_path) as f:
        data = json.load(f)
    return data.get("pockets", [])


def build_pockets_js(protein_data, pockets, width=800, height=600,
                     highlight_residues=None):
    """
    Build JS for pocket visualization: protein + colored spheres at pocket centers.

    Pocket spheres are colored by druggability:
      druggable (>0.7) = green, difficult (0.4-0.7) = orange, undruggable (<0.4) = red
    """
    js = []
    js.append(f"  var viewer = $3Dmol.createViewer('viewer', {{")
    js.append(f"    defaultcolors: $3Dmol.rasmolElementColors,")
    js.append(f"    width: {width}, height: {height}, backgroundColor: 'white'")
    js.append(f"  }});")
    js.append("")

    escaped = protein_data.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${")
    js.append(f"  var protein = `{escaped}`;")
    js.append(f"  viewer.addModel(protein, 'pdb');")
    js.append(f"  viewer.setStyle({{model: 0}}, {{cartoon: {{color: 'spectrum', opacity: 0.8}}}});")
    js.append("")

    # Add pocket center spheres
    for i, pocket in enumerate(pockets):
        center = pocket.get("center", [0, 0, 0])
        score = pocket.get("druggability_score", 0.5)
        volume = pocket.get("volume_A3", pocket.get("properties", {}).get("volume_A3", 300))
        rank = pocket.get("rank", i + 1)

        # Color by druggability
        if score > 0.7:
            color = "'green'"
        elif score > 0.4:
            color = "'orange'"
        else:
            color = "'red'"

        # Sphere radius proportional to pocket volume (capped)
        radius = min(max((volume / 300) ** 0.33 * 3, 1.5), 6.0)

        js.append(f"  // Pocket {rank} (druggability: {score:.2f}, volume: {volume:.0f} A^3)")
        js.append(f"  viewer.addSphere({{center: {{x: {center[0]:.1f}, y: {center[1]:.1f}, z: {center[2]:.1f}}}, radius: {radius:.1f}, color: {color}, opacity: 0.5}});")
        js.append(f"  viewer.addLabel('P{rank} ({score:.2f})', {{position: {{x: {center[0]:.1f}, y: {center[1]:.1f}, z: {center[2]:.1f}}}, backgroundColor: {color}, fontColor: 'white', fontSize: 14}});")
        js.append("")

    # Highlight residues if specified
    if highlight_residues:
        for res in highlight_residues:
            js.append(f"  viewer.setStyle({{resi: '{res}'}}, {{stick: {{colorscheme: 'default', radius: 0.15}}, cartoon: {{color: 'spectrum', opacity: 0.8}}}});")

    js.append("  viewer.zoomTo();")
    js.append("  viewer.render();")
    js.append("")
    js.append("  viewer.setClickable({}, true, function(atom, viewer, event, container) {")
    js.append("    if (atom) {")
    js.append("      viewer.addLabel(atom.resn + ' ' + atom.resi + ' : ' + atom.atom,")
    js.append("        {position: atom, backgroundColor: 'black', fontColor: 'white', fontSize: 12});")
    js.append("    }")
    js.append("  });")

    return "\n".join(js)


def build_docking_results_js(protein_data, poses_data, width=800, height=600, top_n=5):
    """
    Build JS for docking results: protein + top N poses colored green→red by rank.
    """
    js = []
    js.append(f"  var viewer = $3Dmol.createViewer('viewer', {{")
    js.append(f"    defaultcolors: $3Dmol.rasmolElementColors,")
    js.append(f"    width: {width}, height: {height}, backgroundColor: 'white'")
    js.append(f"  }});")
    js.append("")

    # Add protein
    escaped_prot = protein_data.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${")
    js.append(f"  var protein = `{escaped_prot}`;")
    js.append(f"  viewer.addModel(protein, 'pdb');")
    js.append(f"  viewer.setStyle({{model: 0}}, {{cartoon: {{color: 'spectrum', opacity: 0.7}}}});")
    js.append("")

    # Split SDF into individual molecules
    js.append(f"  var posesData = `{poses_data.replace(chr(92), chr(92)+chr(92)).replace(chr(96), chr(92)+chr(96)).replace('${', chr(92)+'${')}`;")
    js.append(f"  var molecules = posesData.split('$$$$');")
    js.append(f"  var nPoses = Math.min(molecules.length - 1, {top_n});")
    js.append("")

    # Color gradient: green (rank 1) → yellow → red (rank N)
    js.append("  var colors = ['#00aa00', '#44bb00', '#88cc00', '#ccaa00', '#ee6600', '#ff3300', '#cc0000', '#990000'];")
    js.append("  for (var p = 0; p < nPoses; p++) {")
    js.append("    if (molecules[p].trim().length === 0) continue;")
    js.append("    var molData = molecules[p] + '\\n$$$$\\n';")
    js.append("    viewer.addModel(molData, 'sdf');")
    js.append("    var colorIdx = Math.min(p, colors.length - 1);")
    js.append("    viewer.setStyle({model: p + 1}, {stick: {color: colors[colorIdx], radius: 0.15}});")
    js.append("    // Label first pose")
    js.append("    if (p === 0) {")
    js.append("      viewer.addSurface($3Dmol.SurfaceType.VDW, {opacity: 0.2, color: '#00aa00'}, {model: 1});")
    js.append("    }")
    js.append("  }")
    js.append("")

    js.append("  viewer.zoomTo();")
    js.append("  viewer.render();")
    js.append("")
    js.append("  viewer.setClickable({}, true, function(atom, viewer, event, container) {")
    js.append("    if (atom) {")
    js.append("      viewer.addLabel(atom.resn + ' ' + atom.resi + ' : ' + atom.atom,")
    js.append("        {position: atom, backgroundColor: 'black', fontColor: 'white', fontSize: 12});")
    js.append("    }")
    js.append("  });")

    return "\n".join(js)


def build_viewer_js(data_blocks, style="cartoon", color="chain",
                    width=800, height=600, has_ligand=False):
    """
    Build the JavaScript code for the py3Dmol viewer.

    Parameters
    ----------
    data_blocks : list of dict
        Each dict: {data, format, role} where role is 'protein', 'ligand', or 'molecule'.
    style : str
        Visualization style: cartoon, stick, sphere, surface.
    color : str
        Coloring scheme: chain, element, bfactor, spectrum.
    width : int
        Viewer width in pixels.
    height : int
        Viewer height in pixels.
    has_ligand : bool
        If True, a separate ligand is overlaid on a protein.

    Returns
    -------
    str
        JavaScript code for the viewer.
    """
    js_lines = []
    js_lines.append(f"  var viewer = $3Dmol.createViewer('viewer', {{")
    js_lines.append(f"    defaultcolors: $3Dmol.rasmolElementColors,")
    js_lines.append(f"    width: {width},")
    js_lines.append(f"    height: {height},")
    js_lines.append(f"    backgroundColor: 'white'")
    js_lines.append(f"  }});")
    js_lines.append("")

    for i, block in enumerate(data_blocks):
        data_var = f"data_{i}"
        # Escape the data for JavaScript string
        escaped_data = block["data"].replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${")
        js_lines.append(f"  var {data_var} = `{escaped_data}`;")
        js_lines.append(f"  viewer.addModel({data_var}, '{block['format']}');")
        js_lines.append("")

        role = block.get("role", "molecule")

        if has_ligand and role == "protein":
            # Protein in complex mode: cartoon with chain coloring
            js_lines.append(f"  // Protein representation")
            if color == "chain":
                js_lines.append(f"  viewer.setStyle({{model: {i}}}, {{cartoon: {{color: 'spectrum'}}}});")
            elif color == "bfactor":
                js_lines.append(f"  viewer.setStyle({{model: {i}}}, {{cartoon: {{colorscheme: {{prop: 'b', gradient: 'rwb', min: 0, max: 100}}}}}});")
            elif color == "element":
                js_lines.append(f"  viewer.setStyle({{model: {i}}}, {{cartoon: {{colorscheme: 'default'}}}});")
            else:
                js_lines.append(f"  viewer.setStyle({{model: {i}}}, {{cartoon: {{color: 'spectrum'}}}});")

        elif has_ligand and role == "ligand":
            # Ligand in complex mode: sticks with element coloring + transparent surface
            js_lines.append(f"  // Ligand representation")
            js_lines.append(f"  viewer.setStyle({{model: {i}}}, {{stick: {{colorscheme: 'default', radius: 0.2}}}});")
            js_lines.append(f"  // Transparent surface around ligand binding site")
            js_lines.append(f"  viewer.addSurface($3Dmol.SurfaceType.VDW, {{opacity: 0.3, color: 'lightblue'}}, {{model: {i}}});")

        else:
            # Single molecule or standalone protein/ligand
            if style == "cartoon":
                if color == "chain":
                    js_lines.append(f"  viewer.setStyle({{model: {i}}}, {{cartoon: {{color: 'spectrum'}}}});")
                elif color == "bfactor":
                    js_lines.append(f"  viewer.setStyle({{model: {i}}}, {{cartoon: {{colorscheme: {{prop: 'b', gradient: 'rwb', min: 0, max: 100}}}}}});")
                elif color == "spectrum":
                    js_lines.append(f"  viewer.setStyle({{model: {i}}}, {{cartoon: {{color: 'spectrum'}}}});")
                else:
                    js_lines.append(f"  viewer.setStyle({{model: {i}}}, {{cartoon: {{colorscheme: 'default'}}}});")

            elif style == "stick":
                js_lines.append(f"  viewer.setStyle({{model: {i}}}, {{stick: {{colorscheme: 'default', radius: 0.15}}}});")

            elif style == "sphere":
                js_lines.append(f"  viewer.setStyle({{model: {i}}}, {{sphere: {{colorscheme: 'default', scale: 0.3}}}});")

            elif style == "surface":
                js_lines.append(f"  viewer.setStyle({{model: {i}}}, {{stick: {{colorscheme: 'default', radius: 0.1}}}});")
                js_lines.append(f"  viewer.addSurface($3Dmol.SurfaceType.VDW, {{opacity: 0.8, colorscheme: 'default'}}, {{model: {i}}});")

            else:
                # Default to stick
                js_lines.append(f"  viewer.setStyle({{model: {i}}}, {{stick: {{colorscheme: 'default'}}}});")

        js_lines.append("")

    js_lines.append("  viewer.zoomTo();")
    js_lines.append("  viewer.render();")
    js_lines.append("")
    js_lines.append("  // Enable zoom and rotate (built-in with mouse/touch)")
    js_lines.append("  viewer.setClickable({}, true, function(atom, viewer, event, container) {")
    js_lines.append("    if (atom) {")
    js_lines.append("      viewer.addLabel(atom.resn + ' ' + atom.resi + ' : ' + atom.atom,")
    js_lines.append("        {position: atom, backgroundColor: 'black', fontColor: 'white', fontSize: 12});")
    js_lines.append("    }")
    js_lines.append("  });")

    return "\n".join(js_lines)


def generate_html(viewer_js, width=800, height=600, title="3D Molecular Viewer"):
    """
    Generate a self-contained HTML file with the embedded py3Dmol viewer.

    Parameters
    ----------
    viewer_js : str
        JavaScript code for setting up the viewer.
    width : int
        Viewer width in pixels.
    height : int
        Viewer height in pixels.
    title : str
        Page title.

    Returns
    -------
    str
        Complete HTML content.
    """
    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{title}</title>
    <script src="{PY3DMOL_CDN}"></script>
    <style>
        * {{
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }}
        body {{
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background-color: #f5f5f5;
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 20px;
        }}
        h1 {{
            font-size: 18px;
            color: #333;
            margin-bottom: 12px;
        }}
        #viewer {{
            width: {width}px;
            height: {height}px;
            border: 1px solid #ccc;
            border-radius: 4px;
            background-color: white;
            position: relative;
        }}
        .controls {{
            margin-top: 12px;
            font-size: 13px;
            color: #666;
        }}
        .controls kbd {{
            display: inline-block;
            padding: 2px 6px;
            font-size: 11px;
            background-color: #eee;
            border: 1px solid #ccc;
            border-radius: 3px;
            font-family: monospace;
        }}
    </style>
</head>
<body>
    <h1>{title}</h1>
    <div id="viewer"></div>
    <div class="controls">
        <kbd>Left-click + drag</kbd> Rotate &nbsp;
        <kbd>Scroll</kbd> Zoom &nbsp;
        <kbd>Right-click + drag</kbd> Translate &nbsp;
        <kbd>Click atom</kbd> Show label
    </div>
    <script>
    $(document).ready(function() {{
{viewer_js}
    }});
    </script>
</body>
</html>"""
    return html


def main():
    parser = argparse.ArgumentParser(
        description="Generate an interactive 3D molecular viewer as a self-contained HTML file.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s --input protein.pdb --output view.html --style cartoon --color chain
  %(prog)s --input ligand.sdf --output ligand.html --style stick --color element
  %(prog)s --input protein.pdb --ligand ligand.sdf --output complex.html
  %(prog)s --input "c1ccccc1" --output benzene.html --style sphere
        """,
    )
    parser.add_argument(
        "--input", required=True,
        help="Input file (PDB, SDF) or SMILES string."
    )
    parser.add_argument(
        "--output", required=True,
        help="Output HTML file path."
    )
    parser.add_argument(
        "--style", default="cartoon",
        choices=["cartoon", "stick", "sphere", "surface"],
        help="Visualization style (default: cartoon)."
    )
    parser.add_argument(
        "--color", default="chain",
        choices=["chain", "element", "bfactor", "spectrum"],
        help="Coloring scheme (default: chain)."
    )
    parser.add_argument(
        "--ligand", default=None,
        help="Optional ligand SDF file to overlay on the protein."
    )
    parser.add_argument(
        "--pockets", default=None,
        help="Pocket JSON file (from pocket-detection/detect.py or druggability.py). "
             "Used with --mode pockets to visualize pocket centers on the protein."
    )
    parser.add_argument(
        "--poses", default=None,
        help="Multi-pose SDF file (from dock.py). "
             "Used with --mode docking-results to overlay ranked poses on the protein."
    )
    parser.add_argument(
        "--mode", default=None,
        choices=["protein", "complex", "pockets", "docking-results"],
        help="Visualization mode. If not specified, auto-detected from inputs."
    )
    parser.add_argument(
        "--highlight-residues", default=None,
        help="Comma-separated residue numbers to highlight as sticks (e.g., '189,195,57')."
    )
    parser.add_argument(
        "--top-n", type=int, default=5,
        help="Number of top poses to show in docking-results mode (default: 5)."
    )
    parser.add_argument(
        "--width", type=int, default=800,
        help="Viewer width in pixels (default: 800)."
    )
    parser.add_argument(
        "--height", type=int, default=600,
        help="Viewer height in pixels (default: 600)."
    )

    args = parser.parse_args()

    # Auto-detect mode if not specified
    if args.mode is None:
        if args.pockets:
            args.mode = "pockets"
        elif args.poses:
            args.mode = "docking-results"
        elif args.ligand:
            args.mode = "complex"
        else:
            args.mode = "protein"

    # Ensure output directory exists
    out_dir = os.path.dirname(args.output)
    if out_dir and not os.path.exists(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    # Parse highlight residues
    highlight_residues = None
    if args.highlight_residues:
        highlight_residues = [r.strip() for r in args.highlight_residues.split(",")]

    # Handle pocket and docking-results modes separately
    if args.mode == "pockets":
        if not args.pockets:
            print("Error: --pockets is required for pockets mode", file=sys.stderr)
            sys.exit(1)
        protein_data = read_file_content(args.input)
        pockets = load_pockets(args.pockets)
        print(f"Loaded protein from {args.input}")
        print(f"Loaded {len(pockets)} pockets from {args.pockets}")

        viewer_js = build_pockets_js(
            protein_data, pockets,
            width=args.width, height=args.height,
            highlight_residues=highlight_residues,
        )
        page_title = f"{os.path.basename(args.input)} — {len(pockets)} Binding Pockets"
        html = generate_html(viewer_js, width=args.width, height=args.height, title=page_title)

        with open(args.output, "w") as f:
            f.write(html)
        print(f"Pocket view saved to {args.output} -- open in browser to interact")
        return

    if args.mode == "docking-results":
        if not args.poses:
            print("Error: --poses is required for docking-results mode", file=sys.stderr)
            sys.exit(1)
        protein_data = read_file_content(args.input)
        poses_data = read_file_content(args.poses)
        n_poses = poses_data.count("$$$$")
        print(f"Loaded protein from {args.input}")
        print(f"Loaded {n_poses} poses from {args.poses}")

        viewer_js = build_docking_results_js(
            protein_data, poses_data,
            width=args.width, height=args.height,
            top_n=args.top_n,
        )
        page_title = f"{os.path.basename(args.input)} — Top {min(n_poses, args.top_n)} Docking Poses"
        html = generate_html(viewer_js, width=args.width, height=args.height, title=page_title)

        with open(args.output, "w") as f:
            f.write(html)
        print(f"Docking results view saved to {args.output} -- open in browser to interact")
        return

    # Original modes: protein and complex
    data_blocks = []
    has_ligand = args.ligand is not None

    # Process main input
    input_type = detect_input_type(args.input)

    if input_type == "pdb":
        data = read_file_content(args.input)
        role = "protein" if has_ligand else "molecule"
        data_blocks.append({"data": data, "format": "pdb", "role": role})
        print(f"Loaded protein from {args.input} ({len(data.splitlines())} lines)")

    elif input_type == "sdf":
        data = read_file_content(args.input)
        role = "molecule"
        data_blocks.append({"data": data, "format": "sdf", "role": role})
        print(f"Loaded molecule from {args.input}")

    elif input_type == "smiles":
        sdf_block = smiles_to_sdf_block(args.input)
        data_blocks.append({"data": sdf_block, "format": "sdf", "role": "molecule"})
        print(f"Converted SMILES to 3D: {args.input}")

    # Process optional ligand overlay
    if has_ligand:
        if not os.path.exists(args.ligand):
            print(f"Error: Ligand file not found: {args.ligand}", file=sys.stderr)
            sys.exit(1)
        lig_data = read_file_content(args.ligand)
        data_blocks.append({"data": lig_data, "format": "sdf", "role": "ligand"})
        print(f"Loaded ligand overlay from {args.ligand}")

    # Build viewer JavaScript
    viewer_js = build_viewer_js(
        data_blocks=data_blocks,
        style=args.style,
        color=args.color,
        width=args.width,
        height=args.height,
        has_ligand=has_ligand,
    )

    # Generate and save HTML
    title_parts = []
    if input_type == "pdb":
        title_parts.append(os.path.basename(args.input))
    elif input_type == "sdf":
        title_parts.append(os.path.basename(args.input))
    else:
        title_parts.append("Molecule")
    if has_ligand:
        title_parts.append(f"+ {os.path.basename(args.ligand)}")
    page_title = " ".join(title_parts)

    html = generate_html(viewer_js, width=args.width, height=args.height, title=page_title)

    with open(args.output, "w") as f:
        f.write(html)

    print(f"3D view saved to {args.output} -- open in browser to interact")


if __name__ == "__main__":
    main()
