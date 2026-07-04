#!/usr/bin/env python3
"""
Pareto-Aware Multi-Objective Molecular Optimization

Generates candidates and identifies the Pareto front across multiple property objectives.
Based on MultiMol (Yu 2025) and MOLLM (Ran 2025).

Usage:
    python pareto_optimize.py --smiles "CCO" --objectives "LogP:minimize:3.0,QED:maximize:0.5" --output results.json
    python pareto_optimize.py --input candidates.csv --objectives "LogP:minimize:3.0,QED:maximize:0.5" --mode analyze
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

import numpy as np

PROPERTY_FUNCS = {
    'MW': lambda m: Descriptors.MolWt(m),
    'LogP': lambda m: Descriptors.MolLogP(m),
    'TPSA': lambda m: Descriptors.TPSA(m),
    'HBA': lambda m: float(Descriptors.NumHAcceptors(m)),
    'HBD': lambda m: float(Descriptors.NumHDonors(m)),
    'RotBonds': lambda m: float(Descriptors.NumRotatableBonds(m)),
    'QED': lambda m: QED.qed(m),
    'AromaticRings': lambda m: float(Descriptors.NumAromaticRings(m)),
    'FractionCSP3': lambda m: Descriptors.FractionCSP3(m),
    'NumRings': lambda m: float(Descriptors.RingCount(m)),
}

BIOISOSTERES = [
    ('[cH]', '[n]', 'C→N in ring'),
    ('Cl', 'F', 'Cl→F'),
    ('OC', 'O', 'OMe→OH'),
    ('CC', 'C', 'shorten chain'),
    ('c1ccccc1', 'c1ccncc1', 'phenyl→pyridine'),
    ('C(=O)N', 'S(=O)(=O)N', 'amide→sulfonamide'),
]


def parse_objectives(obj_str):
    """Parse objective string like 'LogP:minimize:3.0,QED:maximize:0.5'."""
    objectives = []
    for item in obj_str.split(','):
        parts = item.strip().split(':')
        if len(parts) == 3:
            prop, direction, target = parts
            objectives.append({
                'property': prop.strip(),
                'direction': direction.strip(),
                'target': float(target.strip()),
            })
        elif len(parts) == 4:  # range: TPSA:range:20:130
            prop, _, lo, hi = parts
            objectives.append({
                'property': prop.strip(),
                'direction': 'range',
                'target_min': float(lo.strip()),
                'target_max': float(hi.strip()),
            })
    return objectives


def evaluate_molecule(mol, objectives):
    """Evaluate a molecule against all objectives. Returns scores (lower = better)."""
    scores = {}
    props = {}
    for obj in objectives:
        prop = obj['property']
        if prop not in PROPERTY_FUNCS:
            continue
        val = PROPERTY_FUNCS[prop](mol)
        props[prop] = round(val, 4)

        if obj['direction'] == 'minimize':
            score = max(0, val - obj['target'])
        elif obj['direction'] == 'maximize':
            score = max(0, obj['target'] - val)
        elif obj['direction'] == 'range':
            if val < obj['target_min']:
                score = obj['target_min'] - val
            elif val > obj['target_max']:
                score = val - obj['target_max']
            else:
                score = 0
        else:
            score = abs(val - obj.get('target', val))

        scores[prop] = round(score, 4)

    return props, scores


def dominates(scores_a, scores_b):
    """Check if solution A Pareto-dominates solution B (all scores lower = better)."""
    a_vals = list(scores_a.values())
    b_vals = list(scores_b.values())
    at_least_one_better = False
    for a, b in zip(a_vals, b_vals):
        if a > b:
            return False
        if a < b:
            at_least_one_better = True
    return at_least_one_better


def find_pareto_front(candidates):
    """Identify the Pareto front from scored candidates."""
    pareto = []
    dominated = []
    for i, cand_i in enumerate(candidates):
        is_dominated = False
        for j, cand_j in enumerate(candidates):
            if i == j:
                continue
            if dominates(cand_j['scores'], cand_i['scores']):
                is_dominated = True
                break
        if is_dominated:
            dominated.append(cand_i)
        else:
            pareto.append(cand_i)
    return pareto, dominated


def generate_candidates(smiles, max_candidates=16):
    """Generate candidate molecules via bioisosteric replacements."""
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return []

    candidates = []
    for old_pat, new_pat, rationale in BIOISOSTERES:
        if len(candidates) >= max_candidates:
            break
        try:
            old_mol = Chem.MolFromSmarts(old_pat) or Chem.MolFromSmiles(old_pat)
            new_mol = Chem.MolFromSmiles(new_pat) or Chem.MolFromSmarts(new_pat)
            if old_mol is None or new_mol is None:
                continue
            if mol.HasSubstructMatch(old_mol):
                products = AllChem.ReplaceSubstructs(mol, old_mol, new_mol)
                for prod in products:
                    try:
                        smi = Chem.MolToSmiles(prod)
                        if Chem.MolFromSmiles(smi) is not None and smi != smiles:
                            candidates.append({'smiles': smi, 'rationale': rationale})
                    except Exception:
                        continue
        except Exception:
            continue

    # Deduplicate
    seen = set()
    unique = []
    for c in candidates:
        if c['smiles'] not in seen:
            seen.add(c['smiles'])
            unique.append(c)
    return unique[:max_candidates]


def main():
    parser = argparse.ArgumentParser(description='Multi-objective molecular optimization')
    parser.add_argument('--smiles', type=str, help='Input SMILES to optimize')
    parser.add_argument('--input', type=str, help='CSV with candidate molecules')
    parser.add_argument('--smiles-col', type=str, default='SMILES')
    parser.add_argument('--objectives', type=str, required=True, help='Objectives (e.g., "LogP:minimize:3.0,QED:maximize:0.5")')
    parser.add_argument('--candidates', type=int, default=16, help='Max candidates to generate')
    parser.add_argument('--mode', choices=['optimize', 'analyze'], default='optimize')
    parser.add_argument('--output', type=str, default='pareto_results.json')

    args = parser.parse_args()
    objectives = parse_objectives(args.objectives)

    if not objectives:
        print("Error: No valid objectives parsed.", file=sys.stderr)
        return 1

    molecules = []

    if args.smiles and args.mode == 'optimize':
        ref_mol = Chem.MolFromSmiles(args.smiles)
        if ref_mol is None:
            print(f"Error: Invalid SMILES: {args.smiles}", file=sys.stderr)
            return 1

        ref_props, ref_scores = evaluate_molecule(ref_mol, objectives)
        print(f"Reference: {Chem.MolToSmiles(ref_mol)}")
        print(f"Properties: {ref_props}")
        print(f"Objective gaps: {ref_scores}")

        candidates = generate_candidates(args.smiles, args.candidates)
        molecules = [{'smiles': args.smiles, 'is_reference': True}] + candidates

    elif args.input:
        import pandas as pd
        df = pd.read_csv(args.input)
        molecules = [{'smiles': smi} for smi in df[args.smiles_col]]

    else:
        print("Error: Provide --smiles or --input", file=sys.stderr)
        return 1

    # Evaluate all molecules
    evaluated = []
    for entry in molecules:
        mol = Chem.MolFromSmiles(entry['smiles'])
        if mol is None:
            continue
        props, scores = evaluate_molecule(mol, objectives)

        # Similarity to reference if available
        sim = None
        if args.smiles:
            ref_mol = Chem.MolFromSmiles(args.smiles)
            fp1 = AllChem.GetMorganFingerprintAsBitVect(ref_mol, 2, nBits=2048)
            fp2 = AllChem.GetMorganFingerprintAsBitVect(mol, 2, nBits=2048)
            sim = round(DataStructs.TanimotoSimilarity(fp1, fp2), 4)

        evaluated.append({
            'smiles': Chem.MolToSmiles(mol),
            'properties': props,
            'scores': scores,
            'total_gap': round(sum(scores.values()), 4),
            'similarity': sim,
            'rationale': entry.get('rationale', ''),
            'is_reference': entry.get('is_reference', False),
        })

    # Find Pareto front
    pareto, dominated = find_pareto_front(evaluated)

    # Sort Pareto front by total gap
    pareto.sort(key=lambda x: x['total_gap'])

    result = {
        'objectives': objectives,
        'total_evaluated': len(evaluated),
        'pareto_front_size': len(pareto),
        'pareto_front': pareto,
        'dominated': dominated[:10],  # Top 10 dominated for reference
    }

    # Print summary
    print(f"\n{'='*70}")
    print(f"PARETO FRONT ({len(pareto)} solutions)")
    print(f"{'='*70}")
    for i, p in enumerate(pareto):
        ref_tag = ' [REFERENCE]' if p.get('is_reference') else ''
        sim_str = f" sim={p['similarity']}" if p['similarity'] is not None else ''
        print(f"\n#{i+1}{ref_tag}: {p['smiles']}{sim_str}")
        print(f"  Properties: {p['properties']}")
        print(f"  Gaps: {p['scores']} (total: {p['total_gap']})")
        if p.get('rationale'):
            print(f"  Modification: {p['rationale']}")

    with open(args.output, 'w') as f:
        json.dump(result, f, indent=2)
    print(f"\nResults saved to {args.output}")
    return 0


if __name__ == '__main__':
    sys.exit(main() or 0)
