#!/usr/bin/env python3
"""
Drug-likeness filtering for compound libraries.

Applies standard medicinal chemistry filters to molecules:
  - Lipinski Ro5: MW<=500, LogP<=5, HBD<=5, HBA<=10
  - Veber: RotBonds<=10, TPSA<=140
  - QED: quantitative drug-likeness score
  - PAINS: pan-assay interference compounds
  - Brenk: structural alerts for reactive/toxic groups
  - Lead-like: MW 200-350, LogP -1 to 3
  - Fragment-like (Ro3): MW<=300, LogP<=3, HBD<=3, HBA<=3
  - bRo5: beyond Rule of Five (MW 500-1000, LogP -2 to 10)
  - SA score: synthetic accessibility (1=easy, 10=hard)

Usage:
    python filter.py --input library.csv --output filtered.csv --filters lipinski,pains
    python filter.py --input library.csv --output filtered.csv --filters lipinski,veber,qed,pains,brenk,leadlike,fragmentlike,bro5
"""

import argparse
import csv
import sys
import os

try:
    from rdkit import Chem
    from rdkit.Chem import Descriptors, QED, rdMolDescriptors
    from rdkit.Chem.FilterCatalog import FilterCatalog, FilterCatalogParams
    from rdkit import RDLogger
    RDLogger.logger().setLevel(RDLogger.ERROR)
except ImportError:
    print("ERROR: RDKit is required. Install with: pip install rdkit-pypi")
    sys.exit(1)


# ---------------------------------------------------------------------------
# Brenk structural alerts (SMARTS patterns for reactive/toxic groups)
# ---------------------------------------------------------------------------
BRENK_ALERTS = [
    ("[S-]", "thiolate"),
    ("[SX2H0][N]", "thiazide_s_n"),
    ("[NX3H1][NX3H1]", "hydrazine"),
    ("C#N", "nitrile_warn"),  # flagged as alert in some sets
    ("[N+]#[C-]", "isonitrile"),
    ("C(=O)[OH0]N", "hydroxamic_acid_like"),
    ("[NX3;!$([NX3][CX3](=[OX1]))]([#6])([#6])[#6]", "tertiary_amine_bulky"),
    ("[#6]S(=O)(=O)O[#6]", "sulfonate_ester"),
    ("[NX3H2+0,NX4H3+;!$([N]~[!#6]);!$([N]*~[#7,#8,#15,#16])]", "primary_amine_flag"),
    ("C1(=O)OCC1", "beta_lactone"),
    ("[CH1](=O)", "aldehyde"),
    ("OS(=O)(=O)[O-]", "sulfate"),
    ("[N;R0][N;R0]C(=O)", "acylhydrazine"),
    ("C(=O)Cl", "acyl_halide"),
    ("[S;R0][C;R0](=S)", "thiocarbamate"),
    ("[N;R0]=[N;R0]", "diazo"),
    ("[P](=O)([OH])([OH])[OH]", "phosphoric_acid"),
    ("[C;R0](=[O;R0])[O;R0][C;R0](=[O;R0])", "anhydride"),
    ("[NX3;!$(NC=O)]([F,Cl,Br,I])", "n_haloamine"),
    ("[#6]N=N#N", "azide"),
    ("O=N~N", "nitrosamine_like"),
    ("[Si][F,Cl,Br,I]", "silicon_halide"),
    ("C(=O)OO", "peroxide"),
    ("[NX3H0+0,NX4H1+;$([N]([#6])([#6])[#6])]=[O]", "nitroso"),
    ("[Br,I]", "heavy_halide"),  # Some Brenk sets flag Br/I
]


def compute_sa_score(mol):
    """
    Estimate synthetic accessibility (1=easy, 10=hard).
    Heuristic based on molecular complexity features.
    """
    try:
        num_rings = rdMolDescriptors.CalcNumRings(mol)
        num_stereo = rdMolDescriptors.CalcNumAtomStereoCenters(mol)
        mw = Descriptors.MolWt(mol)
        num_rotbonds = Descriptors.NumRotatableBonds(mol)
        num_heavy = mol.GetNumHeavyAtoms()

        ring_info = mol.GetRingInfo()
        num_fused = 0
        if ring_info.NumRings() > 1:
            bond_rings = ring_info.BondRings()
            for i in range(len(bond_rings)):
                for j in range(i + 1, len(bond_rings)):
                    shared = set(bond_rings[i]) & set(bond_rings[j])
                    if shared:
                        num_fused += 1

        sa = 1.0 + 0.25 * num_rings + 0.5 * num_stereo + 0.002 * mw
        sa += 0.1 * num_rotbonds + 0.3 * num_fused
        return round(max(1.0, min(sa, 10.0)), 2)
    except Exception:
        return 5.0


