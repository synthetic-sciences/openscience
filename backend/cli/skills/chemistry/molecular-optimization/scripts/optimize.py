#!/usr/bin/env python3
"""
Iterative Molecular Optimization

Implements the analyze-reason-generate-verify-evaluate loop for lead optimization.
Based on MT-Mol (Kim 2025), DrugR (Liu 2026), MultiMol (Yu 2025).

Usage:
    python optimize.py --smiles "CCO" --targets "LogP<3,QED>0.5" --output results.json
    python optimize.py --input leads.csv --smiles-col SMILES --targets "LogP<3" --output optimized.csv
"""

import argparse
import json
import sys
from dataclasses import dataclass, asdict

try:
    from rdkit import Chem
    from rdkit.Chem import Descriptors, QED, AllChem, DataStructs, rdMolDescriptors
    from rdkit.Chem.Scaffolds import MurckoScaffold
    from rdkit import RDLogger
    RDLogger.logger().setLevel(RDLogger.ERROR)
except ImportError:
    print("Error: rdkit-pypi required. Install with: pip install rdkit-pypi", file=sys.stderr)
    sys.exit(1)

import numpy as np

# ADMET thresholds from DrugR (Liu et al., 2026)
THRESHOLDS = {
    'MW': {'min': 150, 'max': 500, 'severity': 'medium'},
    'LogP': {'min': 1.0, 'max': 3.0, 'severity': 'medium'},
    'TPSA': {'min': 20, 'max': 130, 'severity': 'medium'},
    'HBA': {'max': 10, 'severity': 'low'},
    'HBD': {'max': 5, 'severity': 'low'},
    'RotBonds': {'max': 10, 'severity': 'low'},
    'QED': {'min': 0.5, 'severity': 'low'},
    'LogS': {'min': -4.0, 'severity': 'medium'},
}

SEVERITY_ORDER = {'critical': 0, 'high': 1, 'medium': 2, 'low': 3}

# Common bioisosteric replacements
BIOISOSTERES = [
    ('[cH]', '[n]', 'phenyl C→N (reduce LogP)'),
    ('Cl', 'F', 'Cl→F (reduce MW, lipophilicity)'),
    ('c1ccccc1', 'c1ccncc1', 'phenyl→pyridine (increase polarity)'),
    ('C(=O)N', 'S(=O)(=O)N', 'amide→sulfonamide'),
    ('OC', 'O', 'methoxy→hydroxy (reduce LogP)'),
    ('CC', 'C', 'shorten chain (reduce MW/LogP)'),
    ('c1ccc2ccccc2c1', 'c1ccc2[nH]ccc2c1', 'naphthalene→indole (add HBD)'),
]


def compute_descriptors(mol):
    """Compute core molecular descriptors."""
    return {
        'MW': round(Descriptors.MolWt(mol), 1),
        'LogP': round(Descriptors.MolLogP(mol), 2),
        'TPSA': round(Descriptors.TPSA(mol), 1),
        'HBA': Descriptors.NumHAcceptors(mol),
        'HBD': Descriptors.NumHDonors(mol),
        'RotBonds': Descriptors.NumRotatableBonds(mol),
        'AromaticRings': Descriptors.NumAromaticRings(mol),
        'QED': round(QED.qed(mol), 3),
        'NumRings': Descriptors.RingCount(mol),
    }


def get_scaffold(mol):
    """Get generic Murcko scaffold SMILES."""
    try:
        scaffold = MurckoScaffold.GetScaffoldForMol(mol)
        generic = MurckoScaffold.MakeScaffoldGeneric(scaffold)
        return Chem.MolToSmiles(generic)
    except Exception:
        return None


def compute_similarity(mol1, mol2, radius=2, nbits=2048):
    """Compute Tanimoto similarity using ECFP4."""
    fp1 = AllChem.GetMorganFingerprintAsBitVect(mol1, radius, nBits=nbits)
    fp2 = AllChem.GetMorganFingerprintAsBitVect(mol2, radius, nBits=nbits)
    return round(DataStructs.TanimotoSimilarity(fp1, fp2), 4)


