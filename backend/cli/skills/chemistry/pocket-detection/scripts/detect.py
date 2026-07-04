#!/usr/bin/env python3
"""
Multi-method binding pocket detection.

Detects binding pockets on protein structures using grid-based cavity scan,
fpocket (alpha spheres), or P2Rank (machine learning). Outputs a JSON file
compatible with dock.py auto-discovery.

Usage:
    python detect.py --input protein.pdb --output pockets.json
    python detect.py --input protein.pdb --output pockets.json --method fpocket
    python detect.py --input protein.pdb --output pockets.json --method auto
"""

import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
import warnings
from collections import defaultdict

from output_guard import validate_output_path, log_to_manifest

warnings.filterwarnings("ignore")

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------

try:
    from Bio.PDB import PDBParser, NeighborSearch
    from Bio.PDB.Polypeptide import is_aa
except ImportError:
    sys.exit("ERROR: BioPython is required. Install with: pip install biopython")

try:
    import numpy as np
except ImportError:
    sys.exit("ERROR: NumPy is required. Install with: pip install numpy")

try:
    from scipy.spatial import ConvexHull
    HAS_CONVEX_HULL = True
except ImportError:
    HAS_CONVEX_HULL = False

try:
    from scipy.cluster.hierarchy import fcluster, linkage
    HAS_SCIPY_CLUSTER = True
except ImportError:
    HAS_SCIPY_CLUSTER = False

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

STANDARD_RESIDUES = {
    "ALA", "ARG", "ASN", "ASP", "CYS", "GLN", "GLU", "GLY", "HIS", "ILE",
    "LEU", "LYS", "MET", "PHE", "PRO", "SER", "THR", "TRP", "TYR", "VAL",
    "HID", "HIE", "HIP", "CYX", "ASH", "GLH",
}

WATER_RESIDUES = {"HOH", "WAT", "TIP", "TIP3", "SOL", "H2O"}


# ---------------------------------------------------------------------------
# Utility functions
# ---------------------------------------------------------------------------


def _get_protein_atoms(structure, chain_id=None):
    """Extract protein atom objects from the first model."""
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
                if (hetflag.startswith("H")
                        and resname not in WATER_RESIDUES
                        and resname not in STANDARD_RESIDUES):
                    resid = (chain.get_id(), residue.get_id())
                    for atom in residue:
                        ligand_groups[resid].append(
                            atom.get_vector().get_array()
                        )
        break
    centers = []
    for resid, coords in ligand_groups.items():
        arr = np.array(coords)
        centers.append({
            "chain": resid[0],
            "resid": str(resid[1][1]),
            "resname": resid[1][0] if isinstance(resid[1][0], str) else "",
            "center": arr.mean(axis=0),
            "n_atoms": len(coords),
        })
    return centers


def _residue_names_near(ns, center, radius=8.0):
    """Get sorted list of residue name+id strings near a center point."""
    nearby = ns.search(center, radius, level="R")
    names = []
    for res in nearby:
        resname = res.get_resname().strip()
        if resname in STANDARD_RESIDUES:
            names.append(f"{resname}{res.get_id()[1]}")
    return sorted(set(names))


# ---------------------------------------------------------------------------
# Grid-based detection (enhanced from prepare_target.py)
# ---------------------------------------------------------------------------


def _cluster_dbscan(points, eps=15.0, min_samples=5):
    """Cluster 3D points using scipy hierarchical clustering.

    Uses 'average' linkage — the merge distance is the mean pairwise distance
    between all points in two clusters.  This avoids chain-linking (single
    linkage) while still keeping elongated gorge-type pockets intact (complete
    linkage splits long gorges because the farthest pair exceeds eps).
    """
    if len(points) < min_samples:
        return []

    if HAS_SCIPY_CLUSTER:
        Z = linkage(points, method="average")
        labels = fcluster(Z, t=eps, criterion="distance")
        clusters = defaultdict(list)
        for i, label in enumerate(labels):
            clusters[label].append(points[i])
        return [v for v in clusters.values() if len(v) >= min_samples]

    # Fallback: greedy clustering (same as prepare_target.py)
    return _cluster_greedy(points, cluster_radius=eps, min_size=min_samples)


