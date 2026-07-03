#!/usr/bin/env python3
"""
Drug-Likeness Scoring

Evaluates drug-likeness across multiple frameworks (Lipinski, Veber, QED,
Lead-likeness, Fragment Ro3, bRo5, SA score, Fsp3, BertzCT) with profile-specific
evaluation for oral, CNS, topical, and injectable routes.

Usage:
    python drug_likeness.py --input "CC(=O)Oc1ccccc1C(=O)O" --profile oral
    python drug_likeness.py --input candidates.csv --profile cns --output dl_scores.csv
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


# ---------------------------------------------------------------------------
# Core descriptor calculations
# ---------------------------------------------------------------------------

def compute_descriptors(mol):
    """Compute all relevant molecular descriptors."""
    desc = {}
    desc["MW"] = round(Descriptors.MolWt(mol), 2)
    desc["LogP"] = round(Crippen.MolLogP(mol), 2)
    desc["HBD"] = rdMolDescriptors.CalcNumHBD(mol)
    desc["HBA"] = rdMolDescriptors.CalcNumHBA(mol)
    desc["TPSA"] = round(rdMolDescriptors.CalcTPSA(mol), 2)
    desc["RotBonds"] = rdMolDescriptors.CalcNumRotatableBonds(mol)
    desc["Fsp3"] = round(rdMolDescriptors.CalcFractionCSP3(mol), 3)
    desc["NumRings"] = rdMolDescriptors.CalcNumRings(mol)
    desc["AromaticRings"] = rdMolDescriptors.CalcNumAromaticRings(mol)
    desc["HeavyAtoms"] = mol.GetNumHeavyAtoms()
    desc["BertzCT"] = round(Descriptors.BertzCT(mol), 1)
    desc["MR"] = round(Crippen.MolMR(mol), 2)  # Molar refractivity
    return desc


# ---------------------------------------------------------------------------
# QED (Quantitative Estimate of Drug-likeness)
# ---------------------------------------------------------------------------

def compute_qed(mol):
    """Compute QED score (Bickerton et al. 2012)."""
    try:
        from rdkit.Chem.QED import qed
        return round(qed(mol), 3)
    except ImportError:
        # Fallback simplified QED
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
# Synthetic Accessibility Score (Ertl & Schuffenhauer approximation)
# ---------------------------------------------------------------------------

def compute_sa_score(mol):
    """
    Simplified SA score (1-10 scale, 1=easy, 10=hard).
    Based on ring complexity, stereocenters, heteroatom diversity,
    BertzCT, and size.
    """
    ri = mol.GetRingInfo()
    n_rings = ri.NumRings()
    n_atoms = mol.GetNumHeavyAtoms()
    if n_atoms == 0:
        return 10.0

    ring_sizes = [len(r) for r in ri.AtomRings()]
    large_rings = sum(1 for s in ring_sizes if s > 6)

    n_stereo = len(Chem.FindMolChiralCenters(mol, includeUnassigned=True))
    elements = set(atom.GetAtomicNum() for atom in mol.GetAtoms() if atom.GetAtomicNum() != 6)
    fsp3 = rdMolDescriptors.CalcFractionCSP3(mol)
    bertz = Descriptors.BertzCT(mol)
    bertz_norm = min(bertz / 1000.0, 3.0)

    # Fused ring detection
    fused = 0
    if n_rings > 1 and ri.AtomRings():
        all_ring_atoms = set()
        for r in ri.AtomRings():
            all_ring_atoms.update(r)
        fused = max(0, n_rings - len(all_ring_atoms) // 4)

    score = 1.0
    score += min(n_rings * 0.3, 2.0)
    score += large_rings * 0.5
    score += n_stereo * 0.3
    score += len(elements) * 0.15
    score += fsp3 * 0.5
    score += bertz_norm
    score += fused * 0.2

    if n_atoms > 35:
        score += (n_atoms - 35) * 0.05

    return round(min(max(score, 1.0), 10.0), 2)


# ---------------------------------------------------------------------------
# Drug-likeness rules
# ---------------------------------------------------------------------------

def lipinski_ro5(desc):
    """
    Lipinski Rule of Five: MW <= 500, LogP <= 5, HBD <= 5, HBA <= 10.
    Returns (n_violations, details).
    """
    violations = []
    if desc["MW"] > 500:
        violations.append(f"MW={desc['MW']} > 500")
    if desc["LogP"] > 5:
        violations.append(f"LogP={desc['LogP']} > 5")
    if desc["HBD"] > 5:
        violations.append(f"HBD={desc['HBD']} > 5")
    if desc["HBA"] > 10:
        violations.append(f"HBA={desc['HBA']} > 10")
    return len(violations), violations


def veber_rules(desc):
    """
    Veber rules for oral bioavailability: TPSA <= 140, RotBonds <= 10.
    Returns (n_violations, details).
    """
    violations = []
    if desc["TPSA"] > 140:
        violations.append(f"TPSA={desc['TPSA']} > 140")
    if desc["RotBonds"] > 10:
        violations.append(f"RotBonds={desc['RotBonds']} > 10")
    return len(violations), violations


def lead_likeness(desc):
    """
    Lead-likeness: MW 200-350, LogP -1 to 3, RotBonds <= 7.
    Returns (n_violations, details).
    """
    violations = []
    if desc["MW"] < 200:
        violations.append(f"MW={desc['MW']} < 200")
    elif desc["MW"] > 350:
        violations.append(f"MW={desc['MW']} > 350")
    if desc["LogP"] < -1:
        violations.append(f"LogP={desc['LogP']} < -1")
    elif desc["LogP"] > 3:
        violations.append(f"LogP={desc['LogP']} > 3")
    if desc["RotBonds"] > 7:
        violations.append(f"RotBonds={desc['RotBonds']} > 7")
    return len(violations), violations


def fragment_ro3(desc):
    """
    Rule of Three for fragment-based drug design:
    MW <= 300, LogP <= 3, HBD <= 3, HBA <= 3, RotBonds <= 3, TPSA <= 60.
    Returns (n_violations, details).
    """
    violations = []
    if desc["MW"] > 300:
        violations.append(f"MW={desc['MW']} > 300")
    if desc["LogP"] > 3:
        violations.append(f"LogP={desc['LogP']} > 3")
    if desc["HBD"] > 3:
        violations.append(f"HBD={desc['HBD']} > 3")
    if desc["HBA"] > 3:
        violations.append(f"HBA={desc['HBA']} > 3")
    if desc["RotBonds"] > 3:
        violations.append(f"RotBonds={desc['RotBonds']} > 3")
    if desc["TPSA"] > 60:
        violations.append(f"TPSA={desc['TPSA']} > 60")
    return len(violations), violations


def beyond_ro5(desc):
    """
    Beyond Rule of Five (bRo5) for macrocycles and natural products.
    Extended property space: MW <= 1000, LogP -2 to 10, HBD <= 6, HBA <= 15,
    TPSA <= 250, RotBonds <= 20.
    Returns (n_violations, details).
    """
    violations = []
    if desc["MW"] > 1000:
        violations.append(f"MW={desc['MW']} > 1000")
    if desc["LogP"] > 10:
        violations.append(f"LogP={desc['LogP']} > 10")
    elif desc["LogP"] < -2:
        violations.append(f"LogP={desc['LogP']} < -2")
    if desc["HBD"] > 6:
        violations.append(f"HBD={desc['HBD']} > 6")
    if desc["HBA"] > 15:
        violations.append(f"HBA={desc['HBA']} > 15")
    if desc["TPSA"] > 250:
        violations.append(f"TPSA={desc['TPSA']} > 250")
    if desc["RotBonds"] > 20:
        violations.append(f"RotBonds={desc['RotBonds']} > 20")
    return len(violations), violations


def wager_cns_mpo(desc):
    """
    Wager CNS MPO (Multi-Parameter Optimization) score.
    Six parameters each scored 0-1 (linear desirability), sum gives 0-6.
    MW < 360 = 1, > 500 = 0. LogP 1-3 = 1. PSA 40-90. HBD <= 1 = 1. pKa (est).
    Returns (score, details).
    """
    # MW desirability: 1 at MW<=360, 0 at MW>=500, linear between
    def _linear(val, low, high):
        """1 at val<=low, 0 at val>=high, linear between."""
        if val <= low:
            return 1.0
        elif val >= high:
            return 0.0
        return (high - val) / (high - low)

    d_mw = _linear(desc["MW"], 360, 500)
    d_logp = max(0, 1.0 - abs(desc["LogP"] - 2.0) / 3.0)  # Optimal around 2
    d_tpsa = 1.0 if 40 <= desc["TPSA"] <= 90 else _linear(abs(desc["TPSA"] - 65), 0, 50)
    d_hbd = 1.0 if desc["HBD"] <= 1 else _linear(desc["HBD"], 1, 4)

    # Simplified pKa estimate: basic N count as proxy
    # (Real pKa would need more sophisticated calculation)
    d_pka = 0.8  # Default moderate score without actual pKa

    # Fsp3 > 0.2 is favorable for CNS
    d_fsp3 = 1.0 if desc["Fsp3"] >= 0.2 else desc["Fsp3"] / 0.2

    score = d_mw + d_logp + d_tpsa + d_hbd + d_pka + d_fsp3
    details = {
        "MW_score": round(d_mw, 2),
        "LogP_score": round(d_logp, 2),
        "TPSA_score": round(d_tpsa, 2),
        "HBD_score": round(d_hbd, 2),
        "pKa_score": round(d_pka, 2),
        "Fsp3_score": round(d_fsp3, 2),
    }
    return round(score, 2), details


# ---------------------------------------------------------------------------
# Profile-specific evaluations
# ---------------------------------------------------------------------------

def evaluate_oral(desc, qed, sa, lip_v, veber_v):
    """Evaluate compound for oral drug-likeness."""
    score_parts = []
    # Lipinski
    if lip_v[0] == 0:
        score_parts.append(("Lipinski Ro5", "PASS", "0 violations"))
    elif lip_v[0] == 1:
        score_parts.append(("Lipinski Ro5", "CAUTION", f"1 violation: {lip_v[1][0]}"))
    else:
        score_parts.append(("Lipinski Ro5", "FAIL", f"{lip_v[0]} violations: {'; '.join(lip_v[1])}"))

    # Veber
    if veber_v[0] == 0:
        score_parts.append(("Veber rules", "PASS", "0 violations"))
    else:
        score_parts.append(("Veber rules", "FAIL", f"{veber_v[0]} violations: {'; '.join(veber_v[1])}"))

    # QED
    if qed > 0.67:
        score_parts.append(("QED", "PASS", f"QED={qed}"))
    elif qed >= 0.49:
        score_parts.append(("QED", "CAUTION", f"QED={qed}"))
    else:
        score_parts.append(("QED", "FAIL", f"QED={qed}"))

    # SA
    if sa <= 4:
        score_parts.append(("Synthetic accessibility", "PASS", f"SA={sa}"))
    elif sa <= 6:
        score_parts.append(("Synthetic accessibility", "CAUTION", f"SA={sa}"))
    else:
        score_parts.append(("Synthetic accessibility", "FAIL", f"SA={sa}"))

    # Overall
    fails = sum(1 for _, verdict, _ in score_parts if verdict == "FAIL")
    cautions = sum(1 for _, verdict, _ in score_parts if verdict == "CAUTION")
    if fails >= 2:
        overall = "FAIL"
    elif fails == 1 or cautions >= 2:
        overall = "CAUTION"
    else:
        overall = "PASS"

    return overall, score_parts


def evaluate_cns(desc, qed, sa):
    """Evaluate compound for CNS drug-likeness."""
    score_parts = []
    cns_score, cns_details = wager_cns_mpo(desc)

    # CNS MPO score
    if cns_score >= 4.5:
        score_parts.append(("CNS MPO", "PASS", f"Score={cns_score}/6"))
    elif cns_score >= 3.5:
        score_parts.append(("CNS MPO", "CAUTION", f"Score={cns_score}/6"))
    else:
        score_parts.append(("CNS MPO", "FAIL", f"Score={cns_score}/6"))

    # Individual CNS criteria
    if desc["MW"] < 450:
        score_parts.append(("MW < 450", "PASS", f"MW={desc['MW']}"))
    else:
        score_parts.append(("MW < 450", "FAIL", f"MW={desc['MW']}"))

    if 1 <= desc["LogP"] <= 3:
        score_parts.append(("LogP 1-3", "PASS", f"LogP={desc['LogP']}"))
    elif 0 <= desc["LogP"] <= 4:
        score_parts.append(("LogP 1-3", "CAUTION", f"LogP={desc['LogP']}"))
    else:
        score_parts.append(("LogP 1-3", "FAIL", f"LogP={desc['LogP']}"))

    if desc["TPSA"] < 90:
        score_parts.append(("TPSA < 90", "PASS", f"TPSA={desc['TPSA']}"))
    else:
        score_parts.append(("TPSA < 90", "FAIL", f"TPSA={desc['TPSA']}"))

    if desc["HBD"] <= 1:
        score_parts.append(("HBD <= 1", "PASS", f"HBD={desc['HBD']}"))
    elif desc["HBD"] <= 2:
        score_parts.append(("HBD <= 1", "CAUTION", f"HBD={desc['HBD']}"))
    else:
        score_parts.append(("HBD <= 1", "FAIL", f"HBD={desc['HBD']}"))

    # Overall
    fails = sum(1 for _, verdict, _ in score_parts if verdict == "FAIL")
    cautions = sum(1 for _, verdict, _ in score_parts if verdict == "CAUTION")
    if fails >= 2:
        overall = "FAIL"
    elif fails == 1 or cautions >= 2:
        overall = "CAUTION"
    else:
        overall = "PASS"

    return overall, score_parts, cns_score, cns_details


def evaluate_topical(desc, qed, sa):
    """Evaluate compound for topical drug-likeness."""
    score_parts = []

    if desc["MW"] < 500:
        score_parts.append(("MW < 500", "PASS", f"MW={desc['MW']}"))
    else:
        score_parts.append(("MW < 500", "FAIL", f"MW={desc['MW']}"))

    if 1 <= desc["LogP"] <= 4:
        score_parts.append(("LogP 1-4", "PASS", f"LogP={desc['LogP']}"))
    elif 0 <= desc["LogP"] <= 5:
        score_parts.append(("LogP 1-4", "CAUTION", f"LogP={desc['LogP']}"))
    else:
        score_parts.append(("LogP 1-4", "FAIL", f"LogP={desc['LogP']}"))

    # Topical: good skin penetration needs moderate lipophilicity
    if desc["TPSA"] < 120:
        score_parts.append(("TPSA < 120", "PASS", f"TPSA={desc['TPSA']}"))
    else:
        score_parts.append(("TPSA < 120", "FAIL", f"TPSA={desc['TPSA']}"))

    if sa <= 5:
        score_parts.append(("Synthetic accessibility", "PASS", f"SA={sa}"))
    else:
        score_parts.append(("Synthetic accessibility", "CAUTION", f"SA={sa}"))

    fails = sum(1 for _, verdict, _ in score_parts if verdict == "FAIL")
    cautions = sum(1 for _, verdict, _ in score_parts if verdict == "CAUTION")
    if fails >= 2:
        overall = "FAIL"
    elif fails == 1 or cautions >= 2:
        overall = "CAUTION"
    else:
        overall = "PASS"

    return overall, score_parts


def evaluate_injectable(desc, qed, sa):
    """Evaluate compound for injectable drug-likeness (wider MW, no oral constraints)."""
    score_parts = []

    # Injectable: wider MW range acceptable
    if desc["MW"] < 1000:
        score_parts.append(("MW < 1000", "PASS", f"MW={desc['MW']}"))
    else:
        score_parts.append(("MW < 1000", "FAIL", f"MW={desc['MW']}"))

    # Solubility is critical for injectables: low LogP preferred
    if desc["LogP"] < 4:
        score_parts.append(("LogP < 4", "PASS", f"LogP={desc['LogP']}"))
    elif desc["LogP"] < 6:
        score_parts.append(("LogP < 4", "CAUTION", f"LogP={desc['LogP']}"))
    else:
        score_parts.append(("LogP < 4", "FAIL", f"LogP={desc['LogP']}"))

    # QED still useful as general quality metric
    if qed > 0.49:
        score_parts.append(("QED > 0.49", "PASS", f"QED={qed}"))
    else:
        score_parts.append(("QED > 0.49", "CAUTION", f"QED={qed}"))

    if sa <= 6:
        score_parts.append(("Synthetic accessibility", "PASS", f"SA={sa}"))
    elif sa <= 8:
        score_parts.append(("Synthetic accessibility", "CAUTION", f"SA={sa}"))
    else:
        score_parts.append(("Synthetic accessibility", "FAIL", f"SA={sa}"))

    fails = sum(1 for _, verdict, _ in score_parts if verdict == "FAIL")
    cautions = sum(1 for _, verdict, _ in score_parts if verdict == "CAUTION")
    if fails >= 2:
        overall = "FAIL"
    elif fails == 1 or cautions >= 2:
        overall = "CAUTION"
    else:
        overall = "PASS"

    return overall, score_parts


# ---------------------------------------------------------------------------
# Full drug-likeness scorecard
# ---------------------------------------------------------------------------

def compute_scorecard(mol, name="Compound", profile="oral"):
    """Compute the full drug-likeness scorecard for a molecule."""
    smiles = Chem.MolToSmiles(mol)
    desc = compute_descriptors(mol)
    qed = compute_qed(mol)
    sa = compute_sa_score(mol)

    # Rule checks
    lip = lipinski_ro5(desc)
    veb = veber_rules(desc)
    lead = lead_likeness(desc)
    frag = fragment_ro3(desc)
    bro5 = beyond_ro5(desc)

    scorecard = {
        "name": name,
        "smiles": smiles,
        "descriptors": desc,
        "QED": qed,
        "SA_score": sa,
        "Lipinski_violations": lip[0],
        "Lipinski_details": lip[1],
        "Veber_violations": veb[0],
        "Veber_details": veb[1],
        "Lead_likeness_violations": lead[0],
        "Lead_likeness_details": lead[1],
        "Fragment_Ro3_violations": frag[0],
        "Fragment_Ro3_details": frag[1],
        "bRo5_violations": bro5[0],
        "bRo5_details": bro5[1],
        "profile": profile,
    }

    # Profile-specific evaluation
    if profile == "oral":
        overall, parts = evaluate_oral(desc, qed, sa, lip, veb)
        scorecard["profile_evaluation"] = parts
        scorecard["overall_recommendation"] = overall
    elif profile == "cns":
        overall, parts, cns_score, cns_details = evaluate_cns(desc, qed, sa)
        scorecard["profile_evaluation"] = parts
        scorecard["overall_recommendation"] = overall
        scorecard["CNS_MPO_score"] = cns_score
        scorecard["CNS_MPO_details"] = cns_details
    elif profile == "topical":
        overall, parts = evaluate_topical(desc, qed, sa)
        scorecard["profile_evaluation"] = parts
        scorecard["overall_recommendation"] = overall
    elif profile == "injectable":
        overall, parts = evaluate_injectable(desc, qed, sa)
        scorecard["profile_evaluation"] = parts
        scorecard["overall_recommendation"] = overall

    return scorecard


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

def format_scorecard_table(scorecards):
    """Format scorecards as human-readable text."""
    lines = []
    for sc in scorecards:
        lines.append("=" * 80)
        lines.append(f"  DRUG-LIKENESS SCORECARD: {sc['name']}")
        lines.append(f"  SMILES: {sc['smiles']}")
        lines.append(f"  Profile: {sc['profile'].upper()}")
        lines.append(f"  Overall: {sc['overall_recommendation']}")
        lines.append("=" * 80)

        # Descriptors
        lines.append("\n  --- MOLECULAR DESCRIPTORS ---")
        desc = sc["descriptors"]
        for key in ["MW", "LogP", "HBD", "HBA", "TPSA", "RotBonds", "Fsp3",
                     "NumRings", "AromaticRings", "HeavyAtoms", "BertzCT", "MR"]:
            lines.append(f"    {key:<20} {desc[key]}")

        # Scores
        lines.append("\n  --- SCORES ---")
        lines.append(f"    {'QED':<20} {sc['QED']}")
        lines.append(f"    {'SA score':<20} {sc['SA_score']}")

        # Rule evaluations
        lines.append("\n  --- RULE EVALUATIONS ---")
        rules = [
            ("Lipinski Ro5", sc["Lipinski_violations"], sc["Lipinski_details"]),
            ("Veber rules", sc["Veber_violations"], sc["Veber_details"]),
            ("Lead-likeness", sc["Lead_likeness_violations"], sc["Lead_likeness_details"]),
            ("Fragment Ro3", sc["Fragment_Ro3_violations"], sc["Fragment_Ro3_details"]),
            ("Beyond Ro5", sc["bRo5_violations"], sc["bRo5_details"]),
        ]
        for rule_name, n_viol, details in rules:
            status = "PASS" if n_viol == 0 else f"{n_viol} violation(s)"
            lines.append(f"    {rule_name:<20} {status}")
            for d in details:
                lines.append(f"      - {d}")

        # CNS MPO if applicable
        if "CNS_MPO_score" in sc:
            lines.append(f"\n  --- CNS MPO SCORE: {sc['CNS_MPO_score']}/6 ---")
            for k, v in sc["CNS_MPO_details"].items():
                lines.append(f"    {k:<20} {v}")

        # Profile evaluation
        lines.append(f"\n  --- PROFILE EVALUATION ({sc['profile'].upper()}) ---")
        for criterion, verdict, detail in sc["profile_evaluation"]:
            marker = "[PASS]" if verdict == "PASS" else "[CAUTION]" if verdict == "CAUTION" else "[FAIL]"
            lines.append(f"    {criterion:<30} {marker:<12} {detail}")

        lines.append(f"\n  >>> OVERALL RECOMMENDATION: {sc['overall_recommendation']} <<<")
        lines.append("")

    return "\n".join(lines)


def scorecards_to_csv_rows(scorecards):
    """Flatten scorecards to CSV rows."""
    rows = []
    for sc in scorecards:
        row = {
            "Name": sc["name"],
            "SMILES": sc["smiles"],
            "Profile": sc["profile"],
            "Overall": sc["overall_recommendation"],
            "QED": sc["QED"],
            "SA_score": sc["SA_score"],
            "Lipinski_violations": sc["Lipinski_violations"],
            "Veber_violations": sc["Veber_violations"],
            "Lead_likeness_violations": sc["Lead_likeness_violations"],
            "Fragment_Ro3_violations": sc["Fragment_Ro3_violations"],
            "bRo5_violations": sc["bRo5_violations"],
        }
        # Add all descriptors
        for k, v in sc["descriptors"].items():
            row[k] = v
        # CNS MPO if present
        if "CNS_MPO_score" in sc:
            row["CNS_MPO_score"] = sc["CNS_MPO_score"]
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
        description="Drug-likeness scoring with profile-specific evaluation.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python drug_likeness.py --input "CC(=O)Oc1ccccc1C(=O)O" --profile oral
  python drug_likeness.py --input candidates.csv --profile cns --output dl_scores.csv
  python drug_likeness.py --input "C1CCCCC1" --profile topical
        """,
    )
    parser.add_argument(
        "--input", required=True,
        help="SMILES string (comma-separated for multiple) or path to CSV file."
    )
    parser.add_argument(
        "--output", default=None,
        help="Output CSV file path."
    )
    parser.add_argument(
        "--profile", choices=["oral", "cns", "topical", "injectable"], default="oral",
        help="Drug-likeness profile to evaluate against. Default: oral."
    )

    args = parser.parse_args()

    molecules = parse_input(args.input)
    if not molecules:
        print("ERROR: No valid molecules found in input.", file=sys.stderr)
        sys.exit(1)

    print(f"Processing {len(molecules)} molecule(s) for drug-likeness ({args.profile} profile)...\n",
          file=sys.stderr)

    scorecards = []
    for name, mol in molecules:
        sc = compute_scorecard(mol, name=name, profile=args.profile)
        scorecards.append(sc)

    # Print formatted table
    print(format_scorecard_table(scorecards))

    # Write CSV if requested
    if args.output:
        rows = scorecards_to_csv_rows(scorecards)
        write_csv(rows, args.output)


if __name__ == "__main__":
    main()
