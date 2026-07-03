#!/usr/bin/env python3
"""
Focused Toxicity Prediction Panel

Detailed toxicity assessment for drug candidates using SMARTS-based structural
alerts covering hERG, AMES mutagenicity, hepatotoxicity (DILI), skin sensitization,
phospholipidosis (CAD), and LD50 class estimation.

Usage:
    python predict_toxicity.py --input "CCO"
    python predict_toxicity.py --input candidates.csv --output tox_results.csv
"""

import argparse
import csv
import json
import os
import sys

try:
    from rdkit import Chem
    from rdkit.Chem import Descriptors, rdMolDescriptors, Crippen
    from rdkit.Chem import FilterCatalog
    from rdkit.Chem.FilterCatalog import FilterCatalogParams
except ImportError:
    print("ERROR: RDKit is required. Install with: pip install rdkit-pypi", file=sys.stderr)
    sys.exit(1)


# ---------------------------------------------------------------------------
# hERG liability: pharmacophore-based structural alerts
# ---------------------------------------------------------------------------

HERG_ALERTS = [
    # Basic nitrogen patterns with hydrophobic context
    ("[NX3;H2,H1,H0;+0;!$(NC=O)]c1ccccc1",
     "Basic N adjacent to aromatic ring", "high"),
    ("[NX3;H2,H1,H0;+0]CCc1ccccc1",
     "Basic N two carbons from aromatic ring", "high"),
    ("[NX3;H2,H1;+0]CCCc1ccccc1",
     "Basic N three carbons from aromatic ring", "medium"),
    ("[NX3;H2,H1;+0]CCOc1ccccc1",
     "Basic N ethoxyaryl pattern", "high"),
    ("[NX3;H2,H1,H0;+1]",
     "Quaternary or protonated nitrogen", "medium"),
    # Tricyclic and polycyclic hydrophobic scaffolds
    ("c1ccc2c(c1)CCc1ccccc1C2",
     "Tricyclic hydrophobic scaffold", "high"),
    ("c1ccc2c(c1)Cc1ccccc1C2",
     "Fluorene-like scaffold", "medium"),
    ("c1ccc(-c2ccccc2)cc1",
     "Biphenyl (hydrophobic mass)", "low"),
    # Piperidine / piperazine with aryl
    ("C1CCN(CC1)c1ccccc1",
     "Arylpiperidine", "high"),
    ("C1CCN(CC1)Cc1ccccc1",
     "Benzylpiperidine", "high"),
    ("C1CNCCN1c1ccccc1",
     "Arylpiperazine", "high"),
    # Long-chain tertiary amines
    ("[NX3;H0;+0](C)(C)CCCC",
     "Tertiary amine with long alkyl chain", "medium"),
    # Diarylmethyl amines
    ("[NX3]C(c1ccccc1)c1ccccc1",
     "Diarylmethylamine", "high"),
]

# ---------------------------------------------------------------------------
# AMES mutagenicity: comprehensive structural alert library (~30 patterns)
# ---------------------------------------------------------------------------