def _cluster_greedy(points, cluster_radius=3.5, min_size=5):
    """Simple greedy clustering fallback."""
    remaining = list(range(len(points)))
    clusters = []
    while remaining:
        seed_idx = remaining[0]
        seed = points[seed_idx]
        cluster = [seed]
        new_remaining = []
        for idx in remaining[1:]:
            if np.linalg.norm(points[idx] - seed) <= cluster_radius:
                cluster.append(points[idx])
            else:
                new_remaining.append(idx)
        if len(cluster) > 1:
            center = np.mean(cluster, axis=0)
            still_remaining = []
            for idx in new_remaining:
                if np.linalg.norm(points[idx] - center) <= cluster_radius * 1.5:
                    cluster.append(points[idx])
                else:
                    still_remaining.append(idx)
            new_remaining = still_remaining
        if len(cluster) >= min_size:
            clusters.append(cluster)
        remaining = new_remaining
    return clusters


def detect_grid(structure, chain_id=None, grid_spacing=1.0, min_volume=200,
                max_pockets=10, include_ligand_sites=False):
    """
    Grid-based cavity detection.

    Enhanced from prepare_target.py:
    - Hierarchical clustering instead of greedy for better pocket separation
    - Bounding box computation per pocket
    - Pocket depth estimation
    - Same 2M grid point limit for performance
    """
    atoms = _get_protein_atoms(structure, chain_id)
    if not atoms:
        return []

    coords = np.array([a.get_vector().get_array() for a in atoms])
    ns = NeighborSearch(atoms)

    # Build grid with margin
    margin = 6.0
    mins = coords.min(axis=0) - margin
    maxs = coords.max(axis=0) + margin

    xs = np.arange(mins[0], maxs[0], grid_spacing)
    ys = np.arange(mins[1], maxs[1], grid_spacing)
    zs = np.arange(mins[2], maxs[2], grid_spacing)

    # Limit grid size for performance (2M points max)
    total_points = len(xs) * len(ys) * len(zs)
    if total_points > 2_000_000:
        scale = (total_points / 2_000_000) ** (1 / 3)
        grid_spacing = grid_spacing * scale
        xs = np.arange(mins[0], maxs[0], grid_spacing)
        ys = np.arange(mins[1], maxs[1], grid_spacing)
        zs = np.arange(mins[2], maxs[2], grid_spacing)

    # van der Waals parameters
    vdw = 1.7
    inner_cutoff = vdw + 0.5
    outer_cutoff = vdw + 1.4 + 2.0  # probe_radius = 1.4

    # Narrow channel clearance: just outside van der Waals contact
    narrow_cutoff = vdw + 0.1  # 1.8 Å

    cavity_points = []
    for x in xs:
        for y in ys:
            for z in zs:
                point = np.array([x, y, z])
                # Inside protein → skip (but check for narrow channel)
                if ns.search(point, inner_cutoff, level="A"):
                    # Gorge detection: points between 1.8 Å and 2.2 Å from
                    # protein surface sit inside tight channels that the
                    # standard inner_cutoff excludes.
                    if not ns.search(point, narrow_cutoff, level="A"):
                        nearby_outer = ns.search(point, outer_cutoff, level="A")
                        if nearby_outer and len(nearby_outer) >= 4:
                            nearby_coords = np.array(
                                [a.get_vector().get_array()
                                 for a in nearby_outer]
                            )
                            relative = nearby_coords - point
                            # Tunnel geometry: protein on opposing sides
                            # of at least 2 axes
                            opposing = sum(
                                1 for d in range(3)
                                if (np.any(relative[:, d] > 1.5)
                                    and np.any(relative[:, d] < -1.5))
                            )
                            if opposing >= 2:
                                cavity_points.append(point)
                    continue
                # Bulk solvent → skip
                nearby_outer = ns.search(point, outer_cutoff, level="A")
                if not nearby_outer:
                    continue
                # Check buriedness via octant spread
                if len(nearby_outer) >= 4:
                    nearby_coords = np.array(
                        [a.get_vector().get_array() for a in nearby_outer]
                    )
                    relative = nearby_coords - point
                    octants = set(
                        tuple(s.astype(int))
                        for s in np.sign(relative)
                    )
                    if len(octants) >= 3:
                        cavity_points.append(point)

    if not cavity_points:
        return []

    cavity_points = np.array(cavity_points)

    # Cluster with average-linkage hierarchical clustering
    # Average linkage keeps elongated gorge-type pockets intact while still
    # separating distinct binding sites. min_samples=5 catches narrow channels.
    clusters = _cluster_dbscan(cavity_points, eps=15.0, min_samples=5)
    clusters.sort(key=lambda c: len(c), reverse=True)

    # Convert to pocket descriptions
    pockets = []
    for cluster in clusters[:max_pockets]:
        cluster_arr = np.array(cluster)
        center = cluster_arr.mean(axis=0)

        # Volume estimation
        volume = len(cluster) * (grid_spacing ** 3)
        if HAS_CONVEX_HULL and len(cluster) >= 4:
            try:
                hull = ConvexHull(cluster_arr)
                volume = hull.volume
            except Exception:
                pass

        if volume < min_volume:
            continue

        # Bounding box
        bbox_min = cluster_arr.min(axis=0).tolist()
        bbox_max = cluster_arr.max(axis=0).tolist()

        # Pocket depth: max distance from center to any cavity point
        distances = np.linalg.norm(cluster_arr - center, axis=1)
        depth = float(distances.max())

        # Shape analysis via PCA — classify cavity vs gorge
        if len(cluster) >= 4:
            centered = cluster_arr - center
            cov = np.cov(centered.T)
            eigenvalues = np.sort(np.linalg.eigvalsh(cov))[::-1]
            aspect_ratio = round(float(np.sqrt(
                eigenvalues[0] / max(eigenvalues[2], 0.01)
            )), 1)
            pocket_type = "gorge" if aspect_ratio > 2.5 else "cavity"
        else:
            aspect_ratio = 1.0
            pocket_type = "cavity"

        # Nearby residues
        residue_names = _residue_names_near(ns, center, radius=8.0)

        pockets.append({
            "rank": len(pockets) + 1,
            "source": "grid",
            "center": [round(c, 1) for c in center.tolist()],
            "volume_A3": round(volume, 1),
            "grid_volume_A3": round(len(cluster) * (grid_spacing ** 3), 1),
            "n_grid_points": len(cluster),
            "depth_A": round(depth, 1),
            "pocket_type": pocket_type,
            "aspect_ratio": aspect_ratio,
            "residues": residue_names,
            "n_residues": len(residue_names),
            "bbox_min": [round(c, 1) for c in bbox_min],
            "bbox_max": [round(c, 1) for c in bbox_max],
        })

    # Optionally add ligand-derived pockets
    if include_ligand_sites:
        ligand_centers = _find_hetatm_centers(structure, chain_id)
        for lc in ligand_centers:
            residue_names = _residue_names_near(ns, lc["center"], radius=8.0)
            pockets.append({
                "rank": len(pockets) + 1,
                "source": "co-crystallized_ligand",
                "center": [round(c, 1) for c in lc["center"].tolist()],
                "residues": residue_names,
                "n_residues": len(residue_names),
            })

    # Re-rank by volume (ligand-derived pockets go first if present)
    ligand_pockets = [p for p in pockets if p["source"] == "co-crystallized_ligand"]
    cavity_pockets = [p for p in pockets if p["source"] != "co-crystallized_ligand"]
    cavity_pockets.sort(key=lambda p: p.get("volume_A3", 0), reverse=True)
    ordered = ligand_pockets + cavity_pockets
    for i, p in enumerate(ordered):
        p["rank"] = i + 1

    return ordered


