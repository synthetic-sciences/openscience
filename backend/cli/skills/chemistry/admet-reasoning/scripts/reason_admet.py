#!/usr/bin/env python3
"""
ADMET Reasoning — Interpretable ADMET analysis with mechanistic explanations.

Maps each ADMET liability to structural cause, biological mechanism, and suggested fix.
Based on CoTox (Park et al., 2025) and DrugR (Liu et al., 2026).

Usage:
    python reason_admet.py --smiles "c1ccc(NC(=O)c2ccccc2Cl)cc1" --output report.json
    python reason_admet.py --input compounds.csv --output report.csv
"""

import argparse
import json
import sys

try:
    from rdkit import Chem
    from rdkit.Chem import Descriptors, QED, rdMolDescriptors, Fragments
    from rdkit import RDLogger
    RDLogger.logger().setLevel(RDLogger.ERROR)
except ImportError:
    print("Error: rdkit-pypi required.", file=sys.stderr)
    sys.exit(1)


# ADMET thresholds from DrugR (Liu et al., 2026)
THRESHOLDS = {
    'LogP': {'min': 1.0, 'max': 3.0, 'severity': 'medium'},
    'LogS_est': {'min': -4.0, 'severity': 'medium'},
    'MW': {'min': 150, 'max': 500, 'severity': 'medium'},
    'TPSA': {'min': 20, 'max': 130, 'severity': 'medium'},
    'QED': {'min': 0.5, 'severity': 'low'},
    'HBA': {'max': 10, 'severity': 'low'},
    'HBD': {'max': 5, 'severity': 'low'},
    'RotBonds': {'max': 10, 'severity': 'low'},
}

# Structural alerts mapped to ADMET endpoints
# Each alert: (SMARTS, endpoint, cause, mechanism, fix)
STRUCTURAL_ALERTS = [
    # hERG liabilities
    ('[NH1]1CCNCC1', 'hERG', 'Basic piperazine (pKa ~8.5)',
     'Basic amines bind hERG channel inner vestibule via cation-π interactions',
     'Replace piperazine with morpholine to reduce basicity while maintaining H-bond acceptor'),
    ('[NH1]1CCCCC1', 'hERG', 'Basic piperidine',
     'Lipophilic basic amines are classic hERG pharmacophores — they block the potassium channel',
     'Reduce basicity: N-acylation, replace with tetrahydropyran, or add polar substituent'),
    ('[nH1]1cccc1', 'hERG', 'Aromatic nitrogen in 5-membered ring',
     'Electron-rich heteroaromatics can interact with hERG channel aromatic residues',
     'Consider N-methylation or ring expansion'),

    # DILI / hepatotoxicity
    ('c1cc(=O)[nH]c(=O)c1', 'DILI', 'Uracil / pyrimidinedione scaffold',
     'Known hepatotoxic scaffold — CYP-mediated bioactivation to reactive epoxide intermediates',
     'Consider bioisosteric replacement of the dione motif'),
    ('[N+](=O)[O-]', 'DILI', 'Nitro group',
     'Nitro groups undergo nitroreduction to reactive nitroso and hydroxylamine metabolites causing oxidative stress',
     'Replace nitro with cyano, trifluoromethyl, or methylsulfonyl'),
    ('c1ccc2c(c1)ccc1ccccc12', 'DILI', 'Naphthalene ring system',
     'Polycyclic aromatic hydrocarbons undergo CYP-mediated oxidation to reactive epoxides causing hepatocyte damage',
     'Break into monocyclic system or add polar substituents to block metabolic sites'),

    # CYP inhibition
    ('[nH0]1cccc1', 'CYP', 'Unsubstituted imidazole/triazole',
     'Azole nitrogen coordinates to CYP heme iron, blocking the active site',
     'N-methylation or replacement with non-coordinating heterocycle'),
    ('c1ccc(-c2ccccc2)cc1', 'CYP', 'Biphenyl system',
     'Planar aromatic systems are CYP3A4 substrates due to hydrophobic channel fitting',
     'Introduce sp3 carbon to break planarity, or add polar group'),

    # Solubility
    ('c1ccc2ccccc2c1', 'Solubility', 'Fused aromatic rings',
     'Extended aromatic systems increase crystal packing energy and reduce aqueous solubility',
     'Disrupt planarity with sp3 centers, reduce ring count, or add solubilizing groups (OH, NH2)'),

    # Mutagenicity
    ('[NH2]c1ccccc1', 'AMES', 'Aromatic amine',
     'Aromatic amines undergo N-hydroxylation by CYP1A2 forming electrophilic nitrenium ions that react with DNA',
     'Acetylation (amide), N-methylation, or replacement with non-amino substituent'),
    ('c1cc([N+](=O)[O-])ccc1[NH2]', 'AMES', 'Para-nitroaniline',
     'Classic Ames-positive structural alert — nitroreduction + amine activation creates potent DNA-reactive species',
     'Remove either the nitro or amino group; replace with non-reactive bioisostere'),
]


