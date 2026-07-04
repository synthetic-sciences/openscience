#!/usr/bin/env python3
"""
Full ADMET Panel Prediction

Predicts Absorption, Distribution, Metabolism, Excretion, and Toxicity properties
for drug candidates using RDKit molecular descriptors and SMARTS-based structural alerts.

Usage:
    python predict_admet.py --input "CCO" --format table
    python predict_admet.py --input candidates.csv --output results.csv --format csv
"""

import argparse
import csv
import json
import math
import os
import sys

try:
    from rdkit import Chem
    from rdkit.Chem import Descriptors, rdMolDescriptors, FilterCatalog, Crippen
    from rdkit.Chem.FilterCatalog import FilterCatalogParams
except ImportError:
    print("ERROR: RDKit is required. Install with: pip install rdkit-pypi", file=sys.stderr)
    sys.exit(1)

try:
    import pandas as pd
    HAS_PANDAS = True
except ImportError:
    HAS_PANDAS = False

try:
    import numpy as np
    HAS_NUMPY = True
except ImportError:
    HAS_NUMPY = False


# ---------------------------------------------------------------------------
# Traffic-light helpers
# ---------------------------------------------------------------------------

def traffic_light_qed(val):
    if val > 0.67:
        return "GREEN"
    elif val >= 0.49:
        return "YELLOW"
    return "RED"


def traffic_light_logp(val):
    if -0.4 <= val <= 3.5:
        return "GREEN"
    elif 3.5 < val <= 5.0:
        return "YELLOW"
    return "RED"


def traffic_light_mw(val):
    if 150 <= val <= 500:
        return "GREEN"
    elif 500 < val <= 700:
        return "YELLOW"
    return "RED"


def traffic_light_tpsa(val):
    if val < 90:
        return "GREEN"
    elif val <= 140:
        return "YELLOW"
    return "RED"


def traffic_light_hbd(val):
    if val <= 5:
        return "GREEN"
    elif val <= 7:
        return "YELLOW"
    return "RED"


def traffic_light_hba(val):
    if val <= 10:
        return "GREEN"
    elif val <= 12:
        return "YELLOW"
    return "RED"


def traffic_light_rotbonds(val):
    if val <= 10:
        return "GREEN"
    elif val <= 13:
        return "YELLOW"
    return "RED"


def traffic_light_logs(val):
    if val > -4:
        return "GREEN"
    elif val >= -6:
        return "YELLOW"
    return "RED"


def traffic_light_lipinski(violations):
    if violations == 0:
        return "GREEN"
    elif violations == 1:
        return "YELLOW"
    return "RED"


def traffic_light_herg(n_alerts):
    if n_alerts == 0:
        return "GREEN"
    elif n_alerts == 1:
        return "YELLOW"
    return "RED"


def traffic_light_ames(n_alerts):
    if n_alerts == 0:
        return "GREEN"
    return "RED"


def traffic_light_dili(n_alerts):
    if n_alerts == 0:
        return "GREEN"
    elif n_alerts == 1:
        return "YELLOW"
    return "RED"


def traffic_light_pains(n_alerts):
    if n_alerts == 0:
        return "GREEN"
    elif n_alerts == 1:
        return "YELLOW"
    return "RED"


def traffic_light_sa(val):
    if val <= 4:
        return "GREEN"
    elif val <= 6:
        return "YELLOW"
    return "RED"


# ---------------------------------------------------------------------------
# ESOL solubility model (Delaney 2004)
# ---------------------------------------------------------------------------

def compute_esol(mol):
    """Estimate aqueous solubility (logS) using Delaney's ESOL equation."""
    logp = Crippen.MolLogP(mol)
    mw = Descriptors.MolWt(mol)
    rb = rdMolDescriptors.CalcNumRotatableBonds(mol)
    ap = _aromatic_proportion(mol)
    # Delaney ESOL: logS = 0.16 - 0.63*logP - 0.0062*MW + 0.066*RB - 0.74*AP
    logs = 0.16 - 0.63 * logp - 0.0062 * mw + 0.066 * rb - 0.74 * ap
    return round(logs, 2)


def _aromatic_proportion(mol):
    """Fraction of atoms that are aromatic."""
    n_atoms = mol.GetNumHeavyAtoms()
    if n_atoms == 0:
        return 0.0
    aromatic = sum(1 for atom in mol.GetAtoms() if atom.GetIsAromatic())
    return aromatic / n_atoms