# ---------------------------------------------------------------------------
# fpocket wrapper
# ---------------------------------------------------------------------------


def detect_fpocket(input_pdb, max_pockets=10):
    """
    Detect pockets using fpocket (alpha sphere method).

    Requires the fpocket binary in PATH.
    """
    fpocket_bin = shutil.which("fpocket")
    if not fpocket_bin:
        print("ERROR: fpocket not found in PATH.")
        print("Install: sudo apt-get install fpocket (Linux) or brew install fpocket (macOS)")
        return None

    # fpocket needs to run in its own temp directory
    tmpdir = tempfile.mkdtemp(prefix="fpocket_")
    try:
        # Copy PDB to tmpdir (fpocket creates output next to input)
        tmp_pdb = os.path.join(tmpdir, "input.pdb")
        shutil.copy2(input_pdb, tmp_pdb)

        result = subprocess.run(
            [fpocket_bin, "-f", tmp_pdb],
            capture_output=True, text=True, timeout=300,
        )
        if result.returncode != 0:
            print(f"WARNING: fpocket failed: {result.stderr.strip()}")
            return None

        # Parse output directory
        out_dir = os.path.join(tmpdir, "input_out")
        if not os.path.isdir(out_dir):
            # Try alternate naming
            candidates = glob.glob(os.path.join(tmpdir, "*_out"))
            if candidates:
                out_dir = candidates[0]
            else:
                print("WARNING: fpocket output directory not found.")
                return None

        # Parse pocket PDB files for centers
        pockets = []
        pocket_files = sorted(glob.glob(os.path.join(out_dir, "pockets", "pocket*_atm.pdb")))

        for pf in pocket_files[:max_pockets]:
            atoms_coords = []
            residue_set = set()
            with open(pf) as f:
                for line in f:
                    if line.startswith("ATOM") or line.startswith("HETATM"):
                        x = float(line[30:38])
                        y = float(line[38:46])
                        z = float(line[46:54])
                        atoms_coords.append([x, y, z])
                        resname = line[17:20].strip()
                        resid = line[22:26].strip()
                        if resname in STANDARD_RESIDUES:
                            residue_set.add(f"{resname}{resid}")

            if not atoms_coords:
                continue

            arr = np.array(atoms_coords)
            center = arr.mean(axis=0)

            volume = 0.0
            if HAS_CONVEX_HULL and len(arr) >= 4:
                try:
                    hull = ConvexHull(arr)
                    volume = hull.volume
                except Exception:
                    volume = len(arr) * 1.0  # rough estimate

            pockets.append({
                "rank": len(pockets) + 1,
                "source": "fpocket",
                "center": [round(c, 1) for c in center.tolist()],
                "volume_A3": round(volume, 1),
                "residues": sorted(residue_set),
                "n_residues": len(residue_set),
            })

        # Also parse info file for druggability scores if available
        info_file = os.path.join(out_dir, "input_info.txt")
        if os.path.exists(info_file):
            _parse_fpocket_info(info_file, pockets)

        return pockets

    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _parse_fpocket_info(info_file, pockets):
    """Parse fpocket info file for additional pocket properties."""
    try:
        with open(info_file) as f:
            content = f.read()
        # fpocket info format varies; extract what we can
        # This is a best-effort parser
        for pocket in pockets:
            pocket.setdefault("fpocket_score", None)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# P2Rank wrapper