AMES_ALERTS = [
    # Aromatic amines (bioactivation via N-hydroxylation)
    ("[NH2]c1ccccc1", "Primary aromatic amine", "high"),
    ("[NH1](C)c1ccccc1", "Secondary aromatic amine", "medium"),
    ("c1ccc(c(c1)[N+](=O)[O-])[NH2]", "Ortho-aminonitrobenzene", "high"),
    ("c1cc([NH2])cc([NH2])c1", "Diaminobenzene", "high"),
    ("c1ccc(cc1)N(C)c1ccccc1", "Diarylamine", "medium"),

    # Nitro compounds
    ("[N+](=O)[O-]c", "Aromatic nitro", "high"),
    ("[N+](=O)[O-]C", "Aliphatic nitro", "medium"),

    # Nitroso and N-nitroso compounds
    ("[NH]N=O", "N-nitrosamine", "high"),
    ("N(N=O)C", "N-nitroso-N-alkyl", "high"),
    ("O=Nc", "C-nitroso aromatic", "high"),

    # Azo compounds
    ("c1ccc(cc1)N=Nc1ccccc1", "Azobenzene", "high"),
    ("N=N", "Azo bond", "medium"),

    # Alkylating agents
    ("C1(O1)", "Epoxide", "high"),
    ("C1(N1)", "Aziridine", "high"),
    ("[CH2]Cl", "Chloromethyl", "high"),
    ("[CH2]Br", "Bromomethyl", "high"),
    ("[CH2]I", "Iodomethyl", "high"),
    ("ClCCCl", "Bis(chloroethyl) / mustard-like", "high"),
    ("OS(=O)(=O)[O-,OH]", "Sulfonate ester", "high"),

    # Michael acceptors
    ("C=CC(=O)[C,N,O]", "Michael acceptor (enone/enamide)", "medium"),
    ("C=CC#N", "Michael acceptor (acrylonitrile)", "medium"),
    ("C=CC(=O)O", "Michael acceptor (acrylate ester)", "medium"),
    ("C=CS(=O)", "Vinyl sulfonyl (Michael acceptor)", "medium"),

    # Acylating agents
    ("C(=O)Cl", "Acyl chloride", "high"),
    ("C(=O)OC(=O)", "Anhydride", "medium"),
    ("S(=O)(=O)Cl", "Sulfonyl chloride", "high"),
    ("P(=O)(Cl)", "Phosphoryl chloride", "high"),

    # Polycyclic aromatic hydrocarbons
    ("[$(c1ccc2c(c1)ccc1ccccc12)]", "PAH (bay region potential)", "high"),
    ("c1ccnc2c1ncc1ccccc12", "Acridine-like intercalator", "medium"),

    # Miscellaneous
    ("N#[N+]", "Diazonium", "high"),
    ("[N;$(NC(=S)N)]", "Thiourea", "medium"),
    ("[Se]", "Selenium-containing", "medium"),
    ("C(=O)[NH]O", "Hydroxamic acid (potential)", "low"),
    ("[N;H1;$(Nc1ccccc1)]C=O", "N-aryl formamide", "low"),
    ("c1cnc2ccccc2n1", "Quinoxaline", "low"),
]

# ---------------------------------------------------------------------------
# Hepatotoxicity (DILI) structural alerts
# ---------------------------------------------------------------------------

DILI_ALERTS = [
    ("NN", "Hydrazine", "high"),
    ("[NH]NC=O", "Hydrazide", "high"),
    ("NC(=S)N", "Thiourea", "high"),
    ("NC(=S)", "Thioamide", "medium"),
    ("c1ccc(cc1)O", "Phenol (quinone bioactivation)", "low"),
    ("[OH]c1cc(O)ccc1", "Catechol / hydroquinone", "high"),
    ("c1cc(O)c(O)cc1", "Ortho-catechol", "high"),
    ("C(=O)Oc1ccccc1", "Aryl ester (hydrolysis)", "low"),
    ("c1ccc(cc1[NH2])O", "Aminophenol", "high"),
    ("[N;$(NC(=O)c1ccccc1)]", "Anilide", "medium"),
    ("C#N", "Nitrile (cyanide metabolite)", "medium"),
    ("C=CC=O", "Alpha-beta-unsaturated aldehyde", "high"),
    ("[N+](=O)[O-]c", "Aromatic nitro (nitroreduction)", "high"),
    ("c1ccc(cc1)SC", "Aryl thioether", "medium"),
    ("C(F)(F)F", "Trifluoromethyl (metabolic defluorination)", "low"),
    ("CC(=O)Nc1ccc(O)cc1", "Acetaminophen-like (NAPQI risk)", "high"),
    ("[$(c1ccncc1)]", "Pyridine (hepatotoxic scaffold)", "low"),
    ("c1cc2c(cc1Cl)OCO2", "Chloromethylenedioxy (bioactivation)", "medium"),
]

# ---------------------------------------------------------------------------
# Skin sensitization: reactive electrophile alerts
# ---------------------------------------------------------------------------