def compute_properties(smiles):
    """Compute ADMET-relevant properties."""
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return None, None

    props = {
        'MW': round(Descriptors.MolWt(mol), 1),
        'LogP': round(Descriptors.MolLogP(mol), 2),
        'TPSA': round(Descriptors.TPSA(mol), 1),
        'HBA': Descriptors.NumHAcceptors(mol),
        'HBD': Descriptors.NumHDonors(mol),
        'RotBonds': Descriptors.NumRotatableBonds(mol),
        'AromaticRings': Descriptors.NumAromaticRings(mol),
        'QED': round(QED.qed(mol), 3),
        'NumRings': Descriptors.RingCount(mol),
        'FractionCSP3': round(Descriptors.FractionCSP3(mol), 3),
        'HeavyAtoms': Descriptors.HeavyAtomCount(mol),
    }

    # Estimate LogS (Delaney equation)
    logp = props['LogP']
    mw = props['MW']
    rb = props['RotBonds']
    ap = props['AromaticRings'] / max(props['NumRings'], 1) if props['NumRings'] > 0 else 0
    logs_est = 0.16 - 0.63 * logp - 0.0062 * mw + 0.066 * rb - 0.74 * ap
    props['LogS_est'] = round(logs_est, 2)

    return mol, props


def check_structural_alerts(mol, endpoints=None):
    """Check molecule against structural alert database."""
    alerts = []
    for smarts, endpoint, cause, mechanism, fix in STRUCTURAL_ALERTS:
        if endpoints and endpoint not in endpoints:
            continue
        pattern = Chem.MolFromSmarts(smarts)
        if pattern is None:
            continue
        if mol.HasSubstructMatch(pattern):
            matches = mol.GetSubstructMatches(pattern)
            alerts.append({
                'endpoint': endpoint,
                'structural_cause': cause,
                'mechanism': mechanism,
                'suggested_fix': fix,
                'smarts': smarts,
                'num_matches': len(matches),
            })
    return alerts


def check_thresholds(props):
    """Check properties against ADMET thresholds."""
    liabilities = []
    for prop, thresh in THRESHOLDS.items():
        if prop not in props:
            continue
        val = props[prop]
        violation = None
        if 'min' in thresh and 'max' in thresh:
            if val < thresh['min']:
                violation = f"Below minimum ({thresh['min']})"
            elif val > thresh['max']:
                violation = f"Above maximum ({thresh['max']})"
        elif 'min' in thresh and val < thresh['min']:
            violation = f"Below minimum ({thresh['min']})"
        elif 'max' in thresh and val > thresh['max']:
            violation = f"Above maximum ({thresh['max']})"

        if violation:
            liabilities.append({
                'property': prop,
                'value': val,
                'violation': violation,
                'severity': thresh['severity'],
            })

    liabilities.sort(key=lambda x: {'critical': 0, 'high': 1, 'medium': 2, 'low': 3}.get(x['severity'], 99))
    return liabilities