# ---------------------------------------------------------------------------


def detect_p2rank(input_pdb, max_pockets=10, p2rank_home=None):
    """
    Detect pockets using P2Rank (ML-based).

    Requires P2Rank installation with prank binary.
    """
    p2rank_home = p2rank_home or os.environ.get("P2RANK_HOME", "")
    prank_bin = os.path.join(p2rank_home, "prank") if p2rank_home else "prank"

    if p2rank_home and not os.path.exists(prank_bin):
        # Try with .sh extension
        prank_bin = os.path.join(p2rank_home, "prank.sh")

    if not p2rank_home and not shutil.which("prank"):
        print("ERROR: P2Rank not found. Set P2RANK_HOME or add prank to PATH.")
        return None

    tmpdir = tempfile.mkdtemp(prefix="p2rank_")
    try:
        out_dir = os.path.join(tmpdir, "output")
        os.makedirs(out_dir)

        result = subprocess.run(
            [prank_bin, "predict", "-f", os.path.abspath(input_pdb),
             "-o", out_dir],
            capture_output=True, text=True, timeout=300,
        )
        if result.returncode != 0:
            print(f"WARNING: P2Rank failed: {result.stderr.strip()}")
            return None

        # Find predictions CSV
        pred_files = glob.glob(os.path.join(out_dir, "**/*predictions.csv"),
                               recursive=True)
        if not pred_files:
            print("WARNING: P2Rank predictions file not found.")
            return None

        pockets = []
        import csv
        with open(pred_files[0]) as f:
            reader = csv.DictReader(f)
            for row in reader:
                if len(pockets) >= max_pockets:
                    break
                try:
                    center = [
                        float(row.get("center_x", 0)),
                        float(row.get("center_y", 0)),
                        float(row.get("center_z", 0)),
                    ]
                    score = float(row.get("score", 0))
                    pockets.append({
                        "rank": len(pockets) + 1,
                        "source": "p2rank",
                        "center": [round(c, 1) for c in center],
                        "p2rank_score": round(score, 3),
                        "p2rank_probability": round(
                            float(row.get("probability", 0)), 3
                        ),
                    })
                except (ValueError, KeyError):
                    continue

        # Find residues CSV
        res_files = glob.glob(os.path.join(out_dir, "**/*residues.csv"),
                              recursive=True)
        if res_files:
            _add_p2rank_residues(res_files[0], pockets)

        return pockets

    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _add_p2rank_residues(residues_csv, pockets):
    """Add residue information from P2Rank residues CSV to pocket data."""
    try:
        import csv
        pocket_residues = defaultdict(list)
        with open(residues_csv) as f:
            reader = csv.DictReader(f)
            for row in reader:
                pocket_num = row.get("pocket", "").strip()
                residue = row.get("residue_label", "").strip()
                if pocket_num and residue:
                    try:
                        idx = int(pocket_num) - 1
                        pocket_residues[idx].append(residue)
                    except ValueError:
                        continue

        for i, pocket in enumerate(pockets):
            if i in pocket_residues:
                pocket["residues"] = sorted(set(pocket_residues[i]))
                pocket["n_residues"] = len(pocket["residues"])
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Auto detection (try best available method)
# ---------------------------------------------------------------------------