SKIN_SENSITIZATION_ALERTS = [
    ("C=CC(=O)", "Alpha-beta-unsaturated carbonyl (Michael acceptor)", "high"),
    ("C(=O)Cl", "Acyl halide", "high"),
    ("S(=O)(=O)Cl", "Sulfonyl chloride", "high"),
    ("C1(O1)", "Epoxide", "high"),
    ("[CH2]Cl", "Alkyl halide", "medium"),
    ("[CH2]Br", "Alkyl halide (Br)", "medium"),
    ("C=CC#N", "Acrylonitrile", "medium"),
    ("[N]=C=O", "Isocyanate", "high"),
    ("[N]=C=S", "Isothiocyanate", "high"),
    ("OC(=O)C=C", "Acrylate ester", "medium"),
    ("C(=O)OC(=O)", "Anhydride", "medium"),
    ("c1ccc(cc1)[CH]=O", "Aryl aldehyde", "medium"),
    ("[$(C=O)]c1cc(Cl)ccc1", "Activated aryl halide", "medium"),
    ("C(=S)", "Thioketone/thioaldehyde", "low"),
    ("SC#N", "Thiocyanate", "medium"),
]

# ---------------------------------------------------------------------------
# Phospholipidosis: Cationic Amphiphilic Drug (CAD) checker
# ---------------------------------------------------------------------------

def check_phospholipidosis(mol):
    """
    Check for phospholipidosis liability using the Cationic Amphiphilic Drug
    (CAD) criteria: basic amine + LogP > 2 + amphiphilic character.
    """
    alerts = []
    logp = Crippen.MolLogP(mol)
    mw = Descriptors.MolWt(mol)

    has_basic_n = mol.HasSubstructMatch(
        Chem.MolFromSmarts("[NX3;H2,H1,H0;+0;!$(NC=O);!$(NS=O)]")
    )
    has_cation = mol.HasSubstructMatch(Chem.MolFromSmarts("[NX3;H2,H1,H0;+1]"))

    tpsa = rdMolDescriptors.CalcTPSA(mol)

    # CAD-like: basic or cationic nitrogen, LogP > 2, molecular weight adequate
    if (has_basic_n or has_cation) and logp > 2 and mw > 300:
        severity = "high" if logp > 4 else "medium"
        alerts.append({
            "alert": "CAD-like (cationic amphiphilic drug)",
            "detail": f"Basic/cationic N, LogP={round(logp, 2)}, MW={round(mw, 1)}",
            "severity": severity,
            "reference": "Pelletier et al. J Med Chem 2007; 50(14):3441-50",
        })

    # Additional: low PSA + high LogP + amine => amphiphilic
    if (has_basic_n or has_cation) and logp > 3 and tpsa < 75:
        if not alerts:  # avoid duplicate
            alerts.append({
                "alert": "Amphiphilic amine (low PSA, high LogP)",
                "detail": f"TPSA={round(tpsa, 1)}, LogP={round(logp, 2)}",
                "severity": "medium",
                "reference": "Ploemen et al. Exp Toxicol Pathol 2004; 55:347-55",
            })

    return alerts


# ---------------------------------------------------------------------------
# LD50 class estimation
# ---------------------------------------------------------------------------

def estimate_ld50_class(mol):
    """
    Estimate oral LD50 toxicity class based on structural features.
    Uses a heuristic approach based on functional group toxicity.
    Classes: likely toxic / moderate / low toxicity
    """
    alerts = []
    mw = Descriptors.MolWt(mol)
    logp = Crippen.MolLogP(mol)

    # Highly toxic motifs
    highly_toxic_smarts = [
        ("[As]", "Arsenic-containing"),
        ("[Tl]", "Thallium-containing"),
        ("[Hg]", "Mercury-containing"),
        ("P(=O)(O)(O)F", "Organophosphate (nerve agent type)"),
        ("P(=S)(O)(O)O", "Organophosphate (pesticide type)"),
        ("C#N.[Fe]", "Cyanide-metal complex"),
        ("F[C;$(C(F)(F)F)]S(=O)", "PFOS-like"),
        ("[N+](=O)[O-]c1c([N+](=O)[O-])cccc1", "Dinitroaromatic"),
    ]

    moderate_toxic_smarts = [
        ("[N+](=O)[O-]", "Nitro group"),
        ("C1(O1)", "Epoxide"),
        ("NN", "Hydrazine"),
        ("[F,Cl,Br,I]c1ccccc1", "Halogenated aromatic"),
        ("[CH2]Cl", "Chloroalkyl"),
        ("C(=O)Cl", "Acyl halide"),
    ]

    high_score = 0
    moderate_score = 0
    details = []

    for sma, name in highly_toxic_smarts:
        pat = Chem.MolFromSmarts(sma)
        if pat and mol.HasSubstructMatch(pat):
            high_score += 1
            details.append(f"{name} (highly toxic motif)")

    for sma, name in moderate_toxic_smarts:
        pat = Chem.MolFromSmarts(sma)
        if pat and mol.HasSubstructMatch(pat):
            moderate_score += 1
            details.append(f"{name} (moderate concern)")

    # Size and lipophilicity penalties
    if mw < 100 and logp > 0:
        moderate_score += 1
        details.append("Small lipophilic molecule (easy absorption)")

    if high_score > 0:
        ld50_class = "Likely toxic (Class 1-3)"
        severity = "high"
    elif moderate_score >= 2:
        ld50_class = "Moderate toxicity (Class 3-4)"
        severity = "medium"
    elif moderate_score == 1:
        ld50_class = "Low-moderate toxicity (Class 4)"
        severity = "low"
    else:
        ld50_class = "Low toxicity predicted (Class 4-5)"
        severity = "low"

    return {
        "class": ld50_class,
        "severity": severity,
        "details": details,
        "reference": "GHS acute toxicity classification (Classes 1-5)",
    }


