#!/usr/bin/env python3
"""
Drug Candidate Comparison

Compares candidate drug properties against FDA-approved drug statistics or
custom reference compounds. Produces percentile rankings, outlier flags,
and a text-based radar chart visualization.

Usage:
    python compare_drugs.py --input candidates.csv --output comparison.csv
    python compare_drugs.py --input "CCO,c1ccccc1" --reference approved.csv --output comparison.csv
"""

import argparse
import csv
import json
import math
import os
import sys

try:
    from rdkit import Chem
    from rdkit.Chem import Descriptors, rdMolDescriptors, Crippen
except ImportError:
    print("ERROR: RDKit is required. Install with: pip install rdkit-pypi", file=sys.stderr)
    sys.exit(1)

try:
    from rdkit.Chem.QED import qed as compute_qed_rdkit
    HAS_QED = True
except ImportError:
    HAS_QED = False


# ---------------------------------------------------------------------------
# Built-in reference statistics for FDA-approved oral drugs
# Based on analysis of ~1500 FDA-approved small molecule drugs
# ---------------------------------------------------------------------------

APPROVED_DRUG_STATS = {
    # property: (median, mean, std, p5, p25, p75, p95)
    "MW":       (335.0, 348.2, 122.5, 152.0, 261.0, 420.0, 580.0),
    "LogP":     (2.3,   2.18,  2.05,  -1.2,  0.8,   3.5,   5.8),
    "HBD":      (1.0,   1.8,   1.6,   0.0,   0.0,   3.0,   5.0),
    "HBA":      (4.0,   4.7,   2.8,   1.0,   3.0,   6.0,   10.0),
    "TPSA":     (65.0,  72.8,  42.5,  12.0,  37.0,  95.0,  155.0),
    "RotBonds": (5.0,   5.3,   3.5,   0.0,   2.0,   7.0,   12.0),
    "QED":      (0.68,  0.62,  0.18,  0.25,  0.52,  0.76,  0.88),
    "Fsp3":     (0.36,  0.40,  0.22,  0.05,  0.22,  0.55,  0.80),
    "NumRings": (3.0,   3.1,   1.5,   1.0,   2.0,   4.0,   6.0),
}


# ---------------------------------------------------------------------------
# Descriptor calculations
# ---------------------------------------------------------------------------

def compute_descriptors(mol):
    """Compute property descriptors for a molecule."""
    desc = {}
    desc["MW"] = round(Descriptors.MolWt(mol), 2)
    desc["LogP"] = round(Crippen.MolLogP(mol), 2)
    desc["HBD"] = rdMolDescriptors.CalcNumHBD(mol)
    desc["HBA"] = rdMolDescriptors.CalcNumHBA(mol)
    desc["TPSA"] = round(rdMolDescriptors.CalcTPSA(mol), 2)
    desc["RotBonds"] = rdMolDescriptors.CalcNumRotatableBonds(mol)
    desc["Fsp3"] = round(rdMolDescriptors.CalcFractionCSP3(mol), 3)
    desc["NumRings"] = rdMolDescriptors.CalcNumRings(mol)

    if HAS_QED:
        desc["QED"] = round(compute_qed_rdkit(mol), 3)
    else:
        desc["QED"] = _fallback_qed(mol)

    return desc


def _fallback_qed(mol):
    """Simplified QED when rdkit.Chem.QED is unavailable."""
    mw = Descriptors.MolWt(mol)
    logp = Crippen.MolLogP(mol)
    hbd = rdMolDescriptors.CalcNumHBD(mol)
    hba = rdMolDescriptors.CalcNumHBA(mol)
    tpsa = rdMolDescriptors.CalcTPSA(mol)
    rb = rdMolDescriptors.CalcNumRotatableBonds(mol)
    arom = rdMolDescriptors.CalcNumAromaticRings(mol)

    def _gauss(x, mu, sigma):
        return math.exp(-0.5 * ((x - mu) / sigma) ** 2)

    d_mw = _gauss(mw, 300, 150)
    d_logp = _gauss(logp, 2.0, 1.5)
    d_hbd = _gauss(hbd, 1, 2)
    d_hba = _gauss(hba, 4, 3)
    d_tpsa = _gauss(tpsa, 70, 40)
    d_rb = _gauss(rb, 4, 3)
    d_arom = _gauss(arom, 2, 1.5)
    return round((d_mw * d_logp * d_hbd * d_hba * d_tpsa * d_rb * d_arom) ** (1.0 / 7.0), 3)