def detect_auto(input_pdb, structure, chain_id=None, min_volume=100,
                max_pockets=10, grid_spacing=1.0, include_ligand_sites=False,
                p2rank_home=None):
    """Try P2Rank → fpocket → grid, using the first available method."""
    # Try P2Rank first (highest accuracy)
    p2rank_home = p2rank_home or os.environ.get("P2RANK_HOME", "")
    if p2rank_home or shutil.which("prank"):
        print("Auto: trying P2Rank...")
        result = detect_p2rank(input_pdb, max_pockets, p2rank_home)
        if result is not None:
            print(f"  P2Rank detected {len(result)} pocket(s).")
            return result, "p2rank"

    # Try fpocket
    if shutil.which("fpocket"):
        print("Auto: trying fpocket...")
        result = detect_fpocket(input_pdb, max_pockets)
        if result is not None:
            print(f"  fpocket detected {len(result)} pocket(s).")
            return result, "fpocket"

    # Fall back to grid
    print("Auto: using built-in grid method.")
    result = detect_grid(
        structure, chain_id, grid_spacing, min_volume,
        max_pockets, include_ligand_sites,
    )
    return result, "grid"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(
        description="Multi-method binding pocket detection. "
                    "Detects pockets using grid-based cavity scan, fpocket, "
                    "or P2Rank. Outputs dock.py-compatible JSON.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python detect.py --input protein.pdb --output pockets.json
  python detect.py --input protein.pdb --output pockets.json --method fpocket
  python detect.py --input protein.pdb --output pockets.json --method auto
  python detect.py --input protein.pdb --output pockets.json --chain A --include-ligand-sites
        """,
    )
    parser.add_argument("--input", required=True, help="Input PDB file")
    parser.add_argument("--output", required=True, help="Output pockets JSON file")
    parser.add_argument(
        "--method", default="auto",
        choices=["grid", "fpocket", "p2rank", "auto"],
        help="Detection method (default: auto — tries P2Rank → fpocket → grid)",
    )
    parser.add_argument("--chain", default=None, help="Chain ID to analyze")
    parser.add_argument(
        "--min-volume", type=float, default=200,
        help="Minimum pocket volume in A^3 (default: 200)",
    )
    parser.add_argument(
        "--max-pockets", type=int, default=10,
        help="Maximum pockets to return (default: 10)",
    )
    parser.add_argument(
        "--grid-spacing", type=float, default=1.0,
        help="Grid spacing for grid method in A (default: 1.0)",
    )
    parser.add_argument(
        "--p2rank-home", default=None,
        help="Path to P2Rank installation (default: env P2RANK_HOME)",
    )
    parser.add_argument(
        "--include-ligand-sites", action="store_true",
        help="Also detect pockets from co-crystallized ligands",
    )

    args = parser.parse_args()

    if not os.path.exists(args.input):
        sys.exit(f"ERROR: Input file not found: {args.input}")

    args.output = validate_output_path(args.output)

    output_dir = os.path.dirname(args.output)
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)

    # Parse structure
    pdb_parser = PDBParser(QUIET=True)
    structure = pdb_parser.get_structure("protein", args.input)

    print("=" * 60)
    print("POCKET DETECTION")
    print("=" * 60)
    print(f"Input: {args.input}")
    print(f"Method: {args.method}")
    if args.chain:
        print(f"Chain: {args.chain}")
    print()

    # Run detection
    method_used = args.method
    if args.method == "grid":
        pockets = detect_grid(
            structure, args.chain, args.grid_spacing, args.min_volume,
            args.max_pockets, args.include_ligand_sites,
        )
    elif args.method == "fpocket":
        pockets = detect_fpocket(args.input, args.max_pockets)
        if pockets is None:
            print("Falling back to grid method.")
            pockets = detect_grid(
                structure, args.chain, args.grid_spacing, args.min_volume,
                args.max_pockets, args.include_ligand_sites,
            )
            method_used = "grid"
    elif args.method == "p2rank":
        pockets = detect_p2rank(args.input, args.max_pockets, args.p2rank_home)
        if pockets is None:
            print("Falling back to grid method.")
            pockets = detect_grid(
                structure, args.chain, args.grid_spacing, args.min_volume,
                args.max_pockets, args.include_ligand_sites,
            )
            method_used = "grid"
    elif args.method == "auto":
        pockets, method_used = detect_auto(
            args.input, structure, args.chain, args.min_volume,
            args.max_pockets, args.grid_spacing, args.include_ligand_sites,
            args.p2rank_home,
        )

    if not pockets:
        print("\nNo pockets detected.")
        print("Consider:")
        print("  - Reducing --min-volume")
        print("  - Using a different --method")
        print("  - Providing manual coordinates for docking")

    # Print results
    print(f"\nDetected {len(pockets)} pocket(s):\n")
    for p in pockets:
        c = p["center"]
        print(f"  Pocket {p['rank']} ({p.get('source', method_used)}):")
        print(f"    Center: ({c[0]:.1f}, {c[1]:.1f}, {c[2]:.1f})")
        if "volume_A3" in p:
            print(f"    Volume: ~{p['volume_A3']:.0f} A^3")
        if "depth_A" in p:
            print(f"    Depth: {p['depth_A']:.1f} A")
        if "residues" in p:
            res = p["residues"]
            print(f"    Residues ({len(res)}): {', '.join(res[:10])}")
            if len(res) > 10:
                print(f"      ... and {len(res) - 10} more")
        if "p2rank_probability" in p:
            print(f"    P2Rank probability: {p['p2rank_probability']:.3f}")
        print()

    # Write output JSON (dock.py compatible format)
    output_data = {
        "protein": os.path.basename(args.input),
        "method": method_used,
        "chain": args.chain,
        "n_pockets": len(pockets),
        "pockets": pockets,
    }

    with open(args.output, "w") as f:
        json.dump(output_data, f, indent=2)

    print(f"Pocket data saved to: {args.output}")

    if pockets:
        best = pockets[0]
        c = best["center"]
        print(f"\nRecommended docking center (Pocket 1):")
        print(f"  --center_x {c[0]:.1f} --center_y {c[1]:.1f} --center_z {c[2]:.1f}")

    log_to_manifest("detect.py", {
        "--input": args.input,
        "--method": args.method,
        "--chain": args.chain,
    }, args.output)


if __name__ == "__main__":
    main()