# ---------------------------------------------------------------------------
# Run complete toxicity panel
# ---------------------------------------------------------------------------

def run_smarts_alerts(mol, alert_list, category_name):
    """Run a set of SMARTS alerts and return structured results."""
    results = []
    for smarts_str, name, severity in alert_list:
        pat = Chem.MolFromSmarts(smarts_str)
        if pat is None:
            continue
        matches = mol.GetSubstructMatches(pat)
        if matches:
            results.append({
                "alert": name,
                "smarts": smarts_str,
                "severity": severity,
                "n_matches": len(matches),
                "category": category_name,
                "matched_atoms": [list(m) for m in matches],
            })
    return results


def run_toxicity_panel(mol, name="Compound"):
    """Run the focused toxicity panel for a single molecule."""
    smiles = Chem.MolToSmiles(mol)
    panel = {
        "name": name,
        "smiles": smiles,
        "endpoints": {},
    }

    # hERG
    herg_results = run_smarts_alerts(mol, HERG_ALERTS, "hERG")
    n_herg = len(herg_results)
    high_herg = sum(1 for r in herg_results if r["severity"] == "high")
    if n_herg == 0:
        herg_verdict = "LOW RISK"
        herg_tl = "GREEN"
    elif high_herg >= 2:
        herg_verdict = "HIGH RISK"
        herg_tl = "RED"
    elif n_herg >= 2 or high_herg >= 1:
        herg_verdict = "MODERATE RISK"
        herg_tl = "YELLOW"
    else:
        herg_verdict = "LOW-MODERATE RISK"
        herg_tl = "YELLOW"
    panel["endpoints"]["hERG"] = {
        "verdict": herg_verdict,
        "flag": herg_tl,
        "n_alerts": n_herg,
        "alerts": herg_results,
    }

    # AMES
    ames_results = run_smarts_alerts(mol, AMES_ALERTS, "AMES")
    n_ames = len(ames_results)
    high_ames = sum(1 for r in ames_results if r["severity"] == "high")
    if n_ames == 0:
        ames_verdict = "LIKELY NON-MUTAGEN"
        ames_tl = "GREEN"
    elif high_ames >= 2:
        ames_verdict = "LIKELY MUTAGEN"
        ames_tl = "RED"
    elif n_ames >= 1:
        ames_verdict = "POSSIBLE MUTAGEN"
        ames_tl = "RED"
    else:
        ames_verdict = "UNCERTAIN"
        ames_tl = "YELLOW"
    panel["endpoints"]["AMES"] = {
        "verdict": ames_verdict,
        "flag": ames_tl,
        "n_alerts": n_ames,
        "alerts": ames_results,
    }

    # DILI (Hepatotoxicity)
    dili_results = run_smarts_alerts(mol, DILI_ALERTS, "DILI")
    n_dili = len(dili_results)
    high_dili = sum(1 for r in dili_results if r["severity"] == "high")
    if n_dili == 0:
        dili_verdict = "LOW RISK"
        dili_tl = "GREEN"
    elif high_dili >= 2:
        dili_verdict = "HIGH RISK"
        dili_tl = "RED"
    elif n_dili >= 2 or high_dili >= 1:
        dili_verdict = "MODERATE RISK"
        dili_tl = "YELLOW"
    else:
        dili_verdict = "LOW RISK"
        dili_tl = "GREEN"
    panel["endpoints"]["DILI"] = {
        "verdict": dili_verdict,
        "flag": dili_tl,
        "n_alerts": n_dili,
        "alerts": dili_results,
    }

    # Skin sensitization
    skin_results = run_smarts_alerts(mol, SKIN_SENSITIZATION_ALERTS, "Skin_Sensitization")
    n_skin = len(skin_results)
    high_skin = sum(1 for r in skin_results if r["severity"] == "high")
    if n_skin == 0:
        skin_verdict = "LOW RISK"
        skin_tl = "GREEN"
    elif high_skin >= 1:
        skin_verdict = "HIGH RISK"
        skin_tl = "RED"
    elif n_skin >= 1:
        skin_verdict = "MODERATE RISK"
        skin_tl = "YELLOW"
    else:
        skin_verdict = "LOW RISK"
        skin_tl = "GREEN"
    panel["endpoints"]["Skin_Sensitization"] = {
        "verdict": skin_verdict,
        "flag": skin_tl,
        "n_alerts": n_skin,
        "alerts": skin_results,
    }

    # Phospholipidosis (CAD)
    plp_results = check_phospholipidosis(mol)
    if not plp_results:
        plp_verdict = "LOW RISK"
        plp_tl = "GREEN"
    elif any(r["severity"] == "high" for r in plp_results):
        plp_verdict = "HIGH RISK"
        plp_tl = "RED"
    else:
        plp_verdict = "MODERATE RISK"
        plp_tl = "YELLOW"
    panel["endpoints"]["Phospholipidosis"] = {
        "verdict": plp_verdict,
        "flag": plp_tl,
        "n_alerts": len(plp_results),
        "alerts": plp_results,
    }

    # LD50 class
    ld50 = estimate_ld50_class(mol)
    if ld50["severity"] == "high":
        ld50_tl = "RED"
    elif ld50["severity"] == "medium":
        ld50_tl = "YELLOW"
    else:
        ld50_tl = "GREEN"
    panel["endpoints"]["LD50_class"] = {
        "verdict": ld50["class"],
        "flag": ld50_tl,
        "details": ld50["details"],
        "reference": ld50["reference"],
    }

    # PAINS filter
    try:
        params = FilterCatalogParams()
        params.AddCatalog(FilterCatalogParams.FilterCatalogs.PAINS)
        catalog = FilterCatalog.FilterCatalog(params)
        pains_matches = catalog.GetMatches(mol)
        n_pains = len(pains_matches)
        pains_names = [m.GetDescription() for m in pains_matches]
    except Exception:
        n_pains = 0
        pains_names = []

    if n_pains == 0:
        pains_verdict = "NO PAINS ALERTS"
        pains_tl = "GREEN"
    elif n_pains == 1:
        pains_verdict = "1 PAINS ALERT"
        pains_tl = "YELLOW"
    else:
        pains_verdict = f"{n_pains} PAINS ALERTS"
        pains_tl = "RED"
    panel["endpoints"]["PAINS"] = {
        "verdict": pains_verdict,
        "flag": pains_tl,
        "n_alerts": n_pains,
        "alert_names": pains_names,
    }

    return panel


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
# Output formatting
# ---------------------------------------------------------------------------