# ---------------------------------------------------------------------------
# Synthetic Accessibility score (Ertl & Schuffenhauer approximation)
# ---------------------------------------------------------------------------

def compute_sa_score(mol):
    """
    Simplified SA score estimate (1-10 scale, 1=easy, 10=hard).
    Uses fragment-based heuristics: ring complexity, stereocenters,
    macrocycles, spiro/bridged systems, and heteroatom diversity.
    """
    ri = mol.GetRingInfo()
    n_rings = ri.NumRings()
    n_atoms = mol.GetNumHeavyAtoms()
    if n_atoms == 0:
        return 10.0

    # Ring complexity contribution
    ring_sizes = [len(r) for r in ri.AtomRings()]
    large_rings = sum(1 for s in ring_sizes if s > 6)
    fused = max(0, n_rings - len(set().union(*[set(r) for r in ri.AtomRings()])) // 3) if n_rings > 0 and ri.AtomRings() else 0

    # Stereocenters
    n_stereo = len(Chem.FindMolChiralCenters(mol, includeUnassigned=True))

    # Heteroatom diversity
    elements = set(atom.GetAtomicNum() for atom in mol.GetAtoms() if atom.GetAtomicNum() != 6)

    # Sp3 fraction (higher sp3 often harder to synthesize)
    fsp3 = rdMolDescriptors.CalcFractionCSP3(mol)

    # Bertz complexity
    bertz = Descriptors.BertzCT(mol)
    bertz_norm = min(bertz / 1000.0, 3.0)

    score = 1.0
    score += min(n_rings * 0.3, 2.0)
    score += large_rings * 0.5
    score += n_stereo * 0.3
    score += len(elements) * 0.15
    score += fsp3 * 0.5
    score += bertz_norm
    score += fused * 0.2

    # Size penalty
    if n_atoms > 35:
        score += (n_atoms - 35) * 0.05

    return round(min(max(score, 1.0), 10.0), 2)


# ---------------------------------------------------------------------------
# QED (Quantitative Estimate of Drug-likeness)
# ---------------------------------------------------------------------------

def compute_qed(mol):
    """Compute QED score (Bickerton et al. 2012) using RDKit."""
    try:
        from rdkit.Chem.QED import qed
        return round(qed(mol), 3)
    except ImportError:
        # Fallback: simplified QED-like score based on desirability functions
        mw = Descriptors.MolWt(mol)
        logp = Crippen.MolLogP(mol)
        hbd = rdMolDescriptors.CalcNumHBD(mol)
        hba = rdMolDescriptors.CalcNumHBA(mol)
        tpsa = rdMolDescriptors.CalcTPSA(mol)
        rb = rdMolDescriptors.CalcNumRotatableBonds(mol)
        arom = rdMolDescriptors.CalcNumAromaticRings(mol)
        # Simple desirability (Gaussian around optimal values)
        def _gauss(x, mu, sigma):
            return math.exp(-0.5 * ((x - mu) / sigma) ** 2)
        d_mw = _gauss(mw, 300, 150)
        d_logp = _gauss(logp, 2.0, 1.5)
        d_hbd = _gauss(hbd, 1, 2)
        d_hba = _gauss(hba, 4, 3)
        d_tpsa = _gauss(tpsa, 70, 40)
        d_rb = _gauss(rb, 4, 3)
        d_arom = _gauss(arom, 2, 1.5)
        qed_val = (d_mw * d_logp * d_hbd * d_hba * d_tpsa * d_rb * d_arom) ** (1.0 / 7.0)
        return round(qed_val, 3)


# ---------------------------------------------------------------------------
# Lipinski Rule of Five
# ---------------------------------------------------------------------------

def lipinski_violations(mol):
    """Count Lipinski Ro5 violations."""
    violations = 0
    if Descriptors.MolWt(mol) > 500:
        violations += 1
    if Crippen.MolLogP(mol) > 5:
        violations += 1
    if rdMolDescriptors.CalcNumHBD(mol) > 5:
        violations += 1
    if rdMolDescriptors.CalcNumHBA(mol) > 10:
        violations += 1
    return violations


# ---------------------------------------------------------------------------
# SMARTS-based structural alerts
# ---------------------------------------------------------------------------

# hERG liability pharmacophore patterns
HERG_SMARTS = [
    ("[NX3;H2,H1,H0;+0;!$(NC=O)]c1ccccc1", "Basic nitrogen near aromatic ring"),
    ("[NX3;H2,H1,H0;+0]CCc1ccccc1", "Basic nitrogen ethyl-linked to aromatic"),
    ("[NX3;H2,H1;+0]CCOc1ccccc1", "Basic amine ethoxyaryl"),
    ("[NX3;H2,H1,H0;+1]", "Quaternary/protonated nitrogen"),
    ("c1ccc2c(c1)CCc1ccccc1C2", "Tricyclic hydrophobic scaffold"),
]

# AMES mutagenicity structural alerts
AMES_SMARTS = [
    ("[NH2]c1ccccc1", "Primary aromatic amine"),
    ("[NH1]c1ccccc1", "Secondary aromatic amine"),
    ("c1ccc(c(c1)[N+](=O)[O-])[NH2]", "Ortho-aminonitrobenzene"),
    ("[N+](=O)[O-]", "Nitro group"),
    ("[N;R]=[N;R]", "Ring diazo"),
    ("[NH]N=O", "N-nitroso"),
    ("N=N", "Azo compound"),
    ("C1(O1)", "Epoxide"),
    ("C1(N1)", "Aziridine"),
    ("[CH2]Cl", "Alkyl halide (chloromethyl)"),
    ("[CH2]Br", "Alkyl halide (bromomethyl)"),
    ("[CH2]I", "Alkyl halide (iodomethyl)"),
    ("OS(=O)(=O)[O-,OH]", "Sulfonate ester"),
    ("C=CC(=O)", "Michael acceptor (enone)"),
    ("C=CC#N", "Michael acceptor (acrylonitrile)"),
    ("c1cc([NH2])cc([NH2])c1", "Diaminobenzene"),
    ("[$(c1ccc2c(c1)ccc1ccccc12)]", "Polycyclic aromatic hydrocarbon"),
    ("c1ccnc2c1ncc1ccccc12", "Acridine-like"),
    ("[N;$(NC=S)]", "Thioamide/thiourea"),
    ("C(=O)Cl", "Acyl halide"),
    ("C(=O)OC(=O)", "Anhydride"),
    ("S(=O)(=O)Cl", "Sulfonyl chloride"),
    ("P(=O)(Cl)", "Phosphoryl chloride"),
    ("[CH]=[NH]", "Aldimine"),
    ("c1cnc2ccccc2n1", "Quinoxaline"),
    ("N#[N+]", "Diazonium"),
    ("[N;H1;$(Nc1ccccc1)]C=O", "N-aryl formamide"),
    ("c1ccc(cc1)N=Nc1ccccc1", "Azobenzene"),
    ("[N;$(NC(=S)N)]", "Thiourea"),
    ("[Se]", "Selenium-containing"),
]

# DILI (Drug-Induced Liver Injury) structural alerts
DILI_SMARTS = [
    ("NN", "Hydrazine"),
    ("[NH]N", "Hydrazide"),
    ("NC(=S)N", "Thiourea"),
    ("c1ccc(cc1)O", "Phenol (metabolic activation)"),
    ("[OH]c1cc(O)ccc1", "Catechol/hydroquinone"),
    ("C(=O)Oc1ccccc1", "Aryl ester (hydrolysis)"),
    ("c1cc(ccc1[NH2])O", "Aminophenol"),
    ("[N;$(NC(=O)c1ccccc1)]", "Anilide"),
    ("C#N", "Nitrile (metabolic activation)"),
    ("C=CC=O", "Alpha,beta-unsaturated aldehyde"),
    ("[N+](=O)[O-]c", "Aromatic nitro"),
]

# CYP substrate/inhibitor SMARTS patterns
CYP3A4_SMARTS = [
    ("c1ccc2c(c1)[nH]c1ccccc12", "Indole (CYP3A4 substrate motif)"),
    ("C1CCCN1c1ncncc1", "Piperidine-pyrimidine (CYP3A4)"),
    ("c1cnc2ccccc2c1", "Quinoline (CYP3A4)"),
    ("c1ccc(-c2ccccn2)cc1", "Biphenyl-pyridine (CYP3A4)"),
]

CYP2D6_SMARTS = [
    ("[NX3;H2,H1;+0]CCc1ccccc1", "Basic N + ethylaryl (CYP2D6)"),
    ("[NX3;H2,H1;+0]CCCc1ccccc1", "Basic N + propylaryl (CYP2D6)"),
    ("c1ccc(cc1)OCCN", "Phenoxyethylamine (CYP2D6)"),
    ("[NX3;H1,H0]Cc1ccccc1", "N-benzylic (CYP2D6)"),
]

CYP2C9_SMARTS = [
    ("c1ccc(cc1)C(=O)O", "Aryl carboxylic acid (CYP2C9)"),
    ("c1ccc(cc1)S(=O)(=O)N", "Aryl sulfonamide (CYP2C9)"),
    ("c1ccc2[nH]c(=O)[nH]c2c1", "Benzimidazolone (CYP2C9)"),
]

# Metabolic soft spots
METABOLIC_SOFT_SPOTS = [
    ("[CH2;$(C(c))]", "Benzylic CH2 (oxidation)"),
    ("[CH3;$(Cc)]", "Aryl methyl (oxidation)"),
    ("[NX3;H1,H0;$(NC)]C", "N-dealkylation site"),
    ("C(=O)OC", "Ester (hydrolysis)"),
    ("C(=O)NC", "Amide N-dealkylation"),
    ("S[CH3]", "S-methyl (S-demethylation)"),
    ("Oc1ccccc1", "Phenol (glucuronidation)"),
    ("c1cc(O)cc(O)c1", "Dihydroxy aromatic (COMT)"),
    ("[SX2]c", "Thioether aryl (S-oxidation)"),
    ("[NH2]c", "Aromatic amine (N-acetylation)"),
]

# Pgp substrate indicators
PGP_SMARTS = [
    ("[NX3;+1]", "Permanent cation (Pgp)"),
    ("c1cc2c(cc1)OCO2", "Methylenedioxy (Pgp substrate motif)"),
]


# ---------------------------------------------------------------------------
# PAINS filter via RDKit FilterCatalog
# ---------------------------------------------------------------------------

def count_pains_alerts(mol):
    """Count PAINS alerts using RDKit's built-in FilterCatalog."""
    try:
        params = FilterCatalogParams()
        params.AddCatalog(FilterCatalogParams.FilterCatalogs.PAINS)
        catalog = FilterCatalog.FilterCatalog(params)
        entry = catalog.GetFirstMatch(mol)
        count = 0
        matches = catalog.GetMatches(mol)
        count = len(matches)
        return count
    except Exception:
        return 0


def count_smarts_alerts(mol, alert_list):
    """Count how many SMARTS from alert_list match the molecule. Returns (count, matched_names)."""
    matched = []
    for smarts_str, name in alert_list:
        pattern = Chem.MolFromSmarts(smarts_str)
        if pattern is None:
            continue
        if mol.HasSubstructMatch(pattern):
            matched.append(name)
    return len(matched), matched


# ---------------------------------------------------------------------------
# Absorption predictions
# ---------------------------------------------------------------------------

def predict_absorption(mol):
    """Predict absorption endpoints."""
    results = {}
    tpsa = rdMolDescriptors.CalcTPSA(mol)
    mw = Descriptors.MolWt(mol)
    logp = Crippen.MolLogP(mol)
    hbd = rdMolDescriptors.CalcNumHBD(mol)
    hba = rdMolDescriptors.CalcNumHBA(mol)
    rb = rdMolDescriptors.CalcNumRotatableBonds(mol)

    # Caco-2 permeability class
    if tpsa < 90:
        caco2_class = "High"
        caco2_tl = "GREEN"
    elif tpsa <= 140:
        caco2_class = "Medium"
        caco2_tl = "YELLOW"
    else:
        caco2_class = "Low"
        caco2_tl = "RED"
    results["Caco2_class"] = (caco2_class, caco2_tl)

    # HIA (Human Intestinal Absorption)
    if tpsa < 140 and rb <= 10:
        hia = "Likely high"
        hia_tl = "GREEN"
    elif tpsa < 140 or rb <= 10:
        hia = "Uncertain"
        hia_tl = "YELLOW"
    else:
        hia = "Likely low"
        hia_tl = "RED"
    results["HIA"] = (hia, hia_tl)

    # Pgp substrate likelihood
    pgp_alert_count, pgp_names = count_smarts_alerts(mol, PGP_SMARTS)
    if mw > 400 and tpsa > 130:
        pgp = "Likely substrate"
        pgp_tl = "RED"
    elif pgp_alert_count > 0 or (mw > 400 or tpsa > 100):
        pgp = "Possible substrate"
        pgp_tl = "YELLOW"
    else:
        pgp = "Unlikely substrate"
        pgp_tl = "GREEN"
    results["Pgp_substrate"] = (pgp, pgp_tl)

    # LogS (ESOL)
    logs = compute_esol(mol)
    logs_tl = traffic_light_logs(logs)
    results["LogS_ESOL"] = (str(logs), logs_tl)

    # Solubility class
    if logs > -2:
        sol_class = "Highly soluble"
    elif logs > -4:
        sol_class = "Soluble"
    elif logs > -6:
        sol_class = "Moderately soluble"
    else:
        sol_class = "Poorly soluble"
    results["Solubility_class"] = (sol_class, logs_tl)

    return results


# ---------------------------------------------------------------------------
# Distribution predictions
# ---------------------------------------------------------------------------

def predict_distribution(mol):
    """Predict distribution endpoints."""
    results = {}
    logp = Crippen.MolLogP(mol)
    tpsa = rdMolDescriptors.CalcTPSA(mol)
    mw = Descriptors.MolWt(mol)

    # BBB penetration estimate
    bbb_score = logp - (tpsa / 60.0)
    if bbb_score > 0 and mw < 450 and tpsa < 90:
        bbb = "Likely CNS penetrant"
        bbb_tl = "GREEN"
    elif bbb_score > -0.5:
        bbb = "Uncertain"
        bbb_tl = "YELLOW"
    else:
        bbb = "Unlikely CNS penetrant"
        bbb_tl = "RED"
    results["BBB_penetration"] = (bbb, bbb_tl)
    results["BBB_score"] = (str(round(bbb_score, 2)), bbb_tl)

    # Plasma Protein Binding estimate
    if logp > 4:
        ppb = ">95% (high)"
        ppb_tl = "YELLOW"
    elif logp > 2.5:
        ppb = "80-95% (moderate-high)"
        ppb_tl = "GREEN"
    elif logp > 0:
        ppb = "50-80% (moderate)"
        ppb_tl = "GREEN"
    else:
        ppb = "<50% (low)"
        ppb_tl = "GREEN"
    results["PPB_estimate"] = (ppb, ppb_tl)

    # VDss estimate
    # Lipophilic and basic compounds tend to have higher VDss
    has_basic_n = mol.HasSubstructMatch(Chem.MolFromSmarts("[NX3;H2,H1,H0;+0;!$(NC=O)]"))
    if logp > 3 and has_basic_n:
        vdss = "High (>2 L/kg, tissue distribution)"
        vdss_tl = "YELLOW"
    elif logp > 1:
        vdss = "Moderate (0.5-2 L/kg)"
        vdss_tl = "GREEN"
    else:
        vdss = "Low (<0.5 L/kg, plasma confined)"
        vdss_tl = "GREEN"
    results["VDss_estimate"] = (vdss, vdss_tl)

    return results


# ---------------------------------------------------------------------------
# Metabolism predictions
# ---------------------------------------------------------------------------

def predict_metabolism(mol):
    """Predict metabolism endpoints."""
    results = {}
    mw = Descriptors.MolWt(mol)
    logp = Crippen.MolLogP(mol)

    # CYP3A4 liability
    cyp3a4_count, cyp3a4_names = count_smarts_alerts(mol, CYP3A4_SMARTS)
    if mw > 350 and logp > 2:
        cyp3a4_count += 1
        cyp3a4_names.append("Large lipophilic molecule")
    if cyp3a4_count >= 2:
        cyp3a4 = "Likely substrate/inhibitor"
        cyp3a4_tl = "RED"
    elif cyp3a4_count == 1:
        cyp3a4 = "Possible substrate"
        cyp3a4_tl = "YELLOW"
    else:
        cyp3a4 = "Low liability"
        cyp3a4_tl = "GREEN"
    results["CYP3A4_liability"] = (cyp3a4, cyp3a4_tl)
    if cyp3a4_names:
        results["CYP3A4_alerts"] = ("; ".join(cyp3a4_names), cyp3a4_tl)

    # CYP2D6 liability
    cyp2d6_count, cyp2d6_names = count_smarts_alerts(mol, CYP2D6_SMARTS)
    if cyp2d6_count >= 2:
        cyp2d6 = "Likely substrate"
        cyp2d6_tl = "RED"
    elif cyp2d6_count == 1:
        cyp2d6 = "Possible substrate"
        cyp2d6_tl = "YELLOW"
    else:
        cyp2d6 = "Low liability"
        cyp2d6_tl = "GREEN"
    results["CYP2D6_liability"] = (cyp2d6, cyp2d6_tl)
    if cyp2d6_names:
        results["CYP2D6_alerts"] = ("; ".join(cyp2d6_names), cyp2d6_tl)

    # CYP2C9 liability
    cyp2c9_count, cyp2c9_names = count_smarts_alerts(mol, CYP2C9_SMARTS)
    if cyp2c9_count >= 2:
        cyp2c9 = "Likely substrate"
        cyp2c9_tl = "RED"
    elif cyp2c9_count == 1:
        cyp2c9 = "Possible substrate"
        cyp2c9_tl = "YELLOW"
    else:
        cyp2c9 = "Low liability"
        cyp2c9_tl = "GREEN"
    results["CYP2C9_liability"] = (cyp2c9, cyp2c9_tl)
    if cyp2c9_names:
        results["CYP2C9_alerts"] = ("; ".join(cyp2c9_names), cyp2c9_tl)

    # Metabolic soft spots
    soft_count, soft_names = count_smarts_alerts(mol, METABOLIC_SOFT_SPOTS)
    if soft_count >= 4:
        soft = f"{soft_count} soft spots (high metabolic liability)"
        soft_tl = "RED"
    elif soft_count >= 2:
        soft = f"{soft_count} soft spots (moderate metabolic liability)"
        soft_tl = "YELLOW"
    elif soft_count == 1:
        soft = f"1 soft spot"
        soft_tl = "GREEN"
    else:
        soft = "No major soft spots identified"
        soft_tl = "GREEN"
    results["Metabolic_soft_spots"] = (soft, soft_tl)
    if soft_names:
        results["Soft_spot_details"] = ("; ".join(soft_names), soft_tl)

    return results


# ---------------------------------------------------------------------------
# Excretion predictions
# ---------------------------------------------------------------------------

def predict_excretion(mol):
    """Predict excretion endpoints."""
    results = {}
    mw = Descriptors.MolWt(mol)
    logp = Crippen.MolLogP(mol)
    tpsa = rdMolDescriptors.CalcTPSA(mol)

    # Clearance class estimate
    if mw < 350 and logp < 1 and tpsa > 80:
        clearance = "Likely renal (small, polar)"
        clearance_tl = "GREEN"
    elif logp > 3 and mw > 400:
        clearance = "Likely hepatic (large, lipophilic)"
        clearance_tl = "YELLOW"
    elif logp > 2:
        clearance = "Likely hepatic (moderate lipophilicity)"
        clearance_tl = "GREEN"
    else:
        clearance = "Mixed renal/hepatic"
        clearance_tl = "GREEN"
    results["Clearance_route"] = (clearance, clearance_tl)

    # Clearance rate estimate
    if logp > 4 and mw > 500:
        rate = "High clearance risk"
        rate_tl = "RED"
    elif logp > 3:
        rate = "Moderate clearance"
        rate_tl = "YELLOW"
    else:
        rate = "Low-moderate clearance"
        rate_tl = "GREEN"
    results["Clearance_rate"] = (rate, rate_tl)

    return results


# ---------------------------------------------------------------------------
# Toxicity predictions
# ---------------------------------------------------------------------------

def predict_toxicity(mol):
    """Predict toxicity endpoints."""
    results = {}

    # hERG liability
    herg_count, herg_names = count_smarts_alerts(mol, HERG_SMARTS)
    results["hERG_alerts"] = (str(herg_count), traffic_light_herg(herg_count))
    if herg_names:
        results["hERG_details"] = ("; ".join(herg_names), traffic_light_herg(herg_count))

    # AMES mutagenicity
    ames_count, ames_names = count_smarts_alerts(mol, AMES_SMARTS)
    results["AMES_alerts"] = (str(ames_count), traffic_light_ames(ames_count))
    if ames_names:
        results["AMES_details"] = ("; ".join(ames_names), traffic_light_ames(ames_count))

    # DILI (Hepatotoxicity)
    dili_count, dili_names = count_smarts_alerts(mol, DILI_SMARTS)
    results["DILI_alerts"] = (str(dili_count), traffic_light_dili(dili_count))
    if dili_names:
        results["DILI_details"] = ("; ".join(dili_names), traffic_light_dili(dili_count))

    # PAINS
    pains_count = count_pains_alerts(mol)
    results["PAINS_alerts"] = (str(pains_count), traffic_light_pains(pains_count))

    return results


# ---------------------------------------------------------------------------
# Drug-likeness summary
# ---------------------------------------------------------------------------

def predict_druglikeness(mol):
    """Compute drug-likeness summary metrics."""
    results = {}

    mw = Descriptors.MolWt(mol)
    logp = Crippen.MolLogP(mol)
    hbd = rdMolDescriptors.CalcNumHBD(mol)
    hba = rdMolDescriptors.CalcNumHBA(mol)
    tpsa = rdMolDescriptors.CalcTPSA(mol)
    rb = rdMolDescriptors.CalcNumRotatableBonds(mol)

    results["MW"] = (str(round(mw, 1)), traffic_light_mw(mw))
    results["LogP"] = (str(round(logp, 2)), traffic_light_logp(logp))
    results["HBD"] = (str(hbd), traffic_light_hbd(hbd))
    results["HBA"] = (str(hba), traffic_light_hba(hba))
    results["TPSA"] = (str(round(tpsa, 1)), traffic_light_tpsa(tpsa))
    results["RotBonds"] = (str(rb), traffic_light_rotbonds(rb))

    # Lipinski
    lip_v = lipinski_violations(mol)
    results["Lipinski_violations"] = (str(lip_v), traffic_light_lipinski(lip_v))

    # QED
    qed_val = compute_qed(mol)
    results["QED"] = (str(qed_val), traffic_light_qed(qed_val))

    # SA score
    sa = compute_sa_score(mol)
    results["SA_score"] = (str(sa), traffic_light_sa(sa))

    # Fsp3
    fsp3 = rdMolDescriptors.CalcFractionCSP3(mol)
    fsp3_tl = "GREEN" if fsp3 >= 0.25 else ("YELLOW" if fsp3 >= 0.1 else "RED")
    results["Fsp3"] = (str(round(fsp3, 3)), fsp3_tl)

    return results


# ---------------------------------------------------------------------------
# Full ADMET panel
# ---------------------------------------------------------------------------

def run_full_panel(mol, name="Compound"):
    """Run the complete ADMET panel for a single molecule."""
    all_results = {}
    all_results["Name"] = (name, "")

    smiles = Chem.MolToSmiles(mol)
    all_results["SMILES"] = (smiles, "")

    # Drug-likeness
    dl = predict_druglikeness(mol)
    for k, v in dl.items():
        all_results[k] = v

    # Absorption
    ab = predict_absorption(mol)
    for k, v in ab.items():
        all_results[k] = v

    # Distribution
    di = predict_distribution(mol)
    for k, v in di.items():
        all_results[k] = v

    # Metabolism
    me = predict_metabolism(mol)
    for k, v in me.items():
        all_results[k] = v

    # Excretion
    ex = predict_excretion(mol)
    for k, v in ex.items():
        all_results[k] = v

    # Toxicity
    tx = predict_toxicity(mol)
    for k, v in tx.items():
        all_results[k] = v

    return all_results


# ---------------------------------------------------------------------------
# Input parsing
# ---------------------------------------------------------------------------

def parse_input(input_arg):
    """Parse input: either a SMILES string or a CSV file path. Returns list of (name, mol)."""
    molecules = []

    if os.path.isfile(input_arg):
        with open(input_arg, "r") as f:
            reader = csv.DictReader(f)
            fieldnames = [fn.strip().lower() for fn in reader.fieldnames] if reader.fieldnames else []
            # Find smiles column
            smiles_col = None
            name_col = None
            for fn in reader.fieldnames or []:
                fl = fn.strip().lower()
                if fl in ("smiles", "smi", "canonical_smiles", "smiles_string"):
                    smiles_col = fn
                elif fl in ("name", "compound", "id", "compound_name", "mol_name"):
                    name_col = fn

            if smiles_col is None:
                # Try first column as SMILES
                if reader.fieldnames:
                    smiles_col = reader.fieldnames[0]
                    if len(reader.fieldnames) > 1:
                        name_col = reader.fieldnames[1]

            # Re-read file
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
        # Treat as SMILES string (could be comma-separated)
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

def format_table(all_results_list):
    """Format results as a human-readable table."""
    lines = []
    for result in all_results_list:
        name = result.get("Name", ("Unknown", ""))[0]
        smiles = result.get("SMILES", ("", ""))[0]
        lines.append("=" * 80)
        lines.append(f"  ADMET Profile: {name}")
        lines.append(f"  SMILES: {smiles}")
        lines.append("=" * 80)

        # Group endpoints
        sections = {
            "DRUG-LIKENESS": ["MW", "LogP", "HBD", "HBA", "TPSA", "RotBonds",
                              "Lipinski_violations", "QED", "SA_score", "Fsp3"],
            "ABSORPTION": ["Caco2_class", "HIA", "Pgp_substrate", "LogS_ESOL",
                           "Solubility_class"],
            "DISTRIBUTION": ["BBB_penetration", "BBB_score", "PPB_estimate",
                             "VDss_estimate"],
            "METABOLISM": ["CYP3A4_liability", "CYP3A4_alerts", "CYP2D6_liability",
                           "CYP2D6_alerts", "CYP2C9_liability", "CYP2C9_alerts",
                           "Metabolic_soft_spots", "Soft_spot_details"],
            "EXCRETION": ["Clearance_route", "Clearance_rate"],
            "TOXICITY": ["hERG_alerts", "hERG_details", "AMES_alerts", "AMES_details",
                         "DILI_alerts", "DILI_details", "PAINS_alerts"],
        }

        for section_name, keys in sections.items():
            lines.append(f"\n  --- {section_name} ---")
            for key in keys:
                if key in result:
                    val, tl = result[key]
                    tl_str = f"[{tl}]" if tl else ""
                    label = key.replace("_", " ")
                    lines.append(f"    {label:<28} {val:<45} {tl_str}")

        lines.append("")

    # Summary of alerts
    lines.append("-" * 80)
    lines.append("  TRAFFIC LIGHT SUMMARY")
    lines.append("-" * 80)
    for result in all_results_list:
        name = result.get("Name", ("Unknown", ""))[0]
        reds = sum(1 for k, (v, tl) in result.items() if tl == "RED")
        yellows = sum(1 for k, (v, tl) in result.items() if tl == "YELLOW")
        greens = sum(1 for k, (v, tl) in result.items() if tl == "GREEN")
        lines.append(f"  {name}: {greens} GREEN, {yellows} YELLOW, {reds} RED")

    lines.append("")
    return "\n".join(lines)


def results_to_flat_dict(result):
    """Convert a result dict to a flat dict for CSV/JSON output."""
    flat = {}
    for key, (val, tl) in result.items():
        flat[key] = val
        if tl:
            flat[f"{key}_flag"] = tl
    return flat


def format_csv(all_results_list, output_path=None):
    """Format results as CSV. If output_path given, write to file."""
    flat_list = [results_to_flat_dict(r) for r in all_results_list]
    all_keys = []
    seen = set()
    for flat in flat_list:
        for k in flat:
            if k not in seen:
                all_keys.append(k)
                seen.add(k)

    if output_path:
        with open(output_path, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=all_keys)
            writer.writeheader()
            for flat in flat_list:
                writer.writerow(flat)
        print(f"Results written to {output_path}")
    else:
        import io
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=all_keys)
        writer.writeheader()
        for flat in flat_list:
            writer.writerow(flat)
        return buf.getvalue()


