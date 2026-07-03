#!/usr/bin/env python3
"""
Candidate Comparison Tool

Compare multiple candidate molecules against a reference, highlighting
property improvements and regressions.

Usage:
    python compare_candidates.py --reference "c1ccccc1" --candidates candidates.csv --output comparison.csv
    python compare_candidates.py --reference "CCO" --smiles "CCCO" "CC(O)C" "CCF"
"""

import argparse
import json
import sys

try:
    from rdkit import Chem
    from rdkit.Chem import Descriptors, QED, AllChem, DataStructs
    from rdkit.Chem.Scaffolds import MurckoScaffold
    from rdkit import RDLogger
    RDLogger.logger().setLevel(RDLogger.ERROR)
except ImportError:
    print("Error: rdkit-pypi required.", file=sys.stderr)
    sys.exit(1)


THRESHOLDS = {
    'MW': {'min': 150, 'max': 500},
    'LogP': {'min': 1.0, 'max': 3.0},
    'TPSA': {'min': 20, 'max': 130},
    'HBA': {'max': 10},
    'HBD': {'max': 5},
    'QED': {'min': 0.5},
}


def compute_props(mol):
    return {
        'MW': round(Descriptors.MolWt(mol), 1),
        'LogP': round(Descriptors.MolLogP(mol), 2),
        'TPSA': round(Descriptors.TPSA(mol), 1),
        'HBA': Descriptors.NumHAcceptors(mol),
        'HBD': Descriptors.NumHDonors(mol),
        'RotBonds': Descriptors.NumRotatableBonds(mol),
        'QED': round(QED.qed(mol), 3),
    }


def is_in_range(prop, val):
    t = THRESHOLDS.get(prop)
    if not t:
        return True
    if 'min' in t and val < t['min']:
        return False
    if 'max' in t and val > t['max']:
        return False
    return True


def similarity(mol1, mol2):
    fp1 = AllChem.GetMorganFingerprintAsBitVect(mol1, 2, nBits=2048)
    fp2 = AllChem.GetMorganFingerprintAsBitVect(mol2, 2, nBits=2048)
    return round(DataStructs.TanimotoSimilarity(fp1, fp2), 4)


def main():
    parser = argparse.ArgumentParser(description='Compare candidate molecules')
    parser.add_argument('--reference', type=str, required=True, help='Reference SMILES')
    parser.add_argument('--smiles', nargs='+', help='Candidate SMILES strings')
    parser.add_argument('--candidates', type=str, help='CSV file with candidates')
    parser.add_argument('--smiles-col', type=str, default='SMILES')
    parser.add_argument('--output', type=str, default='comparison.json')

    args = parser.parse_args()

    ref_mol = Chem.MolFromSmiles(args.reference)
    if ref_mol is None:
        print(f"Error: Invalid reference SMILES: {args.reference}", file=sys.stderr)
        return 1

    ref_props = compute_props(ref_mol)
    ref_canonical = Chem.MolToSmiles(ref_mol)

    candidate_smiles = []
    if args.smiles:
        candidate_smiles = args.smiles
    elif args.candidates:
        import pandas as pd
        df = pd.read_csv(args.candidates)
        candidate_smiles = df[args.smiles_col].tolist()
    else:
        print("Error: Provide --smiles or --candidates", file=sys.stderr)
        return 1

    # Build comparison
    rows = []
    for smi in candidate_smiles:
        mol = Chem.MolFromSmiles(smi)
        if mol is None:
            rows.append({'smiles': smi, 'valid': False})
            continue

        props = compute_props(mol)
        sim = similarity(ref_mol, mol)

        deltas = {}
        improvements = 0
        regressions = 0
        for prop in ref_props:
            if prop in props:
                delta = round(props[prop] - ref_props[prop], 2)
                ref_ok = is_in_range(prop, ref_props[prop])
                new_ok = is_in_range(prop, props[prop])
                if not ref_ok and new_ok:
                    improvements += 1
                    status = 'FIXED'
                elif ref_ok and not new_ok:
                    regressions += 1
                    status = 'BROKEN'
                elif not ref_ok and not new_ok:
                    status = 'still_out'
                else:
                    status = 'ok'
                deltas[prop] = {'ref': ref_props[prop], 'new': props[prop], 'delta': delta, 'status': status}

        rows.append({
            'smiles': Chem.MolToSmiles(mol),
            'valid': True,
            'similarity': sim,
            'properties': props,
            'deltas': deltas,
            'improvements': improvements,
            'regressions': regressions,
            'net_score': improvements - regressions * 0.5,
        })

    rows.sort(key=lambda x: x.get('net_score', -999), reverse=True)

    result = {
        'reference': ref_canonical,
        'reference_properties': ref_props,
        'candidates': rows,
    }

    # Print table
    print(f"\nReference: {ref_canonical}")
    print(f"{'='*80}")
    print(f"{'Rank':<5} {'SMILES':<40} {'Sim':>6} {'Score':>6} {'Fixed':>6} {'Broken':>7}")
    print(f"{'-'*80}")
    for i, row in enumerate(rows):
        if not row.get('valid'):
            print(f"{i+1:<5} {row['smiles'][:40]:<40} {'INVALID':>6}")
            continue
        print(f"{i+1:<5} {row['smiles'][:40]:<40} {row['similarity']:>6.3f} {row['net_score']:>6.1f} {row['improvements']:>6} {row['regressions']:>7}")

    # Property detail for top 3
    print(f"\n{'='*80}")
    print("TOP CANDIDATES — Property Detail")
    for i, row in enumerate(rows[:3]):
        if not row.get('valid'):
            continue
        print(f"\n#{i+1}: {row['smiles']}")
        print(f"  Similarity: {row['similarity']}")
        for prop, d in row.get('deltas', {}).items():
            arrow = '↑' if d['delta'] > 0 else '↓' if d['delta'] < 0 else '='
            flag = f" [{d['status']}]" if d['status'] in ('FIXED', 'BROKEN') else ''
            print(f"  {prop}: {d['ref']} → {d['new']} ({arrow}{abs(d['delta'])}){flag}")

    with open(args.output, 'w') as f:
        json.dump(result, f, indent=2)
    print(f"\nFull results saved to {args.output}")
    return 0


if __name__ == '__main__':
    sys.exit(main() or 0)