def format_table(panels):
    """Format toxicity panels as human-readable text."""
    lines = []
    for panel in panels:
        lines.append("=" * 80)
        lines.append(f"  TOXICITY PANEL: {panel['name']}")
        lines.append(f"  SMILES: {panel['smiles']}")
        lines.append("=" * 80)

        for endpoint_name, endpoint_data in panel["endpoints"].items():
            verdict = endpoint_data.get("verdict", "N/A")
            flag = endpoint_data.get("flag", "")
            n_alerts = endpoint_data.get("n_alerts", 0)

            label = endpoint_name.replace("_", " ")
            lines.append(f"\n  {label}")
            lines.append(f"    Verdict: {verdict}  [{flag}]")
            lines.append(f"    Alerts:  {n_alerts}")

            # Show individual alerts
            alerts = endpoint_data.get("alerts", [])
            for alert in alerts:
                if isinstance(alert, dict):
                    a_name = alert.get("alert", "")
                    a_sev = alert.get("severity", "")
                    a_smarts = alert.get("smarts", "")
                    a_detail = alert.get("detail", "")
                    if a_smarts:
                        lines.append(f"      - [{a_sev.upper()}] {a_name}")
                        lines.append(f"        SMARTS: {a_smarts}")
                    elif a_detail:
                        lines.append(f"      - [{a_sev.upper()}] {a_name}: {a_detail}")
                    else:
                        lines.append(f"      - [{a_sev.upper()}] {a_name}")

            # LD50 details
            details = endpoint_data.get("details", [])
            for detail in details:
                if isinstance(detail, str):
                    lines.append(f"      - {detail}")

            # PAINS alert names
            alert_names = endpoint_data.get("alert_names", [])
            for aname in alert_names:
                lines.append(f"      - {aname}")

            reference = endpoint_data.get("reference", "")
            if reference:
                lines.append(f"    Reference: {reference}")

        lines.append("")

    # Summary
    lines.append("-" * 80)
    lines.append("  TOXICITY SUMMARY")
    lines.append("-" * 80)
    for panel in panels:
        name = panel["name"]
        reds = sum(1 for ep in panel["endpoints"].values() if ep.get("flag") == "RED")
        yellows = sum(1 for ep in panel["endpoints"].values() if ep.get("flag") == "YELLOW")
        greens = sum(1 for ep in panel["endpoints"].values() if ep.get("flag") == "GREEN")
        total_alerts = sum(ep.get("n_alerts", 0) for ep in panel["endpoints"].values())
        lines.append(f"  {name}: {greens} GREEN, {yellows} YELLOW, {reds} RED "
                     f"({total_alerts} total alerts)")
        if reds >= 2:
            lines.append(f"    >>> CAUTION: Multiple high-risk toxicity flags <<<")
    lines.append("")
    return "\n".join(lines)