# ---------------------------------------------------------------------------
# Percentile and outlier calculations
# ---------------------------------------------------------------------------

def compute_percentile_from_stats(value, prop_name, stats=None):
    """
    Estimate percentile of a value within the approved drug distribution.
    Uses the normal distribution CDF approximation based on mean and std.
    """
    if stats is None:
        stats = APPROVED_DRUG_STATS

    if prop_name not in stats:
        return None

    _median, mean, std, p5, _p25, _p75, p95 = stats[prop_name]

    if std == 0:
        return 50.0

    # Z-score
    z = (value - mean) / std

    # CDF approximation (Abramowitz and Stegun)
    percentile = _norm_cdf(z) * 100
    return round(min(max(percentile, 0.1), 99.9), 1)


def _norm_cdf(z):
    """Approximate normal CDF using the error function."""
    return 0.5 * (1.0 + _erf(z / math.sqrt(2.0)))


def _erf(x):
    """Approximate error function (Abramowitz and Stegun, formula 7.1.26)."""
    sign = 1 if x >= 0 else -1
    x = abs(x)
    t = 1.0 / (1.0 + 0.3275911 * x)
    y = 1.0 - (
        ((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t
        + 0.254829592
    ) * t * math.exp(-x * x)
    return sign * y


def is_outlier(value, prop_name, stats=None, n_sd=2):
    """Check if a value is an outlier (> n_sd standard deviations from mean)."""
    if stats is None:
        stats = APPROVED_DRUG_STATS

    if prop_name not in stats:
        return False, 0

    _median, mean, std, *_ = stats[prop_name]
    if std == 0:
        return False, 0

    z = abs(value - mean) / std
    return z > n_sd, round(z, 2)


def compute_reference_stats(reference_mols):
    """Compute property statistics from a set of reference molecules."""
    props = {k: [] for k in APPROVED_DRUG_STATS.keys()}

    for _name, mol in reference_mols:
        desc = compute_descriptors(mol)
        for key in props:
            if key in desc:
                props[key].append(desc[key])

    stats = {}
    for key, values in props.items():
        if not values:
            continue
        values_sorted = sorted(values)
        n = len(values_sorted)
        mean = sum(values_sorted) / n
        variance = sum((v - mean) ** 2 for v in values_sorted) / max(n - 1, 1)
        std = math.sqrt(variance)
        median = values_sorted[n // 2]
        p5 = values_sorted[max(0, int(n * 0.05))]
        p25 = values_sorted[max(0, int(n * 0.25))]
        p75 = values_sorted[min(n - 1, int(n * 0.75))]
        p95 = values_sorted[min(n - 1, int(n * 0.95))]
        stats[key] = (median, mean, std, p5, p25, p75, p95)

    return stats


# ---------------------------------------------------------------------------
# Comparison
# ---------------------------------------------------------------------------

def compare_compound(mol, name, stats=None):
    """Compare a single compound against reference statistics."""
    if stats is None:
        stats = APPROVED_DRUG_STATS

    desc = compute_descriptors(mol)
    comparison = {
        "name": name,
        "smiles": Chem.MolToSmiles(mol),
        "properties": {},
        "outliers": [],
        "n_outliers": 0,
    }

    for prop_name, value in desc.items():
        if prop_name not in stats:
            comparison["properties"][prop_name] = {
                "value": value,
                "percentile": None,
                "ref_median": None,
                "is_outlier": False,
                "z_score": 0,
            }
            continue

        percentile = compute_percentile_from_stats(value, prop_name, stats)
        outlier, z_score = is_outlier(value, prop_name, stats)
        ref_median = stats[prop_name][0]

        comparison["properties"][prop_name] = {
            "value": value,
            "percentile": percentile,
            "ref_median": ref_median,
            "is_outlier": outlier,
            "z_score": z_score,
        }

        if outlier:
            direction = "above" if value > stats[prop_name][1] else "below"
            comparison["outliers"].append(
                f"{prop_name}={value} ({direction} mean, z={z_score})"
            )

    comparison["n_outliers"] = len(comparison["outliers"])
    return comparison


# ---------------------------------------------------------------------------
# Text-based radar chart
# ---------------------------------------------------------------------------

def render_text_radar(comparison, stats=None):
    """
    Render a text-based 'radar' showing where the compound sits
    relative to the approved drug distribution.
    """
    if stats is None:
        stats = APPROVED_DRUG_STATS

    lines = []
    name = comparison["name"]
    lines.append(f"\n  Drug-Likeness Radar: {name}")
    lines.append(f"  {'Property':<12} {'Value':>8}  {'Pctl':>5}  {'Ref Med':>8}  {'|':>1} Distribution")
    lines.append(f"  {'-'*12} {'-'*8}  {'-'*5}  {'-'*8}  | {'-'*40}")

    for prop_name in ["MW", "LogP", "HBD", "HBA", "TPSA", "RotBonds", "QED", "Fsp3", "NumRings"]:
        prop_data = comparison["properties"].get(prop_name, {})
        value = prop_data.get("value", "N/A")
        percentile = prop_data.get("percentile")
        ref_median = prop_data.get("ref_median")
        is_out = prop_data.get("is_outlier", False)

        if percentile is None:
            lines.append(f"  {prop_name:<12} {str(value):>8}  {'N/A':>5}  {'N/A':>8}  |")
            continue

        # Create distribution bar (40 chars wide)
        bar_width = 40
        # Mark p25, median (p50), p75 positions
        p5_pos = int(0.05 * bar_width)
        p25_pos = int(0.25 * bar_width)
        p50_pos = int(0.50 * bar_width)
        p75_pos = int(0.75 * bar_width)
        p95_pos = int(0.95 * bar_width)
        val_pos = int(min(max(percentile / 100.0, 0), 1.0) * (bar_width - 1))

        bar = [' '] * bar_width
        # Fill the interquartile range
        for i in range(p25_pos, p75_pos + 1):
            bar[i] = '-'
        bar[p5_pos] = '|'
        bar[p25_pos] = '['
        bar[p50_pos] = 'M'
        bar[p75_pos] = ']'
        bar[p95_pos] = '|'

        # Mark the compound position
        marker = '*' if not is_out else '!'
        if 0 <= val_pos < bar_width:
            bar[val_pos] = marker

        bar_str = ''.join(bar)
        outlier_flag = " <<< OUTLIER" if is_out else ""

        lines.append(
            f"  {prop_name:<12} {str(value):>8}  {percentile:>5.1f}  "
            f"{str(ref_median):>8}  |{bar_str}{outlier_flag}"
        )

    lines.append(f"  {'':12} {'':8}  {'':5}  {'':8}  | p5   p25  Med  p75  p95")
    lines.append(f"  Legend: * = compound position, M = median, [-] = IQR, ! = outlier")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Head-to-head comparison
# ---------------------------------------------------------------------------

def head_to_head_table(comparisons):
    """Create a head-to-head comparison table for multiple compounds."""
    lines = []
    lines.append("\n  HEAD-TO-HEAD COMPARISON")
    lines.append("=" * 100)

    props = ["MW", "LogP", "HBD", "HBA", "TPSA", "RotBonds", "QED", "Fsp3", "NumRings"]

    # Header
    header = f"  {'Property':<12}"
    for comp in comparisons:
        name = comp["name"][:15]
        header += f" {name:>16}"
    header += f" {'Ref Median':>12}"
    lines.append(header)
    lines.append("  " + "-" * (14 + 17 * len(comparisons) + 14))

    for prop in props:
        row = f"  {prop:<12}"
        ref_median = APPROVED_DRUG_STATS.get(prop, (None,))[0]

        for comp in comparisons:
            prop_data = comp["properties"].get(prop, {})
            val = prop_data.get("value", "N/A")
            pctl = prop_data.get("percentile")
            is_out = prop_data.get("is_outlier", False)
            flag = "!" if is_out else " "
            if pctl is not None:
                cell = f"{val}{flag}({pctl:.0f}%)"
            else:
                cell = str(val)
            row += f" {cell:>16}"

        if ref_median is not None:
            row += f" {ref_median:>12}"
        else:
            row += f" {'N/A':>12}"
        lines.append(row)

    lines.append("")

    # Outlier summary
    lines.append("  OUTLIER SUMMARY:")
    for comp in comparisons:
        n_out = comp["n_outliers"]
        name = comp["name"]
        if n_out == 0:
            lines.append(f"    {name}: No outlier properties (within approved drug space)")
        else:
            lines.append(f"    {name}: {n_out} outlier(s) - {'; '.join(comp['outliers'])}")

    lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Input parsing
# ---------------------------------------------------------------------------

def parse_input(input_arg):
    """Parse input: SMILES string or CSV file. Returns list of (name, mol)."""
    molecules = []
    if os.path.isfile(input_arg):
        with open(input_arg, "r") as f:
            reader = csv.DictReader(f)
            smiles_col = None
            name_col = None
            for fn in reader.fieldnames or []:
                fl = fn.strip().lower()
                if fl in ("smiles", "smi", "canonical_smiles"):
                    smiles_col = fn
                elif fl in ("name", "compound", "id", "compound_name"):
                    name_col = fn
            if smiles_col is None and reader.fieldnames:
                smiles_col = reader.fieldnames[0]
                if len(reader.fieldnames) > 1:
                    name_col = reader.fieldnames[1]
            f.seek(0)
            reader = csv.DictReader(f)
            for i, row in enumerate(reader):
                smi = row.get(smiles_col, "").strip()
                nm = row.get(name_col, f"Compound_{i+1}").strip() if name_col else f"Compound_{i+1}"
                mol = Chem.MolFromSmiles(smi)
                if mol is not None:
                    molecules.append((nm, mol))
                else:
                    print(f"WARNING: Could not parse SMILES '{smi}' for {nm}", file=sys.stderr)
    else:
        for i, smi in enumerate(input_arg.split(",")):
            smi = smi.strip()
            if not smi:
                continue
            mol = Chem.MolFromSmiles(smi)
            if mol is not None:
                nm = f"Compound_{i+1}" if "," in input_arg else "Query"
                molecules.append((nm, mol))
            else:
                print(f"WARNING: Could not parse SMILES '{smi}'", file=sys.stderr)
    return molecules


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def comparisons_to_csv_rows(comparisons):
    """Flatten comparisons to CSV rows."""
    rows = []
    for comp in comparisons:
        row = {
            "Name": comp["name"],
            "SMILES": comp["smiles"],
            "N_outliers": comp["n_outliers"],
        }
        for prop_name, prop_data in comp["properties"].items():
            row[prop_name] = prop_data["value"]
            if prop_data["percentile"] is not None:
                row[f"{prop_name}_percentile"] = prop_data["percentile"]
            if prop_data["ref_median"] is not None:
                row[f"{prop_name}_ref_median"] = prop_data["ref_median"]
            row[f"{prop_name}_is_outlier"] = prop_data["is_outlier"]
            row[f"{prop_name}_z_score"] = prop_data["z_score"]
        if comp["outliers"]:
            row["Outlier_details"] = "; ".join(comp["outliers"])
        rows.append(row)
    return rows


def write_csv(rows, output_path):
    """Write rows to CSV."""
    if not rows:
        return
    all_keys = []
    seen = set()
    for row in rows:
        for k in row:
            if k not in seen:
                all_keys.append(k)
                seen.add(k)
    with open(output_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=all_keys)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)
    print(f"Results written to {output_path}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Compare drug candidate properties against approved drug statistics.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python compare_drugs.py --input "CC(=O)Oc1ccccc1C(=O)O"
  python compare_drugs.py --input candidates.csv --output comparison.csv
  python compare_drugs.py --input candidates.csv --reference approved.csv --output comparison.csv
        """,
    )
    parser.add_argument(
        "--input", required=True,
        help="SMILES string (comma-separated for multiple) or path to CSV file of candidates."
    )
    parser.add_argument(
        "--reference", default=None,
        help="Optional: CSV file of reference/approved drugs for custom comparison. "
             "If not provided, built-in FDA-approved oral drug statistics are used."
    )
    parser.add_argument(
        "--output", default=None,
        help="Output CSV file path."
    )

    args = parser.parse_args()

    # Parse candidate molecules
    candidates = parse_input(args.input)
    if not candidates:
        print("ERROR: No valid candidate molecules found in input.", file=sys.stderr)
        sys.exit(1)

    # Parse reference molecules if provided
    stats = APPROVED_DRUG_STATS
    if args.reference:
        ref_mols = parse_input(args.reference)
        if ref_mols:
            print(f"Computing statistics from {len(ref_mols)} reference molecules...\n",
                  file=sys.stderr)
            stats = compute_reference_stats(ref_mols)
            if not stats:
                print("WARNING: Could not compute reference stats, falling back to built-in.",
                      file=sys.stderr)
                stats = APPROVED_DRUG_STATS
        else:
            print("WARNING: No valid reference molecules, falling back to built-in stats.",
                  file=sys.stderr)

    print(f"Comparing {len(candidates)} candidate(s) against "
          f"{'custom reference set' if args.reference else 'FDA-approved drug statistics'}...\n",
          file=sys.stderr)

    # Run comparisons
    comparisons = []
    for name, mol in candidates:
        comp = compare_compound(mol, name, stats)
        comparisons.append(comp)

    # Print results
    ref_label = "Custom Reference Set" if args.reference else "FDA-Approved Oral Drugs"
    print("=" * 80)
    print(f"  DRUG CANDIDATE COMPARISON vs {ref_label}")
    print("=" * 80)

    if not args.reference:
        print("\n  Reference statistics (FDA-approved oral drugs, ~1500 compounds):")
        print(f"  {'Property':<12} {'Median':>8} {'Mean':>8} {'Std':>8} {'P5':>8} {'P95':>8}")
        print(f"  {'-'*12} {'-'*8} {'-'*8} {'-'*8} {'-'*8} {'-'*8}")
        for prop_name in ["MW", "LogP", "HBD", "HBA", "TPSA", "RotBonds", "QED", "Fsp3", "NumRings"]:
            if prop_name in stats:
                med, mean, std, p5, _p25, _p75, p95 = stats[prop_name]
                print(f"  {prop_name:<12} {med:>8} {mean:>8.1f} {std:>8.1f} {p5:>8} {p95:>8}")

    # Radar charts for each compound
    for comp in comparisons:
        print(render_text_radar(comp, stats))

    # Head-to-head if multiple compounds
    if len(comparisons) > 1:
        print(head_to_head_table(comparisons))

    # Write CSV
    if args.output:
        rows = comparisons_to_csv_rows(comparisons)
        write_csv(rows, args.output)


if __name__ == "__main__":
    main()