def generate_report(smiles, endpoints=None):
    """Generate full ADMET reasoning report."""
    mol, props = compute_properties(smiles)
    if mol is None:
        return {'error': f'Invalid SMILES: {smiles}'}

    canonical = Chem.MolToSmiles(mol)

    # Threshold-based liabilities
    threshold_liabilities = check_thresholds(props)

    # Structural alerts
    structural_alerts = check_structural_alerts(mol, endpoints)

    # Generate IUPAC-style functional group description
    fg_description = []
    if Descriptors.NumAromaticRings(mol) > 0:
        fg_description.append(f"{Descriptors.NumAromaticRings(mol)} aromatic ring(s)")
    if Descriptors.NumHDonors(mol) > 0:
        fg_description.append(f"{Descriptors.NumHDonors(mol)} H-bond donor(s)")
    if Descriptors.NumHAcceptors(mol) > 0:
        fg_description.append(f"{Descriptors.NumHAcceptors(mol)} H-bond acceptor(s)")
    n_count = sum(1 for a in mol.GetAtoms() if a.GetAtomicNum() == 7)
    if n_count > 0:
        fg_description.append(f"{n_count} nitrogen(s)")
    halogen_count = sum(1 for a in mol.GetAtoms() if a.GetAtomicNum() in (9, 17, 35, 53))
    if halogen_count > 0:
        fg_description.append(f"{halogen_count} halogen(s)")

    # Overall assessment
    total_liabilities = len(threshold_liabilities) + len(structural_alerts)
    if total_liabilities == 0:
        assessment = 'CLEAN — no ADMET liabilities detected'
    elif total_liabilities <= 2:
        assessment = 'MINOR CONCERNS — addressable with targeted modifications'
    elif total_liabilities <= 4:
        assessment = 'MODERATE CONCERNS — optimization needed before advancement'
    else:
        assessment = 'SIGNIFICANT CONCERNS — major redesign may be required'

    return {
        'smiles': canonical,
        'properties': props,
        'functional_groups': fg_description,
        'threshold_liabilities': threshold_liabilities,
        'structural_alerts': structural_alerts,
        'total_liabilities': total_liabilities,
        'assessment': assessment,
    }


def main():
    parser = argparse.ArgumentParser(description='ADMET reasoning with mechanistic explanations')
    parser.add_argument('--smiles', type=str, help='Input SMILES')
    parser.add_argument('--input', type=str, help='Input CSV file')
    parser.add_argument('--smiles-col', type=str, default='SMILES')
    parser.add_argument('--endpoints', type=str, default=None, help='Focus endpoints (comma-sep: hERG,DILI,CYP)')
    parser.add_argument('--output', type=str, default='report.json')

    args = parser.parse_args()
    endpoints = args.endpoints.split(',') if args.endpoints else None

    if args.smiles:
        report = generate_report(args.smiles, endpoints)
        print(json.dumps(report, indent=2))

        # Human-readable summary
        print(f"\n{'='*60}")
        print(f"ADMET REASONING REPORT")
        print(f"{'='*60}")
        print(f"Molecule: {report.get('smiles', 'N/A')}")
        print(f"Assessment: {report.get('assessment', 'N/A')}")

        if report.get('threshold_liabilities'):
            print(f"\nProperty Liabilities:")
            for l in report['threshold_liabilities']:
                print(f"  [{l['severity'].upper()}] {l['property']} = {l['value']} — {l['violation']}")

        if report.get('structural_alerts'):
            print(f"\nStructural Alerts:")
            for a in report['structural_alerts']:
                print(f"\n  [{a['endpoint']}] {a['structural_cause']}")
                print(f"    Mechanism: {a['mechanism']}")
                print(f"    Suggested fix: {a['suggested_fix']}")

        with open(args.output, 'w') as f:
            json.dump(report, f, indent=2)
        print(f"\nFull report saved to {args.output}")

    elif args.input:
        import pandas as pd
        df = pd.read_csv(args.input)
        reports = []
        for _, row in df.iterrows():
            smi = row[args.smiles_col]
            reports.append(generate_report(smi, endpoints))
        with open(args.output, 'w') as f:
            json.dump(reports, f, indent=2)
        flagged = sum(1 for r in reports if r.get('total_liabilities', 0) > 0)
        print(f"Analyzed {len(reports)} molecules: {flagged} with liabilities → {args.output}")

    else:
        print("Error: Provide --smiles or --input", file=sys.stderr)
        return 1

    return 0


if __name__ == '__main__':
    sys.exit(main() or 0)