def format_json(all_results_list):
    """Format results as JSON."""
    flat_list = [results_to_flat_dict(r) for r in all_results_list]
    return json.dumps(flat_list, indent=2)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Full ADMET panel prediction for drug candidates.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python predict_admet.py --input "CC(=O)Oc1ccccc1C(=O)O" --format table
  python predict_admet.py --input candidates.csv --output results.csv --format csv
  python predict_admet.py --input "c1ccccc1,CCO" --format json
        """,
    )
    parser.add_argument(
        "--input", required=True,
        help="SMILES string (comma-separated for multiple) or path to CSV file with name,smiles columns."
    )
    parser.add_argument(
        "--output", default=None,
        help="Output file path (CSV). If not specified, results are printed to stdout."
    )
    parser.add_argument(
        "--format", choices=["table", "csv", "json"], default="table",
        help="Output format: table (human-readable), csv, or json. Default: table."
    )

    args = parser.parse_args()

    molecules = parse_input(args.input)
    if not molecules:
        print("ERROR: No valid molecules found in input.", file=sys.stderr)
        sys.exit(1)

    print(f"Processing {len(molecules)} molecule(s)...\n", file=sys.stderr)

    all_results = []
    for name, mol in molecules:
        result = run_full_panel(mol, name=name)
        all_results.append(result)

    if args.format == "table":
        print(format_table(all_results))
    elif args.format == "csv":
        if args.output:
            format_csv(all_results, output_path=args.output)
        else:
            print(format_csv(all_results))
    elif args.format == "json":
        output = format_json(all_results)
        if args.output:
            with open(args.output, "w") as f:
                f.write(output)
            print(f"Results written to {args.output}")
        else:
            print(output)


if __name__ == "__main__":
    main()