def panels_to_csv_rows(panels):
    """Convert panels to flat CSV rows."""
    rows = []
    for panel in panels:
        row = {"Name": panel["name"], "SMILES": panel["smiles"]}
        for endpoint_name, endpoint_data in panel["endpoints"].items():
            row[f"{endpoint_name}_verdict"] = endpoint_data.get("verdict", "")
            row[f"{endpoint_name}_flag"] = endpoint_data.get("flag", "")
            row[f"{endpoint_name}_n_alerts"] = endpoint_data.get("n_alerts", 0)
            # Flatten alert names
            alerts = endpoint_data.get("alerts", [])
            alert_names = []
            for a in alerts:
                if isinstance(a, dict):
                    alert_names.append(a.get("alert", ""))
            if alert_names:
                row[f"{endpoint_name}_alert_details"] = "; ".join(alert_names)
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
        description="Focused toxicity prediction panel for drug candidates.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python predict_toxicity.py --input "c1ccc2c(c1)cc1ccc3cccc4ccc2c1c34"
  python predict_toxicity.py --input candidates.csv --output tox_results.csv
        """,
    )
    parser.add_argument(
        "--input", required=True,
        help="SMILES string (comma-separated for multiple) or path to CSV file."
    )
    parser.add_argument(
        "--output", default=None,
        help="Output CSV file path. If not specified, results are printed to stdout."
    )

    args = parser.parse_args()

    molecules = parse_input(args.input)
    if not molecules:
        print("ERROR: No valid molecules found in input.", file=sys.stderr)
        sys.exit(1)

    print(f"Processing {len(molecules)} molecule(s) for toxicity assessment...\n",
          file=sys.stderr)

    panels = []
    for name, mol in molecules:
        panel = run_toxicity_panel(mol, name=name)
        panels.append(panel)

    # Always print table summary
    print(format_table(panels))

    # Write CSV if requested
    if args.output:
        rows = panels_to_csv_rows(panels)
        write_csv(rows, args.output)


if __name__ == "__main__":
    main()