def compute_all_properties(mol):
    """Compute all properties needed for filtering."""
    if mol is None:
        return None
    try:
        return {
            "mw": round(Descriptors.MolWt(mol), 2),
            "logp": round(Descriptors.MolLogP(mol), 2),
            "hbd": Descriptors.NumHDonors(mol),
            "hba": Descriptors.NumHAcceptors(mol),
            "rotbonds": Descriptors.NumRotatableBonds(mol),
            "tpsa": round(Descriptors.TPSA(mol), 2),
            "qed": round(QED.qed(mol), 4),
            "sa_score": compute_sa_score(mol),
            "num_rings": rdMolDescriptors.CalcNumRings(mol),
            "num_aromatic_rings": rdMolDescriptors.CalcNumAromaticRings(mol),
            "heavy_atoms": mol.GetNumHeavyAtoms(),
        }
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Filter implementations
# ---------------------------------------------------------------------------
def filter_lipinski(props):
    """Lipinski Rule of Five: MW<=500, LogP<=5, HBD<=5, HBA<=10."""
    violations = 0
    if props["mw"] > 500:
        violations += 1
    if props["logp"] > 5:
        violations += 1
    if props["hbd"] > 5:
        violations += 1
    if props["hba"] > 10:
        violations += 1
    return violations <= 1  # Allow 1 violation


def filter_veber(props):
    """Veber rules: RotBonds<=10, TPSA<=140."""
    return props["rotbonds"] <= 10 and props["tpsa"] <= 140


def filter_qed(props, threshold=0.5):
    """QED drug-likeness filter."""
    return props["qed"] >= threshold


def filter_pains(mol):
    """PAINS filter using RDKit FilterCatalog."""
    try:
        params = FilterCatalogParams()
        params.AddCatalog(FilterCatalogParams.FilterCatalogs.PAINS)
        catalog = FilterCatalog(params)
        entry = catalog.GetFirstMatch(mol)
        return entry is None  # True = passes (no PAINS match)
    except Exception:
        return True  # On error, pass by default


def filter_brenk(mol):
    """Brenk structural alerts filter."""
    try:
        for smarts, name in BRENK_ALERTS:
            pattern = Chem.MolFromSmarts(smarts)
            if pattern is None:
                continue
            if mol.HasSubstructMatch(pattern):
                return False
        return True
    except Exception:
        return True


def filter_leadlike(props):
    """Lead-like: MW 200-350, LogP -1 to 3, RotBonds<=7."""
    return (200 <= props["mw"] <= 350 and
            -1 <= props["logp"] <= 3 and
            props["rotbonds"] <= 7)


def filter_fragmentlike(props):
    """Fragment-like (Rule of Three): MW<=300, LogP<=3, HBD<=3, HBA<=3."""
    return (props["mw"] <= 300 and
            props["logp"] <= 3 and
            props["hbd"] <= 3 and
            props["hba"] <= 3)


def filter_bro5(props):
    """Beyond Rule of Five: for natural product-like space. MW 500-1000, LogP -2 to 10."""
    return (500 <= props["mw"] <= 1000 and
            -2 <= props["logp"] <= 10 and
            props["hbd"] <= 6 and
            props["rotbonds"] <= 20)


def filter_sa(props, threshold=6.0):
    """Synthetic accessibility filter: SA score <= threshold."""
    return props["sa_score"] <= threshold


# ---------------------------------------------------------------------------
# Filter registry
# ---------------------------------------------------------------------------
AVAILABLE_FILTERS = {
    "lipinski": "Lipinski Rule of Five",
    "veber": "Veber rules",
    "qed": "QED drug-likeness",
    "pains": "PAINS filter",
    "brenk": "Brenk structural alerts",
    "leadlike": "Lead-like",
    "fragmentlike": "Fragment-like (Ro3)",
    "bro5": "Beyond Rule of Five",
    "sa": "Synthetic accessibility",
}