def identify_liabilities(descriptors):
    """Flag properties outside ADMET thresholds. Returns sorted list by severity."""
    liabilities = []
    for prop, thresh in THRESHOLDS.items():
        if prop not in descriptors:
            continue
        val = descriptors[prop]
        violation = None
        if 'min' in thresh and 'max' in thresh:
            if val < thresh['min']:
                violation = f"{prop}={val} below target minimum {thresh['min']}"
            elif val > thresh['max']:
                violation = f"{prop}={val} above target maximum {thresh['max']}"
        elif 'min' in thresh:
            if val < thresh['min']:
                violation = f"{prop}={val} below target minimum {thresh['min']}"
        elif 'max' in thresh:
            if val > thresh['max']:
                violation = f"{prop}={val} above target maximum {thresh['max']}"
        if violation:
            liabilities.append({
                'property': prop,
                'value': val,
                'threshold': thresh,
                'severity': thresh['severity'],
                'description': violation,
            })
    liabilities.sort(key=lambda x: SEVERITY_ORDER.get(x['severity'], 99))
    return liabilities


def generate_candidates(smiles, liabilities, max_candidates=8):
    """Generate candidate molecules by applying bioisosteric replacements."""
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return []

    candidates = []
    for old_pattern, new_pattern, rationale in BIOISOSTERES:
        if len(candidates) >= max_candidates:
            break
        try:
            old_mol = Chem.MolFromSmarts(old_pattern)
            if old_mol is None:
                old_mol = Chem.MolFromSmiles(old_pattern)
            if old_mol is None:
                continue
            if mol.HasSubstructMatch(old_mol):
                new_mol = AllChem.ReplaceSubstructs(mol, old_mol, Chem.MolFromSmiles(new_pattern) or Chem.MolFromSmarts(new_pattern))
                for nm in new_mol:
                    try:
                        new_smiles = Chem.MolToSmiles(nm)
                        if Chem.MolFromSmiles(new_smiles) is not None and new_smiles != smiles:
                            candidates.append({
                                'smiles': new_smiles,
                                'rationale': rationale,
                                'modification': f"{old_pattern} → {new_pattern}",
                            })
                    except Exception:
                        continue
        except Exception:
            continue
    return candidates[:max_candidates]


def verify_candidate(original_smiles, candidate_smiles, original_mol=None):
    """Verify a candidate SMILES is valid and structurally related."""
    mol = Chem.MolFromSmiles(candidate_smiles)
    if mol is None:
        return {'valid': False, 'reason': 'Invalid SMILES — RDKit parse failed'}

    if original_mol is None:
        original_mol = Chem.MolFromSmiles(original_smiles)

    similarity = compute_similarity(original_mol, mol)
    orig_scaffold = get_scaffold(original_mol)
    new_scaffold = get_scaffold(mol)
    scaffold_preserved = orig_scaffold == new_scaffold if orig_scaffold and new_scaffold else None

    result = {
        'valid': True,
        'similarity': similarity,
        'scaffold_preserved': scaffold_preserved,
        'original_scaffold': orig_scaffold,
        'new_scaffold': new_scaffold,
    }

    if similarity < 0.4:
        result['warning'] = f'Low similarity ({similarity}) — closer to de novo design than optimization'
    if scaffold_preserved is False:
        result['warning'] = result.get('warning', '') + ' Scaffold changed.'

    return result


def score_candidate(original_desc, candidate_desc, original_liabilities):
    """Score a candidate by net liability improvement."""
    original_liability_props = {l['property'] for l in original_liabilities}
    new_liabilities = identify_liabilities(candidate_desc)
    new_liability_props = {l['property'] for l in new_liabilities}

    fixed = original_liability_props - new_liability_props
    introduced = new_liability_props - original_liability_props
    score = len(fixed) * 1.0 - len(introduced) * 0.5

    return {
        'score': score,
        'liabilities_fixed': list(fixed),
        'liabilities_introduced': list(introduced),
        'remaining_liabilities': list(original_liability_props & new_liability_props),
        'new_liability_count': len(new_liabilities),
    }


def optimize_molecule(smiles, targets=None, max_iterations=3, max_candidates=8):
    """Run the full optimization loop on a single molecule."""
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return {'error': f'Invalid input SMILES: {smiles}'}

    canonical = Chem.MolToSmiles(mol)
    original_desc = compute_descriptors(mol)
    original_scaffold = get_scaffold(mol)

    iterations = []
    best_candidate = None
    best_score = -float('inf')
    current_smiles = canonical

    for iteration in range(max_iterations):
        current_mol = Chem.MolFromSmiles(current_smiles)
        current_desc = compute_descriptors(current_mol)
        liabilities = identify_liabilities(current_desc)

        if not liabilities:
            break  # No liabilities to fix

        # Generate candidates
        candidates = generate_candidates(current_smiles, liabilities, max_candidates)
        if not candidates:
            break  # No modifications possible

        # Verify and score each candidate
        scored = []
        for cand in candidates:
            verification = verify_candidate(canonical, cand['smiles'], mol)
            if not verification['valid']:
                continue

            cand_mol = Chem.MolFromSmiles(cand['smiles'])
            cand_desc = compute_descriptors(cand_mol)
            cand_score = score_candidate(original_desc, cand_desc, identify_liabilities(original_desc))

            scored.append({
                **cand,
                'descriptors': cand_desc,
                'verification': verification,
                'scoring': cand_score,
            })

        scored.sort(key=lambda x: x['scoring']['score'], reverse=True)

        iteration_result = {
            'iteration': iteration + 1,
            'input_smiles': current_smiles,
            'liabilities': liabilities,
            'candidates_generated': len(candidates),
            'candidates_valid': len(scored),
            'top_candidates': scored[:3],
        }
        iterations.append(iteration_result)

        # Update best
        if scored and scored[0]['scoring']['score'] > best_score:
            best_score = scored[0]['scoring']['score']
            best_candidate = scored[0]
            current_smiles = scored[0]['smiles']
        else:
            break  # No improvement, stop iterating

    result = {
        'input_smiles': canonical,
        'input_descriptors': original_desc,
        'input_scaffold': original_scaffold,
        'input_liabilities': identify_liabilities(original_desc),
        'iterations': iterations,
        'best_candidate': best_candidate,
        'best_score': best_score,
    }

    if best_candidate:
        result['improvement_summary'] = {
            'liabilities_fixed': best_candidate['scoring']['liabilities_fixed'],
            'liabilities_introduced': best_candidate['scoring']['liabilities_introduced'],
            'similarity_to_original': best_candidate['verification']['similarity'],
            'scaffold_preserved': best_candidate['verification']['scaffold_preserved'],
        }

    return result


def parse_targets(target_str):
    """Parse target string like 'LogP<3,QED>0.5' into dict."""
    if not target_str:
        return {}
    targets = {}
    for item in target_str.split(','):
        item = item.strip()
        for op in ['<=', '>=', '<', '>']:
            if op in item:
                prop, val = item.split(op, 1)
                targets[prop.strip()] = {'op': op, 'value': float(val.strip())}
                break
    return targets


def main():
    parser = argparse.ArgumentParser(description='Iterative molecular optimization')
    parser.add_argument('--smiles', type=str, help='Input SMILES string')
    parser.add_argument('--input', type=str, help='Input CSV file with molecules')
    parser.add_argument('--smiles-col', type=str, default='SMILES', help='SMILES column name in CSV')
    parser.add_argument('--targets', type=str, default=None, help='Target properties (e.g., "LogP<3,QED>0.5")')
    parser.add_argument('--max-iterations', type=int, default=3, help='Max optimization iterations')
    parser.add_argument('--candidates', type=int, default=8, help='Candidates per iteration')
    parser.add_argument('--output', type=str, default='results.json', help='Output file')

    args = parser.parse_args()

    if not args.smiles and not args.input:
        print("Error: Provide --smiles or --input", file=sys.stderr)
        return 1

    targets = parse_targets(args.targets)

    if args.smiles:
        result = optimize_molecule(args.smiles, targets, args.max_iterations, args.candidates)
        print(json.dumps(result, indent=2))
        with open(args.output, 'w') as f:
            json.dump(result, f, indent=2)
        print(f"\nResults saved to {args.output}")

        # Print summary
        if result.get('best_candidate'):
            bc = result['best_candidate']
            print(f"\n{'='*60}")
            print(f"OPTIMIZATION SUMMARY")
            print(f"{'='*60}")
            print(f"Input:  {result['input_smiles']}")
            print(f"Output: {bc['smiles']}")
            print(f"Modification: {bc['rationale']}")
            print(f"Similarity: {bc['verification']['similarity']}")
            print(f"Scaffold preserved: {bc['verification']['scaffold_preserved']}")
            print(f"Liabilities fixed: {bc['scoring']['liabilities_fixed']}")
            print(f"Liabilities introduced: {bc['scoring']['liabilities_introduced']}")
        else:
            print("\nNo improvement found — molecule may already be well-optimized.")
        return 0

    elif args.input:
        import pandas as pd
        df = pd.read_csv(args.input)
        results = []
        for _, row in df.iterrows():
            smi = row[args.smiles_col]
            result = optimize_molecule(smi, targets, args.max_iterations, args.candidates)
            results.append(result)
        with open(args.output, 'w') as f:
            json.dump(results, f, indent=2)
        print(f"Optimized {len(results)} molecules → {args.output}")
        return 0


if __name__ == '__main__':
    sys.exit(main() or 0)