def apply_filters(mol, props, filter_names, qed_threshold=0.5, sa_threshold=6.0):
    """
    Apply specified filters to a molecule.
    Returns dict of {filter_name: pass/fail}.
    """
    results = {}

    for fname in filter_names:
        fname = fname.lower().strip()

        if fname == "lipinski":
            results["lipinski"] = filter_lipinski(props)
        elif fname == "veber":
            results["veber"] = filter_veber(props)
        elif fname == "qed":
            results["qed"] = filter_qed(props, threshold=qed_threshold)
        elif fname == "pains":
            results["pains"] = filter_pains(mol)
        elif fname == "brenk":
            results["brenk"] = filter_brenk(mol)
        elif fname == "leadlike":
            results["leadlike"] = filter_leadlike(props)
        elif fname == "fragmentlike":
            results["fragmentlike"] = filter_fragmentlike(props)
        elif fname == "bro5":
            results["bro5"] = filter_bro5(props)
        elif fname == "sa":
            results["sa"] = filter_sa(props, threshold=sa_threshold)
        else:
            print(f"WARNING: Unknown filter: {fname}")

    return results


# ---------------------------------------------------------------------------
# Input loading
# ---------------------------------------------------------------------------
def load_molecules(input_file):
    """Load molecules from CSV (expects 'smiles' column) or plain SMILES file."""
    molecules = []

    if input_file.endswith(".csv"):
        with open(input_file, "r") as f:
            reader = csv.DictReader(f)
            for row_idx, row in enumerate(reader):
                # Try common column names
                smi = ""
                for col in ["smiles", "SMILES", "Smiles", "smi", "canonical_smiles"]:
                    if col in row and row[col].strip():
                        smi = row[col].strip()
                        break
                if not smi:
                    # Try first column
                    first_key = list(row.keys())[0] if row else ""
                    smi = row.get(first_key, "").strip()

                mol_id = row.get("id", row.get("ID", row.get("name", f"mol_{row_idx+1:05d}")))

                if smi:
                    mol = Chem.MolFromSmiles(smi)
                    if mol is not None:
                        molecules.append((mol_id, smi, mol))
                    else:
                        print(f"WARNING: Invalid SMILES at row {row_idx+1}: {smi[:50]}")
    else:
        with open(input_file, "r") as f:
            for line_idx, line in enumerate(f):
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split()
                smi = parts[0]
                mol_id = parts[1] if len(parts) > 1 else f"mol_{line_idx+1:05d}"
                mol = Chem.MolFromSmiles(smi)
                if mol is not None:
                    molecules.append((mol_id, smi, mol))
                else:
                    print(f"WARNING: Invalid SMILES at line {line_idx+1}: {smi[:50]}")

    return molecules


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description="Drug-likeness filtering for compound libraries."
    )
    parser.add_argument(
        "--input", required=True,
        help="Input file: CSV with SMILES column, or plain SMILES file (one per line)."
    )
    parser.add_argument(
        "--output", required=True,
        help="Output CSV file path."
    )
    parser.add_argument(
        "--filters", required=True,
        help="Comma-separated filter names: lipinski, veber, qed, pains, brenk, leadlike, fragmentlike, bro5, sa."
    )
    parser.add_argument(
        "--qed-threshold", type=float, default=0.5,
        help="QED score threshold (default: 0.5)."
    )
    parser.add_argument(
        "--sa-threshold", type=float, default=6.0,
        help="Synthetic accessibility threshold (default: 6.0, scale 1-10)."
    )
    args = parser.parse_args()

    # Parse filter names
    filter_names = [f.strip().lower() for f in args.filters.split(",") if f.strip()]
    if not filter_names:
        print("ERROR: No filters specified.")
        sys.exit(1)

    # Validate filter names
    for fn in filter_names:
        if fn not in AVAILABLE_FILTERS:
            print(f"ERROR: Unknown filter '{fn}'. Available: {', '.join(AVAILABLE_FILTERS.keys())}")
            sys.exit(1)

    print(f"Filters to apply: {filter_names}")
    print(f"QED threshold: {args.qed_threshold}")
    print(f"SA threshold: {args.sa_threshold}")

    # Load molecules
    if not os.path.isfile(args.input):
        print(f"ERROR: Input file not found: {args.input}")
        sys.exit(1)

    molecules = load_molecules(args.input)
    if not molecules:
        print("ERROR: No valid molecules found in input file.")
        sys.exit(1)

    print(f"\nLoaded {len(molecules)} valid molecules from {args.input}")

    # Apply filters
    output_rows = []
    filter_pass_counts = {fn: 0 for fn in filter_names}
    all_pass_count = 0

    for mol_id, smi, mol in molecules:
        props = compute_all_properties(mol)
        if props is None:
            continue

        can_smi = Chem.MolToSmiles(mol)
        filter_results = apply_filters(
            mol, props, filter_names,
            qed_threshold=args.qed_threshold,
            sa_threshold=args.sa_threshold
        )

        # Count passes
        all_pass = True
        for fn in filter_names:
            if fn in filter_results and filter_results[fn]:
                filter_pass_counts[fn] += 1
            elif fn in filter_results:
                all_pass = False
            else:
                all_pass = False

        if all_pass:
            all_pass_count += 1

        # Build output row
        row = {
            "id": mol_id,
            "smiles": can_smi,
            "mw": props["mw"],
            "logp": props["logp"],
            "hbd": props["hbd"],
            "hba": props["hba"],
            "rotbonds": props["rotbonds"],
            "tpsa": props["tpsa"],
            "qed": props["qed"],
            "sa_score": props["sa_score"],
            "num_rings": props["num_rings"],
            "heavy_atoms": props["heavy_atoms"],
        }

        # Add filter pass/fail columns
        for fn in filter_names:
            row[f"pass_{fn}"] = "pass" if filter_results.get(fn, False) else "fail"

        row["pass_all"] = "pass" if all_pass else "fail"
        output_rows.append(row)

    # Write output
    if output_rows:
        output_dir = os.path.dirname(args.output)
        if output_dir and not os.path.exists(output_dir):
            os.makedirs(output_dir, exist_ok=True)

        fieldnames = ["id", "smiles", "mw", "logp", "hbd", "hba", "rotbonds",
                       "tpsa", "qed", "sa_score", "num_rings", "heavy_atoms"]
        for fn in filter_names:
            fieldnames.append(f"pass_{fn}")
        fieldnames.append("pass_all")

        with open(args.output, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(output_rows)
        print(f"\nWrote {len(output_rows)} molecules to {args.output}")
    else:
        print("\nWARNING: No valid molecules to write.")
        sys.exit(1)

    # Print summary
    print("\n=== Filtering Summary ===")
    print(f"  Input molecules: {len(molecules)}")
    print(f"  Valid molecules processed: {len(output_rows)}")
    print()
    print(f"  {'Filter':<20} {'Passed':<10} {'Failed':<10} {'Rate':<10}")
    print(f"  {'-'*50}")
    for fn in filter_names:
        passed = filter_pass_counts[fn]
        failed = len(output_rows) - passed
        rate = passed / len(output_rows) * 100 if output_rows else 0
        print(f"  {fn:<20} {passed:<10} {failed:<10} {rate:<10.1f}%")
    print(f"  {'-'*50}")
    all_fail = len(output_rows) - all_pass_count
    all_rate = all_pass_count / len(output_rows) * 100 if output_rows else 0
    print(f"  {'ALL FILTERS':<20} {all_pass_count:<10} {all_fail:<10} {all_rate:<10.1f}%")

    # Property distribution of passing molecules
    passing_rows = [r for r in output_rows if r["pass_all"] == "pass"]
    if passing_rows:
        print(f"\n=== Property Distribution (passing molecules) ===")
        for prop in ["mw", "logp", "qed", "sa_score", "tpsa", "rotbonds"]:
            vals = [r[prop] for r in passing_rows if isinstance(r[prop], (int, float))]
            if vals:
                print(f"  {prop:<12} min={min(vals):<10.2f} max={max(vals):<10.2f} mean={sum(vals)/len(vals):<10.2f}")


if __name__ == "__main__":
    main()
